import test from "node:test";
import assert from "node:assert/strict";
import { aptCachedProblems } from "./check-apt-cached-scope.mjs";

const USES = "      - uses: termenbox/termenbox-ci/.github/actions/apt-cached@c793fdd572460ac87af14956e6676e4c1dac25f6\n";
test("a release workflow may not use apt-cached", () => {
  assert.equal(aptCachedProblems("release-build.yaml", USES).length, 1);
  assert.equal(aptCachedProblems("publish-wiki.yaml", USES).length, 1);
  assert.equal(aptCachedProblems("deploy-site.yaml", USES).length, 1);
});
test("a test workflow may", () => {
  assert.deepEqual(aptCachedProblems("ci.yaml", USES), []);
});
test("a mention in a comment is not a use", () => {
  assert.deepEqual(aptCachedProblems("release-build.yaml", "      # not apt-cached here\n"), []);
});
