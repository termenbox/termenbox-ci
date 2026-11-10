#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every `uses:` line in .github names a local path or a full 40-character commit, so a moved upstream tag or
// branch cannot change the code that builds, signs or deploys. A trailing comment says which tag the commit is.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ya?ml$/.test(name)) out.push(full);
  }
  return out;
}

/** The `uses:` lines of `text` that are neither a local path nor a commit pin: [{ line, value }]. */
export function unpinned(text) {
  const bad = [];
  text.split('\n').forEach((raw, i) => {
    const m = USES.exec(raw);
    if (!m) return;
    const value = m[2];
    if (value.startsWith('./')) return;
    if (/^[^@\s]+@[0-9a-f]{40}$/.test(value)) return;
    bad.push({ line: i + 1, value });
  });
  return bad;
}

export function scan(root = REPO_ROOT) {
  const base = join(root, '.github');
  const found = [];
  for (const file of walk(base)) {
    for (const b of unpinned(readFileSync(file, 'utf8'))) found.push({ file: relative(root, file), ...b });
  }
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const found = scan();
  for (const f of found) console.error(`${f.file}:${f.line}: ${f.value} is not pinned to a commit`);
  process.exit(found.length ? 1 : 0);
}
