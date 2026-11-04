import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ||= {};
const { callResearchToolWithApi } = await import('../web/lib/workspace-app.js');

test('shared research scope collections use the DSH read API and normalize its collection rows', async () => {
  const calls = [];
  const api = {
    async collections(library) {
      calls.push(['collections', library]);
      return { collections: [
        { key: 'COLL0001', name: '文献综述', meta: { numItems: 6 } },
        { key: 'COLL0002', name: '教师政策', parentCollection: 'COLL0001', meta: { numItems: 2 } },
      ] };
    },
    async requestJson() { throw new Error('collections must not use the research POST route'); },
  };

  const result = await callResearchToolWithApi(api, 'list_collections', { library: 'user' });
  assert.deepEqual(calls, [['collections', 'user']]);
  assert.deepEqual(result, { collections: [
    { key: 'COLL0001', name: '文献综述', itemCount: 6, parentCollection: null, depth: 0 },
    { key: 'COLL0002', name: '教师政策', itemCount: 2, parentCollection: 'COLL0001', depth: 1 },
  ] });
});

test('shared research scope search maps query and paging to DSH items and returns shared packet shape', async () => {
  const calls = [];
  const api = {
    async items(options) {
      calls.push(options);
      return { items: [{ key: 'ITEM0001', title: '教师政策研究' }], total: 13, nextStart: 20 };
    },
    async requestJson() { throw new Error('library search must not use the research POST route'); },
  };

  const result = await callResearchToolWithApi(api, 'search_library', {
    library: 'user', query: '教师政策', mode: 'titleCreatorYear', limit: 20, start: 0,
    collection: 'COLL0001', sort: 'title', direction: 'asc', tag: '政策',
  });
  assert.deepEqual(calls, [{
    library: 'user', q: '教师政策', mode: 'titleCreatorYear', limit: 20, start: 0,
    collection: 'COLL0001', sort: 'title', direction: 'asc', tag: '政策',
  }]);
  assert.deepEqual(result, { items: [{ key: 'ITEM0001', title: '教师政策研究' }], total: 13 });
});

test('research jobs retain the research POST envelope and unsupported tools remain rejected', async () => {
  const calls = [];
  const api = {
    async requestJson(path, options) { calls.push([path, options]); return { id: 'job-1' }; },
  };
  const translateArgs = { kind: 'translate', library: 'user', key: 'TEST0001' };
  await callResearchToolWithApi(api, 'start_research_job', translateArgs);
  assert.deepEqual(calls, [['/research', { method: 'POST', body: { action: 'start', args: translateArgs } }]]);
  calls.length = 0;
  const metadataArgs = { kind: 'translate_metadata', library: 'user', key: 'TEST0001' };
  await callResearchToolWithApi(api, 'start_research_job', metadataArgs);
  assert.deepEqual(calls, [['/research', { method: 'POST', body: { action: 'start', args: metadataArgs } }]]);
  calls.length = 0;
  const annotationArgs = {
    kind: 'translate_annotations', library: 'user', keys: ['TEST0001'],
    sourceIds: ['a'.repeat(16)], sourceVersions: { ['a'.repeat(16)]: 'b'.repeat(64) },
  };
  await callResearchToolWithApi(api, 'start_research_job', annotationArgs);
  assert.deepEqual(calls, [['/research', { method: 'POST', body: { action: 'start', args: annotationArgs } }]]);
  calls.length = 0;
  const result = await callResearchToolWithApi(api, 'research_job', { id: 'job-1' });
  assert.deepEqual(result, { id: 'job-1' });
  assert.deepEqual(calls, [['/research', { method: 'POST', body: { action: 'status', id: 'job-1' } }]]);
  await assert.rejects(callResearchToolWithApi(api, 'trash_reader_annotation', {}), /不支持的研究操作/);
});
