import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StdioClient } from './mcp-client.mjs';

test('research metadata translation is exposed alongside existing fold and translation kinds', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'zotero-metadata-protocol-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const client = new StdioClient({ ZOTERO_WORKBENCH_STATE_DIR: stateRoot });
  t.after(() => client.close());
  await client.ready();
  const { tools } = await client.request('tools/list');
  const start = tools.find(tool => tool.name === 'start_research_job');
  assert.ok(start);
  assert.deepEqual(start.inputSchema.properties.kind.enum, [
    'fold', 'draft', 'translate', 'translate_annotations', 'translate_metadata'
  ]);
  assert.match(start.description, /translate_metadata.*标题、摘要和语言.*不依赖 PDF/);
  assert.equal(start.annotations.destructiveHint, false);
});
