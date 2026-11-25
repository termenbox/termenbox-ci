import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaused, mayMove, issueFor, page, PAUSE_VARIABLE } from "./page.mjs";

const fakeApi = () => {
  const issues = [];
  return {
    issues,
    find: async (m) => issues.find((i) => i.body.includes(m)) ?? null,
    create: async (i) => { const n = { ...i, number: issues.length + 1 }; issues.push(n); return n; },
  };
};

test("paused: the pause variable stops the cut and the promotion", async () => {
  const vars = { [PAUSE_VARIABLE]: "true" };
  const get = async (n) => vars[n];
  assert.equal(await isPaused(get), true);
  assert.deepEqual(await mayMove(get), { allowed: false, reason: "paused" });
  vars[PAUSE_VARIABLE] = "";
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
  const r1 = await page(api, a);
  const r2 = await page(api, a);
  const r3 = await page(api, a);
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r3.number, r1.number);
  assert.equal(api.issues.length, 1);
  await page(api, { ...a, cause: "ring-halt" });
  await page(api, { ...a, build: "0.2.4-beta.1" });
  assert.equal(api.issues.length, 3);
});

test("a seeded halt makes exactly one issue", async () => {
  const api = fakeApi();
  const a = { build: "0.2.3-beta.1", ring: 1, cause: "ring-halt", reading: "FAIL", owner: "owner" };
  await page(api, a); await page(api, a);
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
