// The app-token action's script runs against a local stub of the GitHub API: the JWT it signs verifies against the app's
// public key, the token request names one repository and the permissions asked for, the token is masked and written to the
// step output, and a refusal fails without printing the response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../.github/actions/app-token/mint.sh', import.meta.url).pathname;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

async function withStub(handler, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const [status, json] = handler(req, calls);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, calls); } finally { server.close(); }
}

function run(api, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-token-'));
  const out = join(dir, 'out');
  writeFileSync(out, '');
  return new Promise((resolve) => {
    const p = spawn('bash', [script], { env: { PATH: process.env.PATH, GITHUB_API_URL: api, GITHUB_OUTPUT: out, APP_ID: '123', APP_KEY: pem, REPO: 'termenbox/termenbox-source', PERMISSIONS: '{"contents":"read"}', ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (code) => resolve({ code, stdout, stderr, output: readFileSync(out, 'utf8') }));
  });
}

const ok = (req) => (req.url.endsWith('/installation') ? [200, { id: 42 }] : [201, { token: 'ghs_stubtoken', expires_at: '2099-01-01T00:00:00Z' }]);

test('mints a token limited to one repository and the permissions asked for', async () => {
  await withStub(ok, async (api, calls) => {
    const r = await run(api);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.output.trim(), 'token=ghs_stubtoken');
    assert.match(r.stdout, /::add-mask::ghs_stubtoken/);
    assert.equal(calls[0].url, '/repos/termenbox/termenbox-source/installation');
    assert.equal(calls[1].url, '/app/installations/42/access_tokens');
    assert.deepEqual(JSON.parse(calls[1].body), { repositories: ['termenbox-source'], permissions: { contents: 'read' } });
    const [h, b, s] = calls[0].auth.replace('Bearer ', '').split('.');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
    const claims = JSON.parse(Buffer.from(b, 'base64url'));
    assert.equal(claims.iss, '123');
    assert.ok(claims.exp - claims.iat <= 600);
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
    assert.ok(!r.stdout.includes('PRIVATE KEY') && !r.stderr.includes('PRIVATE KEY'));
  });
});

test('a refusal fails without echoing the response', async () => {
  await withStub(() => [403, { message: 'SECRETISH' }], async (api) => {
    const r = await run(api);
    assert.notEqual(r.code, 0);
    assert.ok(!r.stdout.includes('SECRETISH') && !r.stderr.includes('SECRETISH'));
    assert.equal(r.output, '');
  });
});

test('missing credentials, a bad id and a bad repository are refused before any request', async () => {
  await withStub(ok, async (api, calls) => {
    assert.notEqual((await run(api, { APP_KEY: '' })).code, 0);
    assert.notEqual((await run(api, { APP_ID: '12x' })).code, 0);
    assert.notEqual((await run(api, { REPO: 'nodash' })).code, 0);
    assert.equal(calls.length, 0);
  });
});
