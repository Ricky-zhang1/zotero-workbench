import { createHash, randomBytes } from 'node:crypto';
import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const LIBRARY = /^(user|g[1-9]\d{0,19})$/;
const KEY = /^[A-Z0-9]{8}$/;
const SOURCE_ID = /^[a-f0-9]{16}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ENTITY_ID = /^[a-f0-9]{24}$/;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_COUNT = 200;
const MAX_PARAGRAPHS = 100;
const MAX_CLAIMS = 500;
const MAX_BLOCK_TEXT = 12_000;
const MAX_DRAFT_TEXT = 32_000;
const MAX_READ_PAGES = 5;
const MAX_READ_RESPONSE_CHARS = 32_000;
const MAX_SOURCE_TEXT = 40_000;
const MAX_FEEDBACK_RESPONSE_TEXT = 40_000;
const MAX_STORED_DRAFTS = 10;
const MAX_FEEDBACK_PER_DRAFT = 100;
const SESSION_FEEDBACK_PREVIEW = 5;
const TERMINAL_LOCK_WAIT_MS = 12_000;
const inProcessQueues = new Map();

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
).digest('hex');
const randomId = () => randomBytes(12).toString('hex');
const fail = message => { throw new Error(message); };
const sourceVersionKey = source => `${source.id}:${source.fingerprint}`;

function record(value, message = '会话参数格式无效。') {
  if (!isRecord(value)) fail(message);
  return value;
}

function onlyKeys(value, allowed) {
  if (Object.keys(value).some(key => !allowed.has(key))) fail('会话参数中包含不支持的字段。');
}

function validId(value) {
  if (typeof value !== 'string' || !ENTITY_ID.test(value)) fail('会话编号无效。');
  return value;
}

function validLibrary(value = 'user') {
  if (typeof value !== 'string' || !LIBRARY.test(value)) fail('文库编号无效。');
  return value;
}

function validKey(value, label = '条目') {
  if (typeof value !== 'string' || !KEY.test(value)) fail(`${label}编号无效。`);
  return value;
}

function validExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('缺少有效的 expectedRevision，请先重新读取会话。');
  return value;
}

function validText(value, label, { min = 1, max = MAX_BLOCK_TEXT, trim = true } = {}) {
  if (typeof value !== 'string' || (trim && value.trim().length < min) || value.length > max)
    fail(`${label}长度无效。`);
  return value;
}

function checkExactKeys(value, allowed, label) {
  record(value, `${label}格式无效。`);
  onlyKeys(value, allowed);
}

function safeSessionFile(raw) {
  if (raw.length > MAX_SESSION_BYTES) fail('会话状态超过 8 MiB 安全上限；未覆盖。');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('会话状态文件损坏；未覆盖。'); }
  record(parsed, '会话状态文件格式无效；未覆盖。');
  const fields = new Set(['schemaVersion', 'id', 'revision', 'title', 'projectPath', 'createdAt', 'updatedAt', 'sources', 'drafts', 'feedback', 'readings']);
  onlyKeys(parsed, fields);
  if (parsed.schemaVersion !== 1 || !ENTITY_ID.test(parsed.id) || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1 ||
      typeof parsed.title !== 'string' || parsed.title.length > 200 ||
      !(parsed.projectPath === null || typeof parsed.projectPath === 'string') ||
      !Number.isFinite(parsed.createdAt) || !Number.isFinite(parsed.updatedAt) ||
      !Array.isArray(parsed.sources) || parsed.sources.length > MAX_SOURCE_COUNT ||
      !Array.isArray(parsed.drafts) || parsed.drafts.length > MAX_STORED_DRAFTS ||
      !Array.isArray(parsed.feedback) || parsed.feedback.length > 500 ||
      !Array.isArray(parsed.readings) || parsed.readings.length > 100) {
    fail('会话状态文件校验失败；未覆盖。');
  }
  for (const source of parsed.sources) {
    record(source, '会话来源状态损坏；未覆盖。');
    if (!SOURCE_ID.test(source.id) || !LIBRARY.test(source.library) || !KEY.test(source.itemKey) ||
        !KEY.test(source.key) || !FINGERPRINT.test(source.fingerprint) ||
        typeof source.url !== 'string' || !source.url.startsWith('zotero://'))
      fail('会话来源状态校验失败；未覆盖。');
  }
  if (parsed.sources.reduce((sum, source) => sum + String(source.text || '').length + String(source.comment || '').length, 0) > MAX_SOURCE_TEXT)
    fail('会话来源总文本超限；未覆盖。');
  return parsed;
}

function containsPath(root, child) {
  const rel = relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function compactRanges(numbers) {
  if (!numbers.length) return [];
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges = [];
  for (const page of sorted) {
    const last = ranges.at(-1);
    if (last && page === last[1] + 1) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges;
}

function expandRanges(ranges) {
  const pages = [];
  for (const range of ranges) for (let page = range[0]; page <= range[1]; page++) pages.push(page);
  return pages;
}

function latestDraft(session, draftId) {
  const draft = session.drafts.find(item => item.id === draftId);
  if (!draft) fail('目标草稿已不存在，无法记录反馈。');
  return draft;
}

function findFeedbackTarget(draft, claimId) {
  if (claimId === undefined) return { type: 'draft', id: draft.id, textSha256: draft.textSha256 };
  for (const paragraph of draft.paragraphs) {
    const claim = paragraph.claims.find(item => item.id === claimId);
    if (claim) return { type: 'claim', id: claim.id, textSha256: claim.textSha256 };
  }
  fail('反馈目标不属于指定草稿。');
}

function draftSourceIds(draft) {
  return new Set(draft.paragraphs.flatMap(paragraph => [
    ...paragraph.sourceIds,
    ...paragraph.claims.flatMap(claim => claim.sourceIds)
  ]));
}

export class CollaborationWorkspace {
  constructor({ stateDir, researchWorkspace, now = () => Date.now() } = {}) {
    if (!researchWorkspace || typeof researchWorkspace.writingSources !== 'function' ||
        typeof researchWorkspace.fulltext !== 'function' || typeof researchWorkspace.paper !== 'function')
      throw new Error('协作工作台需要已初始化的 ResearchWorkspace。');
    const base = stateDir || process.env.ZOTERO_WORKBENCH_STATE_DIR || join(homedir(), '.local/share/zotero-workbench');
    this.dir = join(resolve(base), 'collaboration', 'sessions');
    this.researchWorkspace = researchWorkspace;
    this.now = now;
  }

  async ready() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  async withLock(id, callback) {
    await this.ready();
    const queueKey = join(this.dir, id);
    const previous = inProcessQueues.get(queueKey) || Promise.resolve();
    let release;
    const gate = new Promise(resolveGate => { release = resolveGate; });
    const tail = previous.then(() => gate);
    inProcessQueues.set(queueKey, tail);
    await previous;
    const lockDir = join(this.dir, `.${id}.lock`);
    const deadline = Date.now() + TERMINAL_LOCK_WAIT_MS;
    let acquired = false;
    try {
      while (!acquired) {
        try {
          await mkdir(lockDir, { mode: 0o700 });
          try {
            await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' });
          } catch (error) {
            await rm(lockDir, { recursive: true, force: true }).catch(() => {});
            throw error;
          }
          acquired = true;
        } catch (error) {
          if (error.code !== 'EEXIST') {
            if (error.code === 'ENOENT' && !lockDir.startsWith(this.dir + sep)) fail('会话锁路径无效。');
            throw error;
          }
          await this.reclaimDeadLock(lockDir);
          if (Date.now() >= deadline) fail('会话正在另一项操作中，请稍后重新读取。');
          await new Promise(resolveWait => setTimeout(resolveWait, 20 + Math.floor(Math.random() * 30)));
        }
      }
      return await callback();
    } finally {
      if (acquired) await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      release();
      if (inProcessQueues.get(queueKey) === tail) inProcessQueues.delete(queueKey);
    }
  }

  async reclaimDeadLock(lockDir) {
    let owner;
    try { owner = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')); }
    catch {
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > 15_000) await rm(lockDir, { recursive: true, force: true });
      } catch {}
      return;
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return;
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  sessionPath(id) { return join(this.dir, `${validId(id)}.json`); }

  async load(id) {
    const path = this.sessionPath(id);
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') fail('会话不存在；请从会话列表中重新选择。'); throw error; }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SESSION_BYTES)
      fail('会话状态文件不可安全读取。');
    let raw;
    try { raw = await readFile(path, 'utf8'); } catch { fail('会话状态读取失败。'); }
    const session = safeSessionFile(raw);
    if (session.id !== id) fail('会话文件身份不匹配。');
    return session;
  }

  async save(session) {
    if (session.sources.length > MAX_SOURCE_COUNT || session.drafts.length > MAX_STORED_DRAFTS ||
        session.feedback.length > 500 || session.readings.length > 100 ||
        session.sources.reduce((sum, source) => sum + String(source.text || '').length + String(source.comment || '').length, 0) > MAX_SOURCE_TEXT)
      fail('会话记录数量超过安全上限；未保存。');
    const path = this.sessionPath(session.id);
    const bytes = Buffer.from(JSON.stringify(session));
    if (bytes.length > MAX_SESSION_BYTES) fail('会话状态超过 8 MiB 安全上限；未保存。');
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      await chmod(path, 0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      if (error?.message?.startsWith('会话')) throw error;
      fail('无法安全保存本地协作会话。');
    }
  }

  async currentSession(id, expectedRevision) {
    const session = await this.load(id);
    if (expectedRevision !== undefined && session.revision !== expectedRevision)
      fail(`会话版本已变化（当前 revision=${session.revision}）；请重新读取后再提交。`);
    return session;
  }

  async commit(session, expectedRevision) {
    if (session.revision !== expectedRevision) fail('会话在操作期间发生变化；未覆盖。');
    session.revision++;
    session.updatedAt = this.now();
    await this.save(session);
    return session;
  }

  publicSession(session, { draftId, includeSources = true, includeFeedback = true } = {}) {
    const { schemaVersion, ...view } = session;
    let drafts;
    if (draftId !== undefined) {
      const selected = session.drafts.find(item => item.id === draftId);
      if (!selected) fail('指定 draftId 不属于该会话。');
      drafts = [structuredClone(selected)];
    } else {
      const latest = session.drafts.at(-1);
      drafts = latest ? [this.draftSummary(latest)] : [];
    }
    const draftSummaries = session.drafts.slice(-10).map(item => this.draftSummary(item));
    const feedback = includeFeedback ? session.feedback.slice(-SESSION_FEEDBACK_PREVIEW).map(entry => {
      const draft = session.drafts.find(item => item.id === entry.draftId);
      const target = draft ? findFeedbackTarget(draft, entry.claimId || undefined) : null;
      return { ...entry, targetStillMatches: target?.textSha256 === entry.targetTextSha256,
        appliesToLatestDraft: session.drafts.at(-1)?.id === entry.draftId };
    }) : [];
    return {
      id: view.id, revision: view.revision, title: view.title, projectPath: view.projectPath,
      createdAt: view.createdAt, updatedAt: view.updatedAt,
      sources: includeSources ? structuredClone(view.sources) : [], sourceCount: view.sources.length,
      drafts, draftSummaries, draftCount: view.drafts.length,
      feedback, feedbackCount: view.feedback.length,
      readings: structuredClone(view.readings.slice(-20)), readingCount: view.readings.length
    };
  }

  draftSummary(draft) {
    return { id: draft.id, revision: draft.revision, title: draft.title, createdAt: draft.createdAt,
      paragraphCount: draft.paragraphs.length, claimCount: draft.paragraphs.reduce((sum, paragraph) => sum + paragraph.claims.length, 0),
      textSha256: draft.textSha256, contentIncluded: false };
  }

  async withStaleness(session, { draftId } = {}) {
    const grouped = new Map();
    const selectedDraft = draftId === undefined ? null : session.drafts.find(item => item.id === draftId);
    if (draftId !== undefined && !selectedDraft) fail('指定 draftId 不属于该会话。');
    const latestDraft = session.drafts.at(-1);
    const draftToCheck = selectedDraft || latestDraft;
    const sourcesToCheck = [...session.sources, ...(draftToCheck?.sources || [])];
    for (const source of sourcesToCheck) {
      const groupKey = `${source.library}:${source.itemKey}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      if (!grouped.get(groupKey).some(item => sourceVersionKey(item) === sourceVersionKey(source))) grouped.get(groupKey).push(source);
    }
    const statuses = new Map();
    for (const sources of grouped.values()) {
      const first = sources[0];
      let paper;
      try { paper = await this.researchWorkspace.paper(first.library, first.itemKey); }
      catch {
        for (const source of sources) statuses.set(sourceVersionKey(source), { stale: true, staleReason: 'read_failed' });
        continue;
      }
      if (paper.errors?.length) {
        for (const source of sources) statuses.set(sourceVersionKey(source), { stale: true, staleReason: 'read_incomplete' });
        continue;
      }
      for (const source of sources) {
        const current = paper.records.find(record => record.id === source.id);
        if (!current) statuses.set(sourceVersionKey(source), { stale: true, staleReason: 'source_missing' });
        else if (current.fingerprint !== source.fingerprint)
          statuses.set(sourceVersionKey(source), { stale: true, staleReason: 'fingerprint_changed' });
        else statuses.set(sourceVersionKey(source), { stale: false, staleReason: null });
      }
    }
    const result = this.publicSession(session, { draftId, includeSources: draftId === undefined });
    const withStatus = source => ({
      ...source, stale: statuses.get(sourceVersionKey(source))?.stale ?? true,
      staleReason: statuses.get(sourceVersionKey(source))?.staleReason ?? 'not_checked'
    });
    if (draftId !== undefined) result.drafts = [
      { ...result.drafts[0], sources: result.drafts[0].sources.map(withStatus) }
    ];
    else {
      result.sources = session.sources.map(withStatus);
      result.latestDraftStaleSources = (latestDraft?.sources || []).filter(source => statuses.get(sourceVersionKey(source))?.stale)
        .map(source => ({ id: source.id, fingerprint: source.fingerprint,
          reason: statuses.get(sourceVersionKey(source))?.staleReason || 'not_checked' }));
      result.latestDraftStaleSourceCount = result.latestDraftStaleSources.length;
    }
    return result;
  }

  async session(rawArgs) {
    const args = record(rawArgs);
    if (args.action === 'create') {
      onlyKeys(args, new Set(['action', 'title', 'projectPath']));
      const title = validText(args.title, '会话标题', { max: 200 });
      let projectPath = null;
      if (args.projectPath !== undefined) {
        if (typeof args.projectPath !== 'string' || !isAbsolute(args.projectPath) || args.projectPath.length > 2048)
          fail('项目目录必须是用户明确选择的绝对路径。');
        try {
          const statInfo = await stat(args.projectPath);
          if (!statInfo.isDirectory()) fail('项目路径必须是已有目录。');
          projectPath = resolve(args.projectPath);
        } catch (error) {
          if (error?.message?.startsWith('项目路径')) throw error;
          fail('无法读取用户选定的项目目录。');
        }
      }
      const id = randomId();
      return await this.withLock(id, async () => {
        const timestamp = this.now();
        const session = { schemaVersion: 1, id, revision: 1, title, projectPath,
          createdAt: timestamp, updatedAt: timestamp, sources: [], drafts: [], feedback: [], readings: [] };
        await this.save(session);
        return { session: this.publicSession(session) };
      });
    }
    if (args.action === 'get') {
      onlyKeys(args, new Set(['action', 'id', 'draftId']));
      const id = validId(args.id);
      if (args.draftId !== undefined) validId(args.draftId);
      const session = await this.load(id);
      return { session: await this.withStaleness(session, { draftId: args.draftId }) };
    }
    if (args.action === 'list') {
      onlyKeys(args, new Set(['action', 'limit']));
      const limit = args.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('会话列表 limit 必须在 1–100 之间。');
      await this.ready();
      const entries = (await readdir(this.dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && /^[a-f0-9]{24}\.json$/.test(entry.name))
        .map(entry => entry.name);
      const all = [];
      for (const filename of entries) {
        const current = await this.load(filename.slice(0, -5));
        all.push({ id: current.id, revision: current.revision, title: current.title,
          projectPath: current.projectPath, createdAt: current.createdAt, updatedAt: current.updatedAt,
          sourceCount: current.sources.length, draftCount: current.drafts.length,
          feedbackCount: current.feedback.length, readingCount: current.readings.length });
      }
      all.sort((a, b) => b.updatedAt - a.updatedAt);
      return { sessions: all.slice(0, limit) };
    }
    fail('collaboration_session action 必须是 create、get 或 list。');
  }

  validateSourceSelector(raw) {
    checkExactKeys(raw, new Set(['library', 'itemKey', 'attachmentKey', 'annotationKey', 'noteKey', 'fingerprint']), '来源选择');
    const library = validLibrary(raw.library);
    const itemKey = validKey(raw.itemKey, '父条目');
    const hasAnnotation = raw.annotationKey !== undefined;
    const hasNote = raw.noteKey !== undefined;
    if (hasAnnotation === hasNote) fail('每项来源必须且只能选择一条批注或一条笔记。');
    const key = validKey(hasAnnotation ? raw.annotationKey : raw.noteKey, hasAnnotation ? '批注' : '笔记');
    const attachmentKey = raw.attachmentKey === undefined ? null : validKey(raw.attachmentKey, '附件');
    if (hasAnnotation !== (attachmentKey !== null)) fail('PDF 批注必须同时提供附件编号；笔记不能附带附件编号。');
    if (typeof raw.fingerprint !== 'string' || !FINGERPRINT.test(raw.fingerprint)) fail('来源缺少研究者当前所见的指纹；请重新读取材料。');
    return { library, itemKey, key, attachmentKey, kind: hasNote ? 'note' : 'annotation', fingerprint: raw.fingerprint };
  }

  async resolveSelectedSources(selectors) {
    if (!Array.isArray(selectors) || !selectors.length || selectors.length > MAX_SOURCE_COUNT)
      fail('来源选择数量必须在 1–200 条之间。');
    const normalized = selectors.map(item => this.validateSourceSelector(item));
    const ids = normalized.map(item => hash([item.library, item.itemKey, item.key]).slice(0, 16));
    if (new Set(ids).size !== ids.length) fail('来源选择中包含重复批注或笔记。');
    const byGroup = new Map();
    for (const item of normalized) {
      const group = `${item.library}:${item.itemKey}`;
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(item);
    }
    for (const group of byGroup.values()) {
      const paper = await this.researchWorkspace.paper(group[0].library, group[0].itemKey);
      if (paper.errors?.length) fail('所选文献的批注或笔记未完整读取；请刷新后重新选择。');
      for (const selector of group) {
        const current = paper.records.find(item => item.id === hash([selector.library, selector.itemKey, selector.key]).slice(0, 16) &&
          item.key === selector.key && item.attachmentKey === selector.attachmentKey &&
          (selector.kind === 'note' ? item.kind === 'note' : item.kind !== 'note'));
        if (!current) fail('所选批注或笔记已不存在或身份不匹配；请刷新后重新选择。');
        if (current.fingerprint !== selector.fingerprint) fail('所选来源内容已变化；请刷新后重新选择，未沿用旧指纹。');
      }
    }
    const selected = [];
    const libraries = new Map();
    for (const source of normalized) {
      const key = source.library;
      if (!libraries.has(key)) libraries.set(key, []);
      libraries.get(key).push(source);
    }
    for (const [library, group] of libraries) {
      const keys = [...new Set(group.map(source => source.itemKey))];
      if (keys.length > 50) fail('每个文库最多一次选择 50 篇文献；请分批加入。');
      const groupIds = group.map(source => hash([source.library, source.itemKey, source.key]).slice(0, 16));
      const current = await this.researchWorkspace.writingSources({ library, keys, sourceIds: groupIds,
        sourceVersions: Object.fromEntries(group.map(source => [hash([source.library, source.itemKey, source.key]).slice(0, 16), source.fingerprint])) });
      selected.push(...current);
    }
    if (selected.reduce((sum, source) => sum + String(source.text || '').length + String(source.comment || '').length, 0) > MAX_SOURCE_TEXT)
      fail('所选来源原文与备注累计超过 40,000 字符；未截断或加入会话，请减少选择。');
    const byId = new Map(selected.map(source => [source.id, source]));
    return ids.map(id => {
      const source = byId.get(id);
      if (!source || source.humanSelected !== true) fail('Zotero 来源校验未通过；请重新读取。');
      return structuredClone(source);
    });
  }

  async sources(rawArgs) {
    const args = record(rawArgs);
    const common = new Set(['action', 'id', 'expectedRevision', 'sources', 'sourceIds']);
    onlyKeys(args, common);
    const id = validId(args.id), expectedRevision = validExpectedRevision(args.expectedRevision);
    if (!['add', 'remove', 'clear'].includes(args.action)) fail('collaboration_sources action 必须是 add、remove 或 clear。');
    if (args.action === 'add' && (args.sources === undefined || args.sourceIds !== undefined)) fail('add 必须提供 sources，不能同时提交 sourceIds。');
    if (args.action === 'remove' && args.sources !== undefined) fail('remove 只能提供 sourceIds。');
    if (args.action === 'clear' && (args.sources !== undefined || args.sourceIds !== undefined)) fail('clear 不接受来源列表。');
    if (args.action === 'remove' && (!Array.isArray(args.sourceIds) || !args.sourceIds.length || args.sourceIds.length > MAX_SOURCE_COUNT ||
        args.sourceIds.some(sourceId => typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) || new Set(args.sourceIds).size !== args.sourceIds.length))
      fail('remove 必须提供 1–200 个互不重复的有效 sourceIds。');
    const resolved = args.action === 'add' ? await this.resolveSelectedSources(args.sources) : [];
    return await this.withLock(id, async () => {
      const session = await this.currentSession(id, expectedRevision);
      let changed = false;
      if (args.action === 'add') {
        const existing = new Map(session.sources.map(source => [source.id, source]));
        for (const source of resolved) {
          const old = existing.get(source.id);
          if (old && old.fingerprint !== source.fingerprint) fail('会话中已有同一来源的旧版本；请先移除旧来源，再重新选入。');
          if (!old) { session.sources.push(source); existing.set(source.id, source); changed = true; }
        }
        if (session.sources.reduce((sum, source) => sum + String(source.text || '').length + String(source.comment || '').length, 0) > MAX_SOURCE_TEXT)
          fail('会话来源原文与备注累计超过 40,000 字符；未修改。');
      } else if (args.action === 'remove') {
        const remove = new Set(args.sourceIds);
        if (args.sourceIds.some(sourceId => !session.sources.some(source => source.id === sourceId)))
          fail('sourceIds 包含不属于本会话的来源；未修改。');
        const next = session.sources.filter(source => !remove.has(source.id));
        changed = next.length !== session.sources.length;
        session.sources = next;
      } else {
        changed = session.sources.length > 0;
        session.sources = [];
      }
      if (changed) await this.commit(session, expectedRevision);
      return { session: this.publicSession(session, { includeFeedback: false }) };
    });
  }

  async bindDocument(session, docPath) {
    if (docPath === undefined) return null;
    if (!session.projectPath) fail('稿件只读绑定需要在创建会话时明确选择项目目录。');
    if (typeof docPath !== 'string' || !docPath || docPath.length > 4096) fail('docPath 无效。');
    const root = resolve(session.projectPath);
    let realRoot, target;
    try {
      realRoot = await realpath(root);
      target = await realpath(isAbsolute(docPath) ? docPath : join(root, docPath));
    } catch { fail('无法读取用户指定的稿件路径。'); }
    if (!containsPath(realRoot, target)) fail('稿件必须位于会话明确选择的项目目录内。');
    if (!['.md', '.markdown'].includes(extname(target).toLowerCase()))
      fail('docPath 目前只支持 .md 或 .markdown 稿件。');
    let handle;
    try { handle = await open(target, O_RDONLY | (O_NOFOLLOW || 0)); }
    catch { fail('稿件只读绑定读取失败；请确认文件未被替换。'); }
    let bytes;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 8 * 1024 * 1024) fail('稿件必须是 8 MiB 以内的普通 Markdown 文件。');
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.byteLength > 8 * 1024 * 1024)
        fail('稿件在只读绑定期间发生变化或超过 8 MiB；未记录指纹。');
    } catch (error) {
      if (error?.message?.startsWith('稿件')) throw error;
      fail('稿件只读绑定读取失败。');
    } finally { await handle.close().catch(() => {}); }
    return { relativePath: relative(realRoot, target).split(sep).join('/'), sha256: hash(bytes), bytes: bytes.byteLength,
      observedAt: this.now() };
  }

  validateBlock(raw, allowedSourceIds, idSet, label) {
    checkExactKeys(raw, new Set(['id', 'text', 'sourceIds', 'claims']), label);
    const text = validText(raw.text, label);
    if (!Array.isArray(raw.sourceIds) || !raw.sourceIds.length || raw.sourceIds.length > MAX_SOURCE_COUNT ||
        raw.sourceIds.some(sourceId => typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) || !allowedSourceIds.has(sourceId)) ||
        new Set(raw.sourceIds).size !== raw.sourceIds.length)
      fail(`${label}必须引用本会话已选来源；不能引用范围外 sourceIds。`);
    const id = raw.id === undefined ? randomId() : this.validateBlockId(raw.id);
    if (idSet.has(id)) fail('段落或论断编号重复。');
    idSet.add(id);
    return { id, text, textSha256: hash(text), sourceIds: [...raw.sourceIds] };
  }

  validateBlockId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail('段落或论断编号格式无效。');
    return value;
  }

  async revalidateSessionSources(session) {
    if (!session.sources.length) fail('会话尚未选择 Zotero 高亮或笔记。');
    const libraries = new Map();
    for (const source of session.sources) {
      if (!libraries.has(source.library)) libraries.set(source.library, []);
      libraries.get(source.library).push(source);
    }
    const verified = new Map();
    for (const [library, sources] of libraries) {
      const keys = [...new Set(sources.map(source => source.itemKey))];
      if (keys.length > 50) fail('本会话每个文库最多保留 50 篇不同文献的来源。');
      const result = await this.researchWorkspace.writingSources({ library, keys,
        sourceIds: sources.map(source => source.id),
        sourceVersions: Object.fromEntries(sources.map(source => [source.id, source.fingerprint])) });
      for (const source of result) verified.set(source.id, source);
    }
    return verified;
  }

  async draft(rawArgs) {
    const args = record(rawArgs);
    onlyKeys(args, new Set(['id', 'expectedRevision', 'title', 'paragraphs', 'docPath']));
    const id = validId(args.id), expectedRevision = validExpectedRevision(args.expectedRevision);
    if (args.title !== undefined) validText(args.title, '草稿标题', { max: 200 });
    if (!Array.isArray(args.paragraphs) || !args.paragraphs.length || args.paragraphs.length > MAX_PARAGRAPHS)
      fail('草稿必须包含 1–100 个段落。');
    const textTotal = args.paragraphs.reduce((sum, paragraph) => {
      if (typeof paragraph?.text !== 'string') fail('段落文本格式无效。');
      let count = sum + paragraph.text.length;
      if (paragraph.claims !== undefined) {
        if (!Array.isArray(paragraph.claims)) fail('段落论断格式无效。');
        for (const claim of paragraph.claims) {
          if (typeof claim?.text !== 'string') fail('论断文本格式无效。');
          count += claim.text.length;
        }
      }
      return count;
    }, 0);
    const claimCount = args.paragraphs.reduce((sum, paragraph) => sum + (paragraph.claims?.length || 0), 0);
    if (claimCount > MAX_CLAIMS || textTotal > MAX_DRAFT_TEXT) fail('草稿或论断数量/总长度超过安全上限。');
    return await this.withLock(id, async () => {
      const session = await this.currentSession(id, expectedRevision);
      if (session.drafts.length >= MAX_STORED_DRAFTS)
        fail('本会话已保存 10 份草稿；旧稿不会被自动删除，请创建新会话继续。');
      const verified = await this.revalidateSessionSources(session);
      const allowed = new Set(verified.keys());
      const idSet = new Set();
      const paragraphs = args.paragraphs.map(paragraph => {
        checkExactKeys(paragraph, new Set(['id', 'text', 'sourceIds', 'claims']), '段落');
        const base = this.validateBlock({ id: paragraph.id, text: paragraph.text, sourceIds: paragraph.sourceIds }, allowed, idSet, '段落');
        if (paragraph.claims !== undefined && (!Array.isArray(paragraph.claims) || paragraph.claims.length > MAX_CLAIMS))
          fail('论断数量无效。');
        const claims = (paragraph.claims || []).map(claim => {
          checkExactKeys(claim, new Set(['id', 'text', 'sourceIds']), '论断');
          const block = this.validateBlock(claim, allowed, idSet, '论断');
          return { ...block, sourceLinks: block.sourceIds.map(sourceId => ({ id: sourceId, url: verified.get(sourceId).url })) };
        });
        return { ...base, sourceLinks: base.sourceIds.map(sourceId => ({ id: sourceId, url: verified.get(sourceId).url })), claims };
      });
      const binding = await this.bindDocument(session, args.docPath);
      const usedSourceIds = new Set(paragraphs.flatMap(paragraph => [
        ...paragraph.sourceIds, ...paragraph.claims.flatMap(claim => claim.sourceIds)
      ]));
      const draftId = randomId(), revision = expectedRevision + 1, createdAt = this.now();
      const textSha256 = hash({ title: args.title || '', paragraphs: paragraphs.map(({ id, text, textSha256: blockHash, claims }) => ({
        id, textSha256: blockHash, claims: claims.map(claim => ({ id: claim.id, textSha256: claim.textSha256 }))
      })) });
      const draft = { id: draftId, revision, title: args.title || '', createdAt, textSha256, docBinding: binding,
        sources: [...usedSourceIds].map(sourceId => structuredClone(verified.get(sourceId))), paragraphs };
      session.drafts.push(draft);
      await this.commit(session, expectedRevision);
      return { session: this.publicSession(session, { draftId: draft.id, includeSources: false, includeFeedback: false }) };
    });
  }

  async feedback(rawArgs) {
    const args = record(rawArgs);
    if (args.action === 'list') {
      onlyKeys(args, new Set(['action', 'id', 'draftId', 'limit', 'offset']));
      const id = validId(args.id), session = await this.load(id);
      if (args.draftId !== undefined) validId(args.draftId);
      const limit = args.limit ?? 20, offset = args.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
        fail('feedback.list 的 limit/offset 无效。');
      const all = session.feedback.filter(entry => args.draftId === undefined || entry.draftId === args.draftId).slice().reverse();
      const feedback = all.slice(offset, offset + limit).map(entry => {
        const draft = session.drafts.find(item => item.id === entry.draftId);
        const target = draft ? findFeedbackTarget(draft, entry.claimId || undefined) : null;
        return { ...entry, targetStillMatches: target !== null && target.textSha256 === entry.targetTextSha256,
          appliesToLatestDraft: session.drafts.at(-1)?.id === entry.draftId };
      });
      if (feedback.reduce((sum, entry) => sum + entry.comment.length, 0) > MAX_FEEDBACK_RESPONSE_TEXT)
        fail('本批反馈超过 40,000 字符；请调小 limit。');
      return { id, revision: session.revision, total: all.length,
        nextOffset: offset + feedback.length < all.length ? offset + feedback.length : null, feedback };
    }
    if (args.action !== 'record') fail('collaboration_feedback action 必须是 record 或 list。');
    onlyKeys(args, new Set(['action', 'id', 'expectedRevision', 'draftId', 'claimId', 'sourceIds', 'decision', 'comment']));
    const id = validId(args.id), expectedRevision = validExpectedRevision(args.expectedRevision);
    const draftId = validId(args.draftId);
    if (args.claimId !== undefined) this.validateBlockId(args.claimId);
    const decisions = new Set(['supports', 'needs_revision', 'unclear', 'contradicts']);
    if (!decisions.has(args.decision)) fail('反馈 decision 无效。');
    const comment = args.comment === undefined ? '' : validText(args.comment, '反馈', { min: 0, max: 5000, trim: false });
    if (args.sourceIds !== undefined && (!Array.isArray(args.sourceIds) || args.sourceIds.length > MAX_SOURCE_COUNT ||
        args.sourceIds.some(sourceId => typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) || new Set(args.sourceIds).size !== args.sourceIds.length))
      fail('反馈 sourceIds 无效。');
    return await this.withLock(id, async () => {
      const session = await this.currentSession(id, expectedRevision);
      const draft = latestDraft(session, draftId);
      if (session.feedback.filter(entry => entry.draftId === draftId).length >= MAX_FEEDBACK_PER_DRAFT || session.feedback.length >= 500)
        fail('反馈记录已达到会话上限；未覆盖旧记录。');
      const target = findFeedbackTarget(draft, args.claimId);
      const eligibleSources = draftSourceIds(draft);
      const sourceIds = args.sourceIds || [];
      if (sourceIds.some(sourceId => !eligibleSources.has(sourceId))) fail('反馈引用了该草稿未使用的来源。');
      if (args.claimId !== undefined) {
        const claim = draft.paragraphs.flatMap(paragraph => paragraph.claims).find(item => item.id === args.claimId);
        if (sourceIds.some(sourceId => !claim.sourceIds.includes(sourceId))) fail('论断反馈只能引用该论断关联的来源。');
      }
      const entry = { id: randomId(), draftId, claimId: args.claimId || null,
        targetType: target.type, targetId: target.id, targetTextSha256: target.textSha256,
        draftRevision: draft.revision, sourceIds: [...sourceIds], decision: args.decision, comment,
        actor: 'user', origin: 'app-only-user-action', createdAt: this.now() };
      session.feedback.push(entry);
      await this.commit(session, expectedRevision);
      return { sessionId: id, revision: session.revision, feedbackEntry: structuredClone(entry) };
    });
  }

  async readingProgress(session, library) {
    return session.readings.filter(item => library === undefined || item.library === library).map(item => ({ ...item }));
  }

  async read(rawArgs) {
    const args = record(rawArgs);
    if (args.action === 'get') {
      onlyKeys(args, new Set(['action', 'id', 'library']));
      const id = validId(args.id), session = await this.load(id);
      const library = args.library === undefined ? undefined : validLibrary(args.library);
      return { session: this.publicSession(session, { includeSources: false, includeFeedback: false }),
        readings: (await this.readingProgress(session, library)).slice(-20) };
    }
    if (args.action !== 'read') fail('collaboration_read action 必须是 read 或 get。');
    onlyKeys(args, new Set(['action', 'id', 'expectedRevision', 'library', 'key', 'cursor', 'maxPages']));
    const id = validId(args.id), expectedRevision = validExpectedRevision(args.expectedRevision);
    const library = validLibrary(args.library), key = validKey(args.key, '父条目');
    const maxPages = args.maxPages ?? 1;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_READ_PAGES) fail('每次全文续读必须交付 1–5 个完整页面。');
    await this.currentSession(id, expectedRevision);
    let extracted;
    try { extracted = await this.researchWorkspace.fulltext(library, key); }
    catch (error) {
      if (typeof error?.message === 'string' && /^(无法读取所选 PDF|仅支持可完整提取|PDF 文件不可读取|PDF 全文提取失败|全文提取页数不一致|有页面缺少可读取文字|全文超过当前模型流程|PDF 在全文提取期间)/.test(error.message)) throw error;
      fail('全文读取失败；未记录已交付页。');
    }
    const pageCount = extracted.pages.length;
    const result = await this.withLock(id, async () => {
      const session = await this.currentSession(id, expectedRevision);
      const reading = session.readings.find(item => item.library === library && item.key === key);
      if (reading && (reading.pdfSha256 !== extracted.sha256 || reading.attachmentKey !== extracted.attachmentKey || reading.totalPages !== pageCount))
        fail('PDF 指纹、附件或页数与续读记录不同；未接续旧页码。请在新会话重新开始。');
      const delivered = reading ? expandRanges(reading.deliveredRanges) : [];
      if (reading && reading.nextPage === null) fail('该 PDF 的可提取全文已全部交付；请用 get 查询进度。');
      const nextPage = reading?.nextPage ?? 1;
      const cursor = args.cursor ?? nextPage;
      if (!Number.isInteger(cursor) || cursor !== nextPage) fail(`全文续读游标必须是下一未交付页 ${nextPage}。`);
      if (cursor > pageCount) fail('全文续读游标超出页数。');
      if (typeof extracted.title !== 'string' || extracted.title.length > 500) fail('Zotero 条目标题过长，未创建全文续读记录。');
      const selectedPages = extracted.pages.slice(cursor - 1, Math.min(cursor - 1 + maxPages, pageCount));
      if (selectedPages.reduce((total, page) => total + page.text.length, 0) > MAX_READ_RESPONSE_CHARS)
        fail('本次完整页面超过 32,000 字符交付上限；未截断也未记录为已交付，请改用较小页范围。');
      const now = this.now();
      const allDelivered = [...delivered, ...selectedPages.map(page => page.page)];
      const ranges = compactRanges(allDelivered);
      const next = allDelivered.length >= pageCount ? null : Math.max(...allDelivered, 0) + 1;
      const progress = reading || { library, key, itemKey: extracted.itemKey, title: extracted.title,
        attachmentKey: extracted.attachmentKey, pdfSha256: extracted.sha256, totalPages: pageCount,
        deliveredRanges: [], nextPage: 1, createdAt: now };
      progress.deliveredRanges = ranges;
      progress.nextPage = next;
      progress.updatedAt = now;
      if (!reading) session.readings.push(progress);
      await this.commit(session, expectedRevision);
      const allNowDelivered = new Set(allDelivered);
      return { session, deliveredPages: selectedPages.map(page => page.page),
        notProcessedPages: Array.from({ length: pageCount }, (_, i) => i + 1).filter(page => !allNowDelivered.has(page)),
        nextPage: next, understanding: 'not_assessed', pages: selectedPages.map(page => ({ page: page.page, text: page.text })),
        pdfSha256: extracted.sha256, totalPages: pageCount, attachmentKey: extracted.attachmentKey };
    });
      return { ...result, session: this.publicSession(result.session, { includeSources: false, includeFeedback: false }) };
  }
}
