import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countsStep, evaluate, evaluateDetailed, gitIn, lockVersionBumpOnly, pathsOfNameStatus, reviewOnly, schemaIssues } from './check-security-review.mjs';

const GOOD = {
  reviewed_commit: 'abc1234',
  last_delta_review: '2026-11-01',
  last_full_walk: '2026-11-01',
  existential_open: 0,
  trust_ending_open: 0,
  fix_release: false,
};
const git = (changed = [], extra = {}) => ({ isAncestor: () => true, changedFiles: () => changed, edgeGlobsAt: () => [], lastCountsChange: () => null, ...extra });
// The latest change to the counts file, as the git reader reports it.
const change = (counts, previous, files = []) => ({ lastCountsChange: () => ({ counts: { ...GOOD, ...counts }, previous: { ...GOOD, ...previous }, files }) });
const run = (counts, extra = {}) =>
  evaluate({ counts: { ...GOOD, ...counts }, edgeGlobs: ['packages/server/src/main.rs', '.github/workflows/**'], commit: 'def5678', today: '2026-11-03', git: git(), ...extra });

describe('check-security-review', () => {
  it('lets a closed, current review publish', () => {
    assert.deepEqual(run({}), []);
  });

  it('release_refused_with_open_finding', () => {
    assert.notEqual(run({ existential_open: 1 }).length, 0);
    assert.notEqual(run({ trust_ending_open: 2 }).length, 0);
  });

  it('release_refused_when_edges_changed_since_review', () => {
    const issues = run({}, { git: git(['README.md', '.github/workflows/ci.yaml']) });
    assert.match(issues.join('\n'), /edge file/);
    assert.deepEqual(run({}, { git: git(['README.md']) }), []);
  });

  it('release_refused_when_reviewed_commit_is_not_an_ancestor', () => {
    const issues = run({}, { git: { isAncestor: () => false, changedFiles: () => [] } });
    assert.match(issues.join('\n'), /not an ancestor/);
  });

  it('release_refused_on_stale_walk', () => {
    assert.notEqual(run({ last_full_walk: '2026-07-01' }).length, 0);
    assert.deepEqual(run({ last_full_walk: '2026-07-27' }), []);
  });

  it('fix_release_passes_only_with_flag', () => {
    assert.notEqual(run({ existential_open: 1, fix_release: false }).length, 0);
    const flagged = { existential_open: 1, fix_release: true };
    const fix = { git: git([], change(flagged, { existential_open: 2 })) };
    assert.deepEqual(run(flagged, fix), []);
    assert.notEqual(run({ existential_open: null, fix_release: true }, { git: git([], change({ existential_open: null, fix_release: true }, { existential_open: 2 })) }).length, 0);
  });

  it('fix_release_ignored_without_a_decrement', () => {
    const flagged = { existential_open: 1, fix_release: true };
    // The flag was set by a commit that lowered nothing, or raised a count.
    for (const previous of [{ existential_open: 1 }, { existential_open: 0 }]) {
      const res = evaluateDetailed({ counts: { ...GOOD, ...flagged }, edgeGlobs: [], commit: 'def5678', today: '2026-11-03', git: git([], change(flagged, previous)) });
      assert.notEqual(res.issues.length, 0);
      assert.match(res.notes.join('\n'), /fix_release is ignored/);
    }
    // The file was just created, so no count was lowered.
    assert.notEqual(run(flagged, { git: git([], { lastCountsChange: () => ({ counts: { ...GOOD, ...flagged }, previous: null, files: [] }) }) }).length, 0);
    // The commit that lowered a count is not the latest change: the file in hand differs from it.
    assert.notEqual(run(flagged, { git: git([], change({ ...flagged, trust_ending_open: 1 }, { existential_open: 2 })) }).length, 0);
    assert.notEqual(run(flagged, { git: git([], { lastCountsChange: () => null }) }).length, 0);
  });

  it('fix_release_waives_only_flagged_files', () => {
    const flagged = { existential_open: 1, fix_release: true };
    const edge = { edgeGlobs: ['packages/server/src/main.rs', 'packages/server/src/auth.rs'] };
    const g = (changed) => git(changed, change(flagged, { existential_open: 2 }, ['packages/server/src/main.rs']));
    assert.deepEqual(run(flagged, { ...edge, git: g(['packages/server/src/main.rs']) }), []);
    assert.match(run(flagged, { ...edge, git: g(['packages/server/src/main.rs', 'packages/server/src/auth.rs']) }).join('\n'), /edge file/);
    // It waives nothing else: a stale walk and a foreign reviewed commit still refuse.
    assert.notEqual(run({ ...flagged, last_full_walk: '2026-01-01' }, { git: g([]) }).length, 0);
    assert.match(run(flagged, { git: { ...g([]), isAncestor: (a, b) => b === 'refs/remotes/origin/master' } }).join('\n'), /reviewed commit is not an ancestor/);
  });

  it('release_off_master_refused', () => {
    const off = { ...git(), isAncestor: (a) => a !== 'refs/remotes/origin/master' };
    assert.match(run({}, { git: off }).join('\n'), /origin\/master/);
    assert.deepEqual(run({}), []);
  });

  it('edge globs are the union of the list at the reviewed commit and at the release commit', () => {
    const only = { edgeGlobs: ['a/**'] };
    assert.deepEqual(run({}, { ...only, git: git(['old/removed.rs']) }), []);
    const issues = run({}, { ...only, git: git(['old/removed.rs'], { edgeGlobsAt: (rev) => (rev === 'abc1234' ? ['old/**'] : []) }) });
    assert.match(issues.join('\n'), /edge file/);
    assert.match(run({}, { ...only, git: git(['a/new.rs']) }).join('\n'), /edge file/);
  });

  it('the counts file itself is not an edge file', () => {
    assert.deepEqual(run({}, { edgeGlobs: ['docs/**'], git: git(['docs/security-review.json']) }), []);
  });

  it('counts_file_has_no_free_text', () => {
    assert.match(schemaIssues({ ...GOOD, note: 'a long description' }).join('\n'), /unknown key "note"/);
    assert.notEqual(schemaIssues({ ...GOOD, reviewed_commit: 'the fix for the thing' }).length, 0);
    assert.notEqual(schemaIssues({ ...GOOD, last_full_walk: 'yesterday' }).length, 0);
    assert.notEqual(schemaIssues({ ...GOOD, existential_open: '1 open' }).length, 0);
    assert.deepEqual(schemaIssues(GOOD), []);
  });

  it('release_refused_when_an_edge_file_was_moved_and_edited', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-gate-'));
    const git = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
    try {
      git('init', '-q');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/auth.rs'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD').stdout.trim();
      mkdirSync(join(root, 'src/auth'));
      renameSync(join(root, 'src/auth.rs'), join(root, 'src/auth/mod.rs'));
      writeFileSync(join(root, 'src/auth/mod.rs'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
      git('add', '-A');
      git('commit', '-qm', 'move');
      const head = git('rev-parse', 'HEAD').stdout.trim();
      const changed = gitIn(root).changedFiles(base, head);
      assert.ok(changed.includes('src/auth.rs'), `the old path is listed: ${changed}`);
      const issues = evaluate({ counts: { ...GOOD, reviewed_commit: base.slice(0, 12) }, edgeGlobs: ['src/auth.rs'], commit: head, today: '2026-11-05', git: gitIn(root) });
      assert.match(issues.join('\n'), /edge file\(s\) changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('both paths of a rename or copy are listed, with or without an edit', () => {
    assert.deepEqual(pathsOfNameStatus('M\0a.rs\0R087\0src/auth.rs\0src/auth/mod.rs\0C100\0x\0y\0A\0z\0'), ['a.rs', 'src/auth.rs', 'src/auth/mod.rs', 'x', 'y', 'z']);
    assert.deepEqual(pathsOfNameStatus(''), []);
  });

  it('release_refused_when_an_edge_file_was_moved_unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-gate-'));
    const g = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
    try {
      g('init', '-q');
      writeFileSync(join(root, 'edge.rs'), 'a\nb\nc\nd\n');
      g('add', '.');
      g('commit', '-qm', 'base');
      const base = g('rev-parse', 'HEAD').stdout.trim();
      renameSync(join(root, 'edge.rs'), join(root, 'moved.rs'));
      g('add', '-A');
      g('commit', '-qm', 'move');
      const head = g('rev-parse', 'HEAD').stdout.trim();
      const issues = evaluate({ counts: { ...GOOD, reviewed_commit: base.slice(0, 12) }, edgeGlobs: ['edge.rs'], commit: head, today: '2026-11-05', git: gitIn(root) });
      assert.match(issues.join('\n'), /edge file\(s\) changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the counts check of step 0.1 must be present, and a refusal or a missing script stops the release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-counts-'));
    try {
      const absent = countsStep(dir);
      assert.equal(absent.ok, false);
      assert.match(absent.note, /not installed/);
      writeFileSync(join(dir, 'check-security-counts.mjs'), 'process.exit(process.env.COUNTS_RESULT === "fail" ? 1 : 0);\n');
      assert.deepEqual(countsStep(dir, { ...process.env, COUNTS_RESULT: 'ok' }), { ok: true, note: null });
      assert.equal(countsStep(dir, { ...process.env, COUNTS_RESULT: 'fail' }).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a delta review keeps the fix release it follows', () => {
  const v = (o) => ({ reviewed_commit: 'aaaaaaa', last_delta_review: '2026-11-05', last_full_walk: '2026-11-03', existential_open: 3, trust_ending_open: 1, fix_release: true, ...o });

  it('reviewOnly accepts a move of the markers and nothing else', () => {
    assert.equal(reviewOnly(v(), v({ reviewed_commit: 'bbbbbbb', last_delta_review: '2026-11-07' })), true);
    assert.equal(reviewOnly(v(), v({ existential_open: 4 })), false, 'a raised count ends the chain');
    assert.equal(reviewOnly(v(), v({ existential_open: 2 })), false, 'a lowered count is the ordinary rule, not this one');
    assert.equal(reviewOnly(v(), v({ fix_release: false })), false);
    assert.equal(reviewOnly(v({ fix_release: false }), v()), false, 'a flag cannot be set by a review');
    assert.equal(reviewOnly(null, v()), false);
  });

  it('a carried flag waives no file', () => {
    const flagged = { existential_open: 1, fix_release: true };
    const edge = { edgeGlobs: ['packages/server/src/auth.rs'] };
    const files = ['packages/server/src/auth.rs'];
    const carried = { lastCountsChange: () => ({ counts: { ...GOOD, ...flagged }, previous: { ...GOOD, ...flagged }, files, carried: true }) };
    const lowered = change(flagged, { existential_open: 2 }, files);
    assert.deepEqual(run(flagged, { ...edge, git: git(files, lowered) }), [], 'the lowering commit waives its own files');
    assert.match(run(flagged, { ...edge, git: git(files, carried) }).join('\n'), /edge file/, 'a carried flag does not');
    assert.deepEqual(run(flagged, { git: git([], carried) }), [], 'it still lets a closed-edge release publish');
  });

  it('the git walk carries the flag over reviews to the change that lowered a count, and not past any other edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-review-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const commit = (counts, msg) => {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs/security-review.json'), JSON.stringify(counts));
      git('add', '-A');
      git('commit', '-q', '-m', msg);
    };
    git('init', '-q', '-b', 'main');
    commit(v({ existential_open: 5, fix_release: false }), 'start');
    commit(v({ existential_open: 3 }), 'lowers and flags');
    const g = gitIn(dir);
    assert.equal(g.lastCountsChange('HEAD').carried, false, 'the ordinary rule applies to the change that lowered');
    commit(v({ reviewed_commit: 'bbbbbbb', last_delta_review: '2026-11-07' }), 'review one');
    assert.equal(g.lastCountsChange('HEAD').carried, true);
    commit(v({ reviewed_commit: 'ccccccc', last_delta_review: '2026-11-09' }), 'review two');
    assert.equal(g.lastCountsChange('HEAD').carried, true);
    commit(v({ reviewed_commit: 'ddddddd', existential_open: 4 }), 'review that raises a count');
    assert.equal(g.lastCountsChange('HEAD').carried, false);
    commit(v({ reviewed_commit: 'eeeeeee', existential_open: 4 }), 'review after the raise');
    assert.equal(g.lastCountsChange('HEAD').carried, false, 'the raise ended the chain; only a lowered count restores it');
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('a version bump of a workspace package in Cargo.lock', () => {
  const lock = (ver, extra = '') => `[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aa"\n\n[[package]]\nname = "termenbox-server"\nversion = "${ver}"\ndependencies = [\n "serde",${extra}\n]\n`;

  it('is accepted when only the version went up', () => {
    assert.equal(lockVersionBumpOnly(lock('0.1.58'), lock('0.1.59')), true);
    assert.equal(lockVersionBumpOnly(lock('0.1.9'), lock('0.2.0')), true);
  });

  it('is refused for every other change, whatever sits beside the bump', () => {
    assert.equal(lockVersionBumpOnly(lock('0.1.58'), lock('0.1.58')), false, 'no change');
    assert.equal(lockVersionBumpOnly(lock('0.1.59'), lock('0.1.58')), false, 'a downgrade');
    assert.equal(lockVersionBumpOnly(lock('0.1.58'), lock('0.1.59', '\n "evil",')), false, 'a new dependency');
    assert.equal(lockVersionBumpOnly(lock('0.1.58'), lock('0.1.59').replace('checksum = "aa"', 'checksum = "bb"')), false, 'a checksum');
    assert.equal(lockVersionBumpOnly(lock('0.1.58'), lock('0.1.59').replace('version = "1.0.1"', 'version = "1.0.2"')), false, 'a registry crate');
    assert.equal(lockVersionBumpOnly(lock('0.1.58'), lock('0.1.59').replace('termenbox-server', 'termenbox-other').replace('"serde",', '"serde",')), false, 'a rename beside it');
    assert.equal(lockVersionBumpOnly(null, lock('0.1.59')), false, 'a missing file');
  });

  it('is refused when the source key is not next to the version, or is spelled loosely', () => {
    const odd = (v, src) => `[[package]]\nname = "termenbox-fake"\nversion = "${v}"\nchecksum = "aa"\n${src}\n`;
    for (const src of ['source = "registry+x"', 'source="registry+x"', ' source = "registry+x"']) assert.equal(lockVersionBumpOnly(odd('1.0.0', src), odd('1.0.1', src)), false, src);
  });

  it('is refused for a registry crate that carries a termenbox- name', () => {
    const reg = (v) => `[[package]]\nname = "termenbox-fake"\nversion = "${v}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aa"\n`;
    assert.equal(lockVersionBumpOnly(reg('1.0.0'), reg('1.0.1')), false);
  });

  it('lets the gate pass a Cargo.lock edge change only when the reader says it is a bump', () => {
    const edge = (bump) => run({}, { edgeGlobs: ['Cargo.lock'], git: git(['Cargo.lock'], { lockVersionBumpOnly: () => bump }) });
    assert.deepEqual(edge(true), []);
    assert.match(edge(false).join('\n'), /edge file/);
    assert.match(run({}, { edgeGlobs: ['Cargo.lock'], git: git(['Cargo.lock']) }).join('\n'), /edge file/);
  });

  it('does not excuse any other edge file changed beside it', () => {
    const issues = run({}, { edgeGlobs: ['Cargo.lock', 'packages/server/src/main.rs'], git: git(['Cargo.lock', 'packages/server/src/main.rs'], { lockVersionBumpOnly: () => true }) });
    assert.match(issues.join('\n'), /edge file/);
  });

  it('the git reader accepts the real bump of this repository and refuses a changed checksum', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockbump-'));
    try {
      const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
      g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
      const l = (v, c) => `[[package]]\nname = "termenbox-server"\nversion = "${v}"\n\n[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "registry+x"\nchecksum = "${c}"\n`;
      writeFileSync(join(root, 'Cargo.lock'), l('0.1.58', 'aa')); g('add', '.'); g('commit', '-qm', 'a');
      writeFileSync(join(root, 'Cargo.lock'), l('0.1.59', 'aa')); g('commit', '-qam', 'b');
      writeFileSync(join(root, 'Cargo.lock'), l('0.1.59', 'bb')); g('commit', '-qam', 'c');
      assert.equal(gitIn(root).lockVersionBumpOnly('HEAD~2', 'HEAD~1'), true);
      assert.equal(gitIn(root).lockVersionBumpOnly('HEAD~2', 'HEAD'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
