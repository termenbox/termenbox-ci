// node scripts/check-cache-refs.mjs : a registry build cache ref must carry the release channel, so a beta build never
// reads or writes the stable cache. Prints file and line only.
import { readdirSync, readFileSync } from "node:fs";

/** Build-cache refs in a workflow that do not name the channel: [{ line, message }]. */
export function checkCacheRefs(text) {
  const bad = [];
  text.split("\n").forEach((raw, i) => {
    if (!/^\s*cache-(from|to):/.test(raw) || !raw.includes("type=registry")) return;
    if (!/channel/.test(raw)) bad.push({ line: i + 1, message: "registry build cache ref does not carry the release channel" });
  });
  return bad;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../.github/workflows/", import.meta.url);
  let bad = 0;
  for (const f of readdirSync(dir)) {
    for (const b of checkCacheRefs(readFileSync(new URL(f, dir), "utf8"))) { console.log(`${f}:${b.line}: ${b.message}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}
