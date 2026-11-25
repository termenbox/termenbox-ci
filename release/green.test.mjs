import test from "node:test";
import assert from "node:assert/strict";
import { readGreen, isGreen } from "./green.mjs";

const SHA = "a".repeat(40);
const run = (o = {}) => ({ id: 1, head_sha: SHA, head_branch: "main", event: "push", path: ".github/workflows/ci.yaml@refs/heads/main", status: "completed", conclusion: "success", created_at: "2026-11-25T10:00:00Z", ...o });
const ok = [{ conclusion: "success" }, { conclusion: "skipped" }];

test("the normal case: a successful push run of main with a job that ran is green", () => {
  assert.equal(readGreen({ sha: SHA, runs: [run()], jobs: ok }).green, true);
});

test("a commit with a success status but a failed ci run is not green", async () => {
  let statusRead = false;
  const api = {
    runs: async () => [run({ conclusion: "failure" })],
    jobs: async () => ok,
    status: async () => { statusRead = true; return "success"; }, // a forged status; the reader must not look at it
  };
  const r = await isGreen(api, SHA);
  assert.equal(r.green, false);
  assert.match(r.reason, /failure/);
  assert.equal(statusRead, false);
});

test("a pull-request run of the same sha with every job skipped is not green", () => {
  const pr = run({ event: "pull_request", head_branch: "feat/x", conclusion: "success" });
  assert.equal(readGreen({ sha: SHA, runs: [pr], jobs: [{ conclusion: "skipped" }] }).green, false);
});

test("a push run whose jobs were all skipped is not green", () => {
  assert.equal(readGreen({ sha: SHA, runs: [run()], jobs: [{ conclusion: "skipped" }] }).green, false);
});

test("the newest run decides: a later failure after an earlier success is red", () => {
  const runs = [run({ id: 1 }), run({ id: 2, conclusion: "failure", created_at: "2026-11-25T11:00:00Z" })];
  assert.equal(readGreen({ sha: SHA, runs, jobs: ok }).green, false);
});

test("a run still going, a run of another branch, another workflow or another sha is not green", () => {
  for (const r of [run({ status: "in_progress", conclusion: null }), run({ head_branch: "feat/x" }), run({ path: ".github/workflows/other.yaml@refs/heads/main" }), run({ head_sha: "b".repeat(40) })]) {
    assert.equal(readGreen({ sha: SHA, runs: [r], jobs: ok }).green, false);
  }
});

test("no sha, a short sha or no run is not green and calls nothing", async () => {
  let called = false;
  const api = { runs: async () => { called = true; return []; }, jobs: async () => ok };
  assert.equal((await isGreen(api, "abc")).green, false);
  assert.equal(called, false);
  assert.equal((await isGreen(api, SHA)).green, false);
});

test("isGreen reads the jobs of the chosen run", async () => {
  const api = { runs: async () => [run({ id: 7 })], jobs: async (id) => (id === 7 ? ok : []) };
  const r = await isGreen(api, SHA);
  assert.equal(r.green, true);
  assert.equal(r.run, 7);
});
