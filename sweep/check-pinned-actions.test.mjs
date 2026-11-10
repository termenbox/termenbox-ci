import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scan, unpinned } from './check-pinned-actions.mjs';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

describe('check-pinned-actions', () => {
  it('accepts a commit pin with a tag comment and a local path', () => {
    const text = `steps:\n  - uses: actions/checkout@${SHA} # v7\n  - uses: ./.github/actions/deploy-pages\n`;
    assert.deepEqual(unpinned(text), []);
  });

  it('rejects a tag, a branch and a short commit', () => {
    const text = [
      '- uses: actions/checkout@v7',
      '- uses: dtolnay/rust-toolchain@stable',
      '- uses: actions/cache/save@3d3c42e',
      `- uses: "docker/login-action@v4"`,
    ].join('\n');
    assert.deepEqual(
      unpinned(text).map((b) => b.line),
      [1, 2, 3, 4],
    );
  });

  it('rejects a reference with no version at all', () => {
    assert.equal(unpinned('- uses: actions/checkout').length, 1);
  });

  it('finds every uses line in the repository pinned', () => {
    assert.deepEqual(scan(), []);
  });
});
