// node --test scripts/full-ci.test.mjs : the `full-ci` job of release-stable.yaml, run against a stand-in `gh` that serves a list of
// runs. A green manual run of main for the commit passes at once; a red one stops the release and starts nothing; one in progress
// is waited for; none starts a run; a run that ends red or cancelled fails the job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const text = readFileSync(new URL('../.github/workflows/release-stable.yaml', import.meta.url), 'utf8');
const block = text.slice(text.indexOf('\n  full-ci:\n'));
const script = block.split(/^        run: \|\n/m)[1].split(/^\n {2}# /m)[0].replace(/^ {10}/gm, '');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (id, sha, status, conclusion) => ({ databaseId: id, displayTitle: `CI · manual · ${sha}`, createdAt: '2026-01-01T00:00:00Z', status, conclusion });

function go(runs, watchRc = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fullci-'));
  const log = join(dir, 'log');
  writeFileSync(join(dir, 'gh'), `#!/bin/bash
case "$1 $2" in
  "run list") while [ $# -gt 0 ]; do [ "$1" = --jq ] && { expr=$2; break; }; shift; done; printf '%s' "$RUNS_JSON" | jq -c "$expr" ;;
  "workflow run") echo started >> "$LOG" ;;
  "run watch") echo "watch $3" >> "$LOG"; exit ${watchRc} ;;
esac
`);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'sleep'), 0o755);
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHA, LOG: log, RUNS_JSON: JSON.stringify(runs) } });
  return { rc: r.status, out: r.stdout + r.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('a green full run of the commit passes and starts nothing', () => {
  const r = go([run(1, SHA, 'completed', 'success')]);
  assert.equal(r.rc, 0);
  assert.equal(r.log, '');
});

test('a red full run of the commit stops the release and starts nothing', () => {
  const r = go([run(2, SHA, 'completed', 'failure')]);
  assert.equal(r.rc, 1);
  assert.match(r.out, /red \(run 2\)/);
  assert.equal(r.log, '');
});

test('a run in progress is waited for, not started twice', () => {
  const r = go([run(3, SHA, 'in_progress', null)]);
  assert.equal(r.rc, 0);
  assert.equal(r.log, 'watch 3\n');
});

test('a run that ends red or cancelled fails the job', () => {
  assert.equal(go([run(3, SHA, 'in_progress', null)], 1).rc, 1);
});

test('a run of another commit does not count, and no run found after the start fails', () => {
  const r = go([run(4, OTHER, 'completed', 'success')]);
  assert.equal(r.rc, 1);
  assert.equal(r.log, 'started\n');
});

test('only runs of main are read, and the watch is slow', () => {
  assert.match(script, /--branch main/);
  assert.match(script, /gh run watch "\$id" -i 30 /);
});
