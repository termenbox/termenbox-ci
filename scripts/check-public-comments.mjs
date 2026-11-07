// node scripts/check-public-comments.mjs : this repo is public, so a workflow comment must not name a decision, fact, guardrail,
// plan or finding of the private source. Prints the file and line, never anything else; exits 1 when one is found.
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../.github/workflows/", import.meta.url);
const INTERNAL = /docs\/plans\/|DECISION-\d|FACT-\d|GUARDRAIL|SR-\d{4}-\d|(?:decisions?|facts?) \d{4}|private source/i;
let bad = 0;
for (const f of readdirSync(dir)) {
  // a comment run is read as one text, so a name wrapped over two lines ("decision" / "0212") is found too
  let run = "", start = 0;
  const flush = () => { if (run && INTERNAL.test(run)) { console.log(`${f}:${start}: a comment names something internal`); bad++; } run = ""; };
  readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("#")) { if (!run) start = i + 1; run += " " + line.replace(/^\s*#\s?/, ""); } else flush();
  });
  flush();
}
process.exit(bad ? 1 : 0);
