import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { libraryPrefix } from '../../dist/runtime.mjs';
import { itemKey, libraryId } from './library.mjs';

const KEY = /^[A-Z0-9]{8}$/;
const TOKEN = /^[a-f0-9]{48}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const JOURNAL_KIND = 'reader-annotation-comment';
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const textHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function fail(code, message, operationId) {
  const error = new Error(message);
  error.name = 'AnnotationCommentError';
  error.code = code;
  if (operationId) error.operationId = operationId;
  return error;
}

function validateIdentity(args = {}) {
  if (!isRecord(args)) throw fail('invalid_input', '参数格式无效。');
  let library;
  try { library = libraryId(args.library ?? 'user'); }
  catch { throw fail('invalid_input', '文库编号无效。'); }
  const annotationKey = args.annotationKey;
  const attachmentKey = args.attachmentKey;
  if (typeof annotationKey !== 'string' || !KEY.test(annotationKey) ||
      typeof attachmentKey !== 'string' || !KEY.test(attachmentKey))
    throw fail('invalid_input', '批注或 PDF 附件编号无效。');
  try { itemKey(annotationKey); itemKey(attachmentKey); }
  catch { throw fail('invalid_input', '批注或 PDF 附件编号无效。'); }
  return { library, annotationKey, attachmentKey };
}

function immutableSnapshot(data) {
  return {
    itemType: data?.itemType ?? null,
    annotationType: data?.annotationType ?? null,
    parentItem: data?.parentItem ?? null,
    annotationText: typeof data?.annotationText === 'string' ? data.annotationText : '',
    annotationPosition: typeof data?.annotationPosition === 'string' ? data.annotationPosition : '',
    annotationPageLabel: typeof data?.annotationPageLabel === 'string' ? data.annotationPageLabel : '',
    annotationPageIndex: data?.annotationPageIndex ?? null,
    annotationColor: typeof data?.annotationColor === 'string' ? data.annotationColor : '',
    tags: Array.isArray(data?.tags) ? data.tags : []
  };
}

function isDeleted(data) {
  return data?.deleted === true || data?.deleted === 1 || data?.deleted === '1';
}

function isLiveOrImplicitlyLive(data) {
  if (!isRecord(data)) return false;
  if (!Object.hasOwn(data, 'deleted')) return true;
  return data.deleted === false || data.deleted === 0 || data.deleted === '0';
}

function exactRows(rows, key) {
  return Array.isArray(rows) ? rows.filter(row => row?.key === key) : null;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

async function writeAtomicJson(directory, filename, value) {
  await ensurePrivateDirectory(directory);
  const path = join(directory, filename);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function reserveOperation(directory, record) {
  await ensurePrivateDirectory(directory);
  const path = join(directory, `${record.operationId}.json`);
  const create = async value => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
  };
  try {
    await create(record);
    return record;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw fail('journal_unavailable', '无法安全保存本地操作记录；尚未向 Zotero 提交修改。', record.operationId);
  }

  let prior;
  try { prior = await readJson(path); }
  catch { throw fail('operation_exists', `该操作已有记录，未重复写入。请用 review_operation 查询 ${record.operationId}。`, record.operationId); }
  if (prior?.kind !== JOURNAL_KIND || prior.status !== 'rejected')
    throw fail('operation_exists', `该备注操作已有记录（${String(prior?.status ?? 'unknown')}）；未重复写入。请用 review_operation 查询 ${record.operationId}，并先读取 Zotero 当前备注。`, record.operationId);

  const lockPath = `${path}.retry-lock`;
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw fail('operation_in_progress', `该备注操作正在处理；未重复写入。请用 review_operation 查询 ${record.operationId}。`, record.operationId); }
  try {
    await lock.close();
    prior = await readJson(path);
    if (prior?.kind !== JOURNAL_KIND || prior.status !== 'rejected')
      throw fail('operation_exists', `该备注操作已有记录（${String(prior?.status ?? 'unknown')}）；未重复写入。请用 review_operation 查询 ${record.operationId}。`, record.operationId);
    const next = { ...record, attempt: (Number.isSafeInteger(prior.attempt) ? prior.attempt : 1) + 1 };
    await writeAtomicJson(directory, `${record.operationId}.json`, next);
    return next;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function acquireTargetLock(directory, targetId, operationId, identity, now) {
  await ensurePrivateDirectory(directory);
  const path = join(directory, `reader-annotation-comment-${targetId}.lock`);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify({
      kind: `${JOURNAL_KIND}-inflight`, operationId, ...identity,
      pid: process.pid, startedAt: now
    }));
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === 'EEXIST')
      throw fail('operation_in_progress', '这条批注正在保存备注；未提交重复修改。请稍后重新读取。', operationId);
    await unlink(path).catch(() => {});
    throw fail('journal_unavailable', '无法安全保留这条批注的操作身份；尚未向 Zotero 提交修改。', operationId);
  }
  await handle.close();
  return path;
}

function writeError(error) {
  const code = error?.code;
  if (['writes_unsupported', 'write_denied', 'local_api_disabled', 'zotero_not_running'].includes(code))
    return { definite: true, code, message: 'Zotero 未接受这次备注修改；批注未更新。' };
  return { definite: false, code: 'write_outcome_unknown', message: '备注写入结果尚不确定。请重新读取这条批注核对，不要重复保存。' };
}

function httpWriteError(status) {
  if (status === 409 || status === 412 || status === 428)
    return { definite: true, code: 'version_conflict', message: '批注版本或 Zotero 实例已变化；备注未更新。请重新读取后再编辑。' };
  if (status === 400 || status === 404 || status === 405 || status === 501)
    return { definite: true, code: 'write_rejected', message: 'Zotero 未接受这次备注修改；批注未更新。' };
  if (status === 401 || status === 403)
    return { definite: true, code: 'write_denied', message: 'Zotero 未授予这次备注修改权限；批注未更新。' };
  return { definite: false, code: 'write_outcome_unknown', message: 'Zotero 的备注写入结果尚不确定。请重新读取这条批注核对，不要重复保存。' };
}

/** Edits annotationComment on the existing Zotero annotation; never creates a note or replacement annotation. */
export class AnnotationComment {
  constructor({ session, directory = join(homedir(), '.local/share/zotero-workbench/operations'), now = Date.now, tokenTtlMs = TOKEN_TTL_MS } = {}) {
    if (!session) throw new TypeError('session is required');
    this.session = session;
    this.directory = directory;
    this.now = now;
    this.tokenTtlMs = tokenTtlMs;
    this.editTokens = new Map();
  }

  async #readTarget({ library, annotationKey, attachmentKey }) {
    try { await this.session.ready(); }
    catch { throw fail('zotero_unavailable', 'Zotero 当前不可读取；未修改批注。'); }
    const serverId = typeof this.session.client?.status?.serverId === 'string'
      ? this.session.client.status.serverId : null;
    const prefix = libraryPrefix(library);
    let exact, attachment, activeRows, childRows;
    try {
      const [annotationResult, attachmentResult, activeResult, childrenResult] = await Promise.all([
        this.session.client.getJson(`${prefix}/items/${encodeURIComponent(annotationKey)}`),
        this.session.library.raw(library, attachmentKey),
        this.session.client.getJson(`${prefix}/items?itemType=annotation&itemKey=${encodeURIComponent(annotationKey)}`),
        this.session.client.getJson(`${prefix}/items/${encodeURIComponent(attachmentKey)}/children?itemType=annotation`)
      ]);
      exact = annotationResult.data;
      attachment = attachmentResult;
      activeRows = activeResult.data;
      childRows = childrenResult.data;
    } catch (error) {
      if (error?.code === 'not_found' || error?.status === 404)
        throw fail('not_found', 'Zotero 中已找不到该批注或 PDF 附件。');
      throw fail('read_failed', '无法精确读取这条批注及其 PDF 来源；未修改批注。');
    }
    const currentServerId = typeof this.session.client?.status?.serverId === 'string'
      ? this.session.client.status.serverId : null;
    if (serverId !== currentServerId)
      throw fail('server_changed', '读取期间 Zotero 实例发生变化；请重新读取后再编辑。');
    if (!isRecord(exact) || exact.key !== annotationKey || exact.data?.itemType !== 'annotation')
      throw fail('annotation_mismatch', 'Zotero 返回的批注 key 或类型不匹配。');
    if (exact.data.parentItem !== attachmentKey)
      throw fail('parent_mismatch', '这条批注不属于当前 PDF；未读取或修改其他附件。');
    if (isDeleted(exact.data)) throw fail('deleted_target', '这条批注已删除；不能添加备注。');
    if (!isLiveOrImplicitlyLive(exact.data)) throw fail('deleted_state_unknown', '无法确认这条批注处于活动状态；不能添加备注。');
    if (!isRecord(attachment) || attachment.key !== attachmentKey || attachment.data?.itemType !== 'attachment' ||
        attachment.data.contentType !== 'application/pdf')
      throw fail('not_pdf_attachment', '对应来源不是同一文库中的有效 PDF 附件。');
    if (isDeleted(attachment.data)) throw fail('deleted_attachment', '对应 PDF 附件已删除；不能修改其批注。');
    if (!isLiveOrImplicitlyLive(attachment.data)) throw fail('attachment_state_unknown', '无法确认对应 PDF 附件仍处于活动状态；不能修改其批注。');
    if (!Number.isSafeInteger(exact.version) || exact.version < 0 ||
        !Number.isSafeInteger(attachment.version) || attachment.version < 0)
      throw fail('version_unavailable', '无法读取批注或 PDF 的当前版本；未准备修改。');

    const snapshot = immutableSnapshot(exact.data);
    const snapshotHash = digest(snapshot);
    const childMatches = exactRows(childRows, annotationKey);
    const activeMatches = exactRows(activeRows, annotationKey);
    const sameLiveItem = row => row?.version === exact.version && isLiveOrImplicitlyLive(row?.data) &&
      digest(immutableSnapshot(row?.data)) === snapshotHash;
    if (!childMatches || childMatches.length !== 1 || !sameLiveItem(childMatches[0]) ||
        !activeMatches || activeMatches.length > 1 || (activeMatches.length === 1 && !sameLiveItem(activeMatches[0])))
      throw fail('deleted_or_inconsistent', '批注未在当前 PDF 批注列表中以相同版本出现；状态不明，未修改。');

    const comment = typeof exact.data.annotationComment === 'string' ? exact.data.annotationComment : '';
    const commentHash = textHash(comment);
    const sourceGuardFingerprint = digest({
      library, annotationKey, attachmentKey, serverId, annotationVersion: exact.version,
      attachmentVersion: attachment.version, snapshotHash, commentHash
    });
    return {
      annotation: exact,
      attachment,
      comment,
      serverId,
      snapshot,
      snapshotHash,
      commentHash,
      sourceGuard: {
        fingerprint: sourceGuardFingerprint,
        serverId,
        annotationVersion: exact.version,
        attachmentVersion: attachment.version
      }
    };
  }

  async #latestOperation(identity, current) {
    const targetId = digest([identity.library, identity.annotationKey, identity.attachmentKey]);
    let pointer;
    try { pointer = await readJson(join(this.directory, `latest-reader-annotation-comment-${targetId}.json`)); }
    catch { return { operationId: null, status: 'outcome-unknown', message: '无法读取上次备注操作记录；当前批注保持锁定。' }; }
    if (!pointer) return null;
    if (pointer?.kind !== `${JOURNAL_KIND}-latest` || pointer.library !== identity.library ||
        pointer.annotationKey !== identity.annotationKey || pointer.attachmentKey !== identity.attachmentKey ||
        !HASH.test(pointer.operationId ?? ''))
      return { operationId: null, status: 'outcome-unknown', message: '上次备注操作身份无法核实；当前批注保持锁定。' };
    let record;
    try { record = await readJson(join(this.directory, `${pointer.operationId}.json`)); }
    catch { return { operationId: pointer.operationId, status: 'outcome-unknown', message: '无法读取上次备注操作记录；当前批注保持锁定。' }; }
    if (!record || record.kind !== JOURNAL_KIND || record.operationId !== pointer.operationId ||
        record.library !== identity.library || record.annotationKey !== identity.annotationKey ||
        record.attachmentKey !== identity.attachmentKey ||
        typeof record.serverId !== 'string' || !record.serverId ||
        !Number.isSafeInteger(record.annotationVersion) || !Number.isSafeInteger(record.attachmentVersion) ||
        !HASH.test(record.immutableSnapshotHash ?? '') || !HASH.test(record.expectedCommentHash ?? '') ||
        !HASH.test(record.requestedCommentHash ?? ''))
      return { operationId: pointer.operationId, status: 'outcome-unknown', message: '上次备注操作的来源证据不完整；当前批注保持锁定。' };
    const currentCommentMatchesRequested = current.serverId === record.serverId &&
      current.commentHash === record.requestedCommentHash &&
      current.annotation.version > record.annotationVersion;
    const sourceStillMatches = current.serverId === record.serverId &&
      current.attachment.version === record.attachmentVersion &&
      current.snapshotHash === record.immutableSnapshotHash;
    if (record.status === 'outcome-unknown' && currentCommentMatchesRequested && sourceStillMatches) {
      const reconciled = {
        ...record,
        status: 'verified',
        verifiedAt: this.now(),
        postAnnotationVersion: current.annotation.version,
        verifiedCommentHash: current.commentHash,
        verification: 'reconciled_by_exact_read'
      };
      try {
        await writeAtomicJson(this.directory, `${record.operationId}.json`, reconciled);
        record = reconciled;
      } catch {
        return {
          operationId: record.operationId, status: 'outcome-unknown',
          submittedAt: record.submittedAt ?? null, verifiedAt: null,
          annotationVersion: record.annotationVersion,
          currentCommentMatchesRequested: true, reconciliationPending: true
        };
      }
    }
    return {
      operationId: record.operationId,
      status: record.status,
      submittedAt: record.submittedAt ?? null,
      verifiedAt: record.verifiedAt ?? null,
      annotationVersion: record.annotationVersion,
      currentCommentMatchesRequested,
      immutableSourceMatches: sourceStillMatches,
      ...(record.status === 'outcome-unknown' ? { message: '上次备注写入尚未核实，当前批注已锁定编辑；请核对当前备注和 Zotero 状态。' } : {})
    };
  }

  async #activeTargetLock(identity) {
    const targetId = digest([identity.library, identity.annotationKey, identity.attachmentKey]);
    const path = join(this.directory, `reader-annotation-comment-${targetId}.lock`);
    let lock;
    try { lock = await readJson(path); }
    catch { return { operationId: null, status: 'in-flight' }; }
    if (!lock) return null;
    if (Number.isSafeInteger(lock.pid) && lock.pid > 0) {
      try { process.kill(lock.pid, 0); }
      catch (error) {
        if (error?.code === 'ESRCH') {
          await unlink(path).catch(() => {});
          return null;
        }
      }
    }
    return {
      operationId: HASH.test(lock.operationId ?? '') ? lock.operationId : null,
      status: 'in-flight',
      submittedAt: lock.startedAt ?? null,
      currentCommentMatchesRequested: false,
      message: '这条批注正在保存备注；读取结果仅供查看，暂不签发新的编辑凭证。'
    };
  }

  async read(rawArgs = {}) {
    const identity = validateIdentity(rawArgs);
    const current = await this.#readTarget(identity);
    const inflight = await this.#activeTargetLock(identity);
    const lastOperation = inflight ?? await this.#latestOperation(identity, current);
    const operationBlocked = lastOperation?.status === 'in-flight' ||
      (lastOperation !== null && lastOperation !== undefined && !['verified', 'rejected'].includes(lastOperation.status));
    const canUpdate = !operationBlocked && this.session.client?.status?.writes === 'available' &&
      typeof current.serverId === 'string' && current.serverId.length > 0;
    const now = this.now();
    for (const [token, entry] of this.editTokens)
      if (entry.expiresAt <= now) this.editTokens.delete(token);
    let editToken;
    if (canUpdate) {
      editToken = randomBytes(24).toString('hex');
      this.editTokens.set(editToken, {
        ...identity,
        annotationVersion: current.annotation.version,
        attachmentVersion: current.attachment.version,
        comment: current.comment,
        commentHash: current.commentHash,
        snapshotHash: current.snapshotHash,
        serverId: current.serverId,
        sourceGuard: current.sourceGuard.fingerprint,
        expiresAt: now + this.tokenTtlMs
      });
      while (this.editTokens.size > 128) this.editTokens.delete(this.editTokens.keys().next().value);
    }
    return {
      status: 'ready', ...identity,
      comment: current.comment,
      annotationVersion: current.annotation.version,
      attachmentVersion: current.attachment.version,
      serverId: current.serverId,
      sourceGuard: current.sourceGuard,
      editable: canUpdate,
      ...(editToken ? { editToken, editTokenExpiresAt: now + this.tokenTtlMs } : {}),
      ...(operationBlocked ? { editBlockedBy: {
        operationId: lastOperation.operationId,
        status: lastOperation.status,
        message: lastOperation.message
      } } : {}),
      lastOperation
    };
  }

  async #writeRecord(record) {
    await writeAtomicJson(this.directory, `${record.operationId}.json`, record);
  }

  async update(rawArgs = {}) {
    const identity = validateIdentity(rawArgs);
    const { editToken, expectedVersion, expectedComment, comment } = rawArgs;
    if (typeof editToken !== 'string' || !TOKEN.test(editToken))
      throw fail('edit_token_invalid', '备注编辑凭证无效；请重新读取当前批注。');
    const token = this.editTokens.get(editToken);
    this.editTokens.delete(editToken);
    if (!token || token.expiresAt <= this.now())
      throw fail('edit_token_expired', '备注编辑凭证已失效；请重新读取当前批注。');
    if (identity.library !== token.library || identity.annotationKey !== token.annotationKey || identity.attachmentKey !== token.attachmentKey ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== token.annotationVersion ||
        typeof expectedComment !== 'string' || expectedComment !== token.comment ||
        typeof comment !== 'string' || comment.length > 20000)
      throw fail('edit_guard_mismatch', '备注编辑内容或来源与读取时不一致；请重新读取后保存。');

    const current = await this.#readTarget(identity);
    if (current.serverId !== token.serverId || current.sourceGuard.fingerprint !== token.sourceGuard ||
        current.annotation.version !== expectedVersion || current.attachment.version !== token.attachmentVersion ||
        current.comment !== expectedComment || current.snapshotHash !== token.snapshotHash)
      throw fail('version_conflict', '批注、PDF 或 Zotero 实例自读取后已变化；未覆盖备注。请重新读取后再编辑。');
    if (this.session.client?.status?.writes !== 'available')
      throw fail('writes_unsupported', '当前 Zotero 不支持写入或能力未确认；批注未更新。');
    if (typeof this.session.client?.status?.serverId !== 'string' || this.session.client.status.serverId !== token.serverId)
      throw fail('server_changed', 'Zotero 实例已变化；未提交修改。请重新读取当前批注。');

    if (comment === expectedComment) {
      return {
        status: 'verified', verified: true, changed: false, operationId: null, ...identity,
        comment: current.comment, annotationVersion: current.annotation.version,
        attachmentVersion: current.attachment.version, serverId: current.serverId,
        sourceGuard: current.sourceGuard
      };
    }

    const operationId = digest({
      kind: JOURNAL_KIND, ...identity, serverId: token.serverId,
      annotationVersion: expectedVersion, attachmentVersion: token.attachmentVersion,
      sourceGuard: token.sourceGuard, expectedCommentHash: token.commentHash,
      requestedCommentHash: textHash(comment)
    });
    const targetId = digest([identity.library, identity.annotationKey, identity.attachmentKey]);
    const submittedAt = this.now();
    const lockPath = await acquireTargetLock(this.directory, targetId, operationId, identity, submittedAt);
    try {
      let record = {
        kind: JOURNAL_KIND, operationId, status: 'outcome-unknown', ...identity,
        serverId: token.serverId,
        annotationVersion: expectedVersion,
        attachmentVersion: token.attachmentVersion,
        sourceGuard: token.sourceGuard,
        expectedCommentHash: token.commentHash,
        requestedCommentHash: textHash(comment),
        immutableSnapshotHash: token.snapshotHash,
        attempt: 1,
        submittedAt
      };
      record = await reserveOperation(this.directory, record);
      try {
        await writeAtomicJson(this.directory, `latest-reader-annotation-comment-${targetId}.json`, {
          kind: `${JOURNAL_KIND}-latest`, operationId, ...identity, updatedAt: submittedAt
        });
      } catch {
        record.status = 'rejected'; record.finishedAt = this.now(); record.errorCode = 'journal_unavailable';
        await this.#writeRecord(record).catch(() => {});
        throw fail('journal_unavailable', `无法保存未知结果核对入口；尚未向 Zotero 提交修改。操作编号：${operationId}`, operationId);
      }

      let response;
      try {
        response = await this.session.client.write('PATCH', `${libraryPrefix(identity.library)}/items/${encodeURIComponent(identity.annotationKey)}`, {
          body: JSON.stringify({ annotationComment: comment }),
          contentType: 'application/json',
          headers: { 'If-Unmodified-Since-Version': String(expectedVersion) }
        });
      } catch (error) {
        const safe = writeError(error);
        record.status = safe.definite ? 'rejected' : 'outcome-unknown';
        record.finishedAt = this.now(); record.errorCode = safe.code;
        try { await this.#writeRecord(record); }
        catch { throw fail('journal_unavailable', `${safe.message} 本地操作状态无法更新，请先重新读取 Zotero。操作编号：${operationId}`, operationId); }
        this.session.library.invalidate?.(identity.library);
        this.session.emit?.({ kind: 'library', library: identity.library });
        if (safe.definite) throw fail(safe.code, safe.message, operationId);
        return {
          status: 'outcome-unknown', verified: false, changed: null, operationId, ...identity,
          annotationVersion: expectedVersion, serverId: token.serverId,
          message: `${safe.message} 操作编号：${operationId}`
        };
      }

      this.session.library.invalidate?.(identity.library);
      this.session.emit?.({ kind: 'library', library: identity.library });
      if (response.status !== 200 && response.status !== 204) {
        const safe = httpWriteError(response.status);
        record.status = safe.definite ? 'rejected' : 'outcome-unknown';
        record.finishedAt = this.now(); record.errorCode = safe.code; record.httpStatus = response.status;
        try { await this.#writeRecord(record); }
        catch { throw fail('journal_unavailable', `${safe.message} 本地操作状态无法更新。操作编号：${operationId}`, operationId); }
        if (safe.definite) throw fail(safe.code, safe.message, operationId);
        return {
          status: 'outcome-unknown', verified: false, changed: null, operationId, ...identity,
          annotationVersion: expectedVersion, serverId: token.serverId,
          message: `${safe.message} 操作编号：${operationId}`
        };
      }

      record.acknowledgedAt = this.now(); record.httpStatus = response.status;
      try {
        const after = await this.#readTarget(identity);
        const responseServerId = response.headers?.get?.('zotero-server-id');
        const verified = after.comment === comment && after.annotation.version > expectedVersion &&
          after.attachment.version === token.attachmentVersion && after.snapshotHash === token.snapshotHash &&
          after.serverId === token.serverId && (!responseServerId || responseServerId === token.serverId);
        if (!verified) throw fail('readback_mismatch', 'Zotero 已回执，但备注或原批注字段未通过写后回读核实。');
        record.status = 'verified'; record.verifiedAt = this.now();
        record.postAnnotationVersion = after.annotation.version;
        record.verifiedCommentHash = textHash(after.comment);
        record.verification = 'exact_annotation_comment_and_immutable_fields';
        await this.#writeRecord(record);
        return {
          status: 'verified', verified: true, changed: true, operationId, ...identity,
          comment: after.comment, annotationVersion: after.annotation.version,
          attachmentVersion: after.attachment.version, serverId: after.serverId,
          sourceGuard: after.sourceGuard
        };
      } catch (error) {
        record.status = 'outcome-unknown'; record.errorCode = error?.code === 'readback_mismatch' ? 'readback_mismatch' : 'readback_failed';
        record.finishedAt = this.now();
        await this.#writeRecord(record).catch(() => {});
        return {
          status: 'outcome-unknown', verified: false, changed: null, operationId, ...identity,
          annotationVersion: expectedVersion, serverId: token.serverId,
          message: `Zotero 已回执，但备注保存尚未通过回读核实。请调用 read_reader_annotation_comment 读取当前备注，不要重复保存。操作编号：${operationId}`
        };
      }
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }
}
