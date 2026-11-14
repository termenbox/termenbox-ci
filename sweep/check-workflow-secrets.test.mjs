import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWorkflow, trustedNames, triggers } from './check-workflow-secrets.mjs';

const wf = (on, body, top = '') => `name: x\non:\n${on}\n${top}jobs:\n${body}`;
const SECRET = '  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.DEPLOY_KEY }}\n';
const CHECK = '      - run: gh api "repos/$R/collaborators/$ACTOR/permission"\n';

test('triggers_reads_the_three_spellings', () => {
  assert.deepEqual(triggers('on: push\njobs:\n'), ['push']);
  assert.deepEqual(triggers('on: [push, pull_request]\njobs:\n'), ['push', 'pull_request']);
  assert.deepEqual(triggers('on:\n  issues:\n    types: [edited]\n  workflow_dispatch:\njobs:\n'), ['issues', 'workflow_dispatch']);
});

test('fork_pr_cannot_reach_a_secret', () => {
  for (const on of ['  pull_request:', '  pull_request_target:']) {
    const p = checkWorkflow('a.yaml', wf(on, SECRET));
    assert.equal(p.length, 1, on);
    assert.match(p[0], /job j reads DEPLOY_KEY unguarded/);
  }
});

test('issue_and_comment_triggers_cannot_reach_a_secret', () => {
  for (const on of ['  issues:', '  issue_comment:', '  discussion_comment:']) {
    assert.equal(checkWorkflow('a.yaml', wf(on, SECRET)).length, 1, on);
  }
});

test('write_token_without_a_permission_check_fails', () => {
  const body = '  j:\n    runs-on: x\n    steps:\n      - run: echo hi\n';
  const top = 'permissions:\n  contents: write\n';
  assert.equal(checkWorkflow('a.yaml', wf('  issue_comment:', body, top)).length, 1);
  assert.equal(checkWorkflow('a.yaml', wf('  pull_request_target:', body, 'permissions: write-all\n')).length, 1);
  assert.equal(checkWorkflow('a.yaml', wf('  issues:', '  j:\n    permissions:\n      issues: write\n    steps:\n      - run: x\n')).length, 1);
});

test('a_fork_pull_request_token_is_read_only_so_only_secrets_count', () => {
  const body = '  j:\n    permissions:\n      pull-requests: write\n    steps:\n      - run: echo hi\n';
  assert.deepEqual(checkWorkflow('a.yaml', wf('  pull_request:', body)), []);
});

test('first_step_permission_check_guards_the_job', () => {
  const body = `  j:\n    runs-on: x\n    permissions:\n      issues: write\n    steps:\n${CHECK}      - run: echo \${{ secrets.DEPLOY_KEY }}\n`;
  assert.deepEqual(checkWorkflow('a.yaml', wf('  issue_comment:', body)), []);
});

test('a_permission_check_that_is_not_the_first_step_does_not_count', () => {
  const body = `  j:\n    steps:\n      - run: echo \${{ secrets.DEPLOY_KEY }}\n${CHECK}`;
  assert.equal(checkWorkflow('a.yaml', wf('  issue_comment:', body)).length, 1);
});

test('a_job_needing_a_guarded_job_is_guarded', () => {
  const body = `  gate:\n    steps:\n${CHECK}  j:\n    needs: gate\n    permissions:\n      issues: write\n    steps:\n      - run: echo \${{ secrets.DEPLOY_KEY }}\n`;
  assert.deepEqual(checkWorkflow('a.yaml', wf('  issues:', body)), []);
  const open = `  gate:\n    steps:\n      - run: echo\n  j:\n    needs: [gate]\n    steps:\n      - run: echo \${{ secrets.DEPLOY_KEY }}\n`;
  assert.equal(checkWorkflow('a.yaml', wf('  issues:', open)).length, 1);
});

test('a_job_limited_to_dispatch_is_guarded_but_an_or_is_not', () => {
  const guard = (cond) => `  j:\n    if: ${cond}\n    steps:\n      - run: echo \${{ secrets.DEPLOY_KEY }}\n`;
  const on = '  workflow_dispatch:\n  issues:';
  assert.deepEqual(checkWorkflow('a.yaml', wf(on, guard("github.event_name == 'workflow_dispatch'"))), []);
  assert.equal(checkWorkflow('a.yaml', wf(on, guard("github.event_name == 'workflow_dispatch' || github.event_name == 'issues'"))).length, 1);
});

test('workflow_level_secret_and_inherited_secrets_fail', () => {
  assert.equal(checkWorkflow('a.yaml', wf('  issues:', '  j:\n    steps:\n      - run: x\n', 'env:\n  K: ${{ secrets.K }}\n')).length, 1);
  assert.equal(checkWorkflow('a.yaml', wf('  pull_request:', '  j:\n    uses: ./.github/workflows/b.yaml\n    secrets: inherit\n')).length, 1);
});

test('workflow_run_on_a_named_branch_is_trusted', () => {
  const on = '  workflow_run:\n    workflows: [CI]\n    branches: [develop]';
  assert.deepEqual(checkWorkflow('a.yaml', wf(on, SECRET)), []);
  assert.equal(checkWorkflow('a.yaml', wf('  workflow_run:\n    workflows: [CI]', SECRET)).length, 1);
});

test('trusted_triggers_and_github_token_are_ignored', () => {
  assert.deepEqual(checkWorkflow('a.yaml', wf('  push:\n  workflow_dispatch:', SECRET)), []);
  const tok = '  j:\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n';
  assert.deepEqual(checkWorkflow('a.yaml', wf('  pull_request:', tok)), []);
});

test('a_workflow_run_that_follows_only_dispatched_workflows_is_trusted', () => {
  const upstream = 'name: Release\non:\n  workflow_dispatch:\njobs:\n';
  const open = 'name: Open\non:\n  pull_request:\njobs:\n';
  const trusted = trustedNames([upstream, open]);
  assert.deepEqual([...trusted], ['Release']);
  const after = (list) => wf(`  workflow_run:\n    workflows: ${list}\n    types: [completed]`, SECRET);
  assert.deepEqual(checkWorkflow('a.yaml', after("['Release']"), trusted), []);
  assert.deepEqual(checkWorkflow('a.yaml', after('\n      - Release'), trusted), []);
  assert.equal(checkWorkflow('a.yaml', after("['Open']"), trusted).length, 1);
  assert.equal(checkWorkflow('a.yaml', after("['Release', 'Open']"), trusted).length, 1);
  assert.equal(checkWorkflow('a.yaml', after("['Unknown']"), trusted).length, 1);
  assert.equal(checkWorkflow('a.yaml', after("['Release']")).length, 1);
});
