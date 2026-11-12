import assert from "node:assert/strict";
import { test } from "node:test";
import { problems } from "./check-self-refs.mjs";
import { bump, selfRefs } from "./self-refs.mjs";

const A = "a".repeat(40), B = "b".repeat(40);
const yes = () => true;
const at = (sha) => `      - uses: termenbox/termenbox-ci/.github/actions/finish@${sha}\n`;
const refs = (text) => selfRefs(text).map((r) => ({ file: "w.yaml", ...r }));

test("self-references are found in uses: lines, other repositories are not", () => {
  const text = at(A) + `      - uses: actions/checkout@${B} # v7\n` + `    uses: termenbox/termenbox-ci/.github/workflows/build.yaml@${A}\n`;
  assert.deepEqual(selfRefs(text), [{ line: 1, ref: A }, { line: 3, ref: A }]);
});
test("one commit on the base branch passes", () => {
  assert.deepEqual(problems(refs(at(A) + at(A)), yes), []);
});
test("a second commit fails and names both", () => {
  const out = problems(refs(at(A) + at(B)), yes);
  assert.equal(out.length, 2);
  assert.match(out[0], /w\.yaml:1: self-references name 2 commits/);
  assert.match(out[1], /w\.yaml:2: .*bbbb/);
});
test("a commit that is not on the base branch fails", () => {
  assert.deepEqual(problems(refs(at(A)), () => false), [`self-reference commit ${A} is not on the base branch`]);
});
test("a branch, tag or short commit fails", () => {
  assert.match(problems(refs(at("main") + at(A)), yes)[0], /w\.yaml:1: a self-reference is not a full commit/);
});
test("bump points every self-reference at one commit and leaves other references alone", () => {
  const other = `      - uses: actions/checkout@${B} # v7\n`;
  const text = at(A) + other + at(B) + at("main");
  assert.equal(bump(text, "c".repeat(40)), at("c".repeat(40)) + other + at("c".repeat(40)) + at("c".repeat(40)));
});
