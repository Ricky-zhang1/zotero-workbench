import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchReaderAnnotationCommentRequest, readerAnnotationCommentOperationsDirectory } from '../index.js';
import { dirname, join } from 'node:path';

const identity = { library: 'user', annotationKey: 'ANN00001', attachmentKey: 'PDF00001' };
const token = 'a'.repeat(48);

test('DSH uses the same explicit state-root ledger directory as the MCP host', () => {
  const keyFile = '/private/test-state/zotero-api-keys.json';
  assert.equal(readerAnnotationCommentOperationsDirectory(keyFile, { ZOTERO_WORKBENCH_STATE_DIR: '/private/test-state' }), dirname(keyFile));
  assert.equal(readerAnnotationCommentOperationsDirectory(keyFile, {}), join(dirname(keyFile), 'operations'));
});

test('DSH annotation-comment bridge returns a minimal read contract from the shared service', async () => {
  let received;
  const service = {
    async read(args) {
      received = args;
      return {
        status: 'ready', ...identity, comment: '原备注', annotationVersion: 4, attachmentVersion: 9,
        editable: true, editToken: token, editTokenExpiresAt: 1_800_000_000_000,
        lastOperation: { operationId: 'b'.repeat(64), status: 'verified', message: '核对完成' },
        serverId: 'must-not-escape', sourceGuard: { fingerprint: 'must-not-escape' },
      };
    },
  };
  const result = await dispatchReaderAnnotationCommentRequest(service, {
    tool: 'read_reader_annotation_comment', args: identity,
  });
  assert.deepEqual(received, identity);
  assert.deepEqual(result, {
    status: 'ready', ...identity, comment: '原备注', annotationVersion: 4, attachmentVersion: 9,
    editable: true, editToken: token, editTokenExpiresAt: 1_800_000_000_000,
    lastOperation: { operationId: 'b'.repeat(64), status: 'verified', message: '核对完成' },
  });
});

test('DSH read-only reconciliation strips the ephemeral edit token from the HTTP result', async () => {
  const service = {
    async read() {
      return {
        status: 'ready', ...identity, comment: '当前备注', annotationVersion: 5, attachmentVersion: 9,
        editable: true, editToken: token, editTokenExpiresAt: 1_800_000_000_000,
        lastOperation: { status: 'outcome-unknown', message: '上次备注写入尚未核实。', serverId: 'private' },
      };
    },
  };
  const result = await dispatchReaderAnnotationCommentRequest(service, {
    tool: 'read_reader_annotation_comment', args: identity, readOnly: true,
  });
  assert.deepEqual(result, {
    status: 'ready', ...identity, comment: '当前备注', annotationVersion: 5, attachmentVersion: 9,
    editable: false, readOnly: true,
    lastOperation: { status: 'outcome-unknown', message: '上次备注写入尚未核实。' },
  });
});

test('DSH annotation-comment bridge sends exact edit guards and returns verified update state only', async () => {
  const updateArgs = {
    ...identity, expectedVersion: 4, expectedComment: '原备注', comment: '新备注', editToken: token,
  };
  let received;
  const service = {
    async update(args) {
      received = args;
      return {
        status: 'verified', verified: true, changed: true, operationId: 'c'.repeat(64),
        ...identity, comment: '新备注', annotationVersion: 5, attachmentVersion: 9,
        serverId: 'must-not-escape', sourceGuard: { fingerprint: 'must-not-escape' },
      };
    },
  };
  const result = await dispatchReaderAnnotationCommentRequest(service, {
    tool: 'update_reader_annotation_comment', args: updateArgs,
  });
  assert.deepEqual(received, updateArgs);
  assert.deepEqual(result, {
    status: 'verified', verified: true, changed: true, operationId: 'c'.repeat(64),
    ...identity, comment: '新备注', annotationVersion: 5, attachmentVersion: 9,
  });
});

test('DSH annotation-comment bridge rejects groups, extra fields, and missing write guards before service calls', async () => {
  let calls = 0;
  const service = {
    async read() { calls += 1; return {}; },
    async update() { calls += 1; return {}; },
  };
  const invalid = [
    { tool: 'create_note', args: identity },
    { tool: 'read_reader_annotation_comment', args: { ...identity, extra: true } },
    { tool: 'read_reader_annotation_comment', args: { ...identity, library: 'g1' } },
    { tool: 'read_reader_annotation_comment', args: identity, readOnly: false },
    { tool: 'update_reader_annotation_comment', args: { ...identity, expectedVersion: 4, expectedComment: 'old', comment: 'new', editToken: token }, readOnly: true },
    { tool: 'update_reader_annotation_comment', args: { ...identity, expectedVersion: 4, expectedComment: 'old', comment: 'new' } },
    { tool: 'update_reader_annotation_comment', args: { ...identity, expectedVersion: 4, expectedComment: 'old', comment: 'new', editToken: 'bad' } },
    { tool: 'update_reader_annotation_comment', args: { ...identity, expectedVersion: -1, expectedComment: 'old', comment: 'new', editToken: token } },
    { tool: 'update_reader_annotation_comment', args: { ...identity, expectedVersion: 4, expectedComment: 'old', comment: 'new', editToken: token, extra: true } },
  ];
  for (const request of invalid) {
    await assert.rejects(dispatchReaderAnnotationCommentRequest(service, request), error => error.status === 400);
  }
  assert.equal(calls, 0);
});

test('DSH preserves shared service guard errors as conflicts instead of retrying or hiding them', async () => {
  const service = {
    async update() {
      const error = new Error('当前批注版本已变化，未修改。');
      error.name = 'AnnotationCommentError';
      error.code = 'version_conflict';
      throw error;
    },
  };
  await assert.rejects(
    dispatchReaderAnnotationCommentRequest(service, {
      tool: 'update_reader_annotation_comment',
      args: { ...identity, expectedVersion: 4, expectedComment: 'old', comment: 'new', editToken: token },
    }),
    error => error.status === 409 && error.code === 'annotation_comment_error' && /版本已变化/.test(error.message),
  );
});
