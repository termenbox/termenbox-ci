// node scripts/check-approval-jobs.mjs : one review per run. The channel Environments (stable, beta) hold secrets and a
// branch policy but no reviewer, so every job of a workflow that can be started directly and that uses one of them (by
// name or through an expression) must, through `needs`, depend on a job that uses an `approve-*` Environment, and an
// `approve-*` job must reference no secret. A workflow that is only ever called (workflow_call) is covered by its caller.
// Scheduled read-only probes are listed below. Prints file, job and the reason, never anything else.
import { readdirSync, readFileSync } from "node:fs";

export const EXEMPT = new Set(["check-deploy-token-scope.yaml", "secret-check.yaml", "token-check.yaml"]);
const PLAIN = /^(site|cloud|docs|smoke|nightly)$/;

export function parseJobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = { name: m[1], line: i + 1, body: [] }; jobs.push(cur); continue; }
    if (/^\S/.test(l)) break;
    if (cur) cur.body.push(l);
  }
  for (const j of jobs) {
    const body = j.body.join("\n");
    const env = /^    environment:\s*(.+?)\s*$/m.exec(body);
    j.env = env ? env[1].replace(/^['"]|['"]$/g, "") : null;
    const needs = [];
    const inline = /^    needs:[ \t]+(\S.*?)[ \t]*$/m.exec(body);
    if (inline) needs.push(...inline[1].replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean));
    else {
      const block = /^    needs:\s*\n((?:      - .+\n?)+)/m.exec(body);
      if (block) needs.push(...block[1].split("\n").map((s) => s.replace(/^\s*-\s*/, "").trim()).filter(Boolean));
    }
    j.needs = needs;
    j.usesSecret = /secrets\./.test(body);
  }
  return jobs;
}

const isApproval = (j) => j.env !== null && /^approve-/.test(j.env);
const needsChannel = (j) => j.env !== null && !isApproval(j) && !PLAIN.test(j.env) && !/^['"]?$/.test(j.env);

export function approvalProblems(text) {
  const out = [];
  const jobs = parseJobs(text);
  const byName = new Map(jobs.map((j) => [j.name, j]));
  for (const j of jobs) if (isApproval(j) && j.usesSecret) out.push([j.line, j.name, "an approval job references a secret"]);
  const direct = /^\s{2}(repository_dispatch|workflow_dispatch|schedule|push|pull_request):/m.test(text.split(/^jobs:/m)[0]);
  if (!direct) return out;
  const reaches = (j, seen = new Set()) => j.needs.some((n) => {
    const d = byName.get(n);
    if (!d || seen.has(n)) return false;
    seen.add(n);
    return isApproval(d) || reaches(d, seen);
  });
  for (const j of jobs) if (needsChannel(j) && !reaches(j)) out.push([j.line, j.name, "uses a channel Environment without needing an approval job"]);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../.github/workflows/", import.meta.url);
  let bad = 0;
  for (const f of readdirSync(dir)) {
    if (EXEMPT.has(f)) continue;
    for (const [line, job, msg] of approvalProblems(readFileSync(new URL(f, dir), "utf8"))) { console.log(`${f}:${line}: job ${job} ${msg}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}
