#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globToRegExp, parseEdges } from './check-security-surface.mjs';

// Guardrail `a-release-needs-its-security-review-closed`: the release gate. Usage:
//   node scripts/check-security-review.mjs <release-commit> [--today YYYY-MM-DD]
// It reads docs/security-review.json and .github/security-edges.txt at the release commit (and the edge list at the
// reviewed commit) and exits non-zero unless the counts are closed, the release commit is on origin/master, the
// reviewed commit is an ancestor, no edge path changed since, and the last full walk is recent. The workflows run
// master's copy of this script. A fix release (fix_release true, set by the latest change to the counts file, which
// lowered an open count, or by delta reviews that only moved the review markers since) may publish with open counts
// and with the files that lowering changed; every other rule holds.

const COUNTS_FILE = 'docs/security-review.json';
const EDGES_FILE = '.github/security-edges.txt';
const LOCK_FILE = 'Cargo.lock';
export const MAX_WALK_AGE_DAYS = 100;
const KEYS = ['reviewed_commit', 'last_delta_review', 'last_full_walk', 'existential_open', 'trust_ending_open', 'fix_release'];
const SHAPES = {
  reviewed_commit: (v) => v === null || (typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v)),
  last_delta_review: (v) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)),
  last_full_walk: (v) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)),
  existential_open: (v) => v === null || (Number.isInteger(v) && v >= 0),
  trust_ending_open: (v) => v === null || (Number.isInteger(v) && v >= 0),
  fix_release: (v) => typeof v === 'boolean',
};

/** Schema problems of the counts file: any other key, or a value of the wrong shape (no free text). */
export function schemaIssues(counts) {
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return ['the counts file is not an object'];
  const issues = [];
  for (const key of Object.keys(counts)) if (!KEYS.includes(key)) issues.push(`unknown key "${key}"`);
  for (const key of KEYS) {
    if (!(key in counts)) issues.push(`missing key "${key}"`);
    else if (!SHAPES[key](counts[key])) issues.push(`"${key}" has a value of the wrong shape`);
  }
  return issues;
}

/**
 * A delta review moves the review markers and nothing else: the blocking counts stay equal and the flag stays set. Such a
 * change keeps the flag valid when the counts change before it was valid (it lowered a count, or was itself such a
 * review), so a review cannot be done without losing the fix release it follows. A raised count, a cleared flag or any
 * other edit ends the chain.
 */
export function reviewOnly(before, now) {
  if (!before || !now || before.fix_release !== true || now.fix_release !== true) return false;
  return before.existential_open === now.existential_open && before.trust_ending_open === now.trust_ending_open;
}

/** True when `now` is a lower count than `before`; a missing or never-counted value never counts as lowered. */
const lowered = (before, now) => Number.isInteger(before) && Number.isInteger(now) && now < before;

/**
 * Decide a release and report why. `git` supplies `isAncestor(a, b)`, `changedFiles(a, b)`, `edgeGlobsAt(rev)` (the
 * edge globs at a revision, empty when the file is missing there) and `lastCountsChange(commit)` (the latest commit
 * that changed the counts file, as `{ counts, previous, files }`, or null). `edgeGlobs` are the globs at the release
 * commit; the list checked is the union of those and the globs at the reviewed commit. Returns `{ issues, notes }`:
 * issues refuse the release, notes only explain how the gate read the file.
 */
export function evaluateDetailed({ counts, edgeGlobs, commit, today, git }) {
  const issues = schemaIssues(counts);
  const notes = [];
  if (issues.length > 0) return { issues, notes };
  // fix_release counts only when the latest change to the counts file set it and lowered an open count.
  let waived = [];
  let fix = false;
  if (counts.fix_release) {
    const change = git.lastCountsChange ? git.lastCountsChange(commit) : null;
    if (!change) notes.push('fix_release is ignored: no commit that changed the counts file was found');
    else if (JSON.stringify(change.counts) !== JSON.stringify(counts)) notes.push('fix_release is ignored: the counts file differs from its latest committed version');
    else if (!change.carried && (!change.previous || !(lowered(change.previous.existential_open, counts.existential_open) || lowered(change.previous.trust_ending_open, counts.trust_ending_open))))
      notes.push('fix_release is ignored: the latest change to the counts file did not lower an open count');
    else {
      fix = true;
      // A flag carried over reviews waives no file: the moved reviewed_commit already covers the fixes, and a review
      // commit may not hide an edge change behind a waiver. Only the commit that lowered the count waives its own files.
      waived = change.carried ? [] : change.files;
    }
  }
  const open = counts.existential_open !== 0 || counts.trust_ending_open !== 0;
  if (open) {
    const unknown = counts.existential_open === null || counts.trust_ending_open === null;
    if (unknown || !fix) issues.push('findings are open or never counted and this is not a fix release');
  }
  // Decision 0282 and 2.8: the gate runs before the cut moves master, so the candidate is not on master yet. Master must be
  // an ancestor of the candidate (a fast-forward is possible) and the candidate must be on develop.
  if (!git.isAncestor('refs/remotes/origin/master', commit)) issues.push('origin/master is not an ancestor of the release commit: master cannot fast-forward to it');
  if (!git.isAncestor(commit, 'refs/remotes/origin/develop')) issues.push('the release commit is not on origin/develop');
  if (counts.reviewed_commit === null) issues.push('no reviewed commit');
  else if (!git.isAncestor(counts.reviewed_commit, commit)) issues.push('the reviewed commit is not an ancestor of the release commit');
  else {
    const atReview = git.edgeGlobsAt ? git.edgeGlobsAt(counts.reviewed_commit) : [];
    const res = [...new Set([...edgeGlobs, ...atReview])].map(globToRegExp);
    const touched = git
      .changedFiles(counts.reviewed_commit, commit)
      .filter((file) => file !== COUNTS_FILE && !waived.includes(file) && res.some((re) => re.test(file)))
      // A version bump of a workspace package in the root lockfile is not a change of what the release depends on.
      .filter((file) => !(file === LOCK_FILE && git.lockVersionBumpOnly?.(counts.reviewed_commit, commit)));
    if (touched.length > 0) issues.push(`${touched.length} edge file(s) changed since the reviewed commit, first: ${touched[0]}`);
  }
  if (counts.last_full_walk === null) issues.push('no full walk on record');
  else {
    const age = (Date.parse(today) - Date.parse(counts.last_full_walk)) / 86_400_000;
    if (!(age <= MAX_WALK_AGE_DAYS)) issues.push(`the last full walk is older than ${MAX_WALK_AGE_DAYS} days`);
  }
  return { issues, notes };
}

/** The reasons the release is refused; an empty list means it may publish. */
export const evaluate = (input) => evaluateDetailed(input).issues;

/** True when the `[[package]]` block holding line `i` has a `source` key anywhere, however it is spaced or ordered. */
function hasSource(lines, i) {
  let from = i;
  while (from > 0 && lines[from] !== '[[package]]') from--;
  for (let k = from + 1; k < lines.length && lines[k] !== '[[package]]' && !/^\[/.test(lines[k]); k++) if (/^\s*source\s*=/.test(lines[k])) return true;
  return false;
}

/**
 * True when two texts of the root Cargo.lock differ only in the `version` of workspace packages (a `termenbox-*` package
 * with no `source` line, so never a registry crate) and each version went up. Same line count, same text elsewhere:
 * a changed checksum, source, dependency list or registry version makes it false.
 */
export function lockVersionBumpOnly(oldText, newText) {
  if (typeof oldText !== 'string' || typeof newText !== 'string') return false;
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length !== b.length) return false;
  const semver = /^version = "(\d+)\.(\d+)\.(\d+)"$/;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const from = semver.exec(a[i]);
    const to = semver.exec(b[i]);
    if (!from || !to || i === 0) return false;
    if (a[i - 1] !== b[i - 1] || !/^name = "termenbox-[a-z0-9-]+"$/.test(b[i - 1])) return false;
    if (hasSource(a, i) || hasSource(b, i)) return false;
    const [x, y] = [from.slice(1).map(Number), to.slice(1).map(Number)];
    const up = x[0] !== y[0] ? y[0] > x[0] : x[1] !== y[1] ? y[1] > x[1] : y[2] > x[2];
    if (!up) return false;
    changed++;
  }
  return changed > 0;
}

/**
 * Paths named by `git diff -M --name-status -z` output: both the old and the new path of a rename or a copy, so a moved
 * edge file counts as changed under either name.
 */
export function pathsOfNameStatus(output) {
  const fields = output.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length && fields[i] !== ''; ) {
    const take = /^[RC]/.test(fields[i]) ? 2 : 1;
    paths.push(...fields.slice(i + 1, i + 1 + take).filter(Boolean));
    i += 1 + take;
  }
  return [...new Set(paths)];
}

/**
 * The counts-file check of step 0.1 (scripts/check-security-counts.mjs), run beside this script. The release
 * workflows copy it from master next to this script; when it is missing the gate refuses (it never skips).
 */
export function countsStep(dir, env = process.env, run = spawnSync) {
  const script = join(dir, 'check-security-counts.mjs');
  if (!existsSync(script)) return { ok: false, note: 'check-security-counts.mjs is not installed next to the gate: the counts cannot be checked, so the release is refused' };
  const res = run(process.execPath, [script], { env, stdio: 'inherit' });
  return res.status === 0 ? { ok: true, note: null } : { ok: false, note: 'check-security-counts.mjs refused the release' };
}

/** Git reads in the repository at `root`; a file missing at a revision reads as null. */
export function gitIn(root) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const show = (rev, path) => {
    try {
      return run(['show', `${rev}:${path}`]);
    } catch {
      return null;
    }
  };
  const json = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const globs = (text) => (text === null ? [] : parseEdges(text).map((edge) => edge.glob));
  return {
    show,
    isAncestor(a, b) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    changedFiles: (a, b) => pathsOfNameStatus(run(['diff', '-M', '--name-status', '-z', `${a}..${b}`])),
    edgeGlobsAt: (rev) => globs(show(rev, EDGES_FILE)),
    lockVersionBumpOnly: (a, b) => lockVersionBumpOnly(show(a, LOCK_FILE), show(b, LOCK_FILE)),
    lastCountsChange(commit) {
      try {
        // The commits that changed the counts file, newest first (at most 20 are read).
        const shas = run(['log', '--first-parent', '-n', '20', '--format=%H', commit, '--', COUNTS_FILE]).trim().split('\n').filter(Boolean);
        if (shas.length === 0) return null;
        const sha = shas[0];
        const counts = json(show(sha, COUNTS_FILE));
        const parent = run(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ')[1];
        if (!parent) return { counts, previous: null, files: pathsOfNameStatus(run(['show', '-M', '--name-status', '-z', '--format=', sha])) };
        const files = pathsOfNameStatus(run(['diff', '-M', '--name-status', '-z', `${parent}..${sha}`]));
        const versions = shas.map((x) => json(show(x, COUNTS_FILE)));
        // Walk back over review-only changes to the change that lowered a count.
        let carried = false;
        for (let i = 0; i + 1 < versions.length; i++) {
          if (lowered(versions[i + 1]?.existential_open, versions[i]?.existential_open) || lowered(versions[i + 1]?.trust_ending_open, versions[i]?.trust_ending_open)) {
            carried = i > 0;
            break;
          }
          if (!reviewOnly(versions[i + 1], versions[i])) break;
        }
        return { counts, previous: versions[1] ?? null, files, carried };
      } catch {
        return null;
      }
    },
  };
}

function main(argv) {
  const commit = argv.find((arg) => !arg.startsWith('--') && argv[argv.indexOf(arg) - 1] !== '--today');
  if (!commit) {
    console.error('usage: check-security-review.mjs <release-commit> [--today YYYY-MM-DD]');
    process.exit(2);
  }
  const at = argv.indexOf('--today');
  const today = at === -1 ? new Date().toISOString().slice(0, 10) : argv[at + 1];
  // The script may run from a copy outside the checkout (the workflows run master's copy): the repository is the
  // current directory, and the counts file and edge list are read from the release commit, not from the work tree.
  const git = gitIn(process.cwd());
  const counts = (() => {
    try {
      return JSON.parse(git.show(commit, COUNTS_FILE));
    } catch {
      return undefined;
    }
  })();
  if (counts === undefined) {
    console.error(`security-review: ${COUNTS_FILE} is missing or not JSON at ${commit}`);
    process.exit(1);
  }
  const edgeText = git.show(commit, EDGES_FILE);
  if (edgeText === null) {
    console.error(`security-review: ${EDGES_FILE} is missing at ${commit}`);
    process.exit(1);
  }
  const edgeGlobs = parseEdges(edgeText).map((edge) => edge.glob);
  const { issues, notes } = evaluateDetailed({ counts, edgeGlobs, commit, today, git });
  for (const note of notes) console.error(`security-review: ${note}`);
  for (const issue of issues) console.error(`security-review: ${issue}`);
  if (issues.length > 0) process.exit(1);
  const counts_ = countsStep(dirname(fileURLToPath(import.meta.url)));
  if (counts_.note) console.error(`security-review: ${counts_.note}`);
  if (!counts_.ok) process.exit(1);
  console.log('security-review: the release may publish');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
