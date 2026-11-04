import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { libraryPrefix, ZoteroSession } from '../../dist/runtime.mjs';
import { scopeKeys } from './evidence.mjs';
import { annotationLink } from './library.mjs';
import { installPagination } from '../transports/zotero-local.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hash = value => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
).digest('hex');
const keyPattern = /^[A-Z0-9]{8}$/;
const libraryPattern = /^(user|g[1-9]\d{0,19})$/;
const sourceIdPattern = /^[a-f0-9]{16}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const jobIdPattern = /^[a-f0-9]{24}$/;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class ResearchWorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResearchWorkspaceError';
  }
}

const failure = message => new ResearchWorkspaceError(message);

function requireRecord(value, message = '参数格式无效。') {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function onlyKeys(value, allowed, message = '参数中包含不支持的字段。') {
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(message);
}

function validLibrary(value = 'user') {
  if (typeof value !== 'string' || !libraryPattern.test(value)) throw new Error('无效文库。');
  return value;
}

function validItemKey(value, label = '条目') {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new Error(`无效${label}编号。`);
  return value;
}

function validKeyList(value, { min = 1, max = 50, label = '文献' } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      value.some(key => typeof key !== 'string' || !keyPattern.test(key)) || new Set(value).size !== value.length) {
    throw new Error(`${label}编号无效；请提供 ${min}–${max} 个互不重复的有效编号。`);
  }
  return [...value];
}

function safeReadError() {
  return '读取材料失败；请检查 Zotero 连接后重新读取。';
}

function safeJobError(error) {
  if (error instanceof ResearchWorkspaceError) return error.message;
  return '研究任务未能完成；未保存不完整结果。';
}

export function noteText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:p|div|h[1-6]|li|br|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const codepoint = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff)
        ? String.fromCodePoint(codepoint) : '';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
    })[name])
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function materialRecord({ library, itemKey, title, raw, attachmentKey }) {
  validLibrary(library);
  validItemKey(itemKey);
  const record = requireRecord(raw, 'Zotero 返回的材料格式无效。');
  const d = requireRecord(record.data, 'Zotero 返回的材料格式无效。');
  const sourceKey = validItemKey(record.key, '批注');
  const isNote = d.itemType === 'note';
  if (!isNote && d.itemType !== 'annotation') throw new Error('仅支持 Zotero 批注和笔记作为写作材料。');
  let position = {};
  try { position = JSON.parse(d.annotationPosition || '{}'); } catch { /* a note can have no PDF position */ }
  const pageIndex = Number.isInteger(position.pageIndex) && position.pageIndex >= 0 ? position.pageIndex : null;
  const resolvedAttachment = attachmentKey == null ? null : validItemKey(attachmentKey, '附件');
  const url = isNote || pageIndex === null
    ? `zotero://select/${library === 'user' ? 'library' : `groups/${library.slice(1)}`}/items/${sourceKey}`
    : annotationLink(library, resolvedAttachment, sourceKey, pageIndex);
  return {
    id: hash([library, itemKey, sourceKey]).slice(0, 16),
    library,
    itemKey,
    title: typeof title === 'string' ? title : '',
    key: sourceKey,
    attachmentKey: resolvedAttachment,
    kind: isNote ? 'note' : d.annotationType || 'annotation',
    text: isNote ? noteText(d.note) : (typeof d.annotationText === 'string' ? d.annotationText : ''),
    comment: isNote ? '' : (typeof d.annotationComment === 'string' ? d.annotationComment : ''),
    pageIndex,
    pageLabel: typeof d.annotationPageLabel === 'string' ? d.annotationPageLabel : '',
    color: typeof d.annotationColor === 'string' ? d.annotationColor : '',
    url,
    modified: typeof d.dateModified === 'string' ? d.dateModified : '',
    origin: 'not-inferred',
    humanSelected: false,
    fingerprint: hash(d)
  };
}

export function validateDraft(draft, sources) {
  if (!isRecord(draft) || !Array.isArray(draft.paragraphs) || !draft.paragraphs.length || draft.paragraphs.length > 100 ||
      !Array.isArray(sources) || !sources.length) {
    throw failure('AI 未返回可用段落；未保存不完整结果。');
  }
  const byId = new Map();
  for (const source of sources) {
    if (!isRecord(source) || typeof source.id !== 'string' || !sourceIdPattern.test(source.id) ||
        typeof source.url !== 'string' || !source.url.startsWith('zotero://') ||
        source.humanSelected !== true || !['annotation', 'note', 'highlight', 'image', 'ink', 'underline', 'text'].includes(source.kind)) {
      throw failure('所选材料缺少可核对的 Zotero 来源回链；未保存初稿。');
    }
    if (byId.has(source.id)) throw failure('所选材料编号重复；未保存初稿。');
    byId.set(source.id, source);
  }
  const paragraphs = draft.paragraphs.map(paragraph => {
    if (!isRecord(paragraph) || typeof paragraph.text !== 'string' || !paragraph.text.trim() || paragraph.text.length > 12000 ||
        !Array.isArray(paragraph.sourceIds) || !paragraph.sourceIds.length || paragraph.sourceIds.length > byId.size ||
        paragraph.sourceIds.some(id => typeof id !== 'string' || !sourceIdPattern.test(id) || !byId.has(id)) ||
        new Set(paragraph.sourceIds).size !== paragraph.sourceIds.length) {
      throw failure('段落缺少所选材料回链，或引用了范围外来源；未作为成稿保存。');
    }
    const sourceLinks = paragraph.sourceIds.map(id => {
      const source = byId.get(id);
      return { id, title: source.title, text: source.text, comment: source.comment, kind: source.kind,
        pageIndex: source.pageIndex, pageLabel: source.pageLabel, url: source.url };
    });
      return { ...paragraph, sourceLinks: sourceLinks.map(source => ({
        id: source.id, title: source.title, kind: source.kind,
        pageIndex: source.pageIndex, pageLabel: source.pageLabel, url: source.url
      })) };
  });
  if (draft.title !== undefined && (typeof draft.title !== 'string' || draft.title.length > 500))
    throw failure('AI 返回的标题格式无效；未保存初稿。');
  if (draft.gaps !== undefined && (!Array.isArray(draft.gaps) || draft.gaps.length > 100 ||
      draft.gaps.some(gap => typeof gap !== 'string' || gap.length > 2000)))
    throw failure('AI 返回的证据缺口格式无效；未保存初稿。');
  return {
    title: typeof draft.title === 'string' ? draft.title : '',
    paragraphs,
    gaps: draft.gaps || [],
    sources,
    reviewStatus: 'human-review-required',
    basis: 'human-selected-notes-only'
  };
}

export function validateFoldResult(result, payload) {
  const pages = payload?.pages;
  if (!isRecord(result) || !Array.isArray(pages) || !pages.length ||
      result.format !== 'textfold/doc' || result.version !== 0 ||
      result.provenance?.ai_generated !== true || result.provenance?.local !== false ||
      typeof result.provenance?.made_with !== 'string' || !result.provenance.made_with.includes('0.10.40') ||
      typeof result.provenance?.model !== 'string' || !result.provenance.model ||
      result.coverage?.allUnitsAI !== true || result.coverage?.pages !== pages.length ||
      !Number.isInteger(result.coverage?.units) || result.coverage.units < 1 ||
      !Array.isArray(result.sections) || result.sections.length !== pages.length) {
    throw failure('TextFold 未完成全文 AI 生成或覆盖核验，未保存局部结果。');
  }
  const expected = new Set(pages.map((_, index) => index));
  const seen = new Set();
  let units = 0;
  for (const section of result.sections) {
    if (!isRecord(section) || !Number.isInteger(section.pageIndex) || !expected.has(section.pageIndex) ||
        seen.has(section.pageIndex) || !Array.isArray(section.units)) {
      throw failure('TextFold 页码覆盖不完整，未保存局部结果。');
    }
    seen.add(section.pageIndex);
    units += section.units.length;
    for (const unit of section.units) {
      if (!isRecord(unit) || typeof unit.full !== 'string' || !unit.full.trim() ||
          !Array.isArray(unit.sentences) || !unit.sentences.length ||
          unit.sentences.some(sentence => typeof sentence !== 'string') ||
          !Array.isArray(unit.brief) || unit.brief.some(sentence => typeof sentence !== 'string') ||
          !Array.isArray(unit.evidence) || unit.evidence.some(index => !Number.isInteger(index) || index < 0 || index >= unit.sentences.length)) {
        throw failure('TextFold 单元结构不完整，未保存局部结果。');
      }
    }
  }
  if (seen.size !== pages.length || units !== result.coverage.units)
    throw failure('TextFold 页码或段落覆盖不完整，未保存局部结果。');
  return result;
}

export class ResearchWorkspace {
  constructor({ session, stateDir, runner, workerPython } = {}) {
    this.ownsSession = !session;
    this.session = session || new ZoteroSession({
      baseUrl: process.env.ZOTERO_URL || 'http://127.0.0.1:23119',
      keyFile: null,
      workspaceRoot: root,
      pdfjsDataDir: join(root, 'dist/pdfjs'),
      log: () => {}
    });
    if (!session) installPagination(this.session.client);
    this.dir = stateDir || join(process.env.ZOTERO_WORKBENCH_STATE_DIR || join(homedir(), '.local/share/zotero-workbench'), 'research');
    this.runner = runner;
    this.workerPython = workerPython;
    this.active = new Map();
    this.scopes = new Map();
    this.saveQueues = new Map();
    this.closed = false;
  }

  async ready() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    if (!this.closed) await this.session.ready();
    else throw new Error('研究工作台已关闭。');
  }

  async writeAtomic(id, value) {
    const path = join(this.dir, `${id}.json`);
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async save(id, valueOrSnapshot) {
    if (!jobIdPattern.test(id)) throw new Error('无效任务编号。');
    const previous = this.saveQueues.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const value = typeof valueOrSnapshot === 'function' ? valueOrSnapshot() : valueOrSnapshot;
      await this.writeAtomic(id, value);
    });
    this.saveQueues.set(id, pending);
    try { await pending; }
    finally { if (this.saveQueues.get(id) === pending) this.saveQueues.delete(id); }
  }

  persist(job) { return this.save(job.id, () => this.public(job)); }

  validateMaterialsArgs(rawArgs) {
    const args = requireRecord(rawArgs);
    onlyKeys(args, new Set(['library', 'keys', 'collection', 'recursive', 'scopeId', 'offset', 'limit']));
    const library = validLibrary(args.library ?? 'user');
    if (args.keys !== undefined) validKeyList(args.keys, { min: 1, max: 500 });
    if (args.collection !== undefined) validItemKey(args.collection, '分类');
    if (args.keys?.length && args.collection) throw new Error('请按文献列表或分类创建读取范围。');
    if (!args.keys?.length && !args.collection && !args.scopeId) throw new Error('请先选择文献或一个分类。');
    if (args.recursive !== undefined && typeof args.recursive !== 'boolean') throw new Error('分类递归参数无效。');
    if (args.scopeId !== undefined && (typeof args.scopeId !== 'string' || !/^[a-f0-9]{24}$/.test(args.scopeId)))
      throw new Error('读取范围编号无效，请重新读取。');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 5;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
        !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('分页参数无效。');
    return { ...args, library, offset, limit };
  }

  async materials(rawArgs) {
    const args = this.validateMaterialsArgs(rawArgs);
    await this.ready();
    const library = args.library;
    try { await this.session.library.checkVersion(library); }
    catch { throw new Error('无法确认 Zotero 文库版本；请检查连接后重新读取。'); }
    const version = String(this.session.library.versionOf(library));
    let scope = args.scopeId ? this.scopes.get(args.scopeId) : null;
    if (args.scopeId && !scope) throw new Error('范围已过期，请重新读取。');
    if (!scope) {
      if (args.offset) throw new Error('续页需要 scopeId。');
      try {
        const keys = await scopeKeys(this.session, { ...args, library, recursive: args.recursive !== false });
        scope = { library, version, keys };
      } catch {
        throw new Error('无法建立完整读取范围；请检查 Zotero 连接、所选分类和文库权限。');
      }
      args.scopeId = randomBytes(12).toString('hex');
      this.scopes.set(args.scopeId, scope);
      if (this.scopes.size > 30) this.scopes.delete(this.scopes.keys().next().value);
    }
    if (scope.library !== library || scope.version !== version) throw new Error('文库变化，请重新读取标注。');
    if (args.offset > scope.keys.length) throw new Error('分页位置超出当前读取范围。');
    const papers = [];
    const errors = [];
    const selectedKeys = scope.keys.slice(args.offset, args.offset + args.limit);
    for (const key of selectedKeys) {
      try { papers.push(await this.paper(library, key)); }
      catch { errors.push({ itemKey: key, message: safeReadError() }); }
    }
    try { await this.session.library.checkVersion(library); }
    catch { throw new Error('无法确认 Zotero 文库版本；请检查连接后重新读取。'); }
    if (String(this.session.library.versionOf(library)) !== version) throw new Error('文库在读取期间变化，请重新读取。');
    const processed = args.offset + selectedKeys.length;
    return {
      scopeId: args.scopeId,
      library,
      version,
      total: scope.keys.length,
      processed,
      nextOffset: processed < scope.keys.length ? processed : null,
      papers,
      errors,
      incomplete: errors.length > 0 || papers.some(paper => paper.errors.length > 0)
    };
  }

  async paper(library, key) {
    validLibrary(library);
    validItemKey(key);
    const prefix = libraryPrefix(library);
    const { data: raw } = await this.session.client.getJson(`${prefix}/items/${key}`);
    const data = raw?.data;
    if (!data || ['attachment', 'annotation', 'note'].includes(data.itemType))
      return { itemKey: key, title: data?.title || key, records: [], errors: [] };
    const title = typeof data.title === 'string' ? data.title : key;
    const records = [];
    const errors = [];
    const { data: children } = await this.session.client.getJson(`${prefix}/items/${key}/children`);
    if (!Array.isArray(children)) throw new Error('Zotero 返回的子条目分页不完整。');
    for (const child of children) {
      if (!isRecord(child) || !isRecord(child.data)) throw new Error('Zotero 返回的子条目格式无效。');
      if (child.data.itemType === 'note') {
        records.push(materialRecord({ library, itemKey: key, title, raw: child }));
      } else if (child.data.itemType === 'attachment') {
        const attachmentKey = validItemKey(child.key, '附件');
        try {
          const { data: annotations } = await this.session.client.getJson(`${prefix}/items/${attachmentKey}/children?itemType=annotation`);
          if (!Array.isArray(annotations)) throw new Error('Zotero 返回的批注分页不完整。');
          for (const annotation of annotations) {
            if (annotation?.data?.itemType !== 'annotation') continue;
            records.push(materialRecord({ library, itemKey: key, title, raw: annotation, attachmentKey }));
          }
        } catch {
          errors.push({ attachmentKey, message: safeReadError() });
        }
      }
    }
    return {
      itemKey: key,
      title,
      creators: Array.isArray(data.creators) ? data.creators : [],
      year: typeof data.date === 'string' ? (data.date.match(/\d{4}/)?.[0] || '') : '',
      records: records.filter(record => record.text || record.comment),
      errors
    };
  }

  validateWritingArgs(rawArgs) {
    const args = requireRecord(rawArgs);
    onlyKeys(args, new Set(['library', 'keys', 'sourceIds', 'sourceVersions', 'purpose', 'framework']));
    const library = validLibrary(args.library ?? 'user');
    const keys = validKeyList(args.keys, { min: 1, max: 50 });
    if (!Array.isArray(args.sourceIds) || !args.sourceIds.length || args.sourceIds.length > 200 ||
        args.sourceIds.some(id => typeof id !== 'string' || !sourceIdPattern.test(id)) ||
        new Set(args.sourceIds).size !== args.sourceIds.length) {
      throw new Error('所选标注编号无效；请重新勾选 1–200 条标注。');
    }
    const versions = requireRecord(args.sourceVersions, '所选标注缺少版本校验；请重新勾选。');
    if (Object.keys(versions).length !== args.sourceIds.length || args.sourceIds.some(id =>
      !own(versions, id) || typeof versions[id] !== 'string' || !fingerprintPattern.test(versions[id]))) {
      throw new Error('所选标注缺少有效版本校验；请重新勾选。');
    }
    const purpose = args.purpose ?? 'paragraph';
    const framework = args.framework ?? '';
    if (!['paragraph', 'review'].includes(purpose) || typeof framework !== 'string' || framework.length > 12000)
      throw new Error('写作要求无效或过长。');
    return { library, keys, sourceIds: [...args.sourceIds], sourceVersions: versions, purpose, framework };
  }

  async writingSources(rawArgs) {
    const args = this.validateWritingArgs(rawArgs);
    let version;
    try {
      await this.session.library.checkVersion(args.library);
      version = String(this.session.library.versionOf(args.library));
    } catch { throw failure('无法确认 Zotero 文库版本；请刷新后再写作。'); }
    const records = [];
    for (const key of args.keys) {
      let paper;
      try { paper = await this.paper(args.library, key); }
      catch { throw failure('所选文献的批注或笔记未完整读取；请刷新后再写作。'); }
      if (paper.errors.length) throw failure('所选文献的批注或笔记未完整读取；请刷新后再写作。');
      records.push(...paper.records);
    }
    let currentVersion;
    try {
      await this.session.library.checkVersion(args.library);
      currentVersion = String(this.session.library.versionOf(args.library));
    } catch { throw failure('无法确认 Zotero 文库版本；请刷新后再写作。'); }
    if (currentVersion !== version)
      throw failure('文库在选取材料时发生变化，请刷新后重新勾选。');
    const selected = args.sourceIds.map(id => {
      const record = records.find(candidate => candidate.id === id);
      if (!record) throw failure('所选标注已经删除或变更，请刷新。');
      if (args.sourceVersions[id] !== record.fingerprint)
        throw failure('选中的标注内容已变化，请刷新后重新勾选。');
      if (!record.url.startsWith('zotero://') || !['note', 'annotation', 'highlight', 'image', 'ink', 'underline', 'text'].includes(record.kind))
        throw failure('所选材料不是可回链的 Zotero 批注或笔记。');
      return { ...record, humanSelected: true };
    });
    if (JSON.stringify(selected).length > 110000)
      throw failure('所选材料过长，请缩小写作范围；没有截断发送。');
    return selected;
  }

  async fulltext(library, key) {
    validLibrary(library);
    validItemKey(key);
    let source;
    try { source = await this.session.pdfText(library, key); }
    catch { throw failure('无法读取所选 PDF；请确认附件仍可读取。'); }
    const { item, attachment, pdf, path } = source || {};
    const pages = pdf?.pages;
    if (!Array.isArray(pages) || !pages.length || pages.length > 200 || typeof path !== 'string' ||
        !isRecord(item) || !isRecord(attachment)) throw failure('仅支持可完整提取的 1–200 页 PDF。');
    validItemKey(item.key);
    validItemKey(attachment.key, '附件');
    let before;
    try { before = await readFile(path); }
    catch { throw failure('PDF 文件不可读取；未启动 AI。'); }
    const fingerprint = hash(before);
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)(process.env.PDFTOTEXT_PATH || 'pdftotext',
        ['-enc', 'UTF-8', path, '-'], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }));
    } catch { throw failure('PDF 全文提取失败；未启动 AI。'); }
    const texts = stdout.replace(/\r\n?/g, '\n').split('\f');
    if (texts.at(-1)?.trim() === '') texts.pop();
    if (texts.length !== pages.length) throw failure('全文提取页数不一致，未启动 AI。');
    const extracted = texts.map((text, index) => ({ page: index + 1, text: text.trim() }));
    if (extracted.some(page => page.text.replace(/\s/g, '').length < 15))
      throw failure('有页面缺少可读取文字，可能是扫描页或图表页。请先完成 OCR；未将部分内容冒充全文。');
    if (stdout.length > 160000) throw failure('全文超过当前模型流程的 16 万字符上限，未截断生成。');
    let after;
    try { after = await readFile(path); }
    catch { throw failure('PDF 在全文提取期间不可读取；未启动 AI。'); }
    if (hash(after) !== fingerprint) throw failure('PDF 在全文提取期间发生变化；请重新读取。');
    return {
      title: typeof item.title === 'string' && item.title ? item.title : (attachment.title || key),
      itemKey: item.key,
      attachmentKey: attachment.key,
      library,
      pages: extracted,
      sha256: fingerprint,
      sourcePath: path
    };
  }

  validateStartArgs(rawArgs) {
    const args = requireRecord(rawArgs);
    onlyKeys(args, new Set(['kind', 'library', 'key', 'keys', 'sourceIds', 'sourceVersions', 'purpose', 'framework']));
    if (!['fold', 'draft'].includes(args.kind)) throw new Error('无效任务。');
    if (args.kind === 'fold') {
      const library = validLibrary(args.library ?? 'user');
      const key = validItemKey(args.key);
      if (args.keys !== undefined || args.sourceIds !== undefined || args.sourceVersions !== undefined)
        throw new Error('全文折叠只接受一篇 PDF 的 Zotero 条目编号。');
      if (args.purpose !== undefined && !['paragraph', 'review'].includes(args.purpose)) throw new Error('任务参数无效。');
      if (args.framework !== undefined && (typeof args.framework !== 'string' || args.framework.length > 12000))
        throw new Error('任务参数无效。');
      return { kind: 'fold', library, key };
    }
    if (args.key !== undefined) throw new Error('标注写作必须提供研究者选定的材料编号。');
    const { kind, ...writingArgs } = args;
    return { kind, ...this.validateWritingArgs(writingArgs) };
  }

  async start(rawArgs) {
    const args = this.validateStartArgs(rawArgs);
    await this.ready();
    const signature = hash(args);
    for (const job of this.active.values()) if (job.signature === signature) return this.public(job);
    if (this.active.size >= 2) throw new Error('已有两项任务执行中，请等待完成。');
    const id = randomBytes(12).toString('hex');
    const job = {
      id, signature, kind: args.kind, status: 'running', stage: '读取材料', createdAt: Date.now(),
      ownerPid: process.pid, progress: 0
    };
    this.active.set(id, job);
    try { await this.persist(job); }
    catch {
      this.active.delete(id);
      throw new Error('无法安全保存任务状态；未启动 AI。');
    }
    void this.run(job, args).catch(async () => {
      if (!terminalStatuses.has(job.status)) {
        job.status = 'failed';
        job.stage = '未完成';
        job.error = '研究任务未能完成；未保存不完整结果。';
      }
      this.active.delete(job.id);
      await this.persist(job).catch(() => {});
    });
    return this.public(job);
  }

  public(job) {
    const { child, signature, ...data } = job;
    return data;
  }

  async run(job, args) {
    const scratch = join(this.dir, job.id);
    try {
      let payload;
      if (args.kind === 'fold') payload = { kind: 'fold', ...await this.fulltext(args.library, args.key) };
      else {
        const { kind, ...writingArgs } = args;
        payload = { kind, sources: await this.writingSources(writingArgs), purpose: args.purpose, framework: args.framework };
      }
      if (job.status !== 'running') return;
      job.stage = args.kind === 'fold' ? 'AI 通读全文' : 'AI 阅读所选标注';
      await this.persist(job);
      await mkdir(scratch, { recursive: false, mode: 0o700 });
      const progress = async update => {
        if (job.status !== 'running' || !isRecord(update)) return;
        if (typeof update.stage === 'string' && update.stage.length <= 160) job.stage = update.stage;
        if (Number.isFinite(update.progress)) job.progress = Math.max(0, Math.min(99, Math.floor(update.progress)));
        await this.persist(job);
      };
      let result;
      if (this.runner) {
        try { result = await this.runner(payload, progress); }
        catch { throw failure('AI 调用失败，未生成完整结果。'); }
      } else result = await this.spawnWorker(job, payload, scratch, progress);
      if (job.status !== 'running') return;
      if (args.kind === 'draft') job.result = validateDraft(result, payload.sources);
      else {
        validateFoldResult(result, payload);
        let current;
        try { current = await readFile(payload.sourcePath); }
        catch { throw failure('生成期间无法确认 PDF 版本；未保存结果。'); }
        if (hash(current) !== payload.sha256) throw failure('生成期间 PDF 已变更，请重新生成。');
        job.result = {
          ...result,
          library: payload.library,
          itemKey: payload.itemKey,
          attachmentKey: payload.attachmentKey,
          sha256: payload.sha256
        };
      }
      job.status = 'completed';
      job.stage = '已完成';
      job.progress = 100;
      job.completedAt = Date.now();
    } catch (error) {
      if (!terminalStatuses.has(job.status)) {
        job.status = 'failed';
        job.stage = '未完成';
        job.error = safeJobError(error);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      try { await this.persist(job); }
      catch { /* the in-memory status remains available until the run settles */ }
      finally { this.active.delete(job.id); }
    }
  }

  spawnWorker(job, payload, scratch, progress) {
    return new Promise((resolve, reject) => {
      const python = this.workerPython || process.env.ZOTERO_WORKBENCH_PYTHON || join(root, '.runtime/textfold/bin/python');
      let child;
      try {
        child = spawn(python, [join(root, 'scripts/research-worker.py'), scratch], {
          cwd: scratch,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONPATH: join(root, 'vendor/textfold'), PYTHONUNBUFFERED: '1' }
        });
      } catch {
        reject(failure('TextFold 后台环境无法启动。'));
        return;
      }
      job.child = child;
      let lines = '';
      let workerErrorCode = '';
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        this.kill(job);
        settle(reject, failure('研究任务超过 30 分钟，已停止。'));
      }, 1800000);
      timer.unref?.();
      child.stdout.on('data', chunk => {
        lines += chunk.toString('utf8');
        if (lines.length > 65536) lines = lines.slice(-65536);
        let end;
        while ((end = lines.indexOf('\n')) >= 0) {
          const line = lines.slice(0, end);
          lines = lines.slice(end + 1);
          try {
            const update = JSON.parse(line);
            if (['codex_cli_missing', 'ai_call_failed', 'textfold_incomplete', 'worker_failed'].includes(update.errorCode))
              workerErrorCode = update.errorCode;
            else void progress(update).catch(() => {});
          } catch { /* ignore non-progress output; stderr is never returned to callers */ }
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', error => {
        const message = error?.code === 'ENOENT'
          ? 'TextFold 运行环境未安装，请运行插件的 setup-research.py。'
          : 'TextFold 后台环境无法启动。';
        settle(reject, failure(message));
      });
      child.on('close', async code => {
        if (settled) return;
        try {
          if (job.status !== 'running') throw new Error('任务已停止。');
          if (code !== 0) {
            const message = {
              codex_cli_missing: '没有找到已登录的 Codex CLI，请配置 ZOTERO_WORKBENCH_CODEX。',
              ai_call_failed: 'Codex 模型调用失败，未生成完整结果。',
              textfold_incomplete: 'TextFold 未完成全部 AI 折叠，已拒绝本地首句回退。',
              worker_failed: '研究任务未能完成；未保存不完整结果。'
            }[workerErrorCode] || 'AI 调用失败，未生成完整结果。';
            throw failure(message);
          }
          const result = JSON.parse(await readFile(join(scratch, 'result.json'), 'utf8'));
          settle(resolve, result);
        } catch (error) {
          settle(reject, error instanceof SyntaxError
            ? failure('AI 返回的结果格式无效；未保存不完整结果。') : error);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  }

  kill(job) {
    if (!job.child?.pid) return;
    try {
      process.kill(process.platform === 'win32' ? job.child.pid : -job.child.pid, 'SIGTERM');
    } catch {
      try { job.child.kill('SIGTERM'); } catch { /* child already stopped */ }
    }
  }

  async status(id) {
    if (typeof id !== 'string' || !jobIdPattern.test(id)) throw new Error('无效任务编号。');
    const live = this.active.get(id);
    if (live) return this.public(live);
    let job;
    try { job = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')); }
    catch { throw new Error('任务不存在或状态文件不可读取。'); }
    if (!isRecord(job) || job.id !== id || typeof job.status !== 'string') throw new Error('任务状态文件无效。');
    if (job.status === 'running') {
      let alive = true;
      try { process.kill(job.ownerPid, 0); } catch { alive = false; }
      if (!alive) {
        job.status = 'interrupted';
        job.stage = '已中断';
        job.error = '宿主已退出，任务未完成；可重新生成。';
        await this.save(id, job).catch(() => {});
      }
    }
    return job;
  }

  async cancel(id) {
    if (typeof id !== 'string' || !jobIdPattern.test(id)) throw new Error('无效任务编号。');
    const job = this.active.get(id);
    if (!job) throw new Error('请在启动此任务的宿主中取消。');
    if (!terminalStatuses.has(job.status)) {
      job.status = 'cancelled';
      job.stage = '已取消';
      job.completedAt = Date.now();
      this.kill(job);
      await this.persist(job).catch(() => { throw new Error('取消状态未能保存；请稍后查询任务状态。'); });
    }
    return this.public(job);
  }

  close() {
    this.closed = true;
    const writes = [];
    for (const job of this.active.values()) {
      if (!terminalStatuses.has(job.status)) {
        job.status = 'interrupted';
        job.stage = '已中断';
        job.error = '宿主已退出，任务未完成；可重新生成。';
      }
      this.kill(job);
      writes.push(this.persist(job));
    }
    if (this.ownsSession) {
      try {
        const cleanup = this.session.close?.();
        if (cleanup && typeof cleanup.then === 'function') writes.push(Promise.resolve(cleanup));
      } catch { /* do not hide shutdown */ }
    }
    return Promise.allSettled(writes);
  }
}
