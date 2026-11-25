import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaused, mayMove, issueFor, page, variableReader, PAUSE_VARIABLE } from "./page.mjs";

const APP = "release-app[bot]";

const fakeApi = (seed = []) => {
  const issues = [...seed];
  return {
    issues,
    search: async (m) => issues.filter((i) => String(i.body).includes(m)),
    create: async (i) => { const n = { ...i, number: issues.length + 1, author: APP }; issues.push(n); return n; },
  };
};

test("paused: the pause variable stops the cut and the promotion", async () => {
  const vars = { [PAUSE_VARIABLE]: "true" };
  const get = async (n) => vars[n];
  assert.equal(await isPaused(get), true);
  assert.deepEqual(await mayMove(get), { allowed: false, reason: "paused" });
  vars[PAUSE_VARIABLE] = "off";
  assert.equal((await mayMove(get)).allowed, true);
  assert.equal((await mayMove(async () => null)).allowed, true);
});

test("paused: a signed freeze variable does not pause", async () => {
  const get = async (n) => (n === "RELEASE_FROZEN" ? "true" : null);
  assert.equal(await isPaused(get), false);
});

test("a repeated cause: one issue per build and cause", async () => {
  const api = fakeApi();
  const a = { build: "0.2.3-beta.1", ring: 0, cause: "hold-missing-reading", reading: "UNKNOWN", owner: "owner" };
  const r1 = await page(api, a, APP);
  const r2 = await page(api, a, APP);
  const r3 = await page(api, a, APP);
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r3.number, r1.number);
  assert.equal(api.issues.length, 1);
  await page(api, { ...a, cause: "ring-halt" }, APP);
  await page(api, { ...a, build: "0.2.4-beta.1" }, APP);
  assert.equal(api.issues.length, 3);
});

test("a seeded halt makes exactly one issue", async () => {
  const api = fakeApi();
  const a = { build: "0.2.3-beta.1", ring: 1, cause: "ring-halt", reading: "FAIL", owner: "owner" };
  await page(api, a, APP); await page(api, a, APP);
  assert.equal(api.issues.length, 1);
  assert.deepEqual(api.issues[0].labels, ["release-page"]);
  assert.deepEqual(api.issues[0].assignees, ["owner"]);
});

test("a finding: the notice says a finding exists and carries none of it", () => {
  const secret = "SECRET-FINDING-TEXT";
  const i = issueFor({ build: "0.2.3-beta.1", ring: 0, cause: "reviewer-finding", reading: "FAIL", finding: secret, text: secret });
  assert.match(i.body, /A finding exists/);
  assert.ok(!JSON.stringify(i).includes(secret));
  assert.throws(() => issueFor({ build: secret + " x y", ring: 0, cause: "reviewer-finding" }));
  assert.throws(() => issueFor({ build: "1.0.0", ring: 0, cause: "other" }));
});

test("paused: the pause fails closed on any value that is not an explicit off", async () => {
  for (const v of ["pause", "stop", "halt", "y", "1", "TRUE", " yes "]) assert.equal(await isPaused(async () => v), true, v);
  for (const v of ["0", "false", "No", "OFF", null, undefined]) assert.equal(await isPaused(async () => v), false, String(v));
});

test("paused: only a 404 means unset; a 403, a 500 or an error refuses the move", async () => {
  const reader = (status, value) => variableReader(async () => ({ status, value }));
  assert.equal((await mayMove(reader(404))).allowed, true);
  assert.deepEqual(await mayMove(reader(200, "true")), { allowed: false, reason: "paused" });
  for (const st of [403, 500]) assert.deepEqual(await mayMove(reader(st)), { allowed: false, reason: "pause unreadable" });
  assert.deepEqual(await mayMove(async () => { throw new Error("network"); }), { allowed: false, reason: "pause unreadable" });
});

test("a repeated cause: an issue by a stranger, or without the label, does not suppress the page", async () => {
  const a = { build: "0.2.3-beta.1", ring: 0, cause: "ring-halt", reading: "FAIL", owner: "owner" };
  const forged = issueFor(a);
  const api = fakeApi([{ ...forged, number: 1, author: "stranger" }, { ...forged, number: 2, author: APP, labels: [] }]);
  const r = await page(api, a, APP);
  assert.equal(r.created, true);
  assert.equal((await page(api, a, APP)).created, false);
});
