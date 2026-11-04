import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../dist/runtime.mjs';

test('pinned runtime summaries retain raw Zotero Extra for local journal-level parsing', () => {
  const extra = '期刊等级：CSSCI 扩展版\n中科院二区';
  const summary = summarize({
    key: 'AAAA0004',
    links: {},
    meta: {},
    data: { itemType: 'journalArticle', title: 'A rank-bearing article', extra, tags: [{ tag: 'SSCI' }] },
  });
  assert.equal(summary.extra, extra);
  assert.deepEqual(summary.tags, ['SSCI']);
});
