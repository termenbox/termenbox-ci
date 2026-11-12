// The shared parts of check-self-refs.mjs and bump-self-refs.mjs: where this repository's workflows and actions name
// one of its own actions or workflows by commit (termenbox/termenbox-ci/.github/actions/<name>@<sha>).
import { readdirSync } from "node:fs";

export const SELF_REF = /(termenbox\/termenbox-ci\/\.github\/(?:actions|workflows)\/[A-Za-z0-9._\/-]+)@([^\s#'"]+)/g;

// Every workflow and local action file, as URLs.
export function files(root = new URL("../", import.meta.url)) {
  const out = [];
  const wf = new URL(".github/workflows/", root);
  for (const f of readdirSync(wf)) if (/\.ya?ml$/.test(f)) out.push(new URL(f, wf));
  const actions = new URL(".github/actions/", root);
  for (const d of readdirSync(actions)) {
    for (const f of readdirSync(new URL(`${d}/`, actions))) if (/\.ya?ml$/.test(f)) out.push(new URL(`${d}/${f}`, actions));
  }
  return out;
}

// [{ line, ref }] for every self-reference in a text; ref is whatever follows the @.
export function selfRefs(text) {
  const refs = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(SELF_REF)) refs.push({ line: i + 1, ref: m[2] });
  });
  return refs;
}

// The text with every self-reference pointing at sha.
export function bump(text, sha) {
  return text.replace(SELF_REF, (_, path) => `${path}@${sha}`);
}
