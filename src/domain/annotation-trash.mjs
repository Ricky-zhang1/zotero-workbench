import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { libraryPrefix } from '../../dist/runtime.mjs';
import { annotationLink, libraryId, itemKey } from './library.mjs';

const KEY = /^[A-Z0-9]{8}$/;
const TOKEN = /^[a-f0-9]{48}$/;
const PREVIEW_TTL_MS = 2 * 60 * 1000;
const JOURNAL_KIND = 'reader-annotation-trash';
const RESTORE_KIND = 'reader-annotation-restore';
const LATEST_TRASH_PATH = 'latest-reader-annotation-trash.json';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AnnotationTrashError extends Error {
  constructor(code, message, operationId) {
    super(message);
    this.name = 'AnnotationTrashError';
    this.code = code;
    if (operationId) this.operationId = operationId;
  }
}

function requireLibrary(value) {
  if (typeof value !== 'string') throw new AnnotationTrashError('invalid_input', '请先选择文库。');
  libraryId(value);
  return value;
}

function requireKey(value, label) {
  if (typeof value !== 'string' || !KEY.test(value))
    throw new AnnotationTrashError('invalid_input', `${label}编号无效。`);
  itemKey(value);
  return value;
}

function pageIndexOf(data) {
  try {
    const value = JSON.parse(String(data?.annotationPosition ?? '{}'))?.pageIndex;
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

function exactItemPath(library, key) {
  return `${libraryPrefix(library)}/items/${encodeURIComponent(key)}`;
}

function activeItemsPath(library, annotationKey) {
  return `${libraryPrefix(library)}/items?itemType=annotation&itemKey=${encodeURIComponent(annotationKey)}`;
}

function annotationChildrenPath(library, attachmentKey) {
  return `${libraryPrefix(library)}/items/${encodeURIComponent(attachmentKey)}/children?itemType=annotation`;
}

function annotationSnapshot(data) {
  return {
    itemType: data?.itemType ?? null,
    annotationType: data?.annotationType ?? null,
    parentItem: data?.parentItem ?? null,
    annotationText: data?.annotationText ?? '',
    annotationComment: data?.annotationComment ?? '',
    annotationPosition: data?.annotationPosition ?? '',
    annotationPageLabel: data?.annotationPageLabel ?? '',
    annotationColor: data?.annotationColor ?? ''
  };
}

function snapshotDigest(data) {
  return digest(annotationSnapshot(data));
}

function isDeleted(item) {
  return item?.data?.deleted === true || item?.data?.deleted === 1 || item?.data?.deleted === '1';
}

function isUndeleted(item) {
  return item?.data?.deleted === false || item?.data?.deleted === 0 || item?.data?.deleted === '0';
}

// Zotero omits `deleted` for ordinary active annotations. Absence alone is
// insufficient: require the same version and content in the parent PDF list.
function isActiveReadback(item, lists) {
  if (isUndeleted(item)) return true;
  if (!isRecord(item?.data) || Object.hasOwn(item.data, 'deleted') || !lists ||
      !Number.isSafeInteger(item.version)) return false;
  const children = exactRows(lists.childRows, item.key);
  const active = exactRows(lists.activeRows, item.key);
  const matches = row => row?.version === item.version &&
    snapshotDigest(row?.data) === snapshotDigest(item.data) &&
    (isUndeleted(row) || (isRecord(row?.data) && !Object.hasOwn(row.data, 'deleted')));
  return children?.length === 1 && matches(children[0]) && active?.length <= 1 &&
    (active.length === 0 || matches(active[0]));
}

function itemMatchesSnapshot(record, item) {
  return item?.key === record.annotationKey && item?.data?.itemType === 'annotation' &&
    item.data.annotationType === 'highlight' && item.data.parentItem === record.attachmentKey &&
    /^[a-f0-9]{64}$/.test(String(record.annotationSnapshotHash ?? '')) &&
    snapshotDigest(item.data) === record.annotationSnapshotHash;
}

function exactRows(rows, key) {
  return Array.isArray(rows) ? rows.filter(row => row?.key === key) : null;
}

function safeWriteError(error) {
  const code = error?.code;
  if (code === 'writes_unsupported')
    return { definite: true, code, message: '当前 Zotero 本地 API 不支持写入；批注未处理。请在 Zotero 中打开这条批注。' };
  if (code === 'write_denied')
    return { definite: true, code, message: 'Zotero 未授予这次本地修改权限；批注未处理。' };
  if (code === 'local_api_disabled' || code === 'zotero_not_running')
    return { definite: true, code, message: 'Zotero 本地接口当前不可用；批注未处理。' };
  return { definite: false, code: 'write_outcome_unknown', message: '写入连接中断，操作结果尚不确定。请在工作台核对上次操作，不要重复确认。' };
}

function safeHttpError(status) {
  if (status === 400 || status === 405 || status === 501)
    return { definite: true, code: 'trash_unsupported', message: '当前 Zotero 本地 API 未接受批注移除操作；未显示删除成功。请在 Zotero 中打开这条批注。' };
  if (status === 401 || status === 403)
    return { definite: true, code: 'write_denied', message: 'Zotero 未授予这次本地修改权限；批注未处理。' };
  if (status === 404)
    return { definite: true, code: 'not_found', message: 'Zotero 中已找不到这条批注；请刷新阅读器。' };
  if (status === 409 || status === 412 || status === 428)
    return { definite: true, code: 'version_conflict', message: '批注或文库版本已变化，未执行移除操作；请刷新后重新预览。' };
  if (status >= 400 && status < 500)
    return { definite: true, code: 'write_rejected', message: `Zotero 拒绝了高亮移除请求（HTTP ${status}）；批注未处理。` };
  return { definite: false, code: 'write_outcome_unknown', message: 'Zotero 的移除结果尚不确定。请在工作台核对上次操作，不要重复确认。' };
}

function safeRestoreHttpError(status) {
  if (status === 400 || status === 405 || status === 501)
    return { definite: true, code: 'restore_unsupported', message: '当前 Zotero 本地 API 未接受恢复请求；请在 Zotero 中核对这条批注。' };
  if (status === 401 || status === 403)
    return { definite: true, code: 'write_denied', message: 'Zotero 未授予这次本地修改权限；批注状态未确认。' };
  if (status === 404)
    return { definite: true, code: 'not_found', message: 'Zotero 中已找不到这条批注；请先检查当前状态。' };
  if (status === 409 || status === 412 || status === 428)
    return { definite: true, code: 'version_conflict', message: '批注版本已变化，未执行恢复；请先在 Zotero 中核对当前状态。' };
  if (status >= 400 && status < 500)
    return { definite: true, code: 'write_rejected', message: `Zotero 拒绝了恢复请求（HTTP ${status}）；请核对当前状态。` };
  return { definite: false, code: 'write_outcome_unknown', message: 'Zotero 的恢复结果尚不确定。请在工作台核对上次操作，不要重复确认。' };
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

async function createJournalRecord(directory, operationId, record) {
  try {
    await ensurePrivateDirectory(directory);
    const path = join(directory, `${operationId}.json`);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior;
      try { prior = JSON.parse(await readFile(path, 'utf8')); }
      catch {
        throw new AnnotationTrashError('operation_exists', `已有同版本操作记录，未重复写入。请用 review_operation 查询 ${operationId}。`, operationId);
      }
      if (prior?.status !== 'rejected')
        throw new AnnotationTrashError('operation_exists', `该批注同一版本已有操作记录（${String(prior?.status ?? 'unknown')}）；未重复写入。请用 review_operation 查询 ${operationId}，并先核对 Zotero。`, operationId);

      // A definite rejection (for example, explicit permission denial) did not
      // change Zotero. Permit a fresh, user-confirmed attempt while serializing
      // competing retries. Unknown outcomes remain permanently reserved.
      const lockPath = `${path}.retry-lock`;
      let lock;
      try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (lockError) {
        if (lockError.code === 'EEXIST')
          throw new AnnotationTrashError('operation_in_progress', `该批注正在处理；未重复写入。请用 review_operation 查询 ${operationId}。`, operationId);
        throw lockError;
      }
      try {
        await lock.close();
        let latest;
        try { latest = JSON.parse(await readFile(path, 'utf8')); }
        catch {
          throw new AnnotationTrashError('operation_exists', `已有同版本操作记录，未重复写入。请用 review_operation 查询 ${operationId}。`, operationId);
        }
        if (latest?.status !== 'rejected')
          throw new AnnotationTrashError('operation_exists', `该批注同一版本已有操作记录（${String(latest?.status ?? 'unknown')}）；未重复写入。请用 review_operation 查询 ${operationId}，并先核对 Zotero。`, operationId);
        record.attempt = (Number.isSafeInteger(latest.attempt) ? latest.attempt : 1) + 1;
        await updateJournalRecord(directory, operationId, record);
      } finally {
        await lock.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
      return;
    }
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (error instanceof AnnotationTrashError) throw error;
    throw new AnnotationTrashError('journal_unavailable', '无法安全保存本地操作记录；尚未向 Zotero 提交修改。', operationId);
  }
}

async function updateJournalRecord(directory, operationId, record) {
  const path = join(directory, `${operationId}.json`);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
}

async function writeAtomicJson(directory, filename, value) {
  await ensurePrivateDirectory(directory);
  const path = join(directory, filename);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
}

function versionsEqual(left, right) {
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right;
}

/**
 * Attempts a version-checked update for one exact, user-selected PDF
 * highlight. It never calls DELETE. Success requires the exact key's direct
 * deleted state and matching activity/children readbacks; an unsupported PATCH
 * or unverified result is never reported as success.
 */
export class AnnotationTrash {
  constructor({ session, directory = join(homedir(), '.local/share/zotero-workbench/operations'), now = Date.now, ttl = PREVIEW_TTL_MS }) {
    if (!session) throw new TypeError('session is required');
    this.session = session;
    this.directory = directory;
    this.now = now;
    this.ttl = ttl;
    this.previews = new Map();
    this.restorePreviews = new Map();
  }

  async #requireWriteSupport() {
    try { await this.session.ready(); }
    catch { throw new AnnotationTrashError('zotero_unavailable', 'Zotero 本地接口当前不可用；未提交批注操作。'); }
    const status = this.session.client?.status?.writes;
    if (status === 'unsupported')
      throw new AnnotationTrashError('writes_unsupported', '当前 Zotero 本地 API 不支持写入；这条批注仍可在 Zotero 中打开。');
    if (status !== 'available')
      throw new AnnotationTrashError('write_capability_unknown', '无法确认 Zotero 本地 API 支持写入；未准备移除操作。');
  }

  async #readExactAnnotation(library, annotationKey, operationId) {
    let annotation;
    try {
      ({ data: annotation } = await this.session.client.getJson(exactItemPath(library, annotationKey)));
    } catch (error) {
      if (error?.code === 'not_found' || error?.status === 404)
        throw new AnnotationTrashError('not_found', 'Zotero 精确条目读取未找到该批注；这不能证明它已删除。', operationId);
      throw new AnnotationTrashError('read_failed', '无法读取 Zotero 中这条批注的精确状态。', operationId);
    }
    if (!isRecord(annotation) || annotation.key !== annotationKey)
      throw new AnnotationTrashError('readback_mismatch', 'Zotero 精确读取返回的批注 key 不匹配。', operationId);
    return annotation;
  }

  async #readActivityLists(library, annotationKey, attachmentKey, operationId) {
    let activeRows, childRows;
    try {
      const [active, children] = await Promise.all([
        this.session.client.getJson(activeItemsPath(library, annotationKey)),
        this.session.client.getJson(annotationChildrenPath(library, attachmentKey))
      ]);
      activeRows = active.data;
      childRows = children.data;
    } catch {
      throw new AnnotationTrashError('read_failed', '无法交叉核对 Zotero 活动项与附件批注列表。', operationId);
    }
    if (!Array.isArray(activeRows) || !Array.isArray(childRows))
      throw new AnnotationTrashError('readback_mismatch', 'Zotero 活动项或附件批注列表格式无效。', operationId);
    return { activeRows, childRows };
  }

  async #readTarget(library, annotationKey, attachmentKey) {
    let annotation, attachment;
    try {
      [annotation, attachment] = await Promise.all([
        this.#readExactAnnotation(library, annotationKey),
        this.session.library.raw(library, attachmentKey)
      ]);
    } catch (error) {
      if (error?.code === 'not_found')
        throw new AnnotationTrashError('not_found', 'Zotero 中已找不到这条批注或对应 PDF；请刷新后再预览。');
      throw new AnnotationTrashError('read_failed', '无法安全读取当前批注和 PDF；未提交移除操作。');
    }
    const data = annotation?.data;
    const attachmentData = attachment?.data;
    if (annotation?.key !== annotationKey || data?.itemType !== 'annotation' || data.annotationType !== 'highlight')
      throw new AnnotationTrashError('not_a_highlight', '只能处理你在阅读器中选中的 Zotero PDF 高亮批注。');
    if (data.parentItem !== attachmentKey)
      throw new AnnotationTrashError('parent_mismatch', '该高亮不属于当前 PDF 附件；未处理。请刷新批注列表。');
    const lists = !Object.hasOwn(data, 'deleted')
      ? await this.#readActivityLists(library, annotationKey, attachmentKey) : null;
    if (!isActiveReadback(annotation, lists))
      throw new AnnotationTrashError('deleted_state_unavailable', '无法确认这条高亮当前明确处于未删除状态；未准备移除操作。');
    if (attachment?.key !== attachmentKey || attachmentData?.itemType !== 'attachment' || attachmentData.contentType !== 'application/pdf')
      throw new AnnotationTrashError('not_pdf_attachment', '当前来源不是有效的 PDF 附件；未处理。');
    if (!Number.isSafeInteger(annotation.version) || annotation.version < 0 ||
        !Number.isSafeInteger(attachment.version) || attachment.version < 0)
      throw new AnnotationTrashError('version_unavailable', '无法读取批注或 PDF 的当前版本；未准备移除操作。');
    return { annotation, attachment };
  }

  async prepare(args) {
    if (!isRecord(args)) throw new AnnotationTrashError('invalid_input', '操作参数无效。');
    const library = requireLibrary(args.library);
    const annotationKey = requireKey(args.annotationKey, '批注');
    const attachmentKey = requireKey(args.attachmentKey, '附件');
    await this.#requireWriteSupport();
    const { annotation, attachment } = await this.#readTarget(library, annotationKey, attachmentKey);
    const data = annotation.data;
    const pageIndex = pageIndexOf(data);
    const page = pageIndex === null ? null : pageIndex + 1;
    const pageLabel = typeof data.annotationPageLabel === 'string' ? data.annotationPageLabel : (page === null ? '' : String(page));
    const token = randomBytes(24).toString('hex');
    const expiresAt = this.now() + this.ttl;
    const operationId = digest({
      kind: JOURNAL_KIND, library, annotationKey, attachmentKey,
      annotationVersion: annotation.version, attachmentVersion: attachment.version
    });
    const preview = {
      operationId, expiresAt, library, annotationKey, attachmentKey,
      annotationVersion: annotation.version, attachmentVersion: attachment.version,
      annotationSnapshotHash: snapshotDigest(data),
      text: typeof data.annotationText === 'string' ? data.annotationText : '',
      comment: typeof data.annotationComment === 'string' ? data.annotationComment : '',
      page, pageLabel,
      url: pageIndex === null ? null : annotationLink(library, attachmentKey, annotationKey, pageIndex),
      title: String(attachment.data.title ?? '')
    };
    this.previews.set(token, preview);
    for (const [oldToken, oldPreview] of this.previews)
      if (oldPreview.expiresAt <= this.now()) this.previews.delete(oldToken);
    while (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value);
    return {
      status: 'previewed', previewToken: token, operationId, expiresAt, requiresConfirmation: true, restorable: true,
      action: 'move_to_trash', restorationStatus: 'unverified',
      annotation: {
        key: annotationKey, attachmentKey, library, text: preview.text, comment: preview.comment,
        page, pageLabel, title: preview.title, url: preview.url,
        itemVersion: annotation.version, attachmentVersion: attachment.version
      }
    };
  }

  async trash({ previewToken, confirmWrite = false } = {}) {
    if (typeof previewToken !== 'string' || !TOKEN.test(previewToken))
      throw new AnnotationTrashError('invalid_input', '移除预览凭证无效。');
    const preview = this.previews.get(previewToken);
    if (!preview || preview.expiresAt <= this.now()) {
      this.previews.delete(previewToken);
      throw new AnnotationTrashError('preview_expired', '移除预览已过期；请重新打开这条批注并预览。');
    }
    this.previews.delete(previewToken);
    if (confirmWrite !== true)
      throw new AnnotationTrashError('confirmation_required', '移除这条高亮前需要明确确认；尚未提交修改。');
    await this.#requireWriteSupport();

    const { annotation, attachment } = await this.#readTarget(preview.library, preview.annotationKey, preview.attachmentKey);
    if (!versionsEqual(annotation.version, preview.annotationVersion) ||
        !versionsEqual(attachment.version, preview.attachmentVersion))
      throw new AnnotationTrashError('version_conflict', '批注或 PDF 在预览后发生变化；未执行移除操作，请刷新后重新预览。');

    const record = {
      kind: JOURNAL_KIND, operationId: preview.operationId, status: 'outcome-unknown',
      library: preview.library, annotationKey: preview.annotationKey, attachmentKey: preview.attachmentKey,
      annotationVersion: preview.annotationVersion, attachmentVersion: preview.attachmentVersion,
      annotationSnapshotHash: preview.annotationSnapshotHash,
      attempt: 1, submittedAt: this.now()
    };
    await createJournalRecord(this.directory, preview.operationId, record);
    try {
      await writeAtomicJson(this.directory, LATEST_TRASH_PATH, {
        kind: 'reader-annotation-trash-latest', operationId: preview.operationId, updatedAt: this.now()
      });
    } catch {
      record.status = 'rejected'; record.finishedAt = this.now(); record.errorCode = 'journal_unavailable';
      await updateJournalRecord(this.directory, preview.operationId, record).catch(() => {});
      throw new AnnotationTrashError('journal_unavailable', '无法保存跨会话操作入口；尚未向 Zotero 提交修改。', preview.operationId);
    }

    let response;
    try {
      response = await this.session.client.write('PATCH', `${libraryPrefix(preview.library)}/items/${preview.annotationKey}`, {
        body: JSON.stringify({ deleted: 1 }),
        contentType: 'application/json',
        headers: { 'If-Unmodified-Since-Version': String(preview.annotationVersion) }
      });
    } catch (error) {
      const safe = safeWriteError(error);
      if (safe.definite) {
        record.status = 'rejected'; record.finishedAt = this.now(); record.errorCode = safe.code;
        try { await updateJournalRecord(this.directory, preview.operationId, record); }
        catch { throw new AnnotationTrashError('journal_unavailable', `${safe.message} 本地状态记录无法更新；请先检查 Zotero。操作编号：${preview.operationId}`, preview.operationId); }
        throw new AnnotationTrashError(safe.code, safe.message, preview.operationId);
      }
      record.status = 'outcome-unknown'; record.errorCode = safe.code;
      await updateJournalRecord(this.directory, preview.operationId, record).catch(() => {});
      throw new AnnotationTrashError(safe.code, `${safe.message} 操作编号：${preview.operationId}`, preview.operationId);
    }

    if (response.status !== 200 && response.status !== 204) {
      const safe = safeHttpError(response.status);
      if (safe.definite) {
        record.status = 'rejected'; record.finishedAt = this.now(); record.errorCode = safe.code; record.httpStatus = response.status;
        try { await updateJournalRecord(this.directory, preview.operationId, record); }
        catch { throw new AnnotationTrashError('journal_unavailable', `${safe.message} 本地状态记录无法更新；请先检查 Zotero。操作编号：${preview.operationId}`, preview.operationId); }
        throw new AnnotationTrashError(safe.code, safe.message, preview.operationId);
      }
      record.status = 'outcome-unknown'; record.errorCode = safe.code; record.httpStatus = response.status;
      await updateJournalRecord(this.directory, preview.operationId, record).catch(() => {});
      throw new AnnotationTrashError(safe.code, `${safe.message} 操作编号：${preview.operationId}`, preview.operationId);
    }

    record.acknowledgedAt = this.now();
    try {
      this.session.library.invalidate?.(preview.library);
      const [readback, lists, attachment] = await Promise.all([
        this.#readExactAnnotation(preview.library, preview.annotationKey, preview.operationId),
        this.#readActivityLists(preview.library, preview.annotationKey, preview.attachmentKey, preview.operationId),
        this.session.library.raw(preview.library, preview.attachmentKey)
      ]);
      const { activeRows, childRows } = lists;
      if (!itemMatchesSnapshot(record, readback) || readback.data?.deleted !== true ||
          !Number.isSafeInteger(readback.version) || readback.version <= preview.annotationVersion ||
          exactRows(activeRows, preview.annotationKey).length !== 0 ||
          exactRows(childRows, preview.annotationKey).length !== 0)
        throw new AnnotationTrashError('readback_mismatch', '精确批注状态、活动列表或 PDF 批注列表未共同确认这条高亮已移除。', preview.operationId);
      if (attachment?.key !== preview.attachmentKey || attachment?.data?.itemType !== 'attachment' ||
          attachment.data.contentType !== 'application/pdf' || !versionsEqual(attachment.version, preview.attachmentVersion))
        throw new AnnotationTrashError('version_conflict', 'PDF 附件或版本在操作期间发生变化；删除结果尚未核实。', preview.operationId);
      record.postTrashVersion = readback.version;
      record.restorationStatus = 'unverified';
      record.status = 'verified'; record.verifiedAt = this.now(); record.httpStatus = response.status;
      record.verificationMethod = 'exact_deleted_state';
      await updateJournalRecord(this.directory, preview.operationId, record);
      this.session.emit?.({ kind: 'library', library: preview.library });
      return {
        status: 'verified', operationId: preview.operationId,
        action: 'moved_to_trash', restorationStatus: 'unverified',
        restoreEntryAvailable: record.postTrashVersion !== null,
        library: preview.library, annotationKey: preview.annotationKey, attachmentKey: preview.attachmentKey,
        page: preview.page, pageLabel: preview.pageLabel, url: preview.url,
        message: '已回读确认 Zotero 将这条高亮标记为已删除；工作台可按原 key 提供恢复预览。恢复需另行操作并以回读确认，不代表它会出现在 Zotero 顶层回收站。'
      };
    } catch (error) {
      record.status = 'outcome-unknown'; record.errorCode = error?.code || 'readback_failed';
      await updateJournalRecord(this.directory, preview.operationId, record).catch(() => {});
      const message = error?.code === 'readback_mismatch'
        ? 'Zotero 已回执，但精确状态和列表尚未共同确认这条高亮已移除；请在工作台核对上次操作，不要重复确认。'
        : 'Zotero 已回执，但状态回读失败；请在工作台核对上次操作，不要重复确认。';
      throw new AnnotationTrashError('outcome_unknown', `${message} 操作编号：${preview.operationId}`, preview.operationId);
    }
  }

  async #readDeletedTarget(source) {
    const [annotation, attachment, lists] = await Promise.all([
      this.#readExactAnnotation(source.library, source.annotationKey, source.operationId),
      this.session.library.raw(source.library, source.attachmentKey),
      this.#readActivityLists(source.library, source.annotationKey, source.attachmentKey, source.operationId)
    ]).catch(error => {
      if (error instanceof AnnotationTrashError) throw error;
      throw new AnnotationTrashError('read_failed', '无法安全读取已移除的批注或对应 PDF；未提交恢复。', source.operationId);
    });
    if (annotation?.data?.itemType !== 'annotation' || annotation.data.annotationType !== 'highlight' ||
        annotation.data.parentItem !== source.attachmentKey || annotation.data.deleted !== true || !itemMatchesSnapshot(source, annotation))
      throw new AnnotationTrashError('deleted_target_mismatch', '精确批注状态、父附件或原内容与移除记录不符；未提交恢复。', source.operationId);
    if (!Number.isSafeInteger(source.postTrashVersion) || !versionsEqual(annotation.version, source.postTrashVersion))
      throw new AnnotationTrashError('version_conflict', '批注版本与已核实的移除记录不一致；未提交恢复。', source.operationId);
    if (exactRows(lists.activeRows, source.annotationKey).length !== 0 ||
        exactRows(lists.childRows, source.annotationKey).length !== 0)
      throw new AnnotationTrashError('readback_mismatch', '活动项或 PDF 批注列表与已删除状态冲突；未提交恢复。', source.operationId);
    if (attachment?.key !== source.attachmentKey || attachment?.data?.itemType !== 'attachment' || attachment.data.contentType !== 'application/pdf')
      throw new AnnotationTrashError('not_pdf_attachment', '原 PDF 附件已不存在或类型变化；未提交恢复。', source.operationId);
    if (!versionsEqual(attachment.version, source.attachmentVersion))
      throw new AnnotationTrashError('version_conflict', '原 PDF 附件版本与移除记录不一致；未提交恢复。', source.operationId);
    return { annotation, attachment };
  }

  #restoreOperationId(source) {
    return digest({
      kind: RESTORE_KIND, sourceOperationId: source.operationId, library: source.library,
      annotationKey: source.annotationKey, attachmentKey: source.attachmentKey,
      postTrashVersion: source.postTrashVersion, attachmentVersion: source.attachmentVersion
    });
  }

  async prepareRestore({ operationId } = {}) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId))
      throw new AnnotationTrashError('invalid_input', '原批注移除操作编号无效。');
    const source = await this.status(operationId);
    if (source?.kind !== JOURNAL_KIND || source.status !== 'verified')
      throw new AnnotationTrashError('source_not_verified', '原批注移除状态尚未回读核实；请先核查操作记录。', operationId);
    if (source.restoredByOperationId)
      throw new AnnotationTrashError('already_restored', '这条批注已由工作台恢复；请刷新 Zotero。', operationId);
    if (!Number.isSafeInteger(source.postTrashVersion))
      throw new AnnotationTrashError('restore_version_unavailable', '原回收站记录缺少可验证的批注版本，不能安全恢复。', operationId);
    await this.#requireWriteSupport();
    const { annotation, attachment } = await this.#readDeletedTarget(source);
    const restoreOperationId = this.#restoreOperationId(source);
    const prior = await this.status(restoreOperationId);
    if (prior && prior.status !== 'rejected')
      throw new AnnotationTrashError('operation_exists', `该恢复操作已有记录（${String(prior.status)}）；未重复写入。请用 review_operation 查询 ${restoreOperationId}。`, restoreOperationId);

    const data = annotation.data;
    const pageIndex = pageIndexOf(data);
    const page = pageIndex === null ? null : pageIndex + 1;
    const previewToken = randomBytes(24).toString('hex');
    const expiresAt = this.now() + this.ttl;
    const preview = {
      operationId, restoreOperationId, expiresAt, library: source.library,
      annotationKey: source.annotationKey, attachmentKey: source.attachmentKey,
      annotationVersion: annotation.version, attachmentVersion: attachment.version,
      annotationSnapshotHash: source.annotationSnapshotHash,
      text: typeof data.annotationText === 'string' ? data.annotationText : '',
      comment: typeof data.annotationComment === 'string' ? data.annotationComment : '',
      page, pageLabel: typeof data.annotationPageLabel === 'string' ? data.annotationPageLabel : (page === null ? '' : String(page)),
      url: pageIndex === null ? null : annotationLink(source.library, source.attachmentKey, source.annotationKey, pageIndex),
      title: String(attachment.data.title ?? '')
    };
    this.restorePreviews.set(previewToken, preview);
    for (const [oldToken, oldPreview] of this.restorePreviews)
      if (oldPreview.expiresAt <= this.now()) this.restorePreviews.delete(oldToken);
    while (this.restorePreviews.size > 64) this.restorePreviews.delete(this.restorePreviews.keys().next().value);
    return {
      status: 'previewed', action: 'restore_to_library', previewToken, expiresAt,
      sourceOperationId: operationId, restoreOperationId, requiresConfirmation: true,
      annotation: {
        key: source.annotationKey, attachmentKey: source.attachmentKey, library: source.library,
        text: preview.text, comment: preview.comment, page, pageLabel: preview.pageLabel,
        title: preview.title, url: preview.url, itemVersion: annotation.version,
        attachmentVersion: attachment.version
      }
    };
  }

  async restore({ previewToken, confirmWrite = false } = {}) {
    if (typeof previewToken !== 'string' || !TOKEN.test(previewToken))
      throw new AnnotationTrashError('invalid_input', '恢复预览凭证无效。');
    const preview = this.restorePreviews.get(previewToken);
    if (!preview || preview.expiresAt <= this.now()) {
      this.restorePreviews.delete(previewToken);
      throw new AnnotationTrashError('preview_expired', '恢复预览已过期；请重新打开原批注移除操作。');
    }
    this.restorePreviews.delete(previewToken);
    if (confirmWrite !== true)
      throw new AnnotationTrashError('confirmation_required', '恢复批注前需要明确确认；尚未提交修改。');
    await this.#requireWriteSupport();

    const source = await this.status(preview.operationId);
    if (source?.kind !== JOURNAL_KIND || source.status !== 'verified' || source.restoredByOperationId)
      throw new AnnotationTrashError('source_not_restorable', '原回收站操作当前不可恢复；未提交修改。', preview.operationId);
    const { annotation, attachment } = await this.#readDeletedTarget(source);
    if (!versionsEqual(annotation.version, preview.annotationVersion) ||
        !versionsEqual(attachment.version, preview.attachmentVersion))
      throw new AnnotationTrashError('version_conflict', '批注或 PDF 在预览后发生变化；未执行恢复，请重新核对。', preview.restoreOperationId);

    const record = {
      kind: RESTORE_KIND, operationId: preview.restoreOperationId, status: 'outcome-unknown',
      sourceOperationId: preview.operationId, library: preview.library,
      annotationKey: preview.annotationKey, attachmentKey: preview.attachmentKey,
      annotationVersion: preview.annotationVersion, attachmentVersion: preview.attachmentVersion,
      annotationSnapshotHash: preview.annotationSnapshotHash,
      attempt: 1, submittedAt: this.now()
    };
    await createJournalRecord(this.directory, preview.restoreOperationId, record);

    let response;
    try {
      response = await this.session.client.write('PATCH', `${libraryPrefix(preview.library)}/items/${preview.annotationKey}`, {
        body: JSON.stringify({ deleted: false }),
        contentType: 'application/json',
        headers: { 'If-Unmodified-Since-Version': String(preview.annotationVersion) }
      });
    } catch (error) {
      const safe = safeWriteError(error);
      if (safe.definite) {
        record.status = 'rejected'; record.finishedAt = this.now(); record.errorCode = safe.code;
        try { await updateJournalRecord(this.directory, preview.restoreOperationId, record); }
        catch { throw new AnnotationTrashError('journal_unavailable', `${safe.message} 本地状态记录无法更新；请先检查 Zotero。操作编号：${preview.restoreOperationId}`, preview.restoreOperationId); }
        throw new AnnotationTrashError(safe.code, safe.message, preview.restoreOperationId);
      }
      record.status = 'outcome-unknown'; record.errorCode = safe.code;
      await updateJournalRecord(this.directory, preview.restoreOperationId, record).catch(() => {});
      throw new AnnotationTrashError(safe.code, `${safe.message} 操作编号：${preview.restoreOperationId}`, preview.restoreOperationId);
    }

    if (response.status !== 200 && response.status !== 204) {
      const safe = safeRestoreHttpError(response.status);
      if (safe.definite) {
        record.status = 'rejected'; record.finishedAt = this.now(); record.errorCode = safe.code; record.httpStatus = response.status;
        try { await updateJournalRecord(this.directory, preview.restoreOperationId, record); }
        catch { throw new AnnotationTrashError('journal_unavailable', `${safe.message} 本地状态记录无法更新；请先检查 Zotero。操作编号：${preview.restoreOperationId}`, preview.restoreOperationId); }
        throw new AnnotationTrashError(safe.code, safe.message, preview.restoreOperationId);
      }
      record.status = 'outcome-unknown'; record.errorCode = safe.code; record.httpStatus = response.status;
      await updateJournalRecord(this.directory, preview.restoreOperationId, record).catch(() => {});
      throw new AnnotationTrashError(safe.code, `${safe.message} 操作编号：${preview.restoreOperationId}`, preview.restoreOperationId);
    }

    record.acknowledgedAt = this.now();
    try {
      this.session.library.invalidate?.(preview.library);
      const [exact, lists, attachment] = await Promise.all([
        this.#readExactAnnotation(preview.library, preview.annotationKey, preview.restoreOperationId),
        this.#readActivityLists(preview.library, preview.annotationKey, preview.attachmentKey, preview.restoreOperationId),
        this.session.library.raw(preview.library, preview.attachmentKey)
      ]);
      const active = exactRows(lists.activeRows, preview.annotationKey);
      const children = exactRows(lists.childRows, preview.annotationKey);
      const rowMatches = row => itemMatchesSnapshot(record, row) && !isDeleted(row) &&
        (!Number.isSafeInteger(row.version) || row.version === exact.version);
      if (!itemMatchesSnapshot(record, exact) || !isActiveReadback(exact, lists) ||
          !Number.isSafeInteger(exact.version) || exact.version <= preview.annotationVersion ||
          children.length !== 1 || !rowMatches(children[0]) ||
          active.length > 1 || (active.length === 1 && !rowMatches(active[0])))
        throw new AnnotationTrashError('readback_mismatch', '精确条目与 PDF 批注列表尚未共同确认原高亮已恢复。');
      if (attachment?.key !== preview.attachmentKey || attachment?.data?.itemType !== 'attachment' ||
          attachment.data.contentType !== 'application/pdf' || !versionsEqual(attachment.version, preview.attachmentVersion))
        throw new AnnotationTrashError('version_conflict', 'PDF 附件或版本在恢复期间发生变化。');

      record.status = 'verified'; record.verifiedAt = this.now(); record.httpStatus = response.status;
      record.postRestoreVersion = exact.version;
      record.verificationMethod = 'exact_active_children_state';
      await updateJournalRecord(this.directory, preview.restoreOperationId, record);
      source.restoredByOperationId = preview.restoreOperationId;
      source.restoredAt = this.now();
      await updateJournalRecord(this.directory, preview.operationId, source);
      await this.#clearLatestTrashIf(preview.operationId);
      this.session.emit?.({ kind: 'library', library: preview.library });
      return {
        status: 'verified', operationId: preview.restoreOperationId,
        sourceOperationId: preview.operationId, action: 'restored_to_library',
        library: preview.library, annotationKey: preview.annotationKey, attachmentKey: preview.attachmentKey,
        page: preview.page, pageLabel: preview.pageLabel, url: preview.url,
        message: '已回读确认原批注 key 未标记为删除，并重新出现在 PDF 批注列表中。'
      };
    } catch (error) {
      record.status = 'outcome-unknown'; record.errorCode = error?.code === 'readback_mismatch' ? error.code : 'readback_failed';
      await updateJournalRecord(this.directory, preview.restoreOperationId, record).catch(() => {});
      const message = error?.code === 'readback_mismatch'
        ? 'Zotero 已回执，但尚未通过精确条目和 PDF 批注列表核实恢复；请在工作台核对上次操作，不要重复确认。'
        : 'Zotero 已回执，但恢复回读失败；请在工作台核对上次操作，不要重复确认。';
      throw new AnnotationTrashError('outcome_unknown', `${message} 操作编号：${preview.restoreOperationId}`, preview.restoreOperationId);
    }
  }

  async reconcile({ operationId } = {}) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId))
      throw new AnnotationTrashError('invalid_input', '操作编号无效。');
    const record = await this.status(operationId);
    if (![JOURNAL_KIND, RESTORE_KIND].includes(record?.kind))
      throw new AnnotationTrashError('operation_not_found', '未找到可核对的批注移除或恢复操作。', operationId);
    if (record.status !== 'outcome-unknown')
      return { status: record.status, action: 'unchanged', operationId, message: '该操作不处于未知状态；本次未改写台账，也未提交 Zotero 修改。' };
    if (!/^[a-f0-9]{64}$/.test(String(record.annotationSnapshotHash ?? '')))
      return { status: 'outcome-unknown', action: 'unresolved', operationId, annotationKey: record.annotationKey,
        message: '这条旧操作记录没有原批注内容摘要；不能安全核实，也没有重发请求。' };

    try {
      this.session.library.invalidate?.(record.library);
      const [annotation, attachment, lists] = await Promise.all([
        this.#readExactAnnotation(record.library, record.annotationKey, operationId),
        this.session.library.raw(record.library, record.attachmentKey),
        this.#readActivityLists(record.library, record.annotationKey, record.attachmentKey, operationId)
      ]);
      const { activeRows, childRows } = lists;
      if (attachment?.key !== record.attachmentKey || attachment?.data?.itemType !== 'attachment' ||
          attachment.data.contentType !== 'application/pdf' || !versionsEqual(attachment.version, record.attachmentVersion))
        return { status: 'outcome-unknown', action: 'unresolved', operationId, annotationKey: record.annotationKey,
          message: '父 PDF 的类型或版本与操作记录不符；台账未变更，也没有重发请求。' };

      if (record.kind === JOURNAL_KIND) {
        if (!itemMatchesSnapshot(record, annotation) || annotation.data?.deleted !== true ||
            !Number.isSafeInteger(annotation.version) || annotation.version <= record.annotationVersion ||
            exactRows(activeRows, record.annotationKey).length !== 0 ||
            exactRows(childRows, record.annotationKey).length !== 0)
          return { status: 'outcome-unknown', action: 'unresolved', operationId, annotationKey: record.annotationKey,
            message: '精确条目、原内容、版本以及活动项和 PDF 批注列表尚未共同证明已移除；台账未变更，也没有重发请求。' };
        record.status = 'verified';
        record.postTrashVersion = annotation.version;
        record.restorationStatus = 'unverified';
        record.verificationMethod = 'reconciled_exact_deleted_state';
        record.verifiedAt = this.now();
        await writeAtomicJson(this.directory, LATEST_TRASH_PATH, {
          kind: 'reader-annotation-trash-latest', operationId, updatedAt: this.now()
        });
        await updateJournalRecord(this.directory, operationId, record);
        this.session.emit?.({ kind: 'library', library: record.library });
        return { status: 'verified', action: 'reconciled_removed', operationId, annotationKey: record.annotationKey,
          restoreEntryAvailable: true,
          message: '已按精确条目状态核实这条高亮当前标记为删除；这不代表此批注已经恢复，恢复须另行操作并回读确认。' };
      }

      const source = await this.status(record.sourceOperationId);
      if (source?.kind !== JOURNAL_KIND || source.status !== 'verified' ||
          source.annotationSnapshotHash !== record.annotationSnapshotHash ||
          source.annotationKey !== record.annotationKey || source.attachmentKey !== record.attachmentKey ||
          !versionsEqual(source.postTrashVersion, record.annotationVersion))
        return { status: 'outcome-unknown', action: 'unresolved', operationId, annotationKey: record.annotationKey,
          message: '对应的删除记录未核实或版本/内容摘要不一致；恢复状态仍未知，没有重发请求。' };
      const active = exactRows(activeRows, record.annotationKey);
      const children = exactRows(childRows, record.annotationKey);
      const rowMatches = row => itemMatchesSnapshot(record, row) && !isDeleted(row) &&
        (!Number.isSafeInteger(row.version) || row.version === annotation.version);
      if (!itemMatchesSnapshot(record, annotation) || !isActiveReadback(annotation, { activeRows, childRows }) ||
          !Number.isSafeInteger(annotation.version) || annotation.version <= record.annotationVersion ||
          children.length !== 1 || !rowMatches(children[0]) || active.length > 1 ||
          (active.length === 1 && !rowMatches(active[0])))
        return { status: 'outcome-unknown', action: 'unresolved', operationId, annotationKey: record.annotationKey,
          message: '尚未由精确条目和 PDF 批注列表确认原高亮已恢复；台账未标成功，也没有重发请求。' };

      record.status = 'verified';
      record.postRestoreVersion = annotation.version;
      record.verificationMethod = 'reconciled_exact_active_children_state';
      record.verifiedAt = this.now();
      await updateJournalRecord(this.directory, operationId, record);
      source.restoredByOperationId = operationId;
      source.restoredAt = this.now();
      await updateJournalRecord(this.directory, source.operationId, source);
      await this.#clearLatestTrashIf(source.operationId).catch(() => {});
      this.session.emit?.({ kind: 'library', library: record.library });
      return { status: 'verified', action: 'reconciled_restored', operationId, sourceOperationId: source.operationId,
        annotationKey: record.annotationKey,
        message: '已回读确认原批注 key 未标记为删除，并重新出现在 PDF 批注列表中。' };
    } catch (error) {
      return { status: 'outcome-unknown', action: 'unresolved', operationId, annotationKey: record.annotationKey,
        errorCode: error?.code || 'read_failed',
        message: '本次核对未完整完成，请按编号查看操作记录；没有重发 Zotero 写入。' };
    }
  }

  async #clearLatestTrashIf(operationId) {
    let pointer;
    try { pointer = JSON.parse(await readFile(join(this.directory, LATEST_TRASH_PATH), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (pointer?.operationId === operationId)
      await writeAtomicJson(this.directory, LATEST_TRASH_PATH, { kind: 'reader-annotation-trash-latest', operationId: null, updatedAt: this.now() });
  }

  async latestTrash() {
    let pointer;
    try { pointer = JSON.parse(await readFile(join(this.directory, LATEST_TRASH_PATH), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new AnnotationTrashError('journal_unavailable', '无法读取最近一次批注移除操作索引。');
    }
    if (pointer?.kind !== 'reader-annotation-trash-latest' || !/^[a-f0-9]{64}$/.test(String(pointer.operationId || ''))) return null;
    const operation = await this.status(pointer.operationId);
    if (operation?.kind !== JOURNAL_KIND || !['verified', 'outcome-unknown'].includes(operation.status)) return null;
    if (operation.restoredByOperationId) return null;
    const restoreOperationId = Number.isSafeInteger(operation.postTrashVersion) ? this.#restoreOperationId(operation) : null;
    let restoreStatus = null;
    if (restoreOperationId) {
      const restore = await this.status(restoreOperationId);
      if (restore?.status === 'verified') return null;
      restoreStatus = restore?.status ?? null;
    }
    return {
      status: operation.status, operationId: operation.operationId,
      library: operation.library, annotationKey: operation.annotationKey, attachmentKey: operation.attachmentKey,
      restoreEntryAvailable: operation.status === 'verified' && operation.restorationStatus === 'unverified' && Number.isSafeInteger(operation.postTrashVersion),
      reconcileAvailable: operation.status === 'outcome-unknown',
      restoreOperationId, restoreStatus,
      restorationStatus: operation.restorationStatus ?? (operation.status === 'outcome-unknown' ? 'unverified' : 'unavailable')
    };
  }

  async status(operationId) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId))
      throw new AnnotationTrashError('invalid_input', '操作编号无效。');
    try {
      const record = JSON.parse(await readFile(join(this.directory, `${operationId}.json`), 'utf8'));
      return record?.kind === JOURNAL_KIND || record?.kind === RESTORE_KIND ? record : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new AnnotationTrashError('journal_unavailable', '无法读取本地操作记录；请检查 Zotero 后再决定下一步。', operationId);
    }
  }
}
