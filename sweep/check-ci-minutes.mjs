#!/usr/bin/env node
// node sweep/check-ci-minutes.mjs : the pull-request runs of ci.yaml do not grow back. Reads the newest successful pull-request
// runs that built code (a docs-only run skips every job) and fails when, as a median over the newest five,
//   the job-minutes are above SWEEP_CI_MINUTES (default 90; the plan's target is 75),
//   the wall time is above SWEEP_CI_WALL_MIN minutes (default 10; the plan's target is 6),
//   or the longest wait of a job for a runner is above SWEEP_CI_QUEUE_SECS seconds (default 360; the plan's target is 60).
// The defaults sit just above the reading of 2026-11-13 so that a regression fails; tighten them with the monthly reading
// (docs/plans/ci-pipeline.md in the source repo, step 5.2). It prints nothing; the exit status is the verdict.
//   SWEEP_GH_REPO  the ci repo (owner/name)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIMITS = { minutes: 90, wallMin: 10, queueSecs: 360 };

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One run from `gh run view --json createdAt,updatedAt,jobs` -> { wallMin, minutes, queueSecs }, or null when it built no code. */
export function reading(run) {
  const ran = (run.jobs ?? []).filter((j) => j.conclusion !== 'skipped' && j.startedAt && j.completedAt);
  if (!ran.some((j) => j.name.startsWith('Static binary'))) return null;
  const at = (s) => Date.parse(s);
  return {
    wallMin: (at(run.updatedAt) - at(run.createdAt)) / 60e3,
    minutes: ran.reduce((n, j) => n + (at(j.completedAt) - at(j.startedAt)) / 60e3, 0),
    queueSecs: Math.max(...ran.map((j) => (at(j.startedAt) - at(run.createdAt)) / 1e3)),
  };
}

/** True when the median of the readings is inside every limit. No reading is a failure: the check must not pass blind. */
export function verdict(readings, limits = LIMITS) {
  if (readings.length === 0) return false;
  return median(readings.map((r) => r.minutes)) <= limits.minutes
    && median(readings.map((r) => r.wallMin)) <= limits.wallMin
    && median(readings.map((r) => r.queueSecs)) <= limits.queueSecs;
}

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

export function main(env = process.env) {
  const repo = env.SWEEP_GH_REPO;
  if (!repo) return 1;
  const limits = {
    minutes: Number(env.SWEEP_CI_MINUTES ?? LIMITS.minutes),
    wallMin: Number(env.SWEEP_CI_WALL_MIN ?? LIMITS.wallMin),
    queueSecs: Number(env.SWEEP_CI_QUEUE_SECS ?? LIMITS.queueSecs),
  };
  try {
    const list = gh('run', 'list', '-R', repo, '--workflow', 'ci.yaml', '--status', 'success', '-L', '30', '--json', 'databaseId,displayTitle');
    const readings = [];
    for (const r of list.filter((x) => x.displayTitle.startsWith('CI · PR'))) {
      const one = reading(gh('run', 'view', String(r.databaseId), '-R', repo, '--json', 'createdAt,updatedAt,jobs'));
      if (one) readings.push(one);
      if (readings.length === 5) break;
    }
    return verdict(readings, limits) ? 0 : 1;
  } catch {
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
