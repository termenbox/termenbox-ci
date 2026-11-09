import test from "node:test";
import assert from "node:assert/strict";
import { groupProblems } from "./check-pages-group.mjs";

const uses = "      - uses: ./.github/actions/deploy-pages\n";
const good = "    concurrency:\n      group: pages-deploy-${{ inputs.channel }}\n";
test("the shared group passes", () => assert.deepEqual(groupProblems(good + uses), []));
test("a second name is named", () => {
  const p = groupProblems("    concurrency:\n      group: deploy-pages-${{ inputs.channel }}\n" + uses);
  assert.deepEqual(p.map((x) => x[1]), ["a workflow that deploys to Pages lacks the concurrency group pages-deploy-<channel>", "another concurrency group name for a Pages deployment"]);
});
test("a workflow that deploys nothing is ignored", () => assert.deepEqual(groupProblems("group: whatever\n"), []));
