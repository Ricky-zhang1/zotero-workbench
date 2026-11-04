import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnnotationComment } from '../src/domain/annotation-comment.mjs';

const LIBRARY = 'user';
const ANNOTATION = 'ANNO1234';
const ATTACHMENT = 'PDF00001';

function startingRows() {
  return new Map([
    [ANNOTATION, {
      key: ANNOTATION, version: 33,
      data: {
        itemType: 'annotation', annotationType: 'highlight', parentItem: ATTACHMENT,
        annotationText: 'A fictional selected passage for testing the Zotero comment editor.',
        annotationComment: 'Earlier reader note.', annotationColor: '#ffd400',
        annotationPageLabel: '1', annotationPageIndex: 0,
        annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[1, 2, 3, 4]] }),
        tags: [{ tag: '类型:研究背景' }]
      }
    }],
    [ATTACHMENT, {
      key: ATTACHMENT, version: 7,
      data: { itemType: 'attachment', contentType: 'application/pdf', title: 'Fictional test.pdf' }
    }]
  ]);
}

async function fixture(t, {
  library = LIBRARY, writeStatus = 204, applyBeforeError = false,
  throwBeforeApply = false, readbackFailure = false, holdWrite = false
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wb-annotation-comment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const items = startingRows();
  const writes = [];
  const reads = [];
  const events = [];
  let readbackFailuresRemaining = readbackFailure ? 1 : 0;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  let releaseWrite;
  const writeGate = holdWrite ? new Promise(resolve => { releaseWrite = resolve; }) : null;
  const session = {
    ready: async () => {},
    emit: event => events.push(event),
    library: {
      raw: async (requestedLibrary, key) => {
        reads.push({ kind: 'raw', library: requestedLibrary, key });
        const item = items.get(key);
        if (!item) { const error = new Error('not found'); error.code = 'not_found'; throw error; }
        return structuredClone(item);
      },
      invalidate: requestedLibrary => events.push({ kind: 'invalidate', library: requestedLibrary })
    },
    client: {
      status: { writes: 'available', serverId: 'server-test-1' },
      getJson: async path => {
        reads.push({ kind: 'getJson', path });
        if (readbackFailuresRemaining && writes.length && path.endsWith(`/items/${ANNOTATION}`)) {
          readbackFailuresRemaining--;
          throw new Error('readback unavailable');
        }
        const annotation = structuredClone(items.get(ANNOTATION));
        if (path.endsWith(`/items/${ANNOTATION}`)) return { data: annotation };
        if (path.includes(`/items?itemType=annotation&itemKey=${ANNOTATION}`))
          return { data: annotation.data.deleted ? [] : [annotation] };
        if (path.endsWith(`/items/${ATTACHMENT}/children?itemType=annotation`))
          return { data: annotation.data.deleted ? [] : [annotation] };
        throw new Error(`Unexpected GET ${path}`);
      },
      write: async (method, path, options) => {
        writes.push({ method, path, options });
        signalWriteStarted();
        if (writeGate) await writeGate;
        assert.equal(method, 'PATCH');
        const patch = JSON.parse(options.body);
        if ((!throwBeforeApply && writeStatus === 200) || (!throwBeforeApply && writeStatus === 204) || applyBeforeError) {
          Object.assign(items.get(ANNOTATION).data, patch);
          items.get(ANNOTATION).version++;
        }
        if (applyBeforeError) throw Object.assign(new Error('socket timed out'), { code: 'zotero_error' });
        if (throwBeforeApply) throw Object.assign(new Error('socket timed out before response'), { code: 'zotero_error' });
        return { status: writeStatus, headers: new Headers({ 'zotero-server-id': 'server-test-1' }) };
      }
    }
  };
  return {
    comments: new AnnotationComment({ session, directory }), session, items, writes, reads, events, directory,
    library, writeStarted, releaseWrite: () => releaseWrite?.()
  };
}

async function beginEdit(f, overrides = {}) {
  const target = await f.comments.read({ library: f.library, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  return {
    target,
    args: {
      library: f.library, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT,
      editToken: target.editToken,
      expectedVersion: target.annotationVersion,
      expectedComment: target.comment,
      comment: 'A temporary updated reader note.',
      ...overrides
    }
  };
}

test('read binds the current Zotero comment, PDF identity, versions, and server to a short-lived edit token', async t => {
  const f = await fixture(t);
  const result = await f.comments.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  assert.equal(result.status, 'ready');
  assert.equal(result.comment, 'Earlier reader note.');
  assert.equal(result.annotationVersion, 33);
  assert.equal(result.attachmentVersion, 7);
  assert.equal(result.serverId, 'server-test-1');
  assert.equal(result.editable, true);
  assert.match(result.editToken, /^[a-f0-9]{48}$/);
  assert.equal(result.sourceGuard.serverId, result.serverId);
  assert.equal(result.sourceGuard.annotationVersion, 33);
  assert.equal(f.writes.length, 0);
});

test('update sends one annotationComment-only version-checked PATCH and verifies the unchanged source fields', async t => {
  const f = await fixture(t);
  const { args } = await beginEdit(f);
  const original = structuredClone(f.items.get(ANNOTATION).data);
  const result = await f.comments.update(args);
  assert.equal(result.status, 'verified');
  assert.equal(result.verified, true);
  assert.equal(result.comment, args.comment);
  assert.equal(result.annotationVersion, 34);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].path, /\/api\/users\/0\/items\/ANNO1234$/);
  assert.deepEqual(JSON.parse(f.writes[0].options.body), { annotationComment: args.comment });
  assert.equal(f.writes[0].options.headers['If-Unmodified-Since-Version'], '33');
  assert.deepEqual(f.items.get(ANNOTATION).data, { ...original, annotationComment: args.comment });
  assert.ok(f.events.some(event => event.kind === 'invalidate' && event.library === LIBRARY));
  assert.ok(f.events.some(event => event.kind === 'library' && event.library === LIBRARY));
  const journalText = await readFile(join(f.directory, `${result.operationId}.json`), 'utf8');
  const journal = JSON.parse(journalText);
  assert.equal(journal.status, 'verified');
  assert.doesNotMatch(journalText, /Earlier reader note|temporary updated reader note/);
});

test('stale version/comment, changed source, or changed server refuses the PATCH', async t => {
  const f = await fixture(t);
  const { args } = await beginEdit(f);
  f.items.get(ANNOTATION).version++;
  f.items.get(ANNOTATION).data.annotationComment = 'Changed elsewhere.';
  await assert.rejects(f.comments.update(args), /已变化；未覆盖备注/);
  assert.equal(f.writes.length, 0);

  const g = await fixture(t);
  const edit = await beginEdit(g);
  g.session.client.status.serverId = 'different-server';
  await assert.rejects(g.comments.update(edit.args), /已变化；未覆盖备注/);
  assert.equal(g.writes.length, 0);
});

test('a Zotero 412 conflict is recorded as rejected without retrying or overwriting', async t => {
  const f = await fixture(t, { writeStatus: 412 });
  const { args } = await beginEdit(f);
  let operationId;
  await assert.rejects(f.comments.update(args), error => {
    assert.match(error.message, /版本或 Zotero 实例已变化/);
    operationId = error.operationId;
    return true;
  });
  assert.equal(f.writes.length, 1);
  assert.equal(f.items.get(ANNOTATION).data.annotationComment, 'Earlier reader note.');
  assert.match(operationId, /^[a-f0-9]{64}$/);
  const record = JSON.parse(await readFile(join(f.directory, `${operationId}.json`), 'utf8'));
  assert.equal(record.status, 'rejected');
  const nextRead = await f.comments.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  assert.equal(nextRead.editable, true, 'a definite conflict can be retried only after a fresh read');
});

test('deleted annotations and annotations under a different parent PDF cannot be read for editing', async t => {
  const f = await fixture(t);
  f.items.get(ANNOTATION).data.deleted = true;
  await assert.rejects(f.comments.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT }), /已删除/);
  f.items.get(ANNOTATION).data.deleted = false;
  f.items.get(ANNOTATION).data.parentItem = 'OTHER001';
  await assert.rejects(f.comments.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT }), /不属于当前 PDF/);
  assert.equal(f.writes.length, 0);
});

test('explicitly unknown deletion states and deleted PDF parents are refused', async t => {
  const annotationUnknown = await fixture(t);
  annotationUnknown.items.get(ANNOTATION).data.deleted = 'unknown';
  await assert.rejects(annotationUnknown.comments.read({
    library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT
  }), /无法确认这条批注处于活动状态/);

  const deletedPdf = await fixture(t);
  deletedPdf.items.get(ATTACHMENT).data.deleted = true;
  await assert.rejects(deletedPdf.comments.read({
    library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT
  }), /PDF 附件已删除/);

  const unknownPdf = await fixture(t);
  unknownPdf.items.get(ATTACHMENT).data.deleted = 'unknown';
  await assert.rejects(unknownPdf.comments.read({
    library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT
  }), /无法确认对应 PDF 附件仍处于活动状态/);
  assert.equal(annotationUnknown.writes.length + deletedPdf.writes.length + unknownPdf.writes.length, 0);
});

test('an empty string clears the existing Zotero comment and is verified', async t => {
  const f = await fixture(t);
  const { args } = await beginEdit(f, { comment: '' });
  const result = await f.comments.update(args);
  assert.equal(result.status, 'verified');
  assert.equal(result.comment, '');
  assert.deepEqual(JSON.parse(f.writes[0].options.body), { annotationComment: '' });
  assert.equal(f.items.get(ANNOTATION).data.annotationComment, '');
});

test('a transport timeout after a change reconciles on read and releases the target lock only after verification', async t => {
  const f = await fixture(t, { applyBeforeError: true });
  const { args } = await beginEdit(f);
  const result = await f.comments.update(args);
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(result.verified, false);
  assert.equal(f.writes.length, 1);
  const record = JSON.parse(await readFile(join(f.directory, `${result.operationId}.json`), 'utf8'));
  assert.equal(record.status, 'outcome-unknown');
  assert.match(record.immutableSnapshotHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(record), /Earlier reader note|temporary updated reader note/);
  await assert.rejects(f.comments.update(args), /凭证已失效/);
  assert.equal(f.writes.length, 1);
  const readback = await f.comments.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  assert.equal(readback.comment, args.comment);
  assert.equal(readback.lastOperation.status, 'verified');
  assert.equal(readback.lastOperation.currentCommentMatchesRequested, true);
  assert.equal(readback.lastOperation.immutableSourceMatches, true);
  assert.equal(readback.editable, true);
  assert.match(readback.editToken, /^[a-f0-9]{48}$/);
});

test('a second surface cannot obtain a different edit token while the same annotation is in flight', async t => {
  const f = await fixture(t, { holdWrite: true });
  const { args } = await beginEdit(f);
  const pending = f.comments.update(args);
  await f.writeStarted;
  const secondSurface = new AnnotationComment({ session: f.session, directory: f.directory });
  const blocked = await secondSurface.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  assert.equal(blocked.editable, false);
  assert.equal(blocked.lastOperation.status, 'in-flight');
  assert.equal(Object.hasOwn(blocked, 'editToken'), false);
  assert.equal(f.writes.length, 1);
  f.releaseWrite();
  assert.equal((await pending).status, 'verified');
});

test('an unapplied unknown write blocks new text and tokens across a new service instance', async t => {
  const f = await fixture(t, { throwBeforeApply: true });
  const { args } = await beginEdit(f);
  const result = await f.comments.update(args);
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(f.writes.length, 1);
  const restarted = new AnnotationComment({ session: f.session, directory: f.directory });
  const readback = await restarted.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  assert.equal(readback.comment, 'Earlier reader note.');
  assert.equal(readback.editable, false);
  assert.equal(readback.lastOperation.status, 'outcome-unknown');
  assert.equal(readback.editBlockedBy.operationId, result.operationId);
  assert.equal(Object.hasOwn(readback, 'editToken'), false);
  await assert.rejects(restarted.update({
    library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT,
    editToken: readback.editToken, expectedVersion: readback.annotationVersion,
    expectedComment: readback.comment, comment: 'A different note after uncertainty.'
  }), /凭证无效/);
  assert.equal(f.writes.length, 1);
});

test('a failed post-write readback stays unknown until a later read verifies it', async t => {
  const f = await fixture(t, { readbackFailure: true });
  const { args } = await beginEdit(f);
  const result = await f.comments.update(args);
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(result.verified, false);
  assert.equal(f.writes.length, 1);
  assert.match(result.operationId, /^[a-f0-9]{64}$/);
  const record = JSON.parse(await readFile(join(f.directory, `${result.operationId}.json`), 'utf8'));
  assert.equal(record.status, 'outcome-unknown');
  const readback = await f.comments.read({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
  assert.equal(readback.comment, args.comment);
  assert.equal(readback.lastOperation.status, 'verified');
  assert.equal(readback.editable, true);
});

test('group library identity is preserved in reads and the write path', async t => {
  const f = await fixture(t, { library: 'g42' });
  const { args } = await beginEdit(f);
  const result = await f.comments.update(args);
  assert.equal(result.library, 'g42');
  assert.match(f.writes[0].path, /\/api\/groups\/42\/items\/ANNO1234$/);
  assert.equal(f.reads.some(read => read.kind === 'raw' && read.library === 'g42'), true);
});
