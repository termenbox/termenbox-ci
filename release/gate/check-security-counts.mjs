#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Step 0.1 of the public-beta plan. Usage:
//   node scripts/check-security-counts.mjs [--repo OWNER/NAME] [--counts FILE] [--issues FILE]
//   node scripts/check-security-counts.mjs sign KEYFILE        (owner's machine) write the signed attestation
// Counts the open issues of the private review repo by tier label (a `fixed-unreleased` issue still counts) and
// exits non-zero when docs/security-review.json differs. It prints counts only, never titles or bodies.
// `--issues FILE` reads a saved `gh api` issue list instead (tests). The token is the caller's (`GH_TOKEN`).

const COUNTS_FILE = 'docs/security-review.json';
const ATTEST_FILE = 'docs/security-counts.attest';
// the full ref: a tag named origin/master would win over the short name
const KEYS_REF = 'refs/remotes/origin/master:packages/client/bundle-keys.txt';
const NAMESPACE = 'termenbox-security-counts';
const MAX_AGE_DAYS = 14;
const REPO = 'termenbox/termenbox-security';
const TIERS = { existential: 'existential_open', 'trust-ending': 'trust_ending_open' };

const labelNames = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** Counts per counts-file key from a list of issues; pull requests and closed issues are skipped. */
export function countByTier(issues) {
  const counts = Object.fromEntries(Object.values(TIERS).map((key) => [key, 0]));
  for (const issue of issues) {
    if (issue.pull_request || (issue.state && issue.state !== 'open')) continue;
    const names = labelNames(issue);
    for (const [label, key] of Object.entries(TIERS)) if (names.includes(label)) counts[key] += 1;
  }
  return counts;
}

/** Lines naming each count key that differs between the counts file and the real count. */
export function compare(file, real) {
  return Object.keys(real)
    .filter((key) => file?.[key] !== real[key])
    .map((key) => `${key}: file ${file?.[key] ?? 'missing'}, review repo ${real[key]}`);
}

/** Open issues of a repo through `gh api`, all pages. */
export function fetchIssues(repo) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out).flat();
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The stable signing keys of a bundle-keys.txt (a line without channel= is a stable key). */
export function stableKeys(text) {
  const keys = [];
  for (const raw of text.split('\n')) {
    const m = /^[A-Za-z0-9._-]+ (ssh-ed25519) ([A-Za-z0-9+/=]+)( channel=(stable|beta|nightly))?$/.exec(raw.trim());
    if (m && (m[4] ?? 'stable') === 'stable') keys.push(`${m[1]} ${m[2]}`);
  }
  return keys;
}

/** The text that is signed: the hash of the counts file, the two counts and the day it was read from the review repo. */
export function attestationText(countsBytes, counts, issued) {
  return JSON.stringify({ counts_sha256: sha256(countsBytes), existential_open: counts.existential_open, trust_ending_open: counts.trust_ending_open, issued }) + '\n';
}

/** Throws unless a pinned stable key signed an attestation that names these counts-file bytes, is not future and is fresh. */
export function verifyAttestation({ countsBytes, attest, sig, keysText, today }) {
  const keys = stableKeys(keysText);
  if (keys.length === 0) throw new Error('no stable key is pinned');
  const dir = mkdtempSync(join(tmpdir(), 'counts-'));
  try {
    writeFileSync(join(dir, 'signers'), keys.map((k) => `counts ${k}`).join('\n') + '\n');
    writeFileSync(join(dir, 'sig'), sig);
    try {
      execFileSync('ssh-keygen', ['-Y', 'verify', '-f', join(dir, 'signers'), '-I', 'counts', '-n', NAMESPACE, '-s', join(dir, 'sig')], { input: attest, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      throw new Error('the attestation is not signed by a pinned key');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const doc = JSON.parse(attest.toString('utf8'));
  const file = JSON.parse(countsBytes.toString('utf8'));
  if (doc.counts_sha256 !== sha256(countsBytes)) throw new Error('the attestation names a different counts file');
  for (const key of Object.values(TIERS)) if (doc[key] !== file[key]) throw new Error('the attested counts differ from the counts file');
  const age = (Date.parse(today) - Date.parse(doc.issued)) / 86400000;
  if (!(age >= 0 && age <= MAX_AGE_DAYS)) throw new Error(`the attestation is not from the last ${MAX_AGE_DAYS} days`);
}

function sign(keyfile, argv) {
  const real = countByTier(fetchIssues(REPO));
  const countsBytes = readFileSync(COUNTS_FILE);
  const diffs = compare(JSON.parse(countsBytes), real);
  if (diffs.length > 0) {
    for (const line of diffs) console.error(line);
    process.exit(1);
  }
  const issued = new Date().toISOString().slice(0, 10);
  writeFileSync(ATTEST_FILE, attestationText(countsBytes, real, issued));
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', keyfile, '-n', NAMESPACE, ATTEST_FILE], { stdio: 'inherit' });
  console.log(`attested ${ATTEST_FILE} (${issued}); commit ${ATTEST_FILE} and ${ATTEST_FILE}.sig`);
}

/** The attestation path of the gate: no review-repo token, only files of this checkout and the pinned keys of master. */
function attested(argv, arg) {
  try {
    const keysText = argv.includes('--keys') ? readFileSync(arg('--keys'), 'utf8') : execFileSync('git', ['show', KEYS_REF], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    verifyAttestation({
      countsBytes: readFileSync(arg('--counts', COUNTS_FILE)),
      attest: readFileSync(arg('--attest', ATTEST_FILE)),
      sig: readFileSync(`${arg('--attest', ATTEST_FILE)}.sig`),
      keysText,
      today: arg('--today', new Date().toISOString().slice(0, 10)),
    });
    return true;
  } catch (e) {
    console.error(`no signed attestation either: ${e.message}`);
    return false;
  }
}

function main(argv) {
  if (argv[0] === 'sign') return sign(argv[1], argv);
  const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  let real;
  try {
    const issues = argv.includes('--issues') ? JSON.parse(readFileSync(arg('--issues'), 'utf8')) : fetchIssues(arg('--repo', REPO));
    real = countByTier(issues);
  } catch {
    console.error('could not read the open issues of the review repo (token access?)');
    // No token in this job: a counts file that the owner signed off, fresh and unchanged, stands in for the live read.
    // A job that has a token and still cannot read (revoked, expired, outage) is refused, not waved through.
    const hasToken = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
    if (!argv.includes('--issues') && !hasToken && attested(argv, arg)) {
      console.log('counts attested by the pinned key');
      return;
    }
    process.exit(2);
  }
  const file = JSON.parse(readFileSync(arg('--counts', COUNTS_FILE), 'utf8'));
  const diffs = compare(file, real);
  if (diffs.length > 0) {
    for (const line of diffs) console.error(line);
    process.exit(1);
  }
  console.log(`counts match: existential ${real.existential_open}, trust-ending ${real.trust_ending_open}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
