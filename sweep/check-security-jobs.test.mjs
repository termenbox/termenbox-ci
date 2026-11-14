import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRepo, checkWorkflow } from './check-security-jobs.mjs';

const wf = (steps) => `name: x\non: push\njobs:\n  fuzz:\n    runs-on: x\n    steps:\n${steps}`;

test('security_tool_jobs_publish_no_crash_inputs', () => {
  const upload = wf('      - run: cargo fuzz run parse\n      - uses: actions/upload-artifact@abc # v4\n        with:\n          path: fuzz/artifacts\n');
  assert.match(checkWorkflow('a.yaml', upload)[0], /job fuzz uploads an artifact/);
  const sarif = wf('      - run: zizmor --format sarif .\n      - uses: github/codeql-action/upload-sarif@abc\n');
  assert.match(checkWorkflow('a.yaml', sarif)[0], /code-scanning/);
  const comment = wf('      - run: pnpm audit\n      - run: gh pr comment 1 --body-file audit.txt\n');
  assert.match(checkWorkflow('a.yaml', comment)[0], /posts to a pull request/);
  const api = wf('      - run: cargo deny check\n      - run: gh api repos/o/r/issues/1/comments -f body=x\n');
  assert.equal(checkWorkflow('a.yaml', api).length, 1);
});

test('a_tool_job_that_only_runs_the_tool_passes', () => {
  assert.deepEqual(checkWorkflow('a.yaml', wf('      - run: cargo fuzz run parse -- -max_total_time=60\n')), []);
});

test('a_job_without_a_security_tool_may_upload_and_comment', () => {
  assert.deepEqual(checkWorkflow('a.yaml', wf('      - run: cargo test\n      - uses: actions/upload-artifact@abc\n      - run: gh pr comment 1 -b hi\n')), []);
});

test('each_job_is_judged_alone', () => {
  const text = 'on: push\njobs:\n  audit:\n    steps:\n      - run: cargo deny check\n  report:\n    steps:\n      - uses: actions/upload-artifact@abc\n';
  assert.deepEqual(checkWorkflow('a.yaml', text), []);
});

test('comments_are_ignored', () => {
  assert.deepEqual(checkWorkflow('a.yaml', wf('      # cargo fuzz, then gh pr comment\n      - run: cargo test\n')), []);
});

test('repository_workflows_pass', () => {
  assert.deepEqual(checkRepo(), []);
});
