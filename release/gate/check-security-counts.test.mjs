import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestationText, compare, countByTier, stableKeys, verifyAttestation } from './check-security-counts.mjs';

const SCRIPT = fileURLToPath(new URL('./check-security-counts.mjs', import.meta.url));
const issue = (number, ...labels) => ({ number, state: 'open', title: 'withheld', labels: labels.map((name) => ({ name })) });
const ISSUES = [
  issue(1, 'existential'),
  issue(2, 'existential', 'fixed-unreleased'),
  issue(3, 'trust-ending'),
  issue(4, 'ordinary'),
  issue(5),
  { ...issue(6, 'existential'), pull_request: {} },
  { ...issue(7, 'trust-ending'), state: 'closed' },
];

describe('check-security-counts', () => {
  it('counts by tier and keeps fixed-unreleased issues', () => {
    assert.deepEqual(countByTier(ISSUES), { existential_open: 2, trust_ending_open: 1 });
  });
  it('counts nothing for an empty list', () => {
    assert.deepEqual(countByTier([]), { existential_open: 0, trust_ending_open: 0 });
  });
  it('reports only the keys that differ', () => {
    assert.deepEqual(compare({ existential_open: 2, trust_ending_open: 0 }, { existential_open: 2, trust_ending_open: 1 }), ['trust_ending_open: file 0, review repo 1']);
    assert.deepEqual(compare({ existential_open: 2, trust_ending_open: 1 }, { existential_open: 2, trust_ending_open: 1 }), []);
    assert.equal(compare({ existential_open: null }, { existential_open: 0 }).length, 1);
  });
  it('exits non-zero on a mismatch and prints no titles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'counts-'));
    try {
      writeFileSync(join(dir, 'issues.json'), JSON.stringify(ISSUES));
      const run = (counts) => {
        writeFileSync(join(dir, 'counts.json'), JSON.stringify(counts));
        return spawnSync(process.execPath, [SCRIPT, '--issues', join(dir, 'issues.json'), '--counts', join(dir, 'counts.json')], { encoding: 'utf8' });
      };
      const ok = run({ existential_open: 2, trust_ending_open: 1 });
      assert.equal(ok.status, 0);
      const bad = run({ existential_open: 0, trust_ending_open: 0 });
      assert.equal(bad.status, 1);
      assert.ok(!(bad.stdout + bad.stderr).includes('withheld'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the signed attestation stands in for a token-less read', () => {
  const COUNTS = { existential_open: 9, trust_ending_open: 1, fix_release: true };
  const bytes = Buffer.from(JSON.stringify(COUNTS));
  const dir = mkdtempSync(join(tmpdir(), 'attest-test-'));
  const keygen = (name) => {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)]);
    return readFileSync(join(dir, `${name}.pub`), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  };
  const pub = keygen('good');
  const other = keygen('other');
  const sign = (name, text) => {
    writeFileSync(join(dir, `${name}.txt`), text);
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', join(dir, name), '-n', 'termenbox-security-counts', join(dir, `${name}.txt`)]);
    return readFileSync(join(dir, `${name}.txt.sig`));
  };
  const keysText = `bk1 ${pub}\nbn1 ${other} channel=nightly\n`;
  const attest = Buffer.from(attestationText(bytes, COUNTS, '2026-11-08'));
  const sig = sign('good', attest);
  const ok = { countsBytes: bytes, attest, sig, keysText, today: '2026-11-10' };

  it('reads only the stable keys', () => {
    assert.deepEqual(stableKeys(keysText), [pub]);
  });
  it('accepts a fresh attestation of these exact counts', () => {
    verifyAttestation(ok);
  });
  it('refuses a counts file that changed after it was signed', () => {
    const changed = Buffer.from(JSON.stringify({ ...COUNTS, existential_open: 0 }));
    assert.throws(() => verifyAttestation({ ...ok, countsBytes: changed }), /different counts file/);
  });
  it('refuses a signature by a key that is not a pinned stable key', () => {
    assert.throws(() => verifyAttestation({ ...ok, sig: sign('other', attest) }), /not signed by a pinned key/);
  });
  it('refuses an attestation that is stale or from the future', () => {
    assert.throws(() => verifyAttestation({ ...ok, today: '2026-11-30' }), /last 14 days/);
    assert.throws(() => verifyAttestation({ ...ok, today: '2026-11-01' }), /last 14 days/);
  });
  it('refuses when no stable key is pinned', () => {
    assert.throws(() => verifyAttestation({ ...ok, keysText: `bn1 ${other} channel=nightly\n` }), /no stable key/);
  });
  it('the command passes with the attestation and no token, and fails closed without it', () => {
    writeFileSync(join(dir, 'counts.json'), bytes);
    writeFileSync(join(dir, 'a.attest'), attest);
    writeFileSync(join(dir, 'a.attest.sig'), sig);
    writeFileSync(join(dir, 'keys.txt'), keysText);
    const env = { ...process.env, PATH: `${dir}/nogh:${process.env.PATH}`, GH_TOKEN: '', GITHUB_TOKEN: '' };
    const args = [SCRIPT, '--repo', 'invalid/none', '--counts', join(dir, 'counts.json'), '--attest', join(dir, 'a.attest'), '--keys', join(dir, 'keys.txt'), '--today'];
    const run = (today = '2026-11-10') => spawnSync('node', [...args, today], { env, encoding: 'utf8' });
    // `gh` may be logged in on the test machine: the repo above does not exist, so the live read fails either way.
    assert.equal(run().status, 0, run().stderr);
    assert.notEqual(run('2026-12-31').status, 0);
    // a job that holds a token but cannot read is refused even with a valid attestation
    const withToken = spawnSync('node', [...args, '2026-11-10'], { env: { ...env, GH_TOKEN: 'x' }, encoding: 'utf8' });
    assert.notEqual(withToken.status, 0);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
});
