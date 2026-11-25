import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GATE_DIR, countsAuthorIssues, gateScript, runGate } from './gate.mjs';
import { evaluateDetailed } from './gate/check-security-review.mjs';

const who = { owners: ['owner'], recorders: ['recorder[bot]'] };
const counts = { reviewed_commit: 'aaaaaaaa', last_delta_review: '2026-11-24', last_full_walk: '2026-11-20', existential_open: 0, trust_ending_open: 0, fix_release: false };
const git = (anc) => ({ isAncestor: (a, b) => anc.some(([x, y]) => x === a && y === b), changedFiles: () => [], edgeGlobsAt: () => [] });
const input = (g) => ({ counts, edgeGlobs: [], commit: 'cand', today: '2026-11-25', git: g });

test('a normal pass: counts by the recorder and a candidate on develop that master can fast-forward to', () => {
  assert.deepEqual(countsAuthorIssues([{ sha: 'abcdef012', pr: { merged_by: 'recorder[bot]' } }], who), []);
  const g = git([['origin/master', 'cand'], ['cand', 'origin/develop'], ['aaaaaaaa', 'cand']]);
  assert.deepEqual(evaluateDetailed(input(g)).issues, []);
});

test('a candidate not yet on master passes: master is its ancestor and it is on develop', () => {
  const g = git([['origin/master', 'cand'], ['cand', 'origin/develop'], ['aaaaaaaa', 'cand']]);
  assert.equal(g.isAncestor('cand', 'origin/master'), false);
  assert.deepEqual(evaluateDetailed(input(g)).issues, []);
});

test('a candidate that master cannot fast-forward to, or that is off develop, is refused', () => {
  const noFf = evaluateDetailed(input(git([['cand', 'origin/develop'], ['aaaaaaaa', 'cand']]))).issues;
  assert.match(noFf.join('\n'), /master cannot fast-forward/);
  const off = evaluateDetailed(input(git([['origin/master', 'cand'], ['aaaaaaaa', 'cand']]))).issues;
  assert.match(off.join('\n'), /not on origin\/develop/);
});

test('a count lowered by another author followed by a marker commit by the recorder is refused', () => {
  const issues = countsAuthorIssues([
    { sha: '1111111111', pr: { merged_by: 'writer' } },
    { sha: '2222222222', pr: { merged_by: 'recorder[bot]' } },
  ], who);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^11111111: .*writer/);
  assert.equal(countsAuthorIssues([{ sha: '3333333333', pr: null }], who).length, 1);
});

test('a candidate that edits a gate script is judged by the ci repo copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  mkdirSync(join(dir, 'scripts'));
  // the candidate replaces its own copy of every gate script with one that always passes
  for (const f of ['check-security-review.mjs', 'check-security-surface.mjs', 'check-security-counts.mjs']) writeFileSync(join(dir, 'scripts', f), 'process.exit(0);\n');
  execFileSync('git', ['init', '-q', dir]);
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 1, stdout: 'refused' }; };
  const res = runGate({ candidateDir: dir, sha: 'cand', commits: [], ...who, run });
  assert.equal(res.ok, false);
  assert.equal(calls[0].args[0], join(GATE_DIR, 'check-security-review.mjs'));
  assert.ok(!calls[0].args[0].startsWith(dir));
  assert.throws(() => gateScript('scripts/evil.mjs', dir), /not a gate script/);
  assert.throws(() => gateScript('check-security-review.mjs', GATE_DIR), /inside the candidate/);
});
