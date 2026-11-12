import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedDigest, inTime } from './check-ci-image-age.mjs';

const SCRIPT = fileURLToPath(new URL('./check-ci-image-age.mjs', import.meta.url));
const d = (c) => `sha256:${c.repeat(64)}`;
const PIN = d('a');
const NEWER = d('b');
const line = (ref) => `    container: \${{ matrix.engine != 'chromium' && 'ghcr.io/termenbox/termenbox-ci${ref}' || '' }}\n`;
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();

test('ci.yaml names one digest, and a tag, a second digest or none is no pin', () => {
  assert.equal(pinnedDigest(line(`@${PIN}`) + line(`@${PIN}`)), PIN);
  assert.equal(pinnedDigest(line(':latest')), null);
  assert.equal(pinnedDigest(line(`@${PIN}`) + line(':latest')), null);
  assert.equal(pinnedDigest(line(`@${PIN}`) + line(`@${NEWER}`)), null);
  assert.equal(pinnedDigest('jobs: {}\n'), null);
});

test('the live ci.yaml pulls the image by one digest', () => {
  const text = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yaml', import.meta.url)), 'utf8');
  assert.match(pinnedDigest(text) ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('the newest build passes at any age; an older pin passes up to the limit', () => {
  const now = Date.now();
  assert.equal(inTime({ pin: PIN, latest: PIN, created: daysAgo(400), now, days: 60 }), true);
  assert.equal(inTime({ pin: PIN, latest: NEWER, created: daysAgo(59), now, days: 60 }), true);
  assert.equal(inTime({ pin: PIN, latest: NEWER, created: daysAgo(61), now, days: 60 }), false);
  assert.equal(inTime({ pin: PIN, latest: NEWER, created: undefined, now, days: 60 }), false);
  assert.equal(inTime({ pin: PIN, latest: NEWER, created: daysAgo(-5), now, days: 60 }), false);
});

// A stand-in registry: `:latest` resolves to `latest`; the pin is an index whose image manifest names a config built at `created`.
function registry({ latest, created }) {
  const index = { manifests: [{ digest: d('c'), platform: { os: 'linux', architecture: 'amd64' } }, { digest: d('e'), platform: { os: 'unknown' } }] };
  const routes = {
    '/token': { token: 'anonymous' },
    [`/v2/termenbox/termenbox-ci/manifests/${PIN}`]: index,
    [`/v2/termenbox/termenbox-ci/manifests/${d('c')}`]: { config: { digest: d('f') } },
    [`/v2/termenbox/termenbox-ci/blobs/${d('f')}`]: { created },
  };
  return createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/v2/termenbox/termenbox-ci/manifests/latest') {
      res.writeHead(200, { 'docker-content-digest': latest, 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (!(path in routes)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(routes[path]));
  });
}

async function run(state, workflow = line(`@${PIN}`).repeat(2)) {
  const server = registry(state);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'ci.yaml'), workflow);
  const env = { ...process.env, SWEEP_REGISTRY: `http://127.0.0.1:${server.address().port}`, TERMENBOX_WORKFLOWS_DIR: dir };
  try {
    return await new Promise((ok) => execFile(process.execPath, [SCRIPT], { env }, (err, stdout, stderr) => ok({ status: err ? err.code : 0, out: stdout + stderr })));
  } finally {
    server.close();
  }
}

test('ci-image-age passes for the newest build and for a recent one, and prints nothing', async () => {
  assert.deepEqual(await run({ latest: PIN, created: daysAgo(100) }), { status: 0, out: '' });
  assert.deepEqual(await run({ latest: NEWER, created: daysAgo(20) }), { status: 0, out: '' });
});

test('ci-image-age fails a bump more than 60 days late, a tag and an unreadable pin', async () => {
  assert.deepEqual(await run({ latest: NEWER, created: daysAgo(70) }), { status: 1, out: '' });
  assert.equal((await run({ latest: NEWER, created: daysAgo(1) }, line(':latest'))).status, 1);
  assert.equal((await run({ latest: NEWER, created: daysAgo(1) }, line(`@${d('9')}`))).status, 1);
});
