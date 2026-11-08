// node scripts/check-action-refs.mjs : every `uses:` in the workflows and local actions names a full commit, so the code a
// job runs is the code that was reviewed (a branch or tag can move; a token with contents:write can move it). Prints the
// file and line, never anything else; exits 1 when a reference is not a 40-hex commit.
import { readdirSync, readFileSync } from "node:fs";

const roots = [new URL("../.github/workflows/", import.meta.url), ...readdirSync(new URL("../.github/actions/", import.meta.url)).map((d) => new URL(`../.github/actions/${d}/`, import.meta.url))];
const USES = /^\s*-?\s*uses:\s*(\S+)/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
export function unpinned(text) {
  const bad = [];
  text.split("\n").forEach((line, i) => {
    const m = USES.exec(line);
    if (m && !m[1].startsWith("./") && !PINNED.test(m[1])) bad.push(i + 1);
  });
  return bad;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  for (const dir of roots) for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    for (const line of unpinned(readFileSync(new URL(f, dir), "utf8"))) { console.log(`${f}:${line}: a uses: reference is not a full commit`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}
