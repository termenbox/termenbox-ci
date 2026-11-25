import test from "node:test";
import assert from "node:assert/strict";
import { cadence, format } from "./meters.mjs";

const H = 3600e3;
const D0 = Date.parse("2026-11-10T00:00:00Z");
const at = (h) => D0 + h * H;
const now = at(7 * 24);
const win = { now, windowMs: 7 * 24 * H };

test("under 3 counted slots is UNKNOWN", () => {
  const r = cadence({ merges: [at(30)], stables: [at(37)], ...win });
  assert.equal(r.counted, 1);
  assert.equal(r.verdict, "UNKNOWN");
});

test("every counted slot reaching stable within 8h passes", () => {
  const merges = [at(25), at(31), at(37), at(43)]; // slots cut at 30, 36, 42, 48
  const stables = [at(33), at(39), at(45), at(51)];
  const r = cadence({ merges, stables, ...win });
  assert.equal(r.counted, 4);
  assert.equal(r.passed, 4);
  assert.equal(r.p90LeadHours, 8);
  assert.equal(r.verdict, "PASS");
});

test("a slot with no change on develop is not counted", () => {
  const r = cadence({ merges: [at(25)], stables: [], ...win });
  assert.equal(r.counted, 1);
  assert.equal(r.passed, 0);
});

test("slots that miss the 8h reach fail", () => {
  const merges = [at(25), at(31), at(37)];
  const stables = [at(60)];
  const r = cadence({ merges, stables, ...win });
  assert.equal(r.counted, 3);
  assert.equal(r.passed, 0);
  assert.equal(r.verdict, "FAIL");
});

test("a long p90 lead fails although slots pass", () => {
  const merges = [at(25), at(31), at(37), at(43)];
  const stables = [at(33), at(39), at(45), at(51)];
  const r = cadence({ merges: merges.map((m) => m - 0), stables: stables.map((t) => t + 5 * H), ...win });
  assert.equal(r.p90LeadHours, 13);
  assert.equal(r.verdict, "FAIL");
});

test("the baseline of 2 stable releases in 8 days fails", () => {
  const n = Date.parse("2026-11-24T00:00:00Z");
  const t = (s) => Date.parse(s);
  const merges = [t("2026-11-15T09:00:00Z"), t("2026-11-16T03:00:00Z"), t("2026-11-18T10:00:00Z"), t("2026-11-19T09:00:00Z"), t("2026-11-22T10:00:00Z")];
  const stables = [t("2026-11-16T12:00:00Z"), t("2026-11-20T12:00:00Z")];
  const r = cadence({ merges, stables, now: n, windowMs: 8 * 24 * H });
  assert.equal(r.stableReleases, 2);
  assert.equal(r.verdict, "FAIL");
  assert.match(format(r), /^release-cadence counted=\d+ passed=\d+ stable=2 /);
});
