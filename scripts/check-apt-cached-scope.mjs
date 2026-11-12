// node scripts/check-apt-cached-scope.mjs : the apt-cached action installs .deb files restored from the Actions cache without
// apt's signature check, and every workflow here shares the default branch's cache scope, so a job that runs source or
// dependency code could plant what a later job installs as root. No release, deploy, publish or signing workflow may use it.
// Prints file and line only.
import { readdirSync, readFileSync } from "node:fs";

const PROTECTED = /^(release-.*|deploy-.*|publish-wiki|docs-media.*|security-sweep)\.ya?ml$/;
export function aptCachedProblems(name, text) {
  if (!PROTECTED.test(name)) return [];
  const problems = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(-\s*)?uses:\s*\S*actions\/apt-cached(@|\s|$)/.test(line)) problems.push([i + 1, "a release, deploy, publish or signing workflow uses the apt-cached action"]);
  });
  return problems;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../.github/workflows/", import.meta.url);
  let bad = 0;
  for (const f of readdirSync(dir)) {
    for (const [line, msg] of aptCachedProblems(f, readFileSync(new URL(f, dir), "utf8"))) { console.log(`${f}:${line}: ${msg}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
}
