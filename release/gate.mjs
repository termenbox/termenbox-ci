#!/usr/bin/env node
// Step 2.8 of the staged release flow: the release gate runs from this repo's copy of its scripts (release/gate/),
// never from the candidate checkout and never from master's copy, and a counts change counts only when the pull
// request that produced it was merged by the recorder app or the owner. Every function takes its reads as input so
// the tests need no network. Usage: node release/gate.mjs <candidate-dir> <sha>   (GATE_OWNERS, GATE_RECORDERS: comma lists)
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'gate');
export const GATE_SCRIPTS = ['check-security-review.mjs', 'check-security-surface.mjs', 'check-security-counts.mjs'];
const COUNTS_FILE = 'docs/security-review.json';

/** The path of a gate script in this repo; a candidate path is never a source of one. */
export function gateScript(name, candidateDir) {
  if (!GATE_SCRIPTS.includes(name)) throw new Error(`${name} is not a gate script`);
  const path = resolve(GATE_DIR, name);
  if (candidateDir) {
    const rel = relative(resolve(candidateDir), path);
    if (!rel.startsWith('..') && !rel.split(sep).includes('..')) throw new Error('the gate scripts must not live inside the candidate checkout');
  }
  return path;
}

/**
 * Reasons a counts change is refused. `commits` are the commits that touch the counts file since the last cut, each
 * `{ sha, pr }` where `pr` is `{ merged, merged_by: { login }, merge_commit_sha }` of the pull request that produced it
 * (the GitHub API shape) or null; every one is checked, not only the latest. Only the commit's merged pull request
 * counts, never the commit email, which a develop writer sets. The caller builds the list and where it starts from ci
 * repo state (the last cut recorded here), never from a tag of the source repo, which a writer can move.
 */
export function countsAuthorIssues(commits, { owners, recorders }) {
  if (!Array.isArray(commits)) return ['the counts-commit list is missing: the counts author cannot be checked, so the release is refused'];
  const allowed = new Set([...owners, ...recorders]);
  const issues = [];
  for (const c of commits) {
    const id = String(c.sha).slice(0, 8);
    const login = c.pr?.merged_by?.login;
    if (!c.pr || c.pr.merged !== true) issues.push(`${id}: no merged pull request produced this counts change`);
    else if (c.pr.merge_commit_sha !== c.sha) issues.push(`${id}: the pull request's merge commit is not this commit`);
    else if (typeof login !== 'string' || !allowed.has(login)) issues.push(`${id}: the counts change was merged by ${login ?? 'nobody'}, not the owner or the recorder`);
  }
  return issues;
}

const SHA = /^[0-9a-f]{40}$/;

/** Runs the gate: the counts-author check, then the ci repo's copy of the review script in the candidate checkout. */
export function runGate({ candidateDir, sha, commits, owners, recorders, env = process.env, run = spawnSync }) {
  if (!SHA.test(sha ?? '')) return { ok: false, issues: ['the candidate must be named by its 40-character commit sha'] };
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: candidateDir, encoding: 'utf8' });
  if (head.status !== 0 || String(head.stdout).trim() !== sha) return { ok: false, issues: ['the checkout is not at the candidate sha'] };
  const issues = countsAuthorIssues(commits, { owners, recorders });
  if (issues.length > 0) return { ok: false, issues };
  const res = run(process.execPath, [gateScript('check-security-review.mjs', candidateDir), sha], { cwd: candidateDir, env, encoding: 'utf8' });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return res.status === 0 ? { ok: true, issues: [], output } : { ok: false, issues: ['the security review gate refused the candidate'], output };
}

export { COUNTS_FILE };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidateDir, sha, commitsFile] = process.argv.slice(2);
  if (!candidateDir || !sha) { console.error('usage: gate.mjs <candidate-dir> <sha> [commits.json]'); process.exit(2); }
  const { readFileSync } = await import('node:fs');
  const list = (v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!commitsFile) { console.error('the counts-commit list (commits.json) is required'); process.exit(2); }
  const commits = JSON.parse(readFileSync(commitsFile, 'utf8'));
  const res = runGate({ candidateDir, sha, commits, owners: list(process.env.GATE_OWNERS), recorders: list(process.env.GATE_RECORDERS) });
  for (const i of res.issues) console.error(i);
  if (res.output) console.error(res.output);
  process.exit(res.ok ? 0 : 1);
}
