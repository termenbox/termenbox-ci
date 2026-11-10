#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './check-repo-structure.mjs';

// Every workflow job that reads a repository secret other than GITHUB_TOKEN declares `environment:`, so the
// secret can live in a GitHub Environment with a branch policy instead of repository scope. A reusable-workflow
// caller that passes secrets (`secrets: inherit` or a `secrets:` map) must call a local workflow that has a job
// with an environment (or one that reads no secret at all: it can then gain none without the job rule above firing,
// and its copy in the ci repo reads the source-read token the caller must pass on), and no composite action or
// workflow-level block reads a secret.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Secrets that live at repository scope in this repo: the list the settings check pins (repo-structure.json). Every other
// secret must sit in an Environment.
export const REPO_LEVEL = new Set(loadConfig().repos['termenbox-ci'].secrets);
const SECRET_REF = /(?<![\w.-])secrets(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[)/g;

/** Secret names read in `text` other than GITHUB_TOKEN and the repository-level ones (`*` for an indexed read); comment lines are ignored. */
export function secretReads(text) {
  const names = new Set();
  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    for (const m of raw.matchAll(SECRET_REF)) if (m[1] !== 'GITHUB_TOKEN' && !REPO_LEVEL.has(m[1])) names.add(m[1] ?? '*');
  }
  return [...names];
}

/** `{ head, jobs }`: the lines before `jobs:` and each job (`name`, `text`) split at two-space keys. */
export function splitJobs(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (at < 0) return { head: text, jobs: [] };
  const jobs = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) jobs.push({ name: m[1], lines: [] });
    else if (jobs.length) jobs[jobs.length - 1].lines.push(line);
  }
  return { head: lines.slice(0, at).join('\n'), jobs: jobs.map((j) => ({ name: j.name, text: j.lines.join('\n') })) };
}

const hasEnvironment = (text) => /^ {4}environment:\s*\S/m.test(text);
const callee = (text) => /^ {4}uses:\s*(\.\/\.github\/workflows\/[^\s#]+)/m.exec(text)?.[1];
const passesSecrets = (text) =>
  /^ {4}secrets:\s*inherit\s*(#.*)?$/m.test(text) || /^ {4}secrets:\s*(#.*)?$/m.test(text);

/** Problems in one workflow file; `read(path)` returns the text of another local workflow or undefined. */
export function checkWorkflow(file, text, read = () => undefined) {
  const problems = [];
  const { head, jobs } = splitJobs(text);
  for (const name of secretReads(head)) problems.push(`${file}: workflow-level block reads secret ${name}`);
  for (const job of jobs) {
    const reads = secretReads(job.text);
    if (reads.length && !hasEnvironment(job.text)) {
      problems.push(`${file}: job ${job.name} reads ${reads.join(', ')} without an environment`);
    }
    const target = callee(job.text);
    if (target && passesSecrets(job.text)) {
      const body = read(target);
      if (body === undefined) problems.push(`${file}: job ${job.name} passes secrets to missing ${target}`);
      else if (secretReads(body).length > 0 && !splitJobs(body).jobs.some((j) => hasEnvironment(j.text))) {
        problems.push(`${file}: job ${job.name} passes secrets to ${target}, which has no job with an environment`);
      }
    }
  }
  return problems;
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ya?ml$/.test(name)) out.push(full);
  }
  return out;
}

export function checkRepo(root = REPO_ROOT) {
  const problems = [];
  const read = (rel) => {
    const p = join(root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
  for (const full of walk(process.env.TERMENBOX_WORKFLOWS_DIR || join(root, '.github/workflows'))) {
    const rel = relative(root, full);
    problems.push(...checkWorkflow(rel, readFileSync(full, 'utf8'), read));
  }
  for (const full of walk(join(root, '.github/actions'))) {
    for (const name of secretReads(readFileSync(full, 'utf8'))) {
      problems.push(`${relative(root, full)}: composite action reads secret ${name}`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkRepo();
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log('check-job-environments: every secret-reading job declares an environment');
}
