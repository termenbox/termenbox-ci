import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commentFor, matchEdges, parseEdges, scan } from './check-security-surface.mjs';

const roots = [];

const MAP_HEAD = '| Id | Edge | Exposure | Controls | Shell w/o factor? | Gaps | Walked |\n|---|---|---|---|---|---|---|\n';
const GOOD_MAP_ROWS = [
  '| P2 | Functions: `api/me/{servers}` | public | signed | no: signed | | yes |',
  '| O1 | Server port | public | x | no: handshake | SR-A1 | yes |',
];
const REG_HEAD = '| Resource | Limit | Who | Cap | Gaps | Walked |\n|---|---|---|---|---|---|\n';
const GOOD_REG_ROWS = ['| Workers | 100k/day | anyone | per-source cap; the quota alarm | | yes |'];

function fixture({ map = GOOD_MAP_ROWS, register = GOOD_REG_ROWS, edges = 'packages/a.rs O1\npackages/client/functions/** P2\n', routes = ['me/servers'], exempt = '', files = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'security-surface-'));
  roots.push(root);
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('docs/facts/0079-map.md', `# Map\n\n## Tier 1\n\n${MAP_HEAD}${map.join('\n')}\n`);
  put('docs/facts/0080-register.md', `# Register\n\n## Tier 1: shared\n\n${REG_HEAD}${register.join('\n')}\n`);
  put('.github/security-edges.txt', `# comment\n${edges}`);
  put('.github/security-edges-exempt.txt', `# comment\n${exempt}`);
  for (const file of files) put(file, '// x\n');
  for (const route of routes) put(`packages/client/functions/api/${route}.ts`, 'export const x = 1;\n');
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('check-security-surface', () => {
  it('passes a good fixture', () => {
    assert.deepEqual(scan(fixture()), []);
  });

  it('every_edge_file_is_listed_or_exempt: a new unlisted .rs file fails', () => {
    const root = fixture({ files: ['packages/server/src/newthing.rs'] });
    assert.match(scan(root).join('\n'), /packages\/server\/src\/newthing\.rs is on neither/);
  });

  it('every_edge_file_is_listed_or_exempt: core, infra and installer files are checked too', () => {
    const root = fixture({ files: ['packages/core/src/a.rs', 'infra/x/y.ts', 'packages/client/installer/z.sh', 'scripts/install-q.sh'] });
    const text = scan(root).join('\n');
    for (const f of ['core/src/a.rs', 'infra/x/y.ts', 'installer/z.sh', 'scripts/install-q.sh']) assert.match(text, new RegExp(f.replace(/\./g, '\\.')));
  });

  it('every_edge_file_is_listed_or_exempt: an edge line or a one-word exemption passes', () => {
    const files = ['packages/server/src/a.rs', 'packages/server/src/b.rs'];
    assert.deepEqual(scan(fixture({ files, edges: 'packages/client/functions/** P2\npackages/server/src/a.rs O1\n', exempt: 'packages/server/src/b.rs internal\n' })), []);
  });

  it('every_edge_file_is_listed_or_exempt: an exemption needs a one-word reason', () => {
    const root = fixture({ files: ['packages/server/src/b.rs'], exempt: 'packages/server/src/b.rs\n' });
    assert.match(scan(root).join('\n'), /needs a one-word reason/);
  });

  it('map_has_an_answer_for_every_edge: a map with a ? fails', () => {
    const root = fixture({ map: ['| P2 | `api/me/servers` | public | signed | ? | | yes |', GOOD_MAP_ROWS[1]] });
    assert.match(scan(root).join('\n'), /P2 answers "\?"/);
  });

  it('map_has_an_answer_for_every_edge: a yes fails', () => {
    const root = fixture({ map: [GOOD_MAP_ROWS[0], '| O1 | Server port | public | x | yes: reaches a shell | | yes |'] });
    assert.match(scan(root).join('\n'), /O1 answers "yes/);
  });

  it('map_has_an_answer_for_every_edge: a missing edge row fails', () => {
    const root = fixture({ edges: 'packages/a.rs O1 O9\n' });
    assert.match(scan(root).join('\n'), /names row O9/);
  });

  it('map_has_an_answer_for_every_edge: a route with no row text fails', () => {
    const root = fixture({ routes: ['me/servers', 'me/newroute'] });
    assert.match(scan(root).join('\n'), /api\/me\/newroute is not in map row P2/);
  });

  it('public_map_has_only_opaque_gap_ids: free text in a Gaps cell fails', () => {
    const root = fixture({ map: [GOOD_MAP_ROWS[0], '| O1 | Server port | public | x | no: handshake | long description of a hole | yes |'] });
    assert.match(scan(root).join('\n'), /free text in its Gaps cell/);
  });

  it('public_map_has_only_opaque_gap_ids: a list of ids passes', () => {
    const root = fixture({ map: [GOOD_MAP_ROWS[0], '| O1 | Server port | public | x | no: handshake | SR-A1, SR-A2 | yes |'] });
    assert.deepEqual(scan(root), []);
  });

  it('every_quota_row_has_an_alarm: a quota row without an alarm fails', () => {
    const root = fixture({ register: ['| Workers | 100k/day | anyone | per-source cap | | yes |'] });
    assert.match(scan(root).join('\n'), /Workers" has a ceiling and names no alarm/);
  });

  it('every_quota_row_has_an_alarm: a recorded finding or an unused resource is exempt', () => {
    const root = fixture({ register: ['| R2 | 1M/month | anyone | Not used today | | yes |', '| D1 | 5M/day | anyone | none | SR-A7 | yes |'] });
    assert.deepEqual(scan(root), []);
  });
});

describe('edge paths and the pull request comment', () => {
  const edges = parseEdges('# c\npackages/server/src/main.rs O1\npackages/core/src/** O1 O7\n.github/workflows/** P5\n');

  it('parses lines and ignores comments', () => {
    assert.deepEqual(edges[0], { glob: 'packages/server/src/main.rs', ids: ['O1'] });
    assert.equal(edges.length, 3);
  });

  it('matches ** across directories and * within one', () => {
    assert.equal(matchEdges(edges, ['packages/core/src/a/b.rs']).length, 1);
    assert.equal(matchEdges(edges, ['packages/server/src/other.rs']).length, 0);
  });

  it('comments only when an edge path changed', () => {
    assert.equal(commentFor(edges, ['README.md']), null);
    const text = commentFor(edges, ['.github/workflows/ci.yaml', 'packages/core/src/x.rs']);
    assert.match(text, /Rows to re-read: O1, O7, P5\./);
  });
});
