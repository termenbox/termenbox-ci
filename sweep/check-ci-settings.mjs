#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './check-repo-structure.mjs';

// Reads the settings of the ci repo (the trust root: it holds every secret and the stable signing key) and of the
// private source repo back through `gh api` and prints the NAMES of the checks that fail. It never prints a value, a
// secret name, a login or a URL. Every call is a GET; there is no write path in this file.
// Secrets are never printed: only the names of failing checks leave this script.

// Per-repo expectations come from the one map in .github/repo-structure.json, shared with check-repo-structure.mjs
// (which also checks the public repos); this file adds the trust-root checks (pinned actions, Environments, GHCR, R2).
const CFG = loadConfig();
const expectation = (name) => {
  const x = CFG.repos[name];
  return {
    repo: x.repo,
    actionsEnabled: x.actions,
    secrets: x.secrets,
    hooks: x.hooks.map((h) => (h === 'WORKER' ? CFG.workerUrl : h)),
    environments: x.environments,
    issues: x.issues,
    collaborators: x.collaborators,
  };
};
export const WORKER_URL = CFG.workerUrl;
export const R2_PROBE_URL = 'https://dl.termenbox.dev/health.txt';
// The approval-only Environments and `cloud` carry a reviewer and a branch policy. The channel Environments hold secrets and a
// branch policy but no reviewer: one approval covers a release. The sweep's Environment has no reviewer either: its tokens only
// read, bar one issue write on the review repo.
export const GATED_ENVIRONMENTS = ['approve-beta', 'approve-stable', 'cloud'];
export const BRANCH_ONLY_ENVIRONMENTS = ['beta', 'stable', 'security'];
export const REPOS = { ci: expectation('termenbox-ci'), private: expectation('termenbox-source') };
// Read anonymously (a pull token, then a tag list): it needs no `read:packages` scope and proves the package is public.
export const GHCR_TOKEN_URL = 'https://ghcr.io/token?scope=repository:termenbox/termenbox:pull';
export const GHCR_TAGS_URL = 'https://ghcr.io/v2/termenbox/termenbox/tags/list';
export const EXPECTED = { ghcrStatus: 200, r2Status: 200 };

// The repo's own reusable workflows are not third-party code.
const OWN_REPO_PATTERN = 'termenbox/termenbox-ci/*';
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/;
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** `get(path)` returns parsed JSON or throws. Returns the settings; a path that fails is `undefined`. */
export function gather(get, repo, spec) {
  const r = (p) => {
    try {
      return get(`repos/${repo}${p}`);
    } catch {
      return undefined;
    }
  };
  const s = {
    repo: r(''),
    actions: r('/actions/permissions'),
    workflow: r('/actions/permissions/workflow'),
    collaborators: r('/collaborators'),
    hooks: r('/hooks'),
    secrets: r('/actions/secrets'),
  };
  if (s.actions?.enabled) {
    s.selected = r('/actions/permissions/selected-actions');
    if (spec.actionsEnabled) s.forkApproval = r('/actions/permissions/fork-pr-contributor-approval');
  }
  if (spec.environments) {
    s.environments = r('/environments');
    s.branchPolicies = {};
    for (const e of [...GATED_ENVIRONMENTS, ...BRANCH_ONLY_ENVIRONMENTS]) s.branchPolicies[e] = r(`/environments/${e}/deployment-branch-policies`);
  }
  return s;
}

/** Names of the failing checks for one repo. */
export function evaluate(s, spec) {
  const bad = [];
  const need = (name, ok) => { if (!ok) bad.push(name); };
  need('repo-readable', !!s.repo);
  need('actions-enabled-as-intended', s.actions?.enabled === spec.actionsEnabled);
  need('default-workflow-permissions-read', s.workflow?.default_workflow_permissions === 'read');
  need('workflow-cannot-approve-prs', s.workflow?.can_approve_pull_request_reviews === false);
  if (spec.actionsEnabled) {
    need('selected-actions-only', s.actions?.allowed_actions === 'selected');
    need('sha-pinning-required', s.actions?.sha_pinning_required === true);
    need('selected-actions-pinned',
      !!s.selected && s.selected.verified_allowed !== true && (s.selected.patterns_allowed ?? []).every((p) => p === OWN_REPO_PATTERN || PINNED.test(p)));
    need('fork-pr-approval-all', s.forkApproval?.approval_policy === 'all_external_contributors');
  }
  if (spec.issues === false) need('issues-off', s.repo?.has_issues === false);
  need('wiki-off', s.repo?.has_wiki === false);
  need('discussions-off', s.repo?.has_discussions === false);
  if (typeof spec.collaborators === 'number') {
    need('collaborator-count', Array.isArray(s.collaborators) && s.collaborators.length === spec.collaborators);
  }
  need('webhooks-match-worker',
    Array.isArray(s.hooks) && sameSet(s.hooks.map((h) => h?.config?.url), spec.hooks));
  need('repo-secrets-match-list',
    !!s.secrets && sameSet((s.secrets.secrets ?? []).map((x) => x.name), spec.secrets));
  if (spec.environments) {
    const envs = s.environments?.environments ?? [];
    for (const e of [...GATED_ENVIRONMENTS, ...BRANCH_ONLY_ENVIRONMENTS]) {
      const env = envs.find((x) => x.name === e);
      const reviewers = (env?.protection_rules ?? []).find((p) => p.type === 'required_reviewers');
      need(`environment-${e}-exists`, !!env);
      if (GATED_ENVIRONMENTS.includes(e)) need(`environment-${e}-required-reviewer`, (reviewers?.reviewers ?? []).length > 0);
      need(`environment-${e}-branch-policy-main`,
        env?.deployment_branch_policy?.custom_branch_policies === true &&
        sameSet((s.branchPolicies?.[e]?.branch_policies ?? []).map((b) => b.name), ['main']));
    }
  }
  return bad;
}

/** Checks outside a repo's settings: GHCR package visibility and the anonymous R2 probe. */
export function evaluateExternal({ ghcrStatus, r2Status }) {
  const bad = [];
  if (ghcrStatus !== EXPECTED.ghcrStatus) bad.push('ghcr-visibility');
  if (r2Status !== EXPECTED.r2Status) bad.push('r2-visibility');
  return bad;
}

export function ghGet(path) {
  if (!/^[A-Za-z0-9_./-]+$/.test(path)) throw new Error('bad path');
  return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

export async function probeStatus(url) {
  try {
    return (await fetch(url, { method: 'GET', redirect: 'manual' })).status;
  } catch {
    return 0;
  }
}

/** Status of an anonymous tag list of the image: 200 only when the package is public. */
export async function probeGhcr(fetchFn = fetch) {
  try {
    const { token } = await (await fetchFn(GHCR_TOKEN_URL)).json();
    return (await fetchFn(GHCR_TAGS_URL, { headers: { Authorization: `Bearer ${token}` } })).status;
  } catch {
    return 0;
  }
}

export async function run({ get = ghGet, probe = probeStatus, ghcr = probeGhcr } = {}) {
  const failing = [];
  for (const [key, spec] of Object.entries(REPOS)) {
    for (const n of evaluate(gather(get, spec.repo, spec), spec)) failing.push(`${key}:${n}`);
  }
  for (const n of evaluateExternal({ ghcrStatus: await ghcr(), r2Status: await probe(R2_PROBE_URL) })) failing.push(`external:${n}`);
  return failing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failing = await run();
  for (const n of failing) console.log(`FAIL ${n}`);
  if (failing.length) process.exit(1);
  console.log('ci settings ok');
}
