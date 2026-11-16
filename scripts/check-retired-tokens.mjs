// node scripts/check-retired-tokens.mjs : no workflow or action reads a personal token that a GitHub app replaced
// (DECISION-0254). The secrets themselves are deleted; this stops one from being set again and read by a new step, which
// token-check cannot see because an app token cannot list secrets. Prints file and line only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED = /secrets\.(SOURCE|STATUS|LOG|DISPATCH|MIRROR|DOCS|REVIEWS|SWEEP)_TOKEN\b/;
export function retiredReads(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => { if (RETIRED.test(line)) hits.push(i + 1); });
  return hits;
}
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.ya?ml$/.test(n) ? [p] : [];
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let bad = 0;
  for (const f of walk(".github")) for (const line of retiredReads(readFileSync(f, "utf8"))) { console.log(`${f}:${line}: reads a retired personal token`); bad++; }
  process.exit(bad ? 1 : 0);
}
