import test from "node:test";
import assert from "node:assert/strict";
import { readGreen, isGreen } from "./green.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
// The real shape: a ci-repo run of ci.yaml on main, started by repository_dispatch; head_sha is the CI repo's own commit.
const run = (o = {}) => ({ id: 1, event: "repository_dispatch", head_branch: "main", head_sha: "c".repeat(40), path: ".github/workflows/ci.yaml@refs/heads/main",
  display_title: `CI · push · ${SHA}`, status: "completed", conclusion: "success", created_at: "2026-11-25T10:00:00Z", ...o });
const ok = [{ name: "changes", conclusion: "success" }, { name: "CI result", conclusion: "success" }];

test("a dispatched ci run of main whose title names the commit and whose CI result job passed is green", () => {
  assert.deepEqual(readGreen({ sha: SHA, runs: [run()], jobs: ok }), { green: true, reason: "", run: 1 });
});

test("a run for another source commit does not count", () => {
  const r = readGreen({ sha: SHA, runs: [run({ display_title: `CI · push · ${OTHER}` })], jobs: ok });
  assert.equal(r.green, false);
});

test("a pull-request run of the same commit never counts", () => {
  const r = readGreen({ sha: SHA, runs: [run({ display_title: `CI · PR #7 · ${SHA}` })], jobs: ok });
  assert.equal(r.green, false);
});

test("a run on another branch, another event or another workflow does not count", () => {
  for (const o of [{ head_branch: "feat/x" }, { event: "push" }, { path: ".github/workflows/other.yaml@refs/heads/main" }, { path: undefined }]) {
    assert.equal(readGreen({ sha: SHA, runs: [run(o)], jobs: ok }).green, false, JSON.stringify(o));
  }
});

test("a successful run whose CI result job did not succeed is not green, however many other jobs passed", () => {
  const jobs = [{ name: "changes", conclusion: "success" }, { name: "ci", conclusion: "success" }, { name: "CI result", conclusion: "skipped" }];
  assert.equal(readGreen({ sha: SHA, runs: [run()], jobs }).green, false);
  assert.equal(readGreen({ sha: SHA, runs: [run()], jobs: [] }).green, false);
});

test("the newest run decides: a red rerun after a green run is red", () => {
  const runs = [run({ id: 1 }), run({ id: 2, conclusion: "failure", created_at: "2026-11-25T11:00:00Z" })];
  assert.equal(readGreen({ sha: SHA, runs, jobs: ok }).green, false);
});

test("a run still going is not green; a bad sha is not green", () => {
  assert.equal(readGreen({ sha: SHA, runs: [run({ status: "in_progress", conclusion: null })], jobs: ok }).green, false);
  assert.equal(readGreen({ sha: "main", runs: [run()], jobs: ok }).green, false);
});

test("isGreen reads the jobs of the chosen run only and no status", async () => {
  const calls = [];
  const api = { runs: async () => [run({ id: 9 })], jobs: async (id) => { calls.push(id); return ok; } };
  assert.equal((await isGreen(api, SHA)).green, true);
  assert.deepEqual(calls, [9]);
  const none = await isGreen({ runs: async () => [], jobs: async () => assert.fail("no run, no jobs") }, SHA);
  assert.equal(none.green, false);
});
