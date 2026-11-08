// node scripts/check-public-comments.mjs : this repo is public, so what it says must not name a decision, fact, guardrail,
// plan, review number or finding of the private source. A workflow is read for its comments; the scripts, the Worker and the
// checks are read whole, because a docstring or an error message ships as much as a comment does. Prints the file and line,
// never anything else; exits 1 when one is found.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const INTERNAL = /docs\/plans\/|DECISION-\d|FACT-\d|GUARDRAIL|SR-\d{4}-\d|(?:decisions?|facts?) \d{4}|private source/i;
const REVIEW_NUMBER = /\bR\d{2,3}\b/;
// review numbers (R36) are read in the scripts only: the workflows are generated from the source, which owns their comments
export const names = (text, review = true) => INTERNAL.test(text) || (review && REVIEW_NUMBER.test(text));

// the lines of a text that name something internal; a comment run is read as one text, so a name wrapped over two lines
// ("decision" / "0212") is found too
export function commentHits(text, review = true) {
  const hits = [];
  let run = "", start = 0;
  const flush = () => { if (run && names(run, review)) hits.push(start); run = ""; };
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("#")) { if (!run) start = i + 1; run += " " + line.replace(/^\s*#\s?/, ""); } else flush();
  });
  flush();
  return hits;
}
export const wholeHits = (text) => text.split("\n").flatMap((line, i) => (names(line) ? [i + 1] : []));

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("../", import.meta.url);
  const list = (dir, keep = () => true) => (existsSync(new URL(dir, root)) ? readdirSync(new URL(dir, root)).filter(keep).map((f) => dir + f) : []);
  const own = (f) => !/^check-public-comments(\.test)?\.mjs$/.test(f);
  const whole = [...list(".github/scripts/"), "worker/index.js", ...list("scripts/", (f) => own(f) && /\.(mjs|py|sh)$/.test(f))];
  let bad = 0;
  const report = (file, line, what) => { console.log(`${file}:${line}: ${what}`); bad++; };
  for (const f of list(".github/workflows/")) {
    for (const line of commentHits(readFileSync(new URL(f, root), "utf8"), false)) report(f, line, "a comment names something internal");
  }
  for (const f of whole) {
    const text = readFileSync(new URL(f, root), "utf8");
    for (const line of new Set([...commentHits(text), ...wholeHits(text)])) report(f, line, "names something internal");
  }
  process.exit(bad ? 1 : 0);
}
