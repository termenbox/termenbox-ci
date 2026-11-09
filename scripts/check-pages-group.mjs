// node scripts/check-pages-group.mjs : every workflow that deploys the client to Pages must run that job in the
// concurrency group `pages-deploy-<channel>`, one name for all of them, so two deployments of a channel never overlap
// (the database migrations and the function secrets run before the upload). Prints file and line only.
import { readdirSync, readFileSync } from "node:fs";

const GROUP = "group: pages-deploy-${{ inputs.channel }}";
export function groupProblems(text) {
  const out = [];
  if (!text.includes("./.github/actions/deploy-pages")) return out;
  if (!text.includes(GROUP)) out.push([1, "a workflow that deploys to Pages lacks the concurrency group pages-deploy-<channel>"]);
  text.split("\n").forEach((l, i) => {
    if (/^\s*group:\s*\S*pages\S*/.test(l) && !l.includes(GROUP)) out.push([i + 1, "another concurrency group name for a Pages deployment"]);
  });
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../.github/workflows/", import.meta.url);
  let bad = 0;
  for (const f of readdirSync(dir)) for (const [line, msg] of groupProblems(readFileSync(new URL(f, dir), "utf8"))) { console.log(`${f}:${line}: ${msg}`); bad++; }
  process.exit(bad ? 1 : 0);
}
