#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reads the organisation's repos back through `gh api` (GET only), fetches public URLs with no credentials and scans
// tracked files, then prints the NAMES of the checks that fail (`--verbose` adds file:line for source calls). It never
// prints a value, a secret name or page text. Groups: settings | surface | references. Select with
// `--only a,b` and `--repo <name>`. Target: .github/repo-structure.json. The
// config says which names a public repo must not carry.

export const GROUPS = ['settings', 'surface', 'references'];
export const loadConfig = (file = new URL("../.github/repo-structure.json", import.meta.url)) => JSON.parse(readFileSync(file, 'utf8'));

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const decode = (f) => (f && typeof f.content === 'string' ? Buffer.from(f.content, 'base64').toString('utf8') : undefined);
const expand = (cfg, list) => (list ?? []).map((h) => (h === 'WORKER' ? cfg.workerUrl : h));

/** `get(path)` returns parsed JSON or throws. A path that fails is `undefined`. */
export function gather(get, spec, groups) {
  const repo = spec.repo;
  const r = (p) => { try { return get(`repos/${repo}${p}`); } catch { return undefined; } };
  const s = { repo: r('') };
  if (!s.repo) return s;
  if (groups.includes('settings')) {
    s.actions = r('/actions/permissions');
    s.collaborators = r('/collaborators');
    s.hooks = r('/hooks');
    s.secrets = r('/actions/secrets');
    s.environments = r('/environments');
  }
  if (groups.includes('surface') && spec.visibility === 'public') {
    s.files = {};
    for (const f of spec.requiredFiles ?? []) s.files[f] = decode(r(`/contents/${f}`)) ?? null;
    s.releases = r('/releases');
    const dir = (p) => {
      const list = r(`/contents/${p}`);
      const out = [];
      for (const e of Array.isArray(list) ? list : []) if (e.type === 'file') out.push(decode(r(`/contents/${e.path}`)) ?? '');
      return out;
    };
    s.issueForms = dir('.github/ISSUE_TEMPLATE');
    s.workflows = dir('.github/workflows');
  }
  return s;
}

const hit = (markers, text) => markers.some((m) => m.test(text ?? ''));
/** The text a reader of a workflow sees without reading the code: comment lines and the names of the workflow, jobs and steps. A secret
 * the code reads is a name the reader can see in the Settings of any fork anyway; the markers are for prose. */
export const proseOf = (text) => (text ?? '').split('\n').filter((l) => /^\s*(#|(- )?name:)/.test(l)).join('\n');

/** Names of the failing settings and surface checks for one repo (without the `<key>:` prefix). */
export function evaluate(s, spec, cfg, groups = GROUPS) {
  const bad = [];
  const need = (name, ok) => { if (!ok) bad.push(name); };
  need('repo-exists', !!s.repo);
  if (!s.repo) return bad;
  if (groups.includes('settings')) {
    need('visibility', s.repo.private === (spec.visibility === 'private'));
    for (const [flag, field] of [['issues', 'has_issues'], ['discussions', 'has_discussions'], ['wiki', 'has_wiki']]) {
      if (typeof spec[flag] === 'boolean') need(`${flag}-${spec[flag] ? 'on' : 'off'}`, !!s.repo[field] === spec[flag]);
    }
    if (typeof spec.actions === 'boolean') need(`actions-${spec.actions ? 'enabled' : 'disabled'}`, s.actions?.enabled === spec.actions);
    if (spec.secrets) {
      need(`secrets-${spec.secrets.length ? 'match-list' : 'none'}`,
        !!s.secrets && sameSet((s.secrets.secrets ?? []).map((x) => x.name), spec.secrets));
    }
    if (spec.hooks) {
      need(`webhooks-${spec.hooks.length ? 'match-worker' : 'none'}`,
        Array.isArray(s.hooks) && sameSet(s.hooks.map((h) => h?.config?.url), expand(cfg, spec.hooks)));
    }
    if (spec.environments === false) need('no-environments', !!s.environments && (s.environments.environments ?? []).length === 0);
    if (typeof spec.collaborators === 'number') {
      need('collaborators-count', Array.isArray(s.collaborators) && s.collaborators.length === spec.collaborators);
    }
    if (spec.license) need('license', !!s.repo.license);
    if (spec.topics) need('topics', (s.repo.topics ?? []).length > 0);
    if (spec.description) need('description', !!s.repo.description);
  }
  if (groups.includes('surface') && spec.visibility === 'public') {
    const markers = (cfg.markers ?? []).map((m) => new RegExp(m, 'i'));
    const attribution = new RegExp(cfg.attributionHeading ?? '^#{1,6}\\s*attribution', 'im');
    for (const [f, text] of Object.entries(s.files ?? {})) need(`required-file-${f.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`, text !== null);
    for (const f of ['README.md', 'profile/README.md']) {
      if (f in (s.files ?? {})) need('readme-attribution-section', attribution.test(s.files[f] ?? ''));
    }
    need('description-marker', !hit(markers, s.repo.description));
    need('topics-marker', !hit(markers, (s.repo.topics ?? []).join(' ')));
    need('homepage-marker', !hit(markers, s.repo.homepage));
    for (const [f, text] of Object.entries(s.files ?? {})) {
      if (text) need(`${f.replace(/\.[a-z]+$/i, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-marker`, !hit(markers, text));
    }
    need('issue-forms-marker', !(s.issueForms ?? []).some((t) => hit(markers, t)));
    need('releases-marker', !(Array.isArray(s.releases) ? s.releases : []).some((x) => hit(markers, `${x?.name} ${x?.body}`)));
    need('workflow-comments-marker', !(s.workflows ?? []).some((t) => hit(markers, proseOf(t))));
  }
  return bad;
}

/** `files` is `{ path: text }`. Returns `[{ path, line }]` of calls that mean the source but name the product repo. */
export function scanSourceCalls(files, cfg) {
  const pats = (cfg.sourceCalls ?? []).map((p) => new RegExp(p));
  const skip = cfg.sourceCallExclude ?? [];
  const allow = cfg.sourceCallAllow ?? [];
  const found = [];
  for (const [path, text] of Object.entries(files)) {
    if (skip.some((x) => path.includes(x))) continue;
    text.split('\n').forEach((l, i) => {
      if (pats.some((p) => p.test(l)) && !allow.some((a) => path.includes(a.path) && l.includes(a.contains))) found.push({ path, line: i + 1 });
    });
  }
  return found;
}

export const trackedFiles = (dir) => {
  const out = {};
  const names = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const n of names) {
    try {
      const t = readFileSync(`${dir}/${n}`, 'utf8');
      if (!t.includes('\0')) out[n] = t;
    } catch { /* deleted or unreadable */ }
  }
  return out;
};

export function ghGet(path) {
  if (!/^[A-Za-z0-9_./-]+$/.test(path)) throw new Error('bad path');
  return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 << 20 }));
}

/** Anonymous GET, redirects followed, no credentials. Returns the final status or 0. */
export async function probeStatus(url) {
  try { return (await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit' })).status; } catch { return 0; }
}

export async function run({ cfg = loadConfig(), get = ghGet, probe = probeStatus, groups = GROUPS, repo, trees = [] } = {}) {
  const failing = [];
  const details = [];
  if (groups.includes('settings') || groups.includes('surface')) {
    for (const [key, spec] of Object.entries(cfg.repos)) {
      if (repo && key !== repo) continue;
      for (const n of evaluate(gather(get, spec, groups), spec, cfg, groups)) failing.push(`${key}:${n}`);
    }
  }
  if (groups.includes('references')) {
    for (const u of cfg.urls ?? []) if ((await probe(u.url)) !== 200) failing.push(`references:url-${u.id}`);
    for (const t of trees) {
      for (const f of scanSourceCalls(t.files, cfg)) {
        const name = `references:source-call-in-${t.name}`;
        if (!failing.includes(name)) failing.push(name);
        details.push(`${t.name}:${f.path}:${f.line}`);
      }
    }
  }
  return { failing, details };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const groups = val('--only') ? val('--only').split(',') : GROUPS;
  if (!groups.every((g) => GROUPS.includes(g))) { console.error(`--only takes ${GROUPS.join(',')}`); process.exit(2); }
  const trees = [{ name: 'source', files: trackedFiles(process.cwd()) }];
  const ci = val('--ci-dir') ?? process.env.TERMENBOX_CI_DIR;
  if (ci) trees.push({ name: 'ci', files: trackedFiles(ci) });
  const { failing, details } = await run({ groups, repo: val('--repo'), trees });
  for (const n of failing) console.log(`FAIL ${n}`);
  if (args.includes('--verbose')) for (const d of details) console.log(`  at ${d}`);
  if (failing.length) process.exit(1);
  console.log('repo structure ok');
}
