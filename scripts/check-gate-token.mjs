// node scripts/check-gate-token.mjs : a "Security review gate" step reads the review repo, so it must carry the token
// (GH_TOKEN from REVIEWS_TOKEN) and its job an Environment, which is where that secret lives. A gate without them would
// refuse every release for a reason nobody sees, or be edited into one that does not check. Prints file and line only.
import { readdirSync, readFileSync } from "node:fs";

const TOKEN = /GH_TOKEN:\s*\$\{\{\s*secrets\.REVIEWS_TOKEN\s*\}\}/;
export function gateProblems(text) {
  const lines = text.split("\n");
  const problems = [];
  lines.forEach((line, i) => {
    if (!/^\s*- name: Security review gate\s*$/.test(line)) return;
    let end = i + 1;
    while (end < lines.length && !/^\s*- /.test(lines[end]) && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
    if (!TOKEN.test(lines.slice(i, end).join("\n"))) problems.push([i + 1, "the gate step has no GH_TOKEN from REVIEWS_TOKEN"]);
    let start = i;
    while (start > 0 && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[start])) start--;
    const job = lines.slice(start, i).join("\n");
    if (!/^    environment:/m.test(job)) problems.push([i + 1, "the gate step's job has no environment"]);
  });
  return problems;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../.github/workflows/", import.meta.url);
  let bad = 0;
  for (const f of readdirSync(dir)) {
    for (const [line, msg] of gateProblems(readFileSync(new URL(f, dir), "utf8"))) { console.log(`${f}:${line}: ${msg}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}
