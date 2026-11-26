#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The rules that no shell opens without a user factor, that open security findings stay private until fixed and that
// every unauthenticated edge declares its caps: the public attack-surface map and resource
// register must answer every edge, hold only opaque ids in their Gaps cells, and name an alarm for
// every shared quota. With `--changed <file>` it also writes the comment for a pull request that touches a path
// listed in `.github/security-edges.txt`.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGES = '.github/security-edges.txt';
const EXEMPT = '.github/security-edges-exempt.txt';
const GAP_CELL = /^SR-[0-9A-Za-z-]+(\s*,\s*SR-[0-9A-Za-z-]+)*$/;
export const MARKER = '<!-- security-surface-check -->';

/** Lines of the edge-path list as `{ glob, ids }`; `#` starts a comment. */
export function parseEdges(text) {
  const edges = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [glob, ...ids] = line.split(/\s+/);
    edges.push({ glob, ids });
  }
  return edges;
}

export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The edge lines that match at least one of the changed paths. */
export function matchEdges(edges, paths) {
  return edges.filter((edge) => {
    const re = globToRegExp(edge.glob);
    return paths.some((path) => re.test(path));
  });
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** Every table row of a fact as `{ section, header, cells }`; `section` is the nearest heading above. */
export function tableRows(markdown) {
  const rows = [];
  let section = '';
  let header = null;
  for (const line of markdown.split('\n')) {
    if (/^#+\s/.test(line)) {
      section = line.replace(/^#+\s*/, '');
      header = null;
    } else if (/^\|/.test(line)) {
      const cells = splitRow(line);
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      if (!header) header = cells;
      else rows.push({ section, header, cells });
    } else header = null;
  }
  return rows;
}

/** Every file under `rel` (repo-relative paths), skipping build and dependency directories. */
function filesUnder(root, rel) {
  const found = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', 'target', '.wrangler', 'dist'].includes(entry.name)) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else found.push(`${prefix}${entry.name}`);
    }
  };
  walk(join(root, rel), rel ? `${rel.replace(/\/$/, '')}/` : '');
  return found;
}

/** Files that can carry an edge: server and core Rust, hosted functions, infra and the installer scripts. */
export function edgeCandidates(root) {
  const out = new Set();
  for (const base of ['packages/server/src', 'packages/core/src', 'packages/mux/src']) {
    for (const f of filesUnder(root, base)) if (f.endsWith('.rs')) out.add(f);
  }
  for (const base of ['packages/client/functions', 'infra', 'packages/client/installer']) {
    for (const f of filesUnder(root, base)) out.add(f);
  }
  for (const base of ['packages/client/public', 'scripts', '.github/scripts']) {
    for (const f of filesUnder(root, base)) {
      if (f.slice(base.length + 1).includes('/')) continue;
      if (/install[^/]*\.sh$/.test(f)) out.add(f);
    }
  }
  return [...out].sort();
}

/** Lines of the exemption list as `{ glob, reason }`; the reason is one word. */
export function parseExempt(text) {
  return parseEdges(text).map(({ glob, ids }) => ({ glob, reason: ids.join(' ') }));
}

function factText(root, prefix) {
  const dir = join(root, 'docs/facts');
  const name = existsSync(dir) ? readdirSync(dir).find((file) => file.startsWith(`${prefix}-`)) : undefined;
  return name ? readFileSync(join(dir, name), 'utf8') : null;
}

function routeFiles(root) {
  const base = join(root, 'packages/client/functions/api');
  const found = [];
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}${entry.name}/`);
      else if (/\.ts$/.test(entry.name) && !/^_|\.test\.ts$/.test(entry.name)) {
        found.push({ dir: rel.replace(/\/$/, ''), name: entry.name.replace(/\.ts$/, '') });
      }
    }
  };
  walk(base, '');
  return found;
}

/** Everything wrong with the map and register under `root`, as readable strings. */
export function scan(root = REPO_ROOT) {
  const issues = [];
  const map = factText(root, '0079');
  const register = factText(root, '0080');
  if (map === null) issues.push('docs/facts/0079-*.md is missing');
  if (register === null) issues.push('docs/facts/0080-*.md is missing');
  const edgesPath = join(root, EDGES);
  const edges = existsSync(edgesPath) ? parseEdges(readFileSync(edgesPath, 'utf8')) : [];
  if (!existsSync(edgesPath)) issues.push(`${EDGES} is missing`);

  // every_edge_file_is_listed_or_exempt
  const exemptPath = join(root, EXEMPT);
  const exempt = existsSync(exemptPath) ? parseExempt(readFileSync(exemptPath, 'utf8')) : [];
  if (!existsSync(exemptPath)) issues.push(`${EXEMPT} is missing`);
  for (const entry of exempt) {
    if (!/^[A-Za-z][A-Za-z-]*$/.test(entry.reason)) issues.push(`${EXEMPT}: "${entry.glob}" needs a one-word reason`);
  }
  const covering = [...edges.map((e) => e.glob), ...exempt.map((e) => e.glob)].map(globToRegExp);
  for (const file of edgeCandidates(root)) {
    if (!covering.some((re) => re.test(file))) issues.push(`${file} is on neither ${EDGES} nor ${EXEMPT}`);
  }

  // map_has_an_answer_for_every_edge
  const mapRows = map ? tableRows(map).filter((row) => /^[OP]\d+$/.test(row.cells[0])) : [];
  const byId = new Map(mapRows.map((row) => [row.cells[0], row]));
  for (const row of mapRows) {
    const shellAt = row.header.findIndex((name) => /^Shell w\/o factor/.test(name));
    // Tier 2 rows keep the answer at the head of the controls cell.
    const answer = row.cells.length === row.header.length ? row.cells[shellAt] : row.cells[3];
    const id = row.cells[0];
    if (!answer || answer === '?' || /^yes\b/i.test(answer)) issues.push(`map row ${id} answers "${answer ?? ''}" to the shell question`);
    if (row.cells.some((cell) => cell === '?')) issues.push(`map row ${id} still has a "?"`);
  }
  for (const edge of edges) {
    for (const id of edge.ids) if (!byId.has(id)) issues.push(`${EDGES}: "${edge.glob}" names row ${id}, which the attack-surface map does not have`);
  }
  const p2 = byId.get('P2')?.cells.join(' ') ?? '';
  for (const route of routeFiles(root)) {
    if (!p2.includes(route.name) || !p2.includes(route.dir)) issues.push(`route api/${route.dir}/${route.name} is not in map row P2`);
  }

  // public_map_has_only_opaque_gap_ids
  for (const [label, text] of [['attack-surface map', map], ['resource register', register]]) {
    if (!text) continue;
    for (const row of tableRows(text)) {
      const gaps = row.cells.at(-2) ?? '';
      if (/^Gaps$/.test(row.header.at(-2)) && gaps && !GAP_CELL.test(gaps)) {
        issues.push(`${label} row "${row.cells[0].slice(0, 40)}" has free text in its Gaps cell`);
      }
    }
  }

  // every_quota_row_has_an_alarm
  if (register) {
    for (const row of tableRows(register).filter((r) => /Tier 1/.test(r.section))) {
      const [name, limit, , cap, gaps, walked] = row.cells;
      const ceiling = /\d/.test(limit);
      if (!ceiling || walked !== 'yes' || gaps || /not used/i.test(cap)) continue;
      if (!/alarm/i.test(cap)) issues.push(`register row "${name.slice(0, 40)}" has a ceiling and names no alarm`);
    }
  }
  return issues;
}

/** The markdown comment for a pull request that changed `paths`, or null when no edge is touched. */
export function commentFor(edges, paths) {
  const hit = matchEdges(edges, paths);
  if (hit.length === 0) return null;
  const ids = [...new Set(hit.flatMap((edge) => edge.ids))].sort();
  return [
    MARKER,
    '**Security surface.** This pull request touches a path that carries an edge of the attack-surface map.',
    '',
    `Rows to re-read: ${ids.join(', ') || 'none named'}.`,
    'If it adds or changes a listener, route, credential, workflow trigger, publishing path or dependency class, update the row in',
    '`docs/facts/0079-*.md` in this pull request (the rule that no shell opens without a user factor).',
    '',
    ...hit.map((edge) => `- \`${edge.glob}\``),
    '',
  ].join('\n');
}

function main(argv) {
  const issues = scan();
  const at = argv.indexOf('--changed');
  const out = argv.indexOf('--comment');
  if (at !== -1 && out !== -1) {
    const paths = readFileSync(argv[at + 1], 'utf8').split('\n').filter(Boolean);
    const edges = parseEdges(readFileSync(join(REPO_ROOT, EDGES), 'utf8'));
    const comment = commentFor(edges, paths);
    if (comment) writeFileSync(argv[out + 1], comment);
  }
  for (const issue of issues) console.error(`security-surface: ${issue}`);
  if (issues.length === 0) console.log('security-surface: ok');
  process.exit(issues.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
