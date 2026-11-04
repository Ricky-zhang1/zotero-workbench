import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnnotationTrash } from '../src/domain/annotation-trash.mjs';

const LIBRARY = 'user';
const ANNOTATION = 'ANNO1234';
const ATTACHMENT = 'PDF00001';

function rows() {
  return new Map([
    [ANNOTATION, {
      key: ANNOTATION, version: 11,
      data: {
        itemType: 'annotation', annotationType: 'highlight', parentItem: ATTACHMENT, deleted: false,
        annotationText: 'Highlight target alpha: Fictional sample sentence for verifying reversible annotation controls.',
        annotationComment: '【工作台验收专用】模拟高亮，仅用于删除/恢复操作验收；非研究批注。',
        annotationColor: '#ffd400', annotationPageLabel: '1', annotationPageIndex: 0,
        annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[72, 657, 559.536, 669]] })
      }
    }],
    [ATTACHMENT, {
      key: ATTACHMENT, version: 7,
      data: { itemType: 'attachment', contentType: 'application/pdf', title: '测试论文.pdf' }
    }]
  ]);
}

async function fixture(t, {
  status = 204, trashedAfterWrite = true, restoredAfterWrite = true,
  initiallyTrashed = false, readbackError = null, activeAnnotationVisible = true,
  exactGet404AfterWrite = false
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wb-annotation-trash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const items = rows();
  const writes = [];
  const readbacks = [];
  const events = [];
  let inTrash = initiallyTrashed;
  if (inTrash) items.get(ANNOTATION).data.deleted = true;
  const session = {
    ready: async () => {},
    emit: event => events.push(event),
    library: {
      raw: async (_library, key) => {
        const item = items.get(key);
        if (!item) throw new Error('not found');
        return structuredClone(item);
      },
      invalidate: () => {}
    },
    client: {
      status: { writes: 'available' },
      write: async (method, path, options) => {
        writes.push({ method, path, options });
        if (status === 200 || status === 204) {
          const patch = JSON.parse(options.body);
          if (patch.deleted === 1 && trashedAfterWrite) {
            inTrash = true;
            items.get(ANNOTATION).version += 1;
            items.get(ANNOTATION).data.deleted = true;
          }
          if (patch.deleted === false && restoredAfterWrite) {
            inTrash = false;
            items.get(ANNOTATION).version += 1;
            items.get(ANNOTATION).data.deleted = false;
          }
        }
        return { status };
      },
      getJson: async path => {
        readbacks.push(path);
        if (readbackError && writes.length > 0) throw readbackError;
        const annotation = structuredClone(items.get(ANNOTATION));
        if (path.endsWith(`/items/${ANNOTATION}`)) {
          if (exactGet404AfterWrite && writes.length > 0) {
            const error = new Error('not found'); error.status = 404; throw error;
          }
          return { data: annotation };
        }
        if (path.includes(`/items/${ATTACHMENT}/children?itemType=annotation`)) return { data: !inTrash ? [annotation] : [] };
        if (path.includes(`/items?itemType=annotation&itemKey=${ANNOTATION}`)) return { data: !inTrash && activeAnnotationVisible ? [annotation] : [] };
        if (path.includes('/items/trash?')) return { data: inTrash ? [annotation] : [] };
        throw new Error(`Unexpected read path: ${path}`);
      }
    }
  };
  return { trash: new AnnotationTrash({ session, directory }), session, items, writes, readbacks, events, directory, setInTrash: value => { inTrash = value; items.get(ANNOTATION).data.deleted = value; } };
}

async function preview(f) {
  return f.trash.prepare({ library: LIBRARY, annotationKey: ANNOTATION, attachmentKey: ATTACHMENT });
}

test('preview names exactly one highlight with PDF provenance and writes nothing', async t => {
  const f = await fixture(t);
  const result = await preview(f);
  assert.equal(result.status, 'previewed');
  assert.equal(result.action, 'move_to_trash');
  assert.equal(result.restorationStatus, 'unverified');
  assert.equal(result.annotation.key, ANNOTATION);
  assert.equal(result.annotation.attachmentKey, ATTACHMENT);
  assert.equal(result.annotation.library, LIBRARY);
  assert.equal(result.annotation.text, 'Highlight target alpha: Fictional sample sentence for verifying reversible annotation controls.');
  assert.equal(result.annotation.comment, '【工作台验收专用】模拟高亮，仅用于删除/恢复操作验收；非研究批注。');
  assert.equal(result.annotation.page, 1);
  assert.equal(result.annotation.pageLabel, '1');
  assert.match(result.annotation.url, /annotation=ANNO1234/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.readbacks.length, 1, 'preflight reads the exact annotation state');
  assert.match(f.readbacks[0], /\/items\/ANNO1234$/);
});

test('confirmWrite false never writes; a confirmed single target uses PATCH and API readback', async t => {
  const f = await fixture(t);
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: false }), /明确确认/);
  assert.equal(f.writes.length, 0);

  const next = await preview(f);
  const result = await f.trash.trash({ previewToken: next.previewToken, confirmWrite: true });
  assert.equal(result.status, 'verified');
  assert.equal(result.action, 'moved_to_trash');
  assert.equal(result.restorationStatus, 'unverified');
  assert.equal(result.restoreEntryAvailable, true);
  assert.equal(result.annotationKey, ANNOTATION);
  assert.equal(result.attachmentKey, ATTACHMENT);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].method, 'PATCH');
  assert.match(f.writes[0].path, new RegExp(`/items/${ANNOTATION}$`));
  assert.deepEqual(JSON.parse(f.writes[0].options.body), { deleted: 1 });
  assert.equal(f.writes[0].options.headers['If-Unmodified-Since-Version'], '11');
  assert.equal(f.readbacks.length, 6, 'preflight and post-write checks use exact state plus activity and children lists');
  assert.ok(f.readbacks.some(path => /\/items\/ANNO1234$/.test(path)));
  assert.ok(f.readbacks.some(path => /\/items\?itemType=annotation&itemKey=ANNO1234$/.test(path)));
  assert.ok(f.readbacks.some(path => /\/items\/PDF00001\/children\?itemType=annotation$/.test(path)));
  assert.ok(!f.readbacks.some(path => /\/items\/trash\?/.test(path)));
  assert.deepEqual(f.events, [{ kind: 'library', library: LIBRARY }]);
  assert.ok(f.writes.every(write => write.method !== 'DELETE'));
});

test('wrong parent and non-PDF source are rejected before a preview can write', async t => {
  const f = await fixture(t);
  f.items.get(ANNOTATION).data.parentItem = 'OTHER001';
  await assert.rejects(preview(f), /不属于当前 PDF/);
  f.items.get(ANNOTATION).data.parentItem = ATTACHMENT;
  f.items.get(ATTACHMENT).data.contentType = 'text/html';
  await assert.rejects(preview(f), /不是有效的 PDF 附件/);
  assert.equal(f.writes.length, 0);
});

test('an annotation directly marked deleted is rejected before preview', async t => {
  const f = await fixture(t, { initiallyTrashed: true });
  await assert.rejects(preview(f), /明确处于未删除状态/);
  assert.equal(f.writes.length, 0);
});

test('omitted deleted field permits preview only with matching parent-PDF evidence', async t => {
  const f = await fixture(t, { activeAnnotationVisible: false });
  delete f.items.get(ANNOTATION).data.deleted;
  assert.equal((await preview(f)).status, 'previewed');
  assert.equal(f.writes.length, 0);
  assert.ok(f.readbacks.some(path => path.includes('/children?itemType=annotation')));
});

test('missing deleted field alone, conflicting content, and conflicting versions never authorize removal', async t => {
  for (const conflict of ['missing', 'text', 'version', 'deleted']) {
    const f = await fixture(t);
    delete f.items.get(ANNOTATION).data.deleted;
    const getJson = f.session.client.getJson;
    f.session.client.getJson = async path => {
      const result = await getJson(path);
      if (path.includes('/children?')) {
        if (conflict === 'missing') result.data = [];
        else if (conflict === 'text') result.data[0].data.annotationText = 'Another annotation';
        else if (conflict === 'version') result.data[0].version += 1;
        else result.data[0].data.deleted = true;
      }
      return result;
    };
    await assert.rejects(preview(f), error => error.code === 'deleted_state_unavailable');
    assert.equal(f.writes.length, 0);
  }
});

test('null or malformed deleted fields remain unknown even if the annotation is listed', async t => {
  for (const value of [null, 'unknown', 2]) {
    const f = await fixture(t);
    f.items.get(ANNOTATION).data.deleted = value;
    await assert.rejects(preview(f), error => error.code === 'deleted_state_unavailable');
    assert.equal(f.writes.length, 0);
  }
});

test('removal and restoration verify the original key when active API responses omit deleted', async t => {
  const f = await fixture(t, { activeAnnotationVisible: false });
  const getJson = f.session.client.getJson;
  f.session.client.getJson = async path => {
    const result = await getJson(path);
    for (const item of Array.isArray(result.data) ? result.data : [result.data])
      if (item?.data?.deleted === false) delete item.data.deleted;
    return result;
  };
  const p = await preview(f);
  const removed = await f.trash.trash({ previewToken:p.previewToken, confirmWrite:true });
  assert.equal(removed.status, 'verified');
  const restore = await f.trash.prepareRestore({ operationId:removed.operationId });
  const restored = await f.trash.restore({ previewToken:restore.previewToken, confirmWrite:true });
  assert.equal(restored.status, 'verified');
  assert.equal(restored.annotationKey, ANNOTATION);
  assert.equal(f.writes.length, 2);
});

test('stale annotation or parent-attachment versions block the write', async t => {
  for (const key of [ANNOTATION, ATTACHMENT]) {
    const f = await fixture(t);
    const p = await preview(f);
    f.items.get(key).version += 1;
    await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }), /发生变化/);
    assert.equal(f.writes.length, 0);
  }
});

test('unsupported API rejection is explicit, queryable, and never reported as success', async t => {
  const f = await fixture(t, { status: 400 });
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'trash_unsupported');
    assert.match(error.message, /未接受批注移除操作/);
    assert.equal(error.operationId, p.operationId);
    return true;
  });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].method, 'PATCH');
  assert.equal(f.readbacks.length, 2, 'both no-write preflights ran');
  assert.equal((await f.trash.status(p.operationId)).status, 'rejected');
});

test('a definite write denial may be retried only after a fresh explicit preview and confirmation', async t => {
  const f = await fixture(t);
  f.trash.session.client.write = async (method, path, options) => {
    f.writes.push({ method, path, options });
    const error = new Error('private Zotero details');
    error.code = 'write_denied';
    throw error;
  };
  const first = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: first.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'write_denied');
    assert.doesNotMatch(error.message, /private Zotero details/);
    return true;
  });
  assert.equal((await f.trash.status(first.operationId)).status, 'rejected');

  f.trash.session.client.write = async (method, path, options) => {
    f.writes.push({ method, path, options });
    f.setInTrash(true);
    f.items.get(ANNOTATION).version += 1;
    return { status: 204 };
  };
  const second = await preview(f);
  assert.equal(second.operationId, first.operationId);
  await f.trash.trash({ previewToken: second.previewToken, confirmWrite: true });
  assert.equal(f.writes.length, 2);
  assert.equal((await f.trash.status(first.operationId)).attempt, 2);
});

test('ambiguous write/readback keeps a stable ID and prevents a duplicate PATCH', async t => {
  const f = await fixture(t, { trashedAfterWrite: false });
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'outcome_unknown');
    assert.equal(error.operationId, p.operationId);
    assert.match(error.message, /不要重复确认/);
    return true;
  });
  assert.equal((await f.trash.status(p.operationId)).status, 'outcome-unknown');

  const retryPreview = await preview(f);
  assert.equal(retryPreview.operationId, p.operationId);
  await assert.rejects(f.trash.trash({ previewToken: retryPreview.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'operation_exists');
    assert.match(error.message, /review_operation/);
    return true;
  });
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes.every(write => write.method !== 'DELETE'));
});

test('unknown deletion survives restart and reconcile verifies only exact deleted state with strict version evidence', async t => {
  const f = await fixture(t, { trashedAfterWrite: false });
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }), /不要重复确认/);
  const latestBefore = await f.trash.latestTrash();
  assert.equal(latestBefore.status, 'outcome-unknown');
  assert.equal(latestBefore.reconcileAvailable, true);
  assert.equal(latestBefore.operationId, p.operationId);
  assert.equal(f.writes.length, 1);

  f.items.get(ANNOTATION).version += 1;
  f.setInTrash(true);
  const restarted = new AnnotationTrash({ session: f.trash.session, directory: f.directory });
  const result = await restarted.reconcile({ operationId: p.operationId });
  assert.equal(result.status, 'verified');
  assert.equal(result.action, 'reconciled_removed');
  assert.equal((await restarted.status(p.operationId)).postTrashVersion, f.items.get(ANNOTATION).version);
  assert.equal((await restarted.latestTrash()).restoreEntryAvailable, true);
  assert.equal(f.writes.length, 1, 'reconcile uses GET only');
});

test('unknown deletion with an exact-item 404 remains unresolved and is not reported as deleted', async t => {
  const f = await fixture(t, { exactGet404AfterWrite: true });
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'outcome_unknown');
    assert.equal(error.operationId, p.operationId);
    return true;
  });
  assert.equal((await f.trash.status(p.operationId)).status, 'outcome-unknown');
  assert.equal((await f.trash.latestTrash()).status, 'outcome-unknown');
  assert.equal(f.writes.length, 1);
});

test('legacy unknown deletion without a stored snapshot cannot be reconciled by guessing', async t => {
  const f = await fixture(t, { trashedAfterWrite: false });
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }));
  const record = await f.trash.status(p.operationId);
  delete record.annotationSnapshotHash;
  await writeFile(join(f.directory, `${p.operationId}.json`), JSON.stringify(record));
  f.items.get(ANNOTATION).version += 1;
  f.setInTrash(true);
  const result = await f.trash.reconcile({ operationId: p.operationId });
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(result.action, 'unresolved');
  assert.equal((await f.trash.status(p.operationId)).status, 'outcome-unknown');
  assert.equal(f.writes.length, 1);
});

test('readback transport failure also records outcome-unknown without exposing its details', async t => {
  const f = await fixture(t, { readbackError: new Error('secret URL and private response body') });
  const p = await preview(f);
  await assert.rejects(f.trash.trash({ previewToken: p.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'outcome_unknown');
    assert.doesNotMatch(error.message, /secret URL|private response/);
    return true;
  });
  const record = await f.trash.status(p.operationId);
  assert.equal(record.status, 'outcome-unknown');
  assert.doesNotMatch(await readFile(join(f.directory, `${p.operationId}.json`), 'utf8'), /Highlight target alpha|工作台验收专用/);
});

test('same-version previews share an operation identity while preview tokens stay one-use', async t => {
  const f = await fixture(t);
  const first = await preview(f), second = await preview(f);
  assert.notEqual(first.previewToken, second.previewToken);
  assert.equal(first.operationId, second.operationId);
  await f.trash.trash({ previewToken: first.previewToken, confirmWrite: true });
  await assert.rejects(f.trash.trash({ previewToken: first.previewToken, confirmWrite: true }), /已过期/);
});

async function movedToTrash(f) {
  const deletionPreview = await preview(f);
  const deletion = await f.trash.trash({ previewToken: deletionPreview.previewToken, confirmWrite: true });
  return { deletionPreview, deletion };
}

test('restore preview requires the persisted verified deletion, exact GET state, and matching versions', async t => {
  const f = await fixture(t);
  const { deletion } = await movedToTrash(f);
  const operation = await f.trash.status(deletion.operationId);
  assert.equal(operation.postTrashVersion, f.items.get(ANNOTATION).version);
  assert.equal(operation.restorationStatus, 'unverified', 'the restore entry is available, while live Zotero restore has not yet been verified');

  const preview = await f.trash.prepareRestore({ operationId: deletion.operationId });
  assert.equal(preview.status, 'previewed');
  assert.equal(preview.action, 'restore_to_library');
  assert.equal(preview.sourceOperationId, deletion.operationId);
  assert.equal(preview.annotation.key, ANNOTATION);
  assert.equal(preview.annotation.text, 'Highlight target alpha: Fictional sample sentence for verifying reversible annotation controls.');
  assert.equal(preview.annotation.comment, '【工作台验收专用】模拟高亮，仅用于删除/恢复操作验收；非研究批注。');
  assert.equal(preview.annotation.page, 1);
  assert.equal(f.writes.length, 1, 'preview is read-only; only the earlier trash operation wrote');
  assert.ok(f.readbacks.some(path => /\/items\/ANNO1234$/.test(path)));
  assert.ok(f.readbacks.some(path => /\/items\/PDF00001\/children\?itemType=annotation$/.test(path)));
  assert.ok(!f.readbacks.some(path => /\/items\/trash\?/.test(path)));
});

test('restore confirmation PATCHes the original key and verifies exact state plus parent children', async t => {
  const f = await fixture(t);
  const { deletion } = await movedToTrash(f);
  const preview = await f.trash.prepareRestore({ operationId: deletion.operationId });
  await assert.rejects(f.trash.restore({ previewToken: preview.previewToken, confirmWrite: false }), /明确确认/);
  assert.equal(f.writes.length, 1, 'unconfirmed restore does not write');

  const nextPreview = await f.trash.prepareRestore({ operationId: deletion.operationId });
  const result = await f.trash.restore({ previewToken: nextPreview.previewToken, confirmWrite: true });
  assert.equal(result.status, 'verified');
  assert.equal(result.action, 'restored_to_library');
  assert.equal(result.annotationKey, ANNOTATION);
  assert.equal(f.writes.length, 2);
  const write = f.writes.at(-1);
  assert.equal(write.method, 'PATCH');
  assert.match(write.path, new RegExp(`/items/${ANNOTATION}$`));
  assert.deepEqual(JSON.parse(write.options.body), { deleted: false });
  assert.equal(write.options.headers['If-Unmodified-Since-Version'], String(nextPreview.annotation.itemVersion));
  assert.ok(f.readbacks.some(path => /\/items\/ANNO1234$/.test(path)));
  assert.ok(f.readbacks.some(path => /\/items\/PDF00001\/children\?itemType=annotation$/.test(path)));
  assert.ok(f.readbacks.some(path => /\/items\?itemType=annotation&itemKey=ANNO1234$/.test(path)));
  assert.ok(!f.readbacks.some(path => /\/items\/trash\?/.test(path)));
  assert.equal(f.items.get(ANNOTATION).key, ANNOTATION, 'the original Zotero item remains the target');
  assert.equal(f.items.size, 2, 'restore does not create a replacement annotation');
  assert.equal(f.items.get(ANNOTATION).data.deleted, false);
  assert.equal((await f.trash.status(nextPreview.restoreOperationId)).status, 'verified');
  assert.equal((await f.trash.status(deletion.operationId)).restoredByOperationId, nextPreview.restoreOperationId);
  const restoreJournal = await readFile(join(f.directory, `${nextPreview.restoreOperationId}.json`), 'utf8');
  assert.doesNotMatch(restoreJournal, /Highlight target alpha|工作台验收专用/);
  assert.equal(await f.trash.latestTrash(), null, 'verified restoration clears the latest recoverable deletion pointer');
  assert.deepEqual(f.events, [{ kind: 'library', library: LIBRARY }, { kind: 'library', library: LIBRARY }]);
  assert.ok(f.writes.every(entry => entry.method !== 'DELETE'));
});

test('restore refuses stale, missing, wrong-parent, or already-restored Trash targets before PATCH', async t => {
  for (const mutate of [
    f => { f.items.get(ANNOTATION).version += 1; },
    f => { f.setInTrash(false); },
    f => { f.items.get(ANNOTATION).data.parentItem = 'OTHER001'; },
    f => { f.items.get(ATTACHMENT).version += 1; },
  ]) {
    const f = await fixture(t);
    const { deletion } = await movedToTrash(f);
    mutate(f);
    await assert.rejects(f.trash.prepareRestore({ operationId: deletion.operationId }));
    assert.equal(f.writes.length, 1, 'only the initial move to Trash was written');
  }
});

test('version drift after restore preview blocks the write and consumes the preview', async t => {
  const f = await fixture(t);
  const { deletion } = await movedToTrash(f);
  const preview = await f.trash.prepareRestore({ operationId: deletion.operationId });
  f.items.get(ANNOTATION).version += 1;
  await assert.rejects(f.trash.restore({ previewToken: preview.previewToken, confirmWrite: true }), /版本/);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.trash.restore({ previewToken: preview.previewToken, confirmWrite: true }), /过期/);
});

test('restore unknown outcome is persistent, queryable, and cannot be retried', async t => {
  const f = await fixture(t, { restoredAfterWrite: false });
  const { deletion } = await movedToTrash(f);
  const preview = await f.trash.prepareRestore({ operationId: deletion.operationId });
  await assert.rejects(f.trash.restore({ previewToken: preview.previewToken, confirmWrite: true }), error => {
    assert.equal(error.code, 'outcome_unknown');
    assert.equal(error.operationId, preview.restoreOperationId);
    assert.match(error.message, /不要重复确认/);
    return true;
  });
  assert.equal((await f.trash.status(preview.restoreOperationId)).status, 'outcome-unknown');
  await assert.rejects(f.trash.prepareRestore({ operationId: deletion.operationId }), error => {
    assert.equal(error.code, 'operation_exists');
    assert.match(error.message, /review_operation/);
    return true;
  });
  const reconciled = await f.trash.reconcile({ operationId: preview.restoreOperationId });
  assert.equal(reconciled.status, 'outcome-unknown', 'the still-deleted exact item does not prove restoration');
  assert.equal(reconciled.action, 'unresolved');
  assert.equal(f.writes.length, 2, 'neither reconciliation nor a follow-up sends another PATCH');
});

test('restore reconciliation requires deleted false and a matching parent child, while activity-list omission is auxiliary', async t => {
  const f = await fixture(t, { restoredAfterWrite: false, activeAnnotationVisible: false });
  const { deletion } = await movedToTrash(f);
  const preview = await f.trash.prepareRestore({ operationId: deletion.operationId });
  await assert.rejects(f.trash.restore({ previewToken: preview.previewToken, confirmWrite: true }), /不要重复确认/);
  assert.equal((await f.trash.status(preview.restoreOperationId)).status, 'outcome-unknown');
  f.items.get(ANNOTATION).version += 1;
  f.setInTrash(false);
  const result = await f.trash.reconcile({ operationId: preview.restoreOperationId });
  assert.equal(result.status, 'verified');
  assert.equal(result.action, 'reconciled_restored');
  assert.equal(f.items.get(ANNOTATION).data.deleted, false);
  assert.equal((await f.trash.status(deletion.operationId)).restoredByOperationId, preview.restoreOperationId);
  assert.equal(f.writes.length, 2, 'reconcile verifies the state without retrying the restore PATCH');
});

test('latest verified deletion pointer and restore journal survive a new service instance', async t => {
  const f = await fixture(t);
  const { deletion } = await movedToTrash(f);
  const restarted = new AnnotationTrash({ session: f.trash.session, directory: f.directory });
  const latest = await restarted.latestTrash();
  assert.equal(latest.status, 'verified');
  assert.equal(latest.operationId, deletion.operationId);
  assert.equal(latest.restoreEntryAvailable, true);
  const preview = await restarted.prepareRestore({ operationId: latest.operationId });
  const result = await restarted.restore({ previewToken: preview.previewToken, confirmWrite: true });
  const review = await restarted.status(result.operationId);
  assert.equal(review.kind, 'reader-annotation-restore');
  assert.equal(review.sourceOperationId, deletion.operationId);
  assert.equal(review.status, 'verified');
});
