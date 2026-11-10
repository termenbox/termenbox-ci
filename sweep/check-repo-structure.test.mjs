import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, gather, evaluate, scanSourceCalls, run, GROUPS } from './check-repo-structure.mjs';

const cfg = loadConfig();
const b64 = (t) => ({ type: 'file', content: Buffer.from(t).toString('base64') });
const clone = (x) => JSON.parse(JSON.stringify(x));

// A conforming public repo listing, built from the spec so the fixtures follow the config.
function publicFixture(spec) {
  const f = {
    '': { private: false, has_issues: spec.issues, has_discussions: spec.discussions, has_wiki: spec.wiki, license: { key: 'x' }, topics: ['terminal'], description: 'A web terminal.', homepage: 'https://termenbox.dev' },
    '/actions/permissions': { enabled: spec.actions },
    '/collaborators': Array.from({ length: spec.collaborators ?? 1 }, () => ({ login: 'x' })),
    '/hooks': [],
    '/actions/secrets': { secrets: spec.secrets.map((name) => ({ name })) },
    '/environments': { total_count: spec.environments ? 3 : 0, environments: spec.environments ? [{ name: 'beta' }] : [] },
    '/releases': [{ name: 'v1', body: 'Notes for users.' }],
    '/contents/.github/ISSUE_TEMPLATE': [{ type: 'file', path: '.github/ISSUE_TEMPLATE/bug.yml' }],
    '/contents/.github/ISSUE_TEMPLATE/bug.yml': b64('name: Bug\nbody: version and OS'),
    '/contents/.github/workflows': [{ type: 'file', path: '.github/workflows/a.yaml' }],
    '/contents/.github/workflows/a.yaml': b64('# Builds the app\non: push'),
  };
  for (const file of spec.requiredFiles ?? []) f[`/contents/${file}`] = b64(file.endsWith('README.md') ? '# Name\n\n## Attribution\nCopyright Example.' : 'text');
  return f;
}
const getter = (fx) => (path) => {
  const key = path.replace(/^repos\/[^/]+\/[^/]+/, '').replace(/^repos\/termenbox\/\.github/, '');
  if (!(key in fx)) throw new Error('404');
  return clone(fx[key]);
};
const check = (key, fx) => evaluate(gather(getter(fx), cfg.repos[key], GROUPS), cfg.repos[key], cfg);

test('a conforming ci repo and product repo pass', () => {
  assert.deepEqual(check('termenbox-ci', publicFixture(cfg.repos['termenbox-ci'])), []);
  assert.deepEqual(check('termenbox', publicFixture(cfg.repos.termenbox)), []);
});

test('a_public_page_with_an_internal_marker_fails', () => {
  const spec = cfg.repos['termenbox-ci'];
  const cases = {
    'readme-marker': ['/contents/README.md', b64('# CI\n\nSet LOG_KEY and run openssl enc.\n## Attribution\nx')],
    'description-marker': ['', { ...publicFixture(spec)[''], description: 'Public harness for the private source' }],
    'topics-marker': ['', { ...publicFixture(spec)[''], topics: ['FACT-1'] }],
    'issue-forms-marker': ['/contents/.github/ISSUE_TEMPLATE/bug.yml', b64('see docs/plans/x.md')],
    'releases-marker': ['/releases', [{ name: 'v1', body: 'fixes SR-2026-1' }]],
    'workflow-comments-marker': ['/contents/.github/workflows/a.yaml', b64('# per DECISION-1\non: push')],
  };
  for (const [name, [path, value]] of Object.entries(cases)) {
    const fx = publicFixture(spec);
    fx[path] = value;
    const bad = check('termenbox-ci', fx);
    assert.ok(bad.includes(name), `${name} in ${bad}`);
    assert.ok(bad.every((n) => !/LOG_KEY|FACT-1|openssl/.test(n)), 'names only');
  }
});

test('a workflow whose code reads a named secret passes and a step name that names the private source fails', () => {
  const spec = cfg.repos['termenbox-ci'];
  const fx = publicFixture(spec);
  fx['/contents/.github/workflows/a.yaml'] = b64('# Builds the app\non: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.SOURCE_TOKEN }}');
  assert.deepEqual(check('termenbox-ci', fx), []);
  fx['/contents/.github/workflows/a.yaml'] = b64('on: push\njobs:\n  a:\n    steps:\n      - name: Check out private source');
  assert.deepEqual(check('termenbox-ci', fx), ['workflow-comments-marker']);
});

test('a public repo without a license, topics or attribution section fails', () => {
  const spec = cfg.repos['termenbox-ci'];
  const fx = publicFixture(spec);
  fx[''] = { ...fx[''], license: null, topics: [] };
  fx['/contents/README.md'] = b64('# Name\nnothing else');
  assert.deepEqual(check('termenbox-ci', fx), ['license', 'topics', 'readme-attribution-section']);
});

test('a_product_repo_with_a_secret_or_workflow_fails', () => {
  const fx = publicFixture(cfg.repos.termenbox);
  fx['/actions/secrets'] = { secrets: [{ name: 'MIRROR_TOKEN' }] };
  fx['/actions/permissions'] = { enabled: true };
  fx['/environments'] = { total_count: 1, environments: [{ name: 'beta' }] };
  fx['/hooks'] = [{ config: { url: cfg.workerUrl } }];
  const bad = check('termenbox', fx);
  for (const n of ['secrets-none', 'actions-disabled', 'no-environments', 'webhooks-none']) assert.ok(bad.includes(n), n);
});

test('a trust-root repo with issues, discussions or wiki on fails; a private product fails', () => {
  const fx = publicFixture(cfg.repos['termenbox-ci']);
  fx[''] = { ...fx[''], has_issues: true, has_discussions: true, has_wiki: true, private: true };
  assert.deepEqual(check('termenbox-ci', fx), ['visibility', 'issues-off', 'discussions-off', 'wiki-off']);
});

test('a missing repo fails by name', () => {
  assert.deepEqual(check('termenbox-security', {}), ['repo-exists']);
});

test('an_unresolvable_public_url_fails', async () => {
  const probe = async (u) => (u.endsWith('/releases') ? 404 : 200);
  const { failing } = await run({ cfg, groups: ['references'], probe });
  assert.deepEqual(failing, ['references:url-product-releases']);
  const none = await run({ cfg, groups: ['references'], probe: async () => 200 });
  assert.deepEqual(none.failing, []);
});

test('a_source_call_aimed_at_the_product_repo_fails', async () => {
  const files = {
    'scripts/a.sh': 'gh api repos/termenbox/termenbox/statuses/abc',
    '.github/p.py': '  GH_REPO: termenbox/termenbox',
    'x.rs': 'git clone https://github.com/termenbox/termenbox.git',
    'w.js': 'const SRC_REPO = "termenbox/termenbox";',
    'ok.sh': 'curl https://github.com/termenbox/termenbox/releases/download/v1/x',
    'sweep/old.md': 'repos/termenbox/termenbox/',
  };
  const found = scanSourceCalls(files, cfg);
  assert.deepEqual(found.map((f) => f.path).sort(), ['.github/p.py', 'scripts/a.sh', 'w.js', 'x.rs']);
  const { failing } = await run({ cfg, groups: ['references'], probe: async () => 200, trees: [{ name: 'ci', files }] });
  assert.deepEqual(failing, ['references:source-call-in-ci']);
  const allowed = scanSourceCalls(files, { ...cfg, sourceCallAllow: [{ path: 'x.rs', contains: 'clone' }] });
  assert.ok(!allowed.some((f) => f.path === 'x.rs'));
});

test('--repo and --only narrow the run', async () => {
  const asked = [];
  const get = (p) => { asked.push(p); throw new Error('404'); };
  const { failing } = await run({ cfg, get, groups: ['settings'], repo: 'termenbox-ci' });
  assert.deepEqual(failing, ['termenbox-ci:repo-exists']);
  assert.ok(asked.every((p) => p.startsWith('repos/termenbox/termenbox-ci')));
});
