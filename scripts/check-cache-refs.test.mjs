import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCacheRefs } from "./check-cache-refs.mjs";

test("a registry build cache ref without the channel is rejected", () => {
  const bad = "  cache-from: type=registry,ref=r/img-cache:${{ matrix.arch }}";
  const ok = "  cache-from: type=registry,ref=r/img-cache:${{ needs.plan.outputs.channel }}-${{ matrix.arch }}";
  assert.equal(checkCacheRefs(bad).length, 1);
  assert.deepEqual(checkCacheRefs(ok), []);
  assert.deepEqual(checkCacheRefs("  cache-from: type=gha"), []);
});
