import assert from "node:assert/strict";
import { test } from "node:test";
import { retiredReads } from "./check-retired-tokens.mjs";

test("a read of a retired token is found with its line", () => {
  assert.deepEqual(retiredReads("a: 1\n  GH_TOKEN: ${{ secrets.MIRROR_TOKEN }}\n"), [2]);
  assert.deepEqual(retiredReads("x: ${{ secrets.SWEEP_TOKEN }}"), [1]);
});
test("app keys and the tokens that stay are not found", () => {
  assert.deepEqual(retiredReads("${{ secrets.PUBLISHER_APP_KEY }}\n${{ secrets.GHCR_TOKEN }}\n${{ secrets.SWEEP_READ_TOKEN }}\n"), []);
});
