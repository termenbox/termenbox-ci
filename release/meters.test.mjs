import test from "node:test";
import assert from "node:assert/strict";
import { cadence, format, parseWindow, parseNow } from "./meters.mjs";

const H = 3600e3;
const D0 = Date.parse("2026-11-10T00:00:00Z");
const at = (h) => D0 + h * H;
const now = at(7 * 24);
const win = { now, windowMs: 7 * 24 * H };
// A fake history: a stable "S<n>" contains merges "M<k>" for k <= n (a stable is cut from the newest merge before it).
const num = (x) => Number(x.slice(1));
const contains = (s, m) => num(m) <= num(s);
const M = (h, k) => ({ t: at(h), sha: `M${k}` });
const S = (h, k) => ({ t: at(h), sha: `S${k}` });

test("under 3 counted slots is UNKNOWN", () => {
  const r = cadence({ merges: [M(30, 1)], stables: [S(37, 1)], contains, ...win });
  assert.equal(r.counted, 1);
  assert.equal(r.verdict, "UNKNOWN");
});

test("every counted slot reaching a stable that contains its change within 8h passes", () => {
  const merges = [M(25, 1), M(31, 2), M(37, 3), M(43, 4)]; // slots cut at 30, 36, 42, 48
  const stables = [S(33, 1), S(39, 2), S(45, 3), S(51, 4)];
  const r = cadence({ merges, stables, contains, ...win });
  assert.equal(r.counted, 4);
  assert.equal(r.passed, 4);
  assert.equal(r.verdict, "PASS");
});

test("a stable that is the promotion of the previous slot does not pass the slot it does not contain", () => {
  const merges = [M(25, 1), M(31, 2), M(37, 3), M(43, 4)];
  const stables = [S(33, 0), S(39, 1), S(45, 2), S(51, 3)]; // each is one slot behind
  const r = cadence({ merges, stables, contains, ...win });
  assert.equal(r.counted, 4);
  assert.equal(r.passed, 0);
  assert.equal(r.verdict, "FAIL");
});

test("a lead time pairs a merge with the first stable that contains it, not the next stable", () => {
  const merges = [M(1, 1), M(7, 2), M(13, 3), M(19, 4)];
  const stables = [S(2, 0), S(8, 1), S(14, 2), S(20, 3), S(26, 4)];
  const r = cadence({ merges, stables, contains, now: at(40), windowMs: 40 * H });
  assert.equal(r.p90LeadHours, 7); // M(19,4) waits for S(26,4); each of the others waits 7h too
});

test("a quiet slot is not counted", () => {
  const r = cadence({ merges: [M(25, 1), M(31, 2), M(37, 3)], stables: [S(33, 1), S(39, 2), S(45, 3)], contains, ...win });
  assert.equal(r.counted, 3); // slots at 30, 36 and 42; the slot at 48 saw no merge
});

test("a slot that misses the 8h reach fails", () => {
  const merges = [M(25, 1), M(31, 2), M(37, 3), M(43, 4)];
  const stables = [S(33, 1), S(39, 2), S(45, 3), S(60, 4)];
  const r = cadence({ merges, stables, contains, ...win });
  assert.equal(r.passed, 3);
  assert.equal(r.verdict, "FAIL");
});

test("a long p90 lead fails even when every slot passes", () => {
  // merges 5.5h before each cut, stables 7.9h after it: every slot passes, every lead is 13.4h
  const cuts = [30, 36, 42, 48];
  const merges = cuts.map((c, i) => M(c - 5.5, i + 1));
  const stables = cuts.map((c, i) => S(c + 7.9, i + 1));
  const r = cadence({ merges, stables, contains, ...win });
  assert.equal(r.passed, r.counted);
  assert.ok(r.p90LeadHours > 12);
  assert.equal(r.verdict, "FAIL");
});

test("the baseline of 2 stable releases in 8 days prints counted, passed, stable and verdict", () => {
  const merges = [M(5, 1), M(20, 2), M(40, 3), M(80, 4), M(120, 5)];
  const stables = [S(150, 5), S(180, 5)];
  const r = cadence({ merges, stables, contains, now: at(192), windowMs: 8 * 24 * H });
  assert.equal(r.stableReleases, 2);
  assert.equal(r.verdict, "FAIL");
  assert.match(format(r), /^release-cadence counted=\d+ passed=\d+ stable=2 p90_lead_h=\S+ verdict=FAIL$/);
});

test("--window reads 12h as hours and 7d as days; anything else is an error", () => {
  assert.equal(parseWindow("12h"), 12 * H);
  assert.equal(parseWindow("7d"), 7 * 24 * H);
  for (const bad of ["12", "0d", "7w", "", undefined]) assert.throws(() => parseWindow(bad), /--window/);
});

test("--now that is not a time is an error, not UNKNOWN", () => {
  assert.throws(() => parseNow("yesterday"), /--now/);
  assert.equal(parseNow("2026-11-24T00:00:00Z"), Date.parse("2026-11-24T00:00:00Z"));
});
