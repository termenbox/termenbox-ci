#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretReads, splitJobs } from './check-job-environments.mjs';

// GUARDRAIL no-shell-without-a-user-factor, rule 4 (`fork_pr_cannot_reach_a_secret`): a workflow that a pull request,
// a fork, an issue or a comment can start does not read a deploy or signing secret (any secret but GITHUB_TOKEN) and
// does not hold a write token, unless the job is guarded: it runs only on a trusted event, or its first step checks the
// actor's permission, or it needs a job whose first step does. A fork's `pull_request` token is read-only and gets no
// secrets, so for that one trigger only secrets are checked; the other triggers run with the repository's own token.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UNTRUSTED = new Set([
  'pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment', 'issues',
  'issue_comment', 'fork', 'discussion', 'discussion_comment', 'watch', 'workflow_run',
]);
const READ_ONLY_FOR_FORKS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);

/** Event names in the `on:` block, in any of its three spellings. */
export function triggers(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^['"]?on['"]?:/.test(l));
  if (at < 0) return [];
  const rest = lines[at].replace(/^['"]?on['"]?:\s*/, '').replace(/\s+#.*$/, '');
  if (rest.startsWith('[')) return rest.replace(/[[\]\s]/g, '').split(',').filter(Boolean);
  if (rest) return [rest];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l) && !/^\s*#/.test(l)) break;
    const m = /^ {2}([a-z_]+):/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The workflow names a `workflow_run` trigger follows, from its `workflows:` list in either spelling. */
function followed(text) {
  const m = /^ {2}workflow_run:\s*\n((?: {4,}.*\n?)*)/m.exec(text);
  const w = m && /^ {4}workflows:[ \t]*(.*)$((?:\n {6}- .*)*)/m.exec(m[1]);
  if (!w) return [];
  const raw = w[1].trim() ? w[1].replace(/^\[|\]$/g, '').split(',') : w[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return raw.map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/**
 * `workflow_run` with a `branches:` filter only follows runs on those (maintainer-only) branches; one that follows only
 * workflows no untrusted event can start (`trusted`: their names) is as trusted as they are.
 */
function untrustedTriggers(text, trusted = new Set()) {
  return triggers(text).filter((t) => {
    if (!UNTRUSTED.has(t)) return false;
    if (t !== 'workflow_run') return true;
    const m = /^ {2}workflow_run:\s*\n((?: {4,}.*\n?)*)/m.exec(text);
    if (m && /^ {4}branches:/m.test(m[1])) return false;
    const names = followed(text);
    return !(names.length && names.every((n) => trusted.has(n)));
  });
}

/** Steps of a job as text blocks, split at the `      - ` list items. */
function stepsOf(jobText) {
  const at = jobText.search(/^ {4}steps:\s*$/m);
  if (at < 0) return [];
  const steps = [];
  for (const line of jobText.slice(at).split('\n').slice(1)) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length) steps[steps.length - 1].push(line);
  }
  return steps.map((s) => s.join('\n'));
}

const checksActor = (step) => /collaborators\/[^\n]*\/permission/.test(step);
const needsOf = (jobText) => {
  const m = /^ {4}needs:\s*(.*)$/m.exec(jobText);
  if (!m) return [];
  if (m[1].trim()) return m[1].replace(/[[\]\s]/g, '').split(',').filter(Boolean);
  return [...jobText.matchAll(/^ {6}- ([\w-]+)\s*$/gm)].map((x) => x[1]);
};
const onlyTrustedEvent = (jobText) => {
  const cond = /^ {4}if:\s*(.*)$/m.exec(jobText)?.[1] ?? '';
  return /github\.event_name\s*==\s*'(workflow_dispatch|schedule|push)'/.test(cond) && !/\|\|/.test(cond);
};

/** True when the job cannot run for an untrusted actor: a trusted event only, an actor check as first step, or a guarded `needs`. */
function guarded(job, jobs, seen = new Set()) {
  if (seen.has(job.name)) return false;
  seen.add(job.name);
  if (onlyTrustedEvent(job.text)) return true;
  const first = stepsOf(job.text)[0];
  if (first && checksActor(first)) return true;
  return needsOf(job.text).some((n) => {
    const dep = jobs.find((j) => j.name === n);
    return dep && guarded(dep, jobs, seen);
  });
}

/** Blocks of `permissions:` (at `indent` spaces) as text; `write-all` counts as a write. */
function writes(text, indent) {
  const pad = ' '.repeat(indent);
  const m = new RegExp(`^${pad}permissions:[ \\t]*(\\S.*)?$((?:\\n${pad} {2,}\\S.*)*)`, 'm').exec(text);
  if (!m) return undefined;
  return /write-all/.test(m[1] ?? '') || /:\s*write\b/.test(m[2] ?? '');
}

/** Problems in one workflow file. */
export function checkWorkflow(file, text, trusted = new Set()) {
  const bad = untrustedTriggers(text, trusted);
  if (!bad.length) return [];
  const forksOnlyRead = bad.every((t) => READ_ONLY_FOR_FORKS.has(t));
  const { head, jobs } = splitJobs(text);
  const problems = [];
  const via = bad.join(', ');
  for (const name of secretReads(head)) problems.push(`${file}: workflow-level block reads secret ${name} and ${via} can start it`);
  const topWrite = writes(head, 0);
  for (const job of jobs) {
    if (guarded(job, jobs)) continue;
    const reads = secretReads(job.text);
    if (reads.length) problems.push(`${file}: job ${job.name} reads ${reads.join(', ')} unguarded and ${via} can start it`);
    if (/^ {4}secrets:/m.test(job.text)) problems.push(`${file}: job ${job.name} passes secrets on unguarded and ${via} can start it`);
    const own = writes(job.text, 4);
    if (!forksOnlyRead && (own ?? topWrite)) problems.push(`${file}: job ${job.name} holds a write token unguarded and ${via} can start it`);
  }
  return problems;
}

/** Names of the workflows that no untrusted event can start (a `workflow_run` one counts as untrusted, whatever it follows). */
export function trustedNames(files) {
  const out = new Set();
  for (const text of files) {
    const name = /^name:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/^['"]|['"]$/g, '');
    if (name && !untrustedTriggers(text).length) out.add(name);
  }
  return out;
}

export function checkRepo(root = REPO_ROOT) {
  const dir = process.env.TERMENBOX_WORKFLOWS_DIR || join(root, '.github/workflows'); // the ci repo's workflows when TERMENBOX_WORKFLOWS_DIR names a checkout of it
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).map((n) => [n, readFileSync(join(dir, n), 'utf8')]);
  const trusted = trustedNames(files.map(([, t]) => t));
  return files.flatMap(([n, t]) => checkWorkflow(`.github/workflows/${n}`, t, trusted));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkRepo();
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log('check-workflow-secrets: no untrusted trigger reaches a secret or an unguarded write token');
}
