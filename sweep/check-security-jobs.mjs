#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitJobs } from './check-job-environments.mjs';

// GUARDRAIL open-security-findings-stay-private-until-fixed, rule 7 (`security_tool_jobs_publish_no_crash_inputs`):
// a job that runs a fuzzer or a dependency, workflow or image audit does not upload crash inputs or its report as an
// artifact, does not upload it as a code-scanning result, and does not post it to a pull request, issue or commit.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = /(?<![\w-])(cargo[ -]fuzz|cargo[ -]audit|cargo[ -]deny|pnpm audit|npm audit|yarn audit|zizmor|actionlint|osv-scanner|trivy|grype|libfuzzer|afl)(?![\w-])|aquasecurity\/trivy-action|rustsec\/audit-check|EmbarkStudios\/cargo-deny-action|zizmorcore\/zizmor-action/i;
const PUBLISH = [
  [/uses:\s*actions\/upload-artifact\b/, 'uploads an artifact'],
  [/uses:\s*github\/codeql-action\/upload-sarif\b/, 'uploads a code-scanning result'],
  [/\bgh\s+(pr|issue)\s+(comment|review|create|edit)\b/, 'posts to a pull request or issue'],
  [/\bgh\s+api\b[^\n]*\/(comments|reviews|statuses|check-runs)\b/, 'posts through the API'],
  [/uses:\s*(actions\/github-script|peter-evans\/[\w-]*comment|marocchino\/sticky-pull-request-comment)\b/, 'can post to a pull request'],
];

/** Problems in one workflow file: a job with a security tool and a way to publish what it prints. */
export function checkWorkflow(file, text) {
  const problems = [];
  for (const job of splitJobs(text).jobs) {
    const body = job.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    if (!TOOL.test(body)) continue;
    for (const [re, what] of PUBLISH) if (re.test(body)) problems.push(`${file}: security tool job ${job.name} ${what}`);
  }
  return problems;
}

export function checkRepo(root = REPO_ROOT) {
  const dir = process.env.TERMENBOX_WORKFLOWS_DIR || join(root, '.github/workflows'); // the ci repo's workflows when TERMENBOX_WORKFLOWS_DIR names a checkout of it
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .flatMap((n) => checkWorkflow(`.github/workflows/${n}`, readFileSync(join(dir, n), 'utf8')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkRepo();
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log('check-security-jobs: no fuzzer or audit job publishes its output');
}
