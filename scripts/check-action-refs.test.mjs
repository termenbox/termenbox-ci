import assert from "node:assert/strict";
import { test } from "node:test";
import { unpinned } from "./check-action-refs.mjs";

const SHA = "a".repeat(40);
test("a full commit passes, a branch, a tag or a short sha does not", () => {
  assert.deepEqual(unpinned(`- uses: x/y@${SHA} # v1\n`), []);
  assert.deepEqual(unpinned("- uses: x/y@main\n- uses: x/y@v4\n- uses: x/y@abc1234\n    uses: x/y/.github/actions/z@main\n"), [1, 2, 3, 4]);
});
test("a local action path is not a reference to a moving ref", () => {
  assert.deepEqual(unpinned("- uses: ./.github/actions/finish\n"), []);
});
