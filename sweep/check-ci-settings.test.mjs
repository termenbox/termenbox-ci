import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPOS, WORKER_URL, GATED_ENVIRONMENTS, BRANCH_ONLY_ENVIRONMENTS, gather, evaluate, evaluateExternal, run, R2_PROBE_URL } from './check-ci-settings.mjs';

const SHA = 'a'.repeat(40);
const clone = (x) => JSON.parse(JSON.stringify(x));

function ciFixture() {
  const env = (name) => ({
    name,
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  const f = {
    '': { has_issues: false, has_wiki: false, has_discussions: false },
    '/actions/permissions': { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
    '/actions/permissions/workflow': { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    '/actions/permissions/selected-actions': { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [`actions/cache/save@${SHA}`, `Swatinem/rust-cache@${SHA}`] },
    '/actions/permissions/fork-pr-contributor-approval': { approval_policy: 'all_external_contributors' },
    '/collaborators': [{ login: 'x' }, { login: 'z' }],
    '/hooks': [],
    '/actions/secrets': { secrets: REPOS.ci.secrets.map((name) => ({ name })) },
    '/environments': { environments: [...GATED_ENVIRONMENTS, ...BRANCH_ONLY_ENVIRONMENTS].map(env) },
  };
  for (const e of [...GATED_ENVIRONMENTS, ...BRANCH_ONLY_ENVIRONMENTS]) f[`/environments/${e}/deployment-branch-policies`] = { branch_policies: [{ name: 'main' }] };
  return f;
}
function privateFixture() {
  return {
    '': { has_issues: false, has_wiki: false, has_discussions: false },
    '/actions/permissions': { enabled: false },
    '/actions/permissions/workflow': { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    '/collaborators': [{ login: 'x' }, { login: 'z' }],
    '/hooks': [{ config: { url: WORKER_URL } }],
    '/actions/secrets': { secrets: [] },
  };
}
const getter = (fx) => (path) => {
  const key = path.replace(/^repos\/[^/]+\/[^/]+/, '');
  if (!(key in fx)) throw new Error('404');
  return clone(fx[key]);
};
const ci = (fx) => evaluate(gather(getter(fx), REPOS.ci.repo, REPOS.ci), REPOS.ci);
const priv = (fx) => evaluate(gather(getter(fx), REPOS.private.repo, REPOS.private), REPOS.private);

test('good fixtures pass', () => {
  assert.deepEqual(ci(ciFixture()), []);
  assert.deepEqual(priv(privateFixture()), []);
});

test('the environment the monthly sweep runs in is checked for a branch policy and needs no reviewer', () => {
  assert.ok(BRANCH_ONLY_ENVIRONMENTS.includes('security'));
  const f = ciFixture();
  f['/environments'].environments = f['/environments'].environments.filter((e) => e.name !== 'security');
  assert.ok(ci(f).includes('environment-security-exists'));
  const g = ciFixture();
  g['/environments'].environments.find((e) => e.name === 'security').protection_rules = [];
  assert.ok(!ci(g).includes('environment-security-required-reviewer'));
  g['/environments'].environments.find((e) => e.name === 'security').deployment_branch_policy = null;
  assert.ok(ci(g).includes('environment-security-branch-policy-main'));
});

test('ci repo: each broken setting names its check', () => {
  const cases = [
    [(f) => { f['/actions/permissions'].enabled = false; }, 'actions-enabled-as-intended'],
    [(f) => { f['/actions/permissions/workflow'].default_workflow_permissions = 'write'; }, 'default-workflow-permissions-read'],
    [(f) => { f['/actions/permissions'].allowed_actions = 'all'; }, 'selected-actions-only'],
    [(f) => { f['/actions/permissions'].sha_pinning_required = false; }, 'sha-pinning-required'],
    [(f) => { f['/actions/permissions/selected-actions'].patterns_allowed.push('actions/checkout@v4'); }, 'selected-actions-pinned'],
    [(f) => { f['/actions/permissions/selected-actions'].patterns_allowed.push('actions/*'); }, 'selected-actions-pinned'],
    [(f) => { f['/actions/permissions/fork-pr-contributor-approval'].approval_policy = 'first_time_contributors'; }, 'fork-pr-approval-all'],
    [(f) => { f[''].has_issues = true; }, 'issues-off'],
    [(f) => { f[''].has_wiki = true; }, 'wiki-off'],
    [(f) => { f[''].has_discussions = true; }, 'discussions-off'],
    [(f) => { f['/collaborators'].push({ login: 'y' }); }, 'collaborator-count'],
    [(f) => { f['/hooks'].push({ config: { url: 'https://example.invalid' } }); }, 'webhooks-match-worker'],
    [(f) => { f['/actions/secrets'].secrets.push({ name: 'EXTRA' }); }, 'repo-secrets-match-list'],
    [(f) => { f['/environments'].environments = f['/environments'].environments.filter((e) => e.name !== 'cloud'); }, 'environment-cloud-exists'],
    [(f) => { f['/environments'].environments[0].protection_rules = []; }, 'environment-approve-beta-required-reviewer'],
    [(f) => { f['/environments/stable/deployment-branch-policies'].branch_policies.push({ name: 'dev' }); }, 'environment-stable-branch-policy-main'],
    [(f) => { f['/environments'].environments.find((e) => e.name === 'cloud').deployment_branch_policy.custom_branch_policies = false; }, 'environment-cloud-branch-policy-main'],
  ];
  for (const [mutate, name] of cases) {
    const f = ciFixture();
    mutate(f);
    assert.ok(ci(f).includes(name), name);
  }
});

test('private repo: Actions on and a wrong hook fail; issues and a second collaborator are allowed', () => {
  const f = privateFixture();
  f['/actions/permissions'].enabled = true;
  f['/collaborators'].push({ login: 'y' });
  f[''].has_issues = true;
  f['/hooks'] = [];
  const bad = priv(f);
  for (const n of ['actions-enabled-as-intended', 'webhooks-match-worker']) assert.ok(bad.includes(n), n);
  for (const n of ['collaborator-count', 'issues-off']) assert.ok(!bad.includes(n), n);
});

test('an unreadable setting fails rather than passes', () => {
  const f = ciFixture();
  delete f['/hooks'];
  delete f['/actions/secrets'];
  const bad = ci(f);
  assert.ok(bad.includes('webhooks-match-worker') && bad.includes('repo-secrets-match-list'));
});

test('external checks', () => {
  assert.deepEqual(evaluateExternal({ ghcrStatus: 200, r2Status: 200 }), []);
  assert.deepEqual(evaluateExternal({ ghcrStatus: 401, r2Status: 404 }), ['ghcr-visibility', 'r2-visibility']);
  assert.deepEqual(evaluateExternal({ ghcrStatus: 0, r2Status: 200 }), ['ghcr-visibility']);
});

test('run prints names only and only GETs', async () => {
  const ciF = ciFixture();
  ciF['/actions/secrets'].secrets.push({ name: 'SUPER_SECRET_NAME' });
  const privF = privateFixture();
  const paths = [];
  const get = (path) => {
    paths.push(path);
    return getter(path.startsWith('repos/termenbox/termenbox-ci') ? ciF : privF)(path);
  };
  const probed = [];
  const failing = await run({ ghcr: async () => 200, get, probe: async (u) => { probed.push(u); return 200; } });
  assert.deepEqual(failing, ['ci:repo-secrets-match-list']);
  assert.ok(!failing.join().includes('SUPER_SECRET_NAME'));
  assert.deepEqual(probed, [R2_PROBE_URL]);
});
