// node scripts/bump-self-refs.mjs <commit> : points every reference of this repository to its own actions and workflows
// at one full commit of main. Run it in the commit after a change to .github/actions/ or release/ has merged, with the
// merge commit; check-self-refs.mjs then passes. Prints the files it changed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bump, files } from "./self-refs.mjs";

const sha = process.argv[2] || "";
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error("usage: node scripts/bump-self-refs.mjs <40-hex commit of main>");
  process.exit(2);
}
for (const u of files()) {
  const text = readFileSync(u, "utf8");
  const next = bump(text, sha);
  if (next !== text) { writeFileSync(u, next); console.log(fileURLToPath(u)); }
}
