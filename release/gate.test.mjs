import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GATE_DIR, countsAuthorIssues, gateScript, runGate } from './gate.mjs';
import { evaluateDetailed } from './gate/check-security-review.mjs';

const who = { owners: ['owner'], recorders: ['recorder[bot]'] };
const counts = { reviewed_commit: 'aaaaaaaa', last_delta_review: '2026-11-24', last_full_walk: '2026-11-20', existential_open: 0, trust_ending_open: 0, fix_release: false };
const git = (anc) => ({ isAncestor: (a, b) => anc.some(([x, y]) => x === a && y === b), changedFiles: () => [], edgeGlobsAt: () => [] });
const pr = (sha, login) => ({ sha, pr: { merged: true, merged_by: { login }, merge_commit_sha: sha } });
const input = (g) => ({ counts, edgeGlobs: [], commit: 'cand', today: '2026-11-25', git: g });

test('a normal pass: counts by the recorder and a candidate on develop that master can fast-forward to', () => {
  assert.deepEqual(countsAuthorIssues([pr('abcdef012', 'recorder[bot]')], who), []);
  const g = git([['refs/remotes/origin/master', 'cand'], ['cand', 'refs/remotes/origin/develop'], ['aaaaaaaa', 'cand']]);
  assert.deepEqual(evaluateDetailed(input(g)).issues, []);
});

test('a candidate not yet on master passes: master is its ancestor and it is on develop', () => {
  const g = git([['refs/remotes/origin/master', 'cand'], ['cand', 'refs/remotes/origin/develop'], ['aaaaaaaa', 'cand']]);
  assert.equal(g.isAncestor('cand', 'refs/remotes/origin/master'), false);
  assert.deepEqual(evaluateDetailed(input(g)).issues, []);
});

test('a candidate that master cannot fast-forward to, or that is off develop, is refused', () => {
  const noFf = evaluateDetailed(input(git([['cand', 'refs/remotes/origin/develop'], ['aaaaaaaa', 'cand']]))).issues;
  assert.match(noFf.join('\n'), /master cannot fast-forward/);
  const off = evaluateDetailed(input(git([['refs/remotes/origin/master', 'cand'], ['aaaaaaaa', 'cand']]))).issues;
  assert.match(off.join('\n'), /not on origin\/develop/);
});

test('a count lowered by another author followed by a marker commit by the recorder is refused', () => {
  const issues = countsAuthorIssues([
    pr('1111111111', 'writer'),
    pr('2222222222', 'recorder[bot]'),
  ], who);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^11111111: .*writer/);
  assert.equal(countsAuthorIssues([{ sha: '3333333333', pr: null }], who).length, 1);
});

test('a missing list, an unmerged or mismatched pull request and a bare login string are refused', () => {
  assert.match(countsAuthorIssues(undefined, who)[0], /list is missing/);
  assert.equal(countsAuthorIssues([{ sha: 'c'.repeat(40), pr: { merged: false, merged_by: { login: 'owner' }, merge_commit_sha: 'c'.repeat(40) } }], who).length, 1);
  assert.match(countsAuthorIssues([{ sha: 'c'.repeat(40), pr: { merged: true, merged_by: { login: 'owner' }, merge_commit_sha: 'd'.repeat(40) } }], who)[0], /merge commit is not this commit/);
  assert.match(countsAuthorIssues([{ sha: 'c'.repeat(40), pr: { merged: true, merged_by: 'owner', merge_commit_sha: 'c'.repeat(40) } }], who)[0], /merged by nobody/);
});

test('a candidate that edits a gate script is judged by the ci repo copy, and its reasons are printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  mkdirSync(join(dir, 'scripts'));
  // the candidate replaces its own copy of every gate script with one that always passes
  for (const f of ['check-security-review.mjs', 'check-security-surface.mjs', 'check-security-counts.mjs']) writeFileSync(join(dir, 'scripts', f), 'process.exit(0);\n');
  const sha = 'a'.repeat(40);
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return args[0] === 'rev-parse' ? { status: 0, stdout: `${sha}\n` } : { status: 1, stdout: 'refused', stderr: ' because' }; };
  const res = runGate({ candidateDir: dir, sha, commits: [], ...who, run });
  assert.equal(res.ok, false);
  assert.equal(res.output, 'refused because');
  const gate = calls.find((c) => c.cmd === process.execPath);
  assert.equal(gate.args[0], join(GATE_DIR, 'check-security-review.mjs'));
  assert.ok(!gate.args[0].startsWith(dir));
  const pass = runGate({ candidateDir: dir, sha, commits: [], ...who, run: (cmd, args) => (args[0] === 'rev-parse' ? { status: 0, stdout: sha } : { status: 0, stdout: 'ok' }) });
  assert.equal(pass.ok, true);
  assert.throws(() => gateScript('scripts/evil.mjs', dir), /not a gate script/);
  assert.throws(() => gateScript('check-security-review.mjs', GATE_DIR), /inside the candidate/);
});

test('a ref name or a checkout at another commit is refused before any script runs', () => {
  const never = () => { throw new Error('ran'); };
  assert.match(runGate({ candidateDir: '.', sha: 'origin/master', commits: [], ...who, run: never }).issues[0], /40-character/);
  const wrong = runGate({ candidateDir: '.', sha: 'a'.repeat(40), commits: [], ...who, run: () => ({ status: 0, stdout: 'b'.repeat(40) }) });
  assert.match(wrong.issues[0], /not at the candidate sha/);
});
