import test from "node:test";
import assert from "node:assert/strict";
import { approvalProblems } from "./check-approval-jobs.mjs";

const head = "on:\n  workflow_dispatch:\n\njobs:\n";
const approve = "  approve:\n    environment: approve-beta\n    steps:\n      - run: echo ok\n";
test("a gate that needs the approval passes", () => {
  assert.deepEqual(approvalProblems(head + approve + "  gate:\n    needs: approve\n    environment: beta\n"), []);
});
test("a job that needs the approval through another job passes", () => {
  assert.deepEqual(approvalProblems(head + approve + "  gate:\n    needs: approve\n    environment: beta\n  sign:\n    needs: [gate]\n    environment: ${{ inputs.channel }}\n"), []);
});
test("a channel job with no approval above it is named", () => {
  const p = approvalProblems(head + approve + "  sign:\n    environment: beta\n");
  assert.equal(p.length, 1);
  assert.equal(p[0][1], "sign");
});
test("an expression Environment counts as a channel", () => {
  assert.equal(approvalProblems(head + "  freeze:\n    environment: ${{ inputs.channel }}\n").length, 1);
});
test("a block needs list is read", () => {
  assert.deepEqual(approvalProblems(head + approve + "  gate:\n    needs:\n      - approve\n    environment: beta\n"), []);
});
test("an approval job with a secret is named", () => {
  const p = approvalProblems(head + "  approve:\n    environment: approve-beta\n    steps:\n      - run: echo ${{ secrets.X }}\n");
  assert.equal(p[0][2], "an approval job references a secret");
});
test("nightly, site and a workflow that is only called are left alone", () => {
  assert.deepEqual(approvalProblems(head + "  a:\n    environment: nightly\n  b:\n    environment: site\n"), []);
  assert.deepEqual(approvalProblems("on:\n  workflow_call:\n\njobs:\n  sign:\n    environment: ${{ inputs.channel }}\n"), []);
});
test("a job below a skippable job needs a status function", () => {
  const skippable = "  approve:\n    if: ${{ x }}\n    environment: approve-beta\n  plan:\n    needs: approve\n    if: ${{ !cancelled() && (needs.approve.result == 'success' || needs.approve.result == 'skipped') }}\n";
  const bad = approvalProblems(head + skippable + "  build:\n    needs: plan\n    if: needs.plan.outputs.run == 'true'\n");
  assert.deepEqual(bad.map((x) => x[1]), ["build"]);
  assert.deepEqual(approvalProblems(head + skippable + "  build:\n    needs: plan\n    if: ${{ !cancelled() && needs.plan.result == 'success' }}\n"), []);
  const deep = approvalProblems(head + skippable + "  build:\n    needs: plan\n    if: ${{ !cancelled() }}\n  last:\n    needs: build\n    if: needs.build.result == 'success'\n");
  assert.deepEqual(deep.map((x) => x[1]), ["last"]);
});
