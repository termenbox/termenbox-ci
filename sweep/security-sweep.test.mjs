import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./security-sweep.sh', import.meta.url));

function sweep(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const list = join(dir, 'checks');
  const summary = join(dir, 'summary');
  writeFileSync(list, lines.join('\n') + '\n');
  const r = spawnSync('sh', [SCRIPT, '--list', list], { encoding: 'utf8', env: { ...process.env, SWEEP_SUMMARY: summary } });
  let written = '';
  try { written = readFileSync(summary, 'utf8'); } catch { /* none written */ }
  return { ...r, written };
}

test('a clean sweep prints only the counts and exits 0', () => {
  const r = sweep(['one\ttrue', 'two\ttrue']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'sweep: 2 passed, 0 failed\n');
  assert.equal(r.stderr, '');
});

test('a failing check is reported by name and none of its output reaches the log or the summary', () => {
  const detail = 'DETAIL-THAT-MUST-NOT-APPEAR';
  const r = sweep([
    'pinned-actions\ttrue',
    `seeded-check\techo ${detail}; echo ${detail} >&2; exit 1`,
    'noisy-pass\techo more-detail',
  ]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'sweep: 2 passed, 1 failed\nfailed: seeded-check\n');
  assert.equal(r.stderr, '');
  assert.equal(r.written, r.stdout);
  assert.ok(!(r.stdout + r.stderr + r.written).includes(detail));
  assert.ok(!(r.stdout + r.stderr + r.written).includes('more-detail'));
});

test('every failing check is named and comments are skipped', () => {
  const r = sweep(['# a comment', 'a\tfalse', 'b\ttrue', 'c\tnonexistent-command-xyz']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'sweep: 1 passed, 2 failed\nfailed: a\nfailed: c\n');
});

test('only the report job of the workflow holds the token that can write issues', async () => {
  const { splitJobs } = await import('./check-job-environments.mjs');
  const text = readFileSync(fileURLToPath(new URL('../.github/workflows/security-sweep.yaml', import.meta.url)), 'utf8');
  const jobs = Object.fromEntries(splitJobs(text).jobs.map((j) => [j.name, j.text]));
  assert.ok(jobs.report.includes('secrets.SWEEP_TOKEN'));
  const secretsIn = (t) => [...t.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(secretsIn(jobs.tools), ['SOURCE_TOKEN']);
  assert.ok(!/environment:/.test(jobs.tools), 'the tools job runs source code and so holds no Environment');
  for (const name of ['state', 'sweep']) {
    assert.ok(!jobs[name].includes('secrets.SWEEP_TOKEN'), name);
    assert.ok(jobs[name].includes('secrets.SWEEP_READ_TOKEN'), name);
  }
});

// A stand-in `gh` that answers the three calls of the ci-storage check from environment variables.
function ciStorage({ artifacts, cache, last, before, billing = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh
case "$*" in
  *actions/artifacts*) printf '%s\\n' ${artifacts.map((n) => `'${n}'`).join(' ')} ;;
  *cache/usage*) echo ${cache} ;;
  *billing/usage*) ${billing ? `case "$*" in *month=$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%-m)*) echo ${last} ;; *) echo ${before} ;; esac` : 'exit 1'} ;;
esac
`);
  chmodSync(gh, 0o755);
  const r = spawnSync('sh', [SCRIPT, '--ci-storage'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SWEEP_GH_REPO: 'o/r' } });
  return r.status;
}

test('ci-storage passes inside every limit and without a readable billing API', () => {
  assert.equal(ciStorage({ artifacts: [100, 200], cache: 1e9, last: 100, before: 100 }), 0);
  assert.equal(ciStorage({ artifacts: [100], cache: 1e9, last: 100, before: 1, billing: false }), 0);
});

test('ci-storage fails over each limit', () => {
  assert.equal(ciStorage({ artifacts: [1.5e9, 6e8], cache: 1e9, last: 1, before: 1 }), 1);
  assert.equal(ciStorage({ artifacts: [1], cache: 7.5e9, last: 1, before: 1 }), 1);
  assert.equal(ciStorage({ artifacts: [1], cache: 1, last: 151, before: 100 }), 1);
});

function manifestAge(issued) {
  const host = mkdtempSync(join(tmpdir(), 'dl-'));
  for (const ch of ['stable', 'beta', 'nightly']) {
    mkdirSync(join(host, ch));
    const at = typeof issued === 'function' ? issued(ch) : issued;
    const body = at === null ? '{\n  "version": "1.0.0"\n}\n' : `{\n  "issued_at": ${at},\n  "version": "1.0.0"\n}\n`;
    writeFileSync(join(host, ch, 'manifest.json'), body);
  }
  return spawnSync('sh', [SCRIPT, '--manifest-age'], { encoding: 'utf8', env: { ...process.env, SWEEP_DL_HOST: `file://${host}` } });
}
const daysAgo = (d) => Math.floor(Date.now() / 1000) - d * 86400;

test('manifest-age passes when every channel was signed within the warning window', () => {
  assert.equal(manifestAge(daysAgo(10)).status, 0);
  assert.equal(manifestAge(daysAgo(59)).status, 0);
});

test('manifest-age fails when one channel has 30 days or less left, has no issue time or states a future one', () => {
  assert.equal(manifestAge((ch) => (ch === 'stable' ? daysAgo(61) : daysAgo(1))).status, 1);
  assert.equal(manifestAge((ch) => (ch === 'beta' ? null : daysAgo(1))).status, 1);
  assert.equal(manifestAge(daysAgo(-5)).status, 1);
});

test('--tools names the source tools and fails without a source tree', () => {
  const r = spawnSync('sh', [SCRIPT, '--tools'], { encoding: 'utf8', env: { ...process.env, SWEEP_SOURCE_DIR: '' } });
  assert.equal(r.status, 2);
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  for (const c of ['cargo', 'node', 'sh']) if (c !== 'sh') { writeFileSync(join(bin, c), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, c), 0o755); }
  const q = spawnSync('sh', [SCRIPT, '--tools'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SWEEP_SOURCE_DIR: src, SWEEP_DENY: 'false', SWEEP_FUZZ: 'false', SWEEP_RUST: 'false' } });
  assert.equal(q.stdout, 'sweep: 0 passed, 4 failed\nfailed: cargo-deny\nfailed: pnpm-audit\nfailed: fuzz-bounded\nfailed: preauth-caps\n');
});
