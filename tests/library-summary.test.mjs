import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installJournalLevelSummaries } from '../src/domain/library.mjs';

function libraryFixture(items) {
  let networkReads = 0;
  const library = {
    client: { getJson: async () => { networkReads += 1; throw new Error('should not make an extra request'); } },
    checkVersion: async () => { networkReads += 1; throw new Error('should not force another version request'); },
    items: async (_id, query) => ({ library: 'user', version: '42', query, total: items.length, items })
  };
  installJournalLevelSummaries(library);
  return { library, networkReads: () => networkReads };
}

test('list summaries preserve fields and rank levels come from retained Zotero Extra and tags', async () => {
  const original = {
    key: 'AAAA0001', title: 'A paper', itemType: 'journalArticle',
    extra: 'CSSCI扩展版\n中科院2区', tags: ['SSCI'], pdf: { key: 'PDF00001' }
  };
  const f = libraryFixture([original]);
  const result = await f.library.items('user', { limit: 50 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].title, original.title);
  assert.equal(result.items[0].pdf.key, 'PDF00001');
  assert.equal(result.items[0].extra, original.extra);
  assert.deepEqual(result.items[0].journalLevels.map(level => level.label), ['CSSCI 扩展版', '中科院二区', 'SSCI']);
  assert.equal(f.networkReads(), 0, 'rank enrichment must not add Zotero API traffic');
});

test('key-only summaries use the same parser without forcing a separate version/read request', async () => {
  const original = { key: 'AAAA0002', title: 'Key result', extra: '北大核心', tags: [] };
  const f = libraryFixture([original]);
  const result = await f.library.items('user', { keys: [original.key] });
  assert.equal(result.items[0].extra, '北大核心');
  assert.deepEqual(result.items[0].journalLevels.map(level => level.id), ['pku']);
  assert.equal(f.networkReads(), 0);
});

test('missing Extra does not block list results and recognized Zotero tags still appear', async () => {
  const f = libraryFixture([{ key: 'AAAA0003', title: 'Tag-only row', tags: [{ tag: 'A&HCI' }] }]);
  const result = await f.library.items('user', { limit: 3 });
  assert.equal(result.items[0].extra, '');
  assert.deepEqual(result.items[0].journalLevels.map(level => level.id), ['ahci']);
  assert.equal(f.networkReads(), 0);
});
