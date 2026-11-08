import assert from "node:assert/strict";
import { test } from "node:test";
import { gateProblems } from "./check-gate-token.mjs";

const job = (env, step) => `jobs:\n  gate:\n    runs-on: ubuntu-latest\n${env}    steps:\n      - name: Security review gate\n${step}        run: echo\n      - name: next\n        run: echo\n`;
test("a gate with the token and an environment passes", () => {
  assert.deepEqual(gateProblems(job("    environment: beta\n", "        env:\n          GH_TOKEN: ${{ secrets.REVIEWS_TOKEN }}\n")), []);
});
test("a gate without the token fails", () => {
  assert.equal(gateProblems(job("    environment: beta\n", "")).length, 1);
});
test("a gate whose job has no environment fails", () => {
  assert.equal(gateProblems(job("", "        env:\n          GH_TOKEN: ${{ secrets.REVIEWS_TOKEN }}\n")).length, 1);
});
test("a token only in the next step does not count", () => {
  const text = job("    environment: beta\n", "").replace("      - name: next\n        run: echo\n", "      - name: next\n        env:\n          GH_TOKEN: ${{ secrets.REVIEWS_TOKEN }}\n        run: echo\n");
  assert.equal(gateProblems(text).length, 1);
});
