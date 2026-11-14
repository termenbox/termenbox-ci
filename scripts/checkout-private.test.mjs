// The checkout-private action runs against a local bare repository standing in for the private source: the action's own
// script is cut out of action.yml, and git's url rewriting sends its github.com URL to the fixture. After the step no
// credential may sit in .git/config, and a branch asked for in `fetch` is there as refs/remotes/origin/<branch>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'ghs_fixturetoken0123456789';
const yml = readFileSync(new URL('../.github/actions/checkout-private/action.yml', import.meta.url), 'utf8');
const script = yml.split('\n    - shell: bash\n')[1].split('      run: |\n')[1].split('\n').map((l) => l.slice(8)).join('\n');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'checkout-private-'));
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'master');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'branch', 'develop');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'two');
  const bare = join(root, 'source.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  return { root, bare, sha: git(work, 'rev-parse', 'HEAD'), first: git(work, 'rev-parse', 'HEAD~1') };
}

function run({ root, bare }, env) {
  const dest = join(root, 'out' + Math.random().toString(16).slice(2));
  const url = `https://x-access-token:${TOKEN}@github.com/termenbox/termenbox-source.git`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: root, TOKEN, SHA: '', BASE: '', DEST: dest, DEPTH: '1', FETCH: '', BRANCH: 'develop',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: url,
      ...env,
    },
  });
  return { ...r, dest };
}

test('a checkout leaves no credential and fetches the branches asked for', () => {
  const f = fixture();
  const r = run(f, { SHA: f.sha, DEPTH: '0', FETCH: 'master develop' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(git(r.dest, 'rev-parse', 'HEAD'), f.sha);
  assert.equal(git(r.dest, 'rev-parse', 'refs/remotes/origin/develop'), f.first);
  assert.ok(git(r.dest, 'rev-parse', 'refs/remotes/origin/master'));
  assert.equal(spawnSync('git', ['config', '--get-all', 'http.https://github.com/.extraheader'], { cwd: r.dest }).stdout.toString(), '');
  assert.ok(!readFileSync(join(r.dest, '.git', 'config'), 'utf8').includes(TOKEN));
  assert.ok(!readFileSync(join(r.dest, '.git', 'config'), 'utf8').toLowerCase().includes('authorization'));
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
});

test('a checkout with no fetch list leaves the remote without the branches', () => {
  const f = fixture();
  const r = run(f, { SHA: f.sha });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/remotes/origin/master'], { cwd: r.dest }).status, 1);
});

test('a branch name that is not a plain name is refused', () => {
  const f = fixture();
  const r = run(f, { SHA: f.sha, FETCH: 'master;touch x' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /bad branch/);
});

test('with a reporter app a read-only token is minted and no credential is left', async () => {
  const http = await import('node:http');
  const { generateKeyPairSync } = await import('node:crypto');
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const asked = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      asked.push({ url: req.url, body: b });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.endsWith('/installation') ? { id: 7 } : { token: 'ghs_minted0123456789', expires_at: '2099-01-01T00:00:00Z' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const f = fixture();
    const minted = 'ghs_minted0123456789';
    const dest = join(f.root, 'app-out');
    const url = `https://x-access-token:${minted}@github.com/termenbox/termenbox-source.git`;
    const r = await new Promise((resolve) => {
      const p = spawn('bash', ['-c', script], { env: {
        PATH: process.env.PATH, HOME: f.root, TOKEN: '', APP_ID: '55', APP_KEY: pem, SHA: f.sha, BASE: '', DEST: dest, DEPTH: '1', FETCH: '', BRANCH: 'develop',
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_ACTION_PATH: new URL('../.github/actions/checkout-private', import.meta.url).pathname,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${f.bare}.insteadOf`, GIT_CONFIG_VALUE_0: url,
      } });
      let stdout = '', stderr = '';
      p.stdout.on('data', (c) => (stdout += c));
      p.stderr.on('data', (c) => (stderr += c));
      p.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(dest, 'rev-parse', 'HEAD'), f.sha);
    assert.deepEqual(JSON.parse(asked[1].body), { repositories: ['termenbox-source'], permissions: { contents: 'read' } });
    assert.ok(!readFileSync(join(dest, '.git', 'config'), 'utf8').includes(minted));
    assert.ok(!r.stdout.includes(minted.slice(4)) || r.stdout.includes('::add-mask::'));
  } finally { server.close(); }
});
