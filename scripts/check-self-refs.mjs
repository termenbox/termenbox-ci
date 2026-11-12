// node scripts/check-self-refs.mjs [base] : every reference of this repository to its own actions and workflows names one
// and the same full commit, and that commit is on the base branch (default origin/main), so every job runs the same
// reviewed copy of the shared actions and release scripts and none runs an older one that was since fixed. The fix for
// a failure is `node scripts/bump-self-refs.mjs <commit of main>`. Prints file, line and commit, never anything else;
// exits 1 when the references differ, a reference is not a full commit, or the commit is not on the base branch.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { files, selfRefs } from "./self-refs.mjs";

const FULL = /^[0-9a-f]{40}$/;

// Problems found in [{ file, line, ref }], given isAncestor(sha) -> boolean. Returns printable lines.
export function problems(refs, isAncestor) {
  const out = [];
  for (const r of refs) if (!FULL.test(r.ref)) out.push(`${r.file}:${r.line}: a self-reference is not a full commit`);
  const shas = [...new Set(refs.map((r) => r.ref).filter((s) => FULL.test(s)))];
  if (shas.length > 1) {
    for (const s of shas) {
      const first = refs.find((r) => r.ref === s);
      out.push(`${first.file}:${first.line}: self-references name ${shas.length} commits; ${s} is one of them`);
    }
  }
  for (const s of shas) if (!isAncestor(s)) out.push(`self-reference commit ${s} is not on the base branch`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] || "origin/main";
  const root = new URL("../", import.meta.url);
  const refs = files(root).flatMap((u) => {
    const file = fileURLToPath(u).slice(fileURLToPath(root).length);
    return selfRefs(readFileSync(u, "utf8")).map((r) => ({ file, ...r }));
  });
  const isAncestor = (sha) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, base], { cwd: fileURLToPath(root), stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const bad = problems(refs, isAncestor);
  for (const line of bad) console.log(line);
  process.exit(bad.length ? 1 : 0);
}
