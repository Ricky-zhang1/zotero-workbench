import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ||= {};
const { callReaderAnnotationCommentToolWithApi } = await import('../web/lib/workspace-app.js');

test('DSH reader comment bridge sends the read identity through the dedicated endpoint', async () => {
  const calls = [];
  const api = {
    async requestJson(path, options) {
      calls.push([path, options]);
      return { comment: '原备注', annotationVersion: 4, editable: true, editToken: 'a'.repeat(48) };
    },
  };
  const args = { library: 'user', annotationKey: 'ANN00001', attachmentKey: 'PDF00001' };
  const result = await callReaderAnnotationCommentToolWithApi(api, 'read_reader_annotation_comment', args);
  assert.deepEqual(result, { comment: '原备注', annotationVersion: 4, editable: true, editToken: 'a'.repeat(48) });
  assert.deepEqual(calls, [[
    '/annotation-comment', { method: 'POST', body: { tool: 'read_reader_annotation_comment', args } },
  ]]);
});

test('DSH reader comment bridge carries exact version, old-comment, and edit-token guards on update', async () => {
  const calls = [];
  const api = {
    async requestJson(path, options) { calls.push([path, options]); return { verified: true, comment: '新备注', annotationVersion: 5 }; },
  };
  const args = {
    library: 'user', annotationKey: 'ANN00001', attachmentKey: 'PDF00001',
    expectedVersion: 4, expectedComment: '原备注', comment: '新备注', editToken: 'a'.repeat(48),
  };
  const result = await callReaderAnnotationCommentToolWithApi(api, 'update_reader_annotation_comment', args);
  assert.deepEqual(result, { verified: true, comment: '新备注', annotationVersion: 5 });
  assert.deepEqual(calls, [[
    '/annotation-comment', { method: 'POST', body: { tool: 'update_reader_annotation_comment', args } },
  ]]);
});

test('DSH reader comment bridge rejects unsupported tools or extra fields before network access', async () => {
  let calls = 0;
  const api = { async requestJson() { calls += 1; return {}; } };
  await assert.rejects(callReaderAnnotationCommentToolWithApi(api, 'create_note', {}), /不支持的批注备注操作/);
  await assert.rejects(callReaderAnnotationCommentToolWithApi(api, 'read_reader_annotation_comment', {
    library: 'user', annotationKey: 'ANN00001', attachmentKey: 'PDF00001', comment: 'unexpected',
  }), /参数不符合/);
  assert.equal(calls, 0);
});

test('DSH read-only reconciliation marks its transport as read-only and cannot be requested for updates', async () => {
  const calls = [];
  const api = { async requestJson(path, options) { calls.push([path, options]); return { comment: '当前备注', readOnly: true }; } };
  const args = { library: 'user', annotationKey: 'ANN00001', attachmentKey: 'PDF00001' };
  await callReaderAnnotationCommentToolWithApi(api, 'read_reader_annotation_comment', args, { readOnly: true });
  assert.deepEqual(calls, [[
    '/annotation-comment', { method: 'POST', body: { tool: 'read_reader_annotation_comment', args, readOnly: true } },
  ]]);
  await assert.rejects(
    callReaderAnnotationCommentToolWithApi(api, 'update_reader_annotation_comment', {
      ...args, expectedVersion: 4, expectedComment: '', comment: 'x', editToken: 'a'.repeat(48),
    }, { readOnly: true }),
    /只读核对仅适用于读取/,
  );
  assert.equal(calls.length, 1);
});
