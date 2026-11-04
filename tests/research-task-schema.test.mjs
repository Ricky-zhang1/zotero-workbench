import assert from 'node:assert/strict';
import test from 'node:test';
import { StdioClient } from './mcp-client.mjs';

test('backend initializes research job schemas for TextFold and derived translations', async t => {
  const client = new StdioClient();
  t.after(() => client.close());
  await client.ready();
  const { tools } = await client.request('tools/list');
  const tool = tools.find(candidate => candidate.name === 'start_research_job');
  assert.ok(tool, 'start_research_job is registered');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.match(tool.description, /translate_annotations/);

  const properties = tool.inputSchema.properties;
  assert.ok(properties.kind.enum.includes('fold'));
  assert.ok(properties.kind.enum.includes('draft'));
  assert.ok(properties.kind.enum.includes('translate'));
  assert.ok(properties.kind.enum.includes('translate_annotations'));
  assert.equal(properties.sourceIds.items.pattern, '^[a-f0-9]{16}$');
  assert.equal(properties.sourceVersions.additionalProperties.pattern, '^[a-f0-9]{64}$');

  const invalid = await client.call('start_research_job', { kind: 'translate', library: 'user' });
  assert.equal(invalid.isError, true, 'a translation without a source key is rejected before starting work');
  const mixedTranslation = await client.call('start_research_job', {
    kind: 'translate', library: 'user', key: 'TEST0001', purpose: 'review',
  });
  assert.equal(mixedTranslation.isError, true, 'translation cannot carry draft-only parameters');
  const oversizedBatch = await client.call('start_research_job', {
    kind: 'translate_annotations', library: 'user', keys: ['TEST0001'],
    sourceIds: Array.from({ length: 21 }, (_, index) => index.toString(16).padStart(16, '0')),
    sourceVersions: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
      index.toString(16).padStart(16, '0'), 'a'.repeat(64),
    ])),
  });
  assert.equal(oversizedBatch.isError, true, 'annotation translation batches over 20 are rejected');
});
