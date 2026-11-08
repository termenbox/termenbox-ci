import assert from "node:assert/strict";
import { test } from "node:test";
import { commentHits, wholeHits } from "./check-public-comments.mjs";

test("a comment that names a decision, a review number or a guardrail is found", () => {
  assert.deepEqual(commentHits("run: x\n# the alias (decision 0132) moves\nrun: y"), [2]);
  assert.deepEqual(commentHits("# see (R68)\n"), [1]);
  assert.deepEqual(commentHits("# a name wrapped over two lines: decision\n# 0212 here\n"), [1]);
  assert.deepEqual(commentHits("# the guardrail\n"), [1]);
  assert.deepEqual(commentHits("# a workflow (R76 step 5)\n", false), []);
});
test("code that is not a comment is left to the whole-file read", () => {
  assert.deepEqual(commentHits('echo "owner work, decision 0130"\n'), []);
  assert.deepEqual(wholeHits('a\necho "owner work, decision 0130"\n"""R68 docstring"""'), [2, 3]);
});
test("ordinary text is not flagged", () => {
  assert.deepEqual(wholeHits("R2_BUCKET and r1 key, a plain decision, SHA-256\n"), []);
  assert.deepEqual(commentHits("# the public source repo\n"), []);
});
