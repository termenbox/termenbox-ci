#!/usr/bin/env node
// node sweep/check-ci-minutes.mjs : the pull-request runs of ci.yaml do not grow back. Reads the newest successful pull-request
// runs that built code (a docs-only run skips every job) and fails when, as a median over the newest five,
//   the job-minutes are above SWEEP_CI_MINUTES (default 90),
//   the wall time is above SWEEP_CI_WALL_MIN minutes (default 12),
//   or the longest wait of a job for a runner (its `started_at` minus its `created_at`, the time it was ready) is above
//   SWEEP_CI_QUEUE_SECS seconds (default 240). A job that waits for `needs` is not queued.
// The defaults sit above what pull requests cost when they were set, so that a regression fails and normal runs do not: they are
// limits, not targets. Tighten them with the monthly reading of the pipeline plan. It prints nothing; the exit status is the verdict.
//   SWEEP_GH_REPO  the ci repo (owner/name)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIMITS = { minutes: 90, wallMin: 12, queueSecs: 240 };

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One run -> { wallMin, minutes, queueSecs }, or null when it built no code. `run` is { createdAt, updatedAt } of the run
 *  and `jobs` the REST jobs of it (name, conclusion, created_at, started_at, completed_at). */
export function reading(run) {
  const ran = (run.jobs ?? []).filter((j) => j.conclusion !== 'skipped' && j.started_at && j.completed_at);
  if (!ran.some((j) => j.name.startsWith('Static binary'))) return null;
  const at = (s) => Date.parse(s);
  return {
    wallMin: (at(run.updatedAt) - at(run.createdAt)) / 60e3,
    minutes: ran.reduce((n, j) => n + (at(j.completed_at) - at(j.started_at)) / 60e3, 0),
    queueSecs: Math.max(...ran.map((j) => (at(j.started_at) - at(j.created_at)) / 1e3)),
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
    minutes: Number(env.SWEEP_CI_MINUTES || LIMITS.minutes),
    wallMin: Number(env.SWEEP_CI_WALL_MIN || LIMITS.wallMin),
    queueSecs: Number(env.SWEEP_CI_QUEUE_SECS || LIMITS.queueSecs),
  };
  try {
    const list = gh('run', 'list', '-R', repo, '--workflow', 'ci.yaml', '--status', 'success', '-L', '30', '--json', 'databaseId,displayTitle,createdAt,updatedAt');
    const readings = [];
    for (const r of list.filter((x) => x.displayTitle.startsWith('CI · PR'))) {
      const jobs = gh('api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${r.databaseId}/jobs`).flatMap((page) => page.jobs);
      const one = reading({ createdAt: r.createdAt, updatedAt: r.updatedAt, jobs });
      if (one) readings.push(one);
      if (readings.length === 5) break;
    }
    return verdict(readings, limits) ? 0 : 1;
  } catch {
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
