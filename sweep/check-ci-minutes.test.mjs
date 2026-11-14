import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reading, verdict, median } from './check-ci-minutes.mjs';

const SCRIPT = fileURLToPath(new URL('./check-ci-minutes.mjs', import.meta.url));
const T0 = Date.parse('2026-11-13T10:00:00Z');
const iso = (secs) => new Date(T0 + secs * 1000).toISOString();
// A run whose jobs start `wait` s after it was created and last `mins` minutes each.
const run = ({ jobs = 10, mins = 5, wait = 60, wall = 600, code = true } = {}) => ({
  createdAt: iso(0),
  updatedAt: iso(wall),
  jobs: [
    ...(code ? [{ name: 'Static binary (x86_64)', conclusion: 'success', startedAt: iso(wait), completedAt: iso(wait + mins * 60) }] : []),
    ...Array.from({ length: jobs - 1 }, (_, i) => ({ name: `job ${i}`, conclusion: 'success', startedAt: iso(wait), completedAt: iso(wait + mins * 60) })),
    { name: 'skipped one', conclusion: 'skipped', startedAt: null, completedAt: null },
  ],
});

test('a run reads as job-minutes, wall minutes and the longest runner wait; a run without code is no reading', () => {
  const r = reading(run({ jobs: 10, mins: 5, wait: 90, wall: 660 }));
  assert.deepEqual({ ...r, minutes: Math.round(r.minutes) }, { wallMin: 11, minutes: 50, queueSecs: 90 });
  assert.equal(reading(run({ code: false })), null);
});

test('the median passes inside every limit and fails over each one, and no reading fails', () => {
  const five = (o) => Array.from({ length: 5 }, () => reading(run(o)));
  assert.equal(verdict(five({ jobs: 10, mins: 5, wait: 60, wall: 600 })), true);
  assert.equal(verdict(five({ jobs: 20, mins: 5 })), false, 'job-minutes: 100');
  assert.equal(verdict(five({ wall: 720 })), false, 'wall: 12 min');
  assert.equal(verdict(five({ wait: 400 })), false, 'queue: 400 s');
  assert.equal(verdict([]), false);
  assert.equal(median([1, 9, 2]), 2);
});

test('one outlier does not fail the median', () => {
  const rs = [run(), run(), run(), run({ jobs: 40 }), run({ wall: 2000 })].map(reading);
  assert.equal(verdict(rs), true);
});

// A stand-in `gh` that lists `runs` pull-request runs and returns the same run for each `view`.
function sweep(o, runs = 6) {
  const dir = mkdtempSync(join(tmpdir(), 'minutes-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh
case "$1" in
  run) case "$2" in
    list) echo '${JSON.stringify(Array.from({ length: runs }, (_, i) => ({ databaseId: i + 1, displayTitle: 'CI · PR #1 · abc' })))}' ;;
    view) echo '${JSON.stringify(run(o))}' ;;
  esac ;;
esac
`);
  chmodSync(gh, 0o755);
  return spawnSync('node', [SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SWEEP_GH_REPO: 'o/r' } }).status;
}

test('the check passes on normal runs and fails by exit status on a seeded oversize, with no output', () => {
  assert.equal(sweep({}), 0);
  assert.equal(sweep({ jobs: 30, mins: 5 }), 1);
  assert.equal(sweep({ wait: 500 }), 1);
  assert.equal(sweep({}, 0), 1);
});
