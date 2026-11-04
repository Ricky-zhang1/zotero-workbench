import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StdioClient } from './mcp-client.mjs';

test('reader comment tools are app-only, bind edits to a read token, and expose unknown results', async t => {
  const client = new StdioClient();
  t.after(() => client.close());
  await client.ready();
  const { tools } = await client.request('tools/list');
  const read = tools.find(tool => tool.name === 'read_reader_annotation_comment');
  const update = tools.find(tool => tool.name === 'update_reader_annotation_comment');
  assert.ok(read);
  assert.ok(update);
  assert.deepEqual(Object.keys(read.inputSchema.properties).sort(), ['annotationKey', 'attachmentKey', 'library']);
  assert.deepEqual(Object.keys(update.inputSchema.properties).sort(), [
    'annotationKey', 'attachmentKey', 'comment', 'editToken', 'expectedComment', 'expectedVersion', 'library'
  ]);
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(update.annotations.readOnlyHint, false);
  assert.equal(update.annotations.destructiveHint, false);
  assert.equal(read._meta.ui.visibility.join(','), 'app');
  assert.equal(update._meta.ui.visibility.join(','), 'app');
  assert.match(update.description, /不要重发/);
  assert.match(update.description, /read_reader_annotation_comment/);
});
