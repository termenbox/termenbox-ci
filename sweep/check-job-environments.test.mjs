import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRepo, checkWorkflow, secretReads } from './check-job-environments.mjs';

const wf = (job) => `name: x\non: workflow_dispatch\njobs:\n  j:\n${job}`;

test('secret_read_without_environment_fails', () => {
  const p = checkWorkflow('a.yaml', wf('    runs-on: x\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n'));
  assert.equal(p.length, 1);
  assert.match(p[0], /job j reads TOKEN/);
});

test('secret_read_with_environment_passes', () => {
  assert.deepEqual(checkWorkflow('a.yaml', wf('    environment: site\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n')), []);
});

test('github_token_and_comments_are_ignored', () => {
  assert.deepEqual(secretReads('# ${{ secrets.X }}\nx: ${{ secrets.GITHUB_TOKEN }}'), []);
});

test('indexed_secret_read_is_caught', () => {
  assert.deepEqual(secretReads('x: ${{ secrets[matrix.k] }}'), ['*']);
});

test('workflow_level_secret_read_fails', () => {
  const p = checkWorkflow('a.yaml', 'env:\n  K: ${{ secrets.K }}\njobs:\n  j:\n    environment: e\n');
  assert.equal(p.length, 1);
});

test('caller_with_inherit_needs_a_callee_job_with_environment', () => {
  const caller = wf('    uses: ./.github/workflows/b.yaml\n    secrets: inherit\n');
  const ok = (path) => (path.endsWith('b.yaml') ? 'jobs:\n  k:\n    environment: e\n' : undefined);
  const no = () => 'jobs:\n  k:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n';
  const none = () => 'jobs:\n  k:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n';
  assert.deepEqual(checkWorkflow('a.yaml', caller, ok), []);
  assert.equal(checkWorkflow('a.yaml', caller, no).length, 1);
  // a callee that reads no secret has nothing to gate; the day it reads one its own job fails the first rule
  assert.deepEqual(checkWorkflow('a.yaml', caller, none), []);
  assert.equal(checkWorkflow('a.yaml', caller, () => undefined).length, 1);
});

test('repository_workflows_and_actions_pass', () => {
  assert.deepEqual(checkRepo(), []);
});

test('repository_level_secrets_are_allowed_and_any_other_still_needs_an_environment', () => {
  const wf = (name) => `on: push\njobs:\n  a:\n    steps:\n      - run: x\n        env:\n          T: \${{ secrets.${name} }}\n`;
  assert.deepEqual(checkWorkflow('a.yaml', wf('REPORTER_APP_KEY')), []);
  assert.deepEqual(checkWorkflow('a.yaml', wf('DISPATCHER_APP_KEY')), []);
  assert.equal(checkWorkflow('a.yaml', wf('R2_RELEASE_SECRET_ACCESS_KEY')).length, 1);
});
