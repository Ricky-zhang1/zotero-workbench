import { ResearchWorkspace } from './domain/research-workspace.mjs';
import { CollaborationWorkspace } from './domain/collaboration-workspace.mjs';
import { AnnotationTrash } from './domain/annotation-trash.mjs';
import { AnnotationComment } from './domain/annotation-comment.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { ZoteroSession, createZoteroMcpServer, StdioServerTransport, z, libraryPrefix, parseIdentifier, resolveIdentifier, ZoteroError } from '../dist/runtime.mjs';
import { scanDuplicateCandidates } from './domain/duplicates.mjs';
import { installPagination } from './transports/zotero-local.mjs';
import { RickyClient } from './transports/zotero-mcp.mjs';
import { installCumulativeItems, installJournalLevelSummaries, libraryId, itemKey, localUrl, annotationLink, annotationFingerprint, annotationPageIndex, findExistingAnnotation } from './domain/library.mjs';
import { ReviewTransactions, upstreamData, LibraryActions } from './domain/gateway.mjs';
import { bibliographyOnly } from './domain/citations.mjs';
import { renderReadingCard, maintenanceRows } from './domain/workspace.mjs';
import { journalLevelsForItem, fetchEasyScholarRank, normalizeVenue } from './domain/journal-levels.mjs';
import { evidenceMarkdown, scopeKeys, paperEvidence } from './domain/evidence.mjs';
import { appendCitation, getCitation, listCitationsByItem, pruneCitations } from './domain/citation-registry.mjs';
import { auditDocument, bindCitationFromDocument, readMarkdownDocument, MAX_MARKDOWN_DOCUMENT_BYTES } from './domain/citation-binding.mjs';
import { openZoteroLink } from './domain/native-links.mjs';
import { applyReaderHighlightTags, READER_HIGHLIGHT_TYPE_TAGS } from './domain/reader-highlight-tags.mjs';
import { annotationHighlightType } from './ui/highlight-presets.js';
import { localAuthKeyFile } from './transports/local-auth.mjs';

const transactions = new ReviewTransactions(process.env.ZOTERO_WORKBENCH_STATE_DIR || join(homedir(), '.local/share/zotero-workbench/operations'));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const log = message => process.stderr.write(`[zotero-workbench] ${message}\n`);
const baseUrl = localUrl(process.env.ZOTERO_URL, 'http://127.0.0.1:23119').origin;
const keyFile = await localAuthKeyFile();
const session = new ZoteroSession({ baseUrl, keyFile, workspaceRoot: process.cwd(), pdfjsDataDir: join(root, 'dist/pdfjs'), log });
installPagination(session.client);
installCumulativeItems(session.library);
installJournalLevelSummaries(session.library, journalLevelsForItem);
const ricky = new RickyClient(process.env.ZOTERO_MCP_URL);
const libraryActions = new LibraryActions({ session, client: ricky, transactions, parseIdentifier, resolveIdentifier });
const annotationTrash = new AnnotationTrash({ session, directory: transactions.directory });
const annotationComment = new AnnotationComment({ session, directory: transactions.directory });
// Agent-proposed evidence highlights stay behind zotero-lattics review. Highlights
// created by the reader's own selection popover carry origin='user' and save directly.
const upstreamSaveHighlights = session.saveHighlights.bind(session);
let highlightSaveQueue = Promise.resolve();
session.saveHighlights = highlights => {
  if (!(Array.isArray(highlights) && highlights.length && highlights.every(h => h?.origin === 'user')))
    throw new Error('AI 证据高亮须经 zotero-lattics 审计（review_evidence）。在阅读器中选中文本并点击“高亮并保存”，你本人的高亮可直接写入。');
  const persist = async () => {
    const tagged = highlights.filter(h => !h.savedAs && Array.isArray(h.tags) && h.tags.length);
    if (!tagged.length) return upstreamSaveHighlights(highlights);
    const writer = session.writer;
    const originalCreate = writer.create;
    const originalCreateDescriptor = Object.getOwnPropertyDescriptor(writer, 'create');
    writer.create = async function(library, kind, objects, ...rest) {
      const relevant = tagged.filter(highlight => highlight.library === library);
      const hasTarget = kind === 'items' && Array.isArray(objects) && relevant.some(highlight => objects.some(object =>
        object?.itemType === 'annotation' && object.parentItem === highlight.attachmentKey
        && object.annotationText === highlight.quote
        && (() => {
          try { return JSON.parse(object.annotationPosition || '{}').pageIndex === highlight.pageIndex; }
          catch { return false; }
        })()
      ));
      if (!hasTarget) return originalCreate.call(this, library, kind, objects, ...rest);
      const withTags = applyReaderHighlightTags(library, objects, relevant);
      return originalCreate.call(this, library, kind, withTags, ...rest);
    };
    try { return await upstreamSaveHighlights(highlights); }
    finally {
      if (originalCreateDescriptor) Object.defineProperty(writer, 'create', originalCreateDescriptor);
      else delete writer.create;
    }
  };
  const operation = highlightSaveQueue.then(persist);
  highlightSaveQueue = operation.then(() => undefined, () => undefined);
  return operation;
};
// A failed annotation read must surface as an error, never a false zero count.
session.itemDetail = async (library, key) => {
  await session.ready();
  const item = await session.library.item(library, key), annotations = new Map();
  for (const attachment of item.attachments.filter(a => a.isPdf))
    annotations.set(attachment.key, await session.library.annotations(library, attachment.key));
  return { item, annotations };
};
const server = createZoteroMcpServer({ session, assetRoot: join(root, 'dist/ui'), pdfjsDataDir: join(root, 'dist/pdfjs'), log });
const ui = { resourceUri: 'ui://zotero/panel.html', visibility: ['model', 'app'] };
const librarySchema = z.string().regex(/^(user|g[1-9]\d*)$/).default('user');
const keySchema = z.string().regex(/^[A-Z0-9]{8}$/);
function register(name, title, description, inputSchema, callback, options = {}) {
  return server.registerTool(name, { title, description, inputSchema,
    annotations: { readOnlyHint: options.readOnly !== false, destructiveHint: options.destructive === true, openWorldHint: false },
    _meta: { ui: { ...ui, ...(options.appOnly ? { visibility: ['app'] } : {}) },
      ...(options.entrypoint ? { 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } : {}) }
  }, async args => {
    try {
      const value = await callback(args);
      if (value?.content) return value;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const message = error.stdout?.trim() || error.message;
      return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: { message } } };
    }
  });
}
// ---------------------------------------------------------------------------
// 逐字引文角标：引用 Zotero 原文前必须先登记，只有拿到 citationId 才可给角标。
// 这里只写本机引文登记表（src/domain/citation-registry.mjs），不写 Zotero。
// ---------------------------------------------------------------------------

// 与 runtime 的引文匹配共用同一套折叠：引号/破折号折叠 + NFKC + 小写、忽略空白。
// 仅用于判断「实际命中是否是请求原文的前缀」（跨页截断），不参与定位匹配本身。
const QUOTE_FOLD = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201A', "'"], ['\u201B', "'"], ['\u2032', "'"],
  ['\u201C', '"'], ['\u201D', '"'], ['\u201E', '"'], ['\u2033', '"'],
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'],
  ['\u2015', '-'], ['\u2212', '-'], ['\u00AD', ''], ['\u200B', ''], ['\u2026', '...']
]);

function compactQuote(value) {
  let compact = '';
  for (const char of String(value ?? '')) {
    if (/\s/.test(char)) continue;
    compact += (QUOTE_FOLD.get(char) ?? char).normalize('NFKC').toLowerCase();
  }
  return compact;
}

// ---------------------------------------------------------------------------
// poppler 回退：部分中文 PDF（CID/嵌入字体）用 pdfjs 提取文本会丢字（只剩标点/数字），
// 此时用 pdftotext -bbox 的逐词坐标在同一物理页做同一套规范化匹配，并给出 rects。
// 坐标：pdftotext 原点在页面左上、y 轴向下；PDF 用户空间 y 轴向上，
// 因此 rect = [xMin, H - yMax, xMax, H - yMin]（H 为 <page height>）。
// ---------------------------------------------------------------------------

const PDFJS_PAGE_MIN_MEANINGFUL_RATIO = 0.45;

function decodeHtmlEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    return named[name.toLowerCase()] ?? whole;
  });
}

function popplerAttrs(source) {
  const attrs = {};
  const pattern = /([A-Za-z]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) attrs[match[1].toLowerCase()] = match[2];
  return attrs;
}

// pdftotext 超时：常规 PDF 2–4s 足够；卡住的 poppler 不应让工具阻塞 20s。
// 可用 PDFTOTEXT_TIMEOUT_MS 覆盖（测试/异常环境）。
const POPPLER_DEFAULT_TIMEOUT_MS = 4_000;

export function popplerTimeoutMs() {
  const configured = Number(process.env.PDFTOTEXT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 200
    ? Math.min(Math.floor(configured), 60_000)
    : POPPLER_DEFAULT_TIMEOUT_MS;
}

function isPopplerTimeout(error) {
  if (error?.killed === true) return true;
  if (typeof error?.signal === 'string' && error.signal !== '') return true;
  return /timed?\s*out/i.test(String(error?.message ?? ''));
}

/** 构造带 fallbackReason 的 quote_unverifiable，便于调用方标注回退原因。 */
function popplerError(reason, message) {
  const error = new ZoteroError('quote_unverifiable', message);
  error.fallbackReason = reason;
  return error;
}

/** 解析 `pdftotext -bbox -enc UTF-8` 的 XHTML，返回 {width, height, words:[{text,xMin,yMin,xMax,yMax}]}。 */
export function parsePopplerBbox(xhtml) {
  const source = String(xhtml ?? '');
  const pageMatch = /<page\b([^>]*)>/i.exec(source);
  if (pageMatch === null)
    throw new ZoteroError('quote_unverifiable', 'pdftotext 输出缺少 <page> 元素，无法校验引文。');
  const pageAttrs = popplerAttrs(pageMatch[1]);
  const width = Number(pageAttrs.width), height = Number(pageAttrs.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new ZoteroError('quote_unverifiable', 'pdftotext 输出的页面尺寸无效，无法校验引文。');
  const words = [];
  const wordPattern = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
  let match;
  while ((match = wordPattern.exec(source)) !== null) {
    const attrs = popplerAttrs(match[1]);
    const xMin = Number(attrs.xmin), yMin = Number(attrs.ymin);
    const xMax = Number(attrs.xmax), yMax = Number(attrs.ymax);
    if (![xMin, yMin, xMax, yMax].every(Number.isFinite)) continue;
    const text = decodeHtmlEntities(match[2]).replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    words.push({ text, xMin, yMin, xMax, yMax });
  }
  return { width, height, words };
}

function verticalOverlap(a, b) {
  return Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin));
}

/** 两个词的 y 区间重叠超过较矮者一半高度 → 视为同一行。 */
function samePopplerLine(a, b) {
  const minHeight = Math.min(a.yMax - a.yMin, b.yMax - b.yMin);
  return minHeight > 0 && verticalOverlap(a, b) / minHeight >= 0.5;
}

/** 按 pdftotext 的阅读顺序拼 display（行内按几何间隙补空格，换行补 \n）。 */
function buildPopplerDisplay(words) {
  let display = '';
  const ranges = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (index > 0) {
      const previous = words[index - 1];
      const height = Math.min(previous.yMax - previous.yMin, word.yMax - word.yMin) || 1;
      const gap = word.xMin - previous.xMax;
      display += samePopplerLine(previous, word) ? (gap > height * 0.15 ? ' ' : '') : '\n';
    }
    const start = display.length;
    display += word.text;
    ranges.push({ start, end: display.length, word });
  }
  return { display, ranges };
}

/** 与 pdfjs 匹配一致的 compact 归一化（NFKC + 大小写折叠 + 去除空白），带 offset→原串索引映射。 */
function buildCompactMap(source) {
  let compact = '';
  const toSource = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) continue;
    const folded = (QUOTE_FOLD.get(char) ?? char).normalize('NFKC').toLowerCase();
    for (const part of folded) {
      compact += part;
      toSource.push(index);
    }
  }
  return { compact, toSource };
}

/** 在当前页词序列里做逐字匹配；命中返回 {quoteExact, rects}，否则抛 quote_not_found。 */
export function matchQuoteInPopplerPage(page, quote) {
  const words = Array.isArray(page?.words) ? page.words : [];
  if (words.length === 0)
    throw new ZoteroError('quote_not_found', 'pdftotext 未在该页提取到任何文字；请确认页码，或该页为纯图片。');
  const height = Number(page?.height);
  if (!Number.isFinite(height) || height <= 0)
    throw new ZoteroError('quote_unverifiable', 'pdftotext 输出的页面高度无效，无法换算坐标。');
  const { display, ranges } = buildPopplerDisplay(words);
  const { compact, toSource } = buildCompactMap(display);
  const needle = buildCompactMap(String(quote ?? '')).compact;
  if (needle === '')
    throw new ZoteroError('quote_not_found', '引文为空，无法校验。请用 read_fulltext/find_in_pdf 复制逐字原文。');
  const position = compact.indexOf(needle);
  if (position < 0)
    throw new ZoteroError('quote_not_found', '该页文字里没有这段逐字引文；请用 read_fulltext/find_in_pdf 复制逐字原文（不要改写、不要跨页）后重试。');
  const startDisplay = toSource[position];
  const endDisplay = toSource[position + needle.length - 1] + 1;
  const quoteExact = display.slice(startDisplay, endDisplay);
  const selected = ranges
    .filter((range) => range.end > startDisplay && range.start < endDisplay)
    .map((range) => range.word);
  const lines = [];
  for (const word of selected) {
    const line = lines[lines.length - 1];
    if (line !== undefined && samePopplerLine(line.previous, word)) {
      line.words.push(word);
      line.previous = word;
    } else lines.push({ words: [word], previous: word });
  }
  const round3 = (value) => Math.round(value * 1000) / 1000;
  const rects = lines.map((line) => {
    const xMin = Math.min(...line.words.map((word) => word.xMin));
    const xMax = Math.max(...line.words.map((word) => word.xMax));
    const yMin = Math.min(...line.words.map((word) => word.yMin));
    const yMax = Math.max(...line.words.map((word) => word.yMax));
    return [round3(xMin), round3(height - yMax), round3(xMax), round3(height - yMin)];
  });
  return { quoteExact, rects };
}

/**
 * 用 pdftotext 对指定物理页做逐字验证（pdfjs 文本缺失/未命中时的回退）。
 * 成功返回 {quoteExact, rects, pageIndex, pageLabel, textSource:'poppler', pageWidth, pageHeight}；
 * 找不到抛 quote_not_found，poppler 缺失/失败抛 quote_unverifiable（附 stderr 摘要）。
 */
export async function verifyQuoteWithPoppler({ path: pdfPath, page, quote }) {
  const binary = process.env.PDFTOTEXT_PATH || 'pdftotext';
  let stdout;
  try {
    const result = await run(binary, ['-f', String(page), '-l', String(page), '-bbox', '-enc', 'UTF-8', String(pdfPath), '-'], {
      timeout: popplerTimeoutMs(),
      maxBuffer: 16 * 1024 * 1024
    });
    stdout = result.stdout;
  } catch (error) {
    if (error?.code === 'ENOENT')
      throw popplerError('poppler_unavailable', `poppler 不可用（找不到 ${binary}）；无法为 pdfjs 提取文本缺失的 PDF 校验逐字引文。可安装 poppler 或设置 PDFTOTEXT_PATH。`);
    if (isPopplerTimeout(error))
      throw popplerError('poppler_timeout', `pdftotext 执行超时（${popplerTimeoutMs()}ms），无法校验该页引文。`);
    const stderr = String(error?.stderr ?? error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 400);
    throw popplerError('poppler_error', `pdftotext 执行失败：${stderr}`);
  }
  const parsed = parsePopplerBbox(stdout);
  const matched = matchQuoteInPopplerPage(parsed, quote);
  return {
    ...matched,
    pageIndex: page - 1,
    pageLabel: String(page),
    textSource: 'poppler',
    pageWidth: parsed.width,
    pageHeight: parsed.height
  };
}

/** 粗略判断 pdfjs 提取的页文本是否退化（非空白字符里字母/数字占比过低）。 */
export function isPdfjsPageTextDegraded(pageText) {
  const source = String(pageText ?? '');
  if (source.length < 40) return true;
  let meaningful = 0;
  for (const char of source) {
    if (/\s/.test(char)) continue;
    if (/[\p{L}\p{N}]/u.test(char.normalize('NFKC'))) meaningful += 1;
  }
  return meaningful / source.length < PDFJS_PAGE_MIN_MEANINGFUL_RATIO;
}

// ---------------------------------------------------------------------------
// read_page_text：用 pdftotext -layout 读取干净页文本。
// 背景：pdfjs 对部分 CID/嵌入字体中文 PDF 会丢字（只剩标点/数字），
// 模型用 read_fulltext 拿不到逐字引文；这里的输出用于让模型复制 quote。
// ---------------------------------------------------------------------------

const READ_PAGE_TEXT_MAX_PAGES = 50;

/** 解析 read_page_text 的 pages 规格（'1'、'2-5'、'1,4-6'）；非法/越界抛 invalid_input。 */
export function parsePagesSpec(spec, pageCount) {
  const source = String(spec ?? '').trim();
  if (source === '') throw new ZoteroError('invalid_input', 'pages 不能为空，示例：1-3、2、1,4-6。');
  const selected = new Set();
  for (const rawToken of source.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new ZoteroError('invalid_input', `pages 规格非法：“${source}”；示例：1-3、2、1,4-6。`);
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (match === null) throw new ZoteroError('invalid_input', `pages 规格非法：“${token}”；示例：1-3、2、1,4-6。`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) throw new ZoteroError('invalid_input', `pages 页码范围非法：“${token}”。`);
    if (end > pageCount) throw new ZoteroError('invalid_input', `第 ${end} 页超出 PDF 范围（共 ${pageCount} 页）。`);
    for (let page = start; page <= end; page += 1) selected.add(page);
  }
  const pages = [...selected].sort((left, right) => left - right);
  if (pages.length > READ_PAGE_TEXT_MAX_PAGES)
    throw new ZoteroError('invalid_input', `一次最多读取 ${READ_PAGE_TEXT_MAX_PAGES} 页；请缩小 pages 范围。`);
  return pages;
}

/** 用 pdftotext -layout 提取单页纯文本；失败/缺失抛 quote_unverifiable（调用方回退 pdfjs）。 */
export async function extractPageTextWithPoppler({ path: pdfPath, page }) {
  const binary = process.env.PDFTOTEXT_PATH || 'pdftotext';
  try {
    const result = await run(binary, ['-f', String(page), '-l', String(page), '-layout', '-enc', 'UTF-8', String(pdfPath), '-'], {
      timeout: popplerTimeoutMs(),
      maxBuffer: 16 * 1024 * 1024
    });
    return String(result.stdout ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (error) {
    if (error?.code === 'ENOENT')
      throw popplerError('poppler_unavailable', `poppler 不可用（找不到 ${binary}）；已回退 pdfjs 页文本。`);
    if (isPopplerTimeout(error))
      throw popplerError('poppler_timeout', `pdftotext 执行超时（${popplerTimeoutMs()}ms）；已回退 pdfjs 页文本。`);
    const stderr = String(error?.stderr ?? error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 400);
    throw popplerError('poppler_error', `pdftotext 执行失败：${stderr}`);
  }
}

/** 把逐页文本拼成 `--- page N ---` 段落，按 maxChars 截断并标记 truncated。 */
export function buildPageText(entries, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 30000;
  const pages = [];
  let text = '';
  let truncated = false;
  for (const entry of entries) {
    const body = String(entry?.text ?? '');
    const addition = `${text === '' ? '' : '\n\n'}--- page ${entry.page} ---\n${body}`;
    const remaining = limit - text.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    pages.push({
      page: entry.page,
      pageLabel: String(entry.pageLabel ?? entry.page),
      chars: body.length,
      ...(entry.textSource === undefined ? {} : { textSource: entry.textSource }),
      ...(entry.fallbackReason === undefined ? {} : { fallbackReason: entry.fallbackReason })
    });
    if (addition.length > remaining) {
      text += addition.slice(0, remaining);
      truncated = true;
      break;
    }
    text += addition;
  }
  return { text, pages, truncated };
}

/**
 * 逐页读取文本并做 poppler→pdfjs 回退（read_page_text 的核心，可注入 extract 便于离线测试）。
 * 返回 {text, pages, truncated, textSource:'poppler'|'pdfjs'|'mixed', fallbackReason?}；
 * pages[].textSource 逐页标注来源，回退页附 fallbackReason。
 */
export async function collectPageTexts({ pdfPages, pdfPath, pageNumbers, maxChars, extractPageText = extractPageTextWithPoppler }) {
  const entries = [];
  let popplerAvailable = true;
  let fallbackReason;
  for (const pageNumber of pageNumbers) {
    let text = null;
    let textSource = 'pdfjs';
    let pageFallbackReason;
    if (popplerAvailable) {
      try {
        text = await extractPageText({ path: pdfPath, page: pageNumber });
        textSource = 'poppler';
      } catch (error) {
        if (!(error instanceof ZoteroError && error.code === 'quote_unverifiable')) throw error;
        popplerAvailable = false;
        pageFallbackReason = error.fallbackReason ?? 'poppler_error';
        if (fallbackReason === undefined) fallbackReason = pageFallbackReason;
      }
    } else {
      pageFallbackReason = fallbackReason ?? 'poppler_unavailable';
    }
    if (text === null) text = String(pdfPages?.[pageNumber - 1]?.text ?? '');
    entries.push({
      page: pageNumber,
      pageLabel: pdfPages?.[pageNumber - 1]?.label ?? pageNumber,
      text,
      textSource,
      ...(pageFallbackReason === undefined ? {} : { fallbackReason: pageFallbackReason })
    });
  }
  const built = buildPageText(entries, maxChars);
  const sources = new Set(entries.map((entry) => entry.textSource));
  const textSource = sources.size === 1 ? [...sources][0] : 'mixed';
  return {
    ...built,
    textSource,
    ...(fallbackReason === undefined ? {} : { fallbackReason })
  };
}

/** 登记记录所需的作者名数组（Zotero 对中英文分别用 name 或 firstName/lastName）。 */
function citationAuthorsFromCreators(creators) {
  if (!Array.isArray(creators)) return [];
  const names = [];
  for (const creator of creators) {
    if (creator === null || typeof creator !== 'object') continue;
    if ((creator.creatorType ?? 'author') !== 'author') continue;
    if (typeof creator.name === 'string' && creator.name.trim() !== '') {
      names.push(creator.name.trim());
      continue;
    }
    const name = [creator.firstName, creator.lastName]
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .join(' ');
    if (name !== '') names.push(name);
  }
  return names.slice(0, 200);
}

/** 登记记录 → 角标 href 与两种 zotero:// 深链。 */
function citationLinks(record) {
  const id = typeof record?.id === 'string' ? record.id : '';
  const page = Number.isInteger(record?.pageIndex) ? Math.max(1, record.pageIndex + 1) : 1;
  const itemKey = typeof record?.itemKey === 'string' ? record.itemKey : '';
  const attachmentKey = typeof record?.attachmentKey === 'string' ? record.attachmentKey : '';
  return {
    href: `https://zotero-wb.invalid/c/${id}`,
    zoteroItemUrl: itemKey === '' ? null : `zotero://select/library/items/${itemKey}`,
    zoteroPdfUrl: attachmentKey === '' ? null : `zotero://open-pdf/library/items/${attachmentKey}?page=${page}`
  };
}

/** 「来源」区一行：[N] 题名. 作者. 期刊/出版, 年, 页. <zotero:// 深链>。 */
function citationSourceLine(entry) {
  const parts = [`[${entry.number}] ${entry.title === '' ? '(无题名)' : entry.title}.`];
  const authors = Array.isArray(entry.authors) ? entry.authors.filter(name => typeof name === 'string' && name !== '') : [];
  if (authors.length > 20) parts.push(`${authors[0]} et al.`);
  else if (authors.length > 0) parts.push(`${authors.join(', ')}.`);
  const source = [entry.venue, entry.year].filter(Boolean).join(', ');
  if (source !== '') parts.push(source.endsWith('.') ? source : `${source}.`);
  if (typeof entry.pages === 'string' && entry.pages !== '') parts.push(`${entry.pages}.`);
  if (typeof entry.doi === 'string' && entry.doi !== '') parts.push(`https://doi.org/${entry.doi}`);
  if (typeof entry.zoteroPdfUrl === 'string' && entry.zoteroPdfUrl !== '') parts.push(entry.zoteroPdfUrl);
  return parts.join(' ');
}

register('open_workbench', 'Zotero 文献工作台', '打开真实 Zotero 文库、PDF 阅读器与 Zotero–Lattics 引用证据面板。', {}, async () => {
  await session.poll(); return { ...session.state(), workbench: { version: packageInfo.version, evidencePolicy: 'source-first; pending human adoption' } };
}, { entrypoint: true });
register('open_in_zotero', '在 Zotero 中打开', '仅把经过校验的 Zotero 文献选择回链，或无参数/含 page 和/或 annotation 的 PDF 回链交给操作系统打开器。成功回执只表示系统已接收请求，不证明 Zotero 已显示或定位到目标。',
  z.object({ url: z.string().max(512) }).strict(), ({ url }) => openZoteroLink(url), { appOnly: true });
let viewState = null;
register('workbench_state', '阅读位置', '保存或恢复当前 MCP 实例的阅读位置，不写入 Zotero。', { state: z.record(z.string(), z.unknown()).optional() }, async ({ state }) => {
  if (state !== undefined) {
    if (JSON.stringify(state).length > 64000) throw new Error('Reading state is too large');
    viewState = state;
  }
  return { state: viewState };
}, { appOnly: true });
register('save_reader_highlights', '保存我的阅读高亮', '把阅读器中你本人创建、尚未保存的会话高亮写入 Zotero。仅处理面板内 origin=user 的高亮；AI 证据高亮走 review_evidence。', {
  ids: z.array(z.string()).max(50).optional(), key: keySchema.optional()
}, async ({ids, key}) => {
  const targets = session.findHighlights(ids, key).filter(h => h.origin === 'user' && !h.savedAs);
  if (!targets.length) throw new Error('没有可保存的个人高亮；在阅读器中选中文本并点击“高亮并保存”。');
  const saved = await session.saveHighlights(targets);
  return { saved: saved.map(s => ({ id: s.id, annotationKey: s.key })), skipped: targets.length - saved.length };
}, { readOnly: false, appOnly: true });
register('create_reader_highlight', '高亮并保存', '把你本人在阅读器中选中的文本保存为 Zotero 高亮批注，可附备注、颜色和预设类型标签。写入前做能力检查与指纹去重；命中已有批注时返回原标签，不修改既有批注。', {
  library: librarySchema, key: keySchema, quote: z.string().min(1).max(20000),
  page: z.number().int().min(1).max(100000).optional(),
  comment: z.string().max(20000).default(''), color: z.string().max(20).optional(),
  tags: z.array(z.enum([...READER_HIGHLIGHT_TYPE_TAGS])).max(1).default([])
}, async ({library, key, quote, page, comment, color, tags}) => {
  // Capability gate BEFORE any side effect (P2/P6): no candidate highlight is created on Zotero 9.
  if (session.client.status.writes === 'unsupported')
    throw new Error(`当前 Zotero ${session.client.status.version ?? ''} 的本地接口不支持写入，无法保存高亮。升级到 Zotero 10 后可在工作台直接保存；现在请先在 Zotero 中标注，工作台会同步显示。`);
  await session.ready();
  const { attachment } = await session.library.resolvePdf(library, key);
  const { data: children } = await session.client.getJson(`${libraryPrefix(library)}/items/${attachment.key}/children?itemType=annotation`);
  const existing = findExistingAnnotation(children, page, quote);
  if (existing) {
    const at = annotationPageIndex(existing.data?.annotationPosition) ?? 0;
    const existingTags = Array.isArray(existing.data?.tags) ? existing.data.tags.map(value => typeof value === 'string' ? value : value?.tag).filter(Boolean) : [];
    return { saved: false, existing: true, annotationKey: existing.key, attachmentKey: attachment.key,
      page: at + 1, text: existing.data?.annotationText ?? '', comment: existing.data?.annotationComment ?? '',
      tags: existingTags, type: annotationHighlightType({ tags: existingTags }), requestedTags: tags, tagsUpdated: false,
      url: annotationLink(library, attachment.key, existing.key, at) };
  }
  const { highlight } = await session.highlight(library, key, { quote, page, comment, color });
  highlight.origin = 'user';
  highlight.tags = tags;
  try {
    await session.saveHighlights([highlight]);
    const created = highlight.savedAs ?? null;
    let verified = false, tagsVerified = false, storedTags = [];
    if (created) {
      const stored = await session.library.raw(library, created).catch(() => null);
      storedTags = Array.isArray(stored?.data?.tags)
        ? stored.data.tags.map(value => typeof value === 'string' ? value : value?.tag).filter(Boolean)
        : [];
      tagsVerified = JSON.stringify([...storedTags].sort()) === JSON.stringify([...tags].sort());
      verified = annotationFingerprint(stored?.data?.annotationText) === annotationFingerprint(highlight.quote)
        && annotationPageIndex(stored?.data?.annotationPosition) === highlight.pageIndex
        && tagsVerified;
    }
    return { saved: true, verified, annotationKey: created, itemKey: highlight.itemKey,
      attachmentKey: highlight.attachmentKey, page: highlight.pageIndex + 1, pageLabel: highlight.pageLabel,
      text: highlight.quote, comment: highlight.comment, tags: storedTags,
      type: annotationHighlightType({ tags: storedTags }), requestedTags: tags,
      tagsVerified, tagsUpdated: tags.length > 0 && tagsVerified,
      url: created ? annotationLink(library, highlight.attachmentKey, created, highlight.pageIndex) : null };
  } catch (error) {
    session.clearHighlights([highlight.id]);
    if (error instanceof Error && /writes_unsupported|only be read/.test(error.message))
      throw new Error(`当前 Zotero ${session.client.status.version ?? ''} 的本地接口不支持写入，高亮未能保存。升级到 Zotero 10 后可在工作台直接保存；现在请先在 Zotero 中标注，工作台会同步显示。`);
    throw error;
  }
}, { readOnly: false, appOnly: true });

register('read_reader_annotation_comment', '读取批注备注', '精确读取同一文库中的现有批注及其父 PDF，返回当前备注、版本、来源指纹与30分钟一次性编辑凭证。此工具不写 Zotero。上次结果未知时会先只读核对；符合实例、版本、批注原文/颜色/标签/位置和备注指纹才解除编辑锁，否则返回 editable=false 且不签发新凭证。', {
  library: librarySchema, annotationKey: keySchema, attachmentKey: keySchema
}, args => annotationComment.read(args), { appOnly: true });
register('update_reader_annotation_comment', '保存批注备注', '把备注保存到原 Zotero 批注的 annotationComment 字段，不创建独立笔记、不替换批注。必须使用读取工具签发且绑定版本和 Zotero 实例的一次性 editToken；写入只提交一次带 If-Unmodified-Since-Version 的 PATCH，并回读备注及原文、颜色、标签、位置。结果未知时不要重发，调用 read_reader_annotation_comment 核对当前备注，并可用 review_operation 查本机操作记录。', {
  library: librarySchema, annotationKey: keySchema, attachmentKey: keySchema,
  editToken: z.string().regex(/^[a-f0-9]{48}$/),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedComment: z.string().max(20000),
  comment: z.string().max(20000)
}, args => annotationComment.update(args), { readOnly: false, appOnly: true });

register('prepare_reader_annotation_trash', '预览移除高亮', '为你在 Codex PDF 阅读器中选中的一条既有 Zotero 高亮生成短时预览。核对原文、备注、页码和 PDF 后，再明确确认；只标记这条高亮为已删除，绝不调用永久删除。工作台恢复入口须以回读核实为准，不承诺它会出现在 Zotero 顶层回收站。', {
  library: librarySchema, annotationKey: keySchema, attachmentKey: keySchema
}, args => annotationTrash.prepare(args), { appOnly: true });
register('trash_reader_annotation', '移除高亮', '执行同一条批注的预览操作；必须明确确认。仅当精确 key 的 GET 显示已删除、原内容/版本吻合且活动项与父 PDF 批注列表均不含该 key 时报告移除已核实。恢复须另行回读确认；不承诺该子批注会出现在 Zotero 顶层回收站。', {
  previewToken: z.string().regex(/^[a-f0-9]{48}$/), confirmWrite: z.boolean().default(false)
}, args => annotationTrash.trash(args), { readOnly: false, appOnly: true, destructive: true });
register('last_reader_annotation_trash', '上次批注移除操作', '读取本机持久操作索引，跨会话提供最近一次已核实或结果未知的批注移除操作；只返回身份与核对/恢复状态，不改 Zotero。', {},
  () => annotationTrash.latestTrash(), { appOnly: true });
register('reader_annotation_operations', '批注移除操作列表', '分页读取本机私人操作台账中的已核实或结果未知的批注移除操作。可按文库筛选；旧记录若没有 Zotero serverId 会标为归属未知，不推测或改写归属。只读，不请求或修改 Zotero。', {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  library: z.string().regex(/^(user|g[1-9]\d*)$/).optional()
}, args => annotationTrash.listOperations(args), { appOnly: true });
register('prepare_reader_annotation_restore', '预览恢复阅读高亮', '根据一条已核实的批注移除操作，确认原 key 当前标记为删除、内容摘要和版本一致，并且活动项与父 PDF 批注列表均无冲突，再生成短时恢复预览；不创建新批注。', {
  operationId: z.string().regex(/^[a-f0-9]{64}$/)
}, args => annotationTrash.prepareRestore(args), { appOnly: true });
register('restore_reader_annotation', '恢复阅读高亮', '明确确认后，对原批注 key 执行带 If-Unmodified-Since-Version 的 PATCH deleted:false；仅在精确 key 未标记为删除、内容/版本吻合并重新出现在父 PDF 批注列表后报告恢复已核实。未知结果不自动重试。', {
  previewToken: z.string().regex(/^[a-f0-9]{48}$/), confirmWrite: z.boolean().default(false)
}, args => annotationTrash.restore(args), { readOnly: false, appOnly: true });
register('reconcile_reader_annotation_operation', '核对上次批注操作', '只读核对未知的批注移除或恢复操作：读取原 key、删除标记、版本、内容摘要及活动项/PDF批注列表；证据精确匹配时仅更新本机操作台账，不向 Zotero 写入或重发 PATCH。旧记录缺少内容摘要或回读不一致时保持未知；恢复能力须单独通过回读确认。', {
  operationId: z.string().regex(/^[a-f0-9]{64}$/)
}, args => annotationTrash.reconcile(args), { appOnly: true });

register('workbench_status', '连接状态', '检查 Zotero 本地 API、现有 Zotero MCP 和引用核查器。', {}, async () => {
  await session.poll(); let mcp;
  // Probe the optional service on a private short-lived client. Each network
  // round trip has a real AbortSignal timeout; a stale MCP endpoint must not
  // hold up the local Zotero readiness indicator or interfere with writes.
  const probe = new RickyClient(process.env.ZOTERO_MCP_URL);
  try {
    const init = await probe.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zotero-workbench-status', version: packageInfo.version } }, false, 500);
    probe.protocol = init.protocolVersion;
    await probe.request('notifications/initialized', {}, true, 500);
    const listed = await probe.request('tools/list', {}, false, 500);
    mcp = { connected: true, server: init.serverInfo, tools: listed.tools.map(t => t.name) };
  }
  catch (error) { mcp = { connected: false, error: error.message }; }
  finally { await probe.close(250); }
  const audit = join(root, 'integrations/zotero-lattics/scripts/citation_evidence_audit.py');
  const writes = session.client.status.writes;
  const legacyWriteTools = new Set(mcp.tools ?? []);
  const hasLegacyLibraryWrites = ['write_note', 'write_metadata', 'write_item'].every(name => legacyWriteTools.has(name));
  const notesMetadataImport = writes === 'available' ? 'local-api'
    : writes === 'unsupported' ? hasLegacyLibraryWrites ? 'legacy-zotero-mcp' : 'unavailable'
    : 'unknown';
  return { zotero: session.client.status, mcp,
    capabilities: {
      reads: session.client.status.state === 'ready' ? 'local-api' : 'unavailable',
      notesMetadataImport,
      userHighlights: writes === 'available' ? 'local-api' : writes === 'unsupported' ? 'read-only' : 'unknown',
      evidenceHighlights: mcp.connected ? 'audited-via-zotero-lattics' : 'unavailable',
      semanticSearch: mcp.connected ? 'upstream-quota' : 'unavailable'
    },
    audit: { script: audit, sha256: createHash('sha256').update(await readFile(audit)).digest('hex') } };
});

const researchWorkspace=new ResearchWorkspace({session});
const collaborationWorkspace = new CollaborationWorkspace({
  stateDir: process.env.ZOTERO_WORKBENCH_STATE_DIR || join(homedir(), '.local/share/zotero-workbench'),
  researchWorkspace
});
register('research_materials','我的标注与笔记','读取指定分类或文献的高亮、批注和子笔记。仅作为研究者选择的写作语料；续页保留 scopeId。',{
 library:librarySchema,keys:z.array(keySchema).max(500).optional(),collection:keySchema.optional(),recursive:z.boolean().default(true),scopeId:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(10).default(5)
},args=>researchWorkspace.materials(args));
const researchSourceIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const researchFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const startResearchJobSchema = z.object({
 kind:z.enum(['fold','draft','translate','translate_annotations']),
 library:librarySchema,
 key:keySchema.optional(),
 keys:z.array(keySchema).max(50).optional(),
 sourceIds:z.array(researchSourceIdSchema).max(200).optional(),
 sourceVersions:z.record(z.string(),researchFingerprintSchema).optional(),
 purpose:z.enum(['paragraph','review']).optional(),
 framework:z.string().max(12000).optional()
}).superRefine((args,ctx)=>{
 const issue=(path,message)=>ctx.addIssue({code:'custom',path,message});
 const unique=(items)=>new Set(items).size===items.length;
 const exactVersions=(ids)=>{
  if(!args.sourceVersions||Object.keys(args.sourceVersions).length!==ids.length||
    ids.some(id=>!Object.hasOwn(args.sourceVersions,id)))
   issue(['sourceVersions'],'sourceVersions 必须为每个所选来源提供且仅提供当前指纹。');
 };
 if(args.kind==='fold'||args.kind==='translate'){
  if(!args.key)issue(['key'],`${args.kind} 必须指定单篇文献 key。`);
  if(args.keys!==undefined||args.sourceIds!==undefined||args.sourceVersions!==undefined)
   issue(['keys'],'全文任务不能混入批注来源参数。');
  if(args.kind==='translate'&&(args.purpose!==undefined||args.framework!==undefined))
   issue(['purpose'],'全文翻译不接受写作 purpose 或 framework。');
  return;
 }
 if(args.kind==='draft'){
  if(args.key!==undefined)issue(['key'],'draft 应使用研究者所选的 keys。');
  if(!args.keys?.length)issue(['keys'],'draft 至少需要一篇明确选择的文献。');
  if(args.keys&&!unique(args.keys))issue(['keys'],'keys 不能重复。');
  if(!args.sourceIds?.length)issue(['sourceIds'],'draft 至少需要一个明确选择的来源。');
  if(args.sourceIds&&!unique(args.sourceIds))issue(['sourceIds'],'sourceIds 不能重复。');
  if(args.sourceIds)exactVersions(args.sourceIds);
  return;
 }
 if(args.key!==undefined)issue(['key'],'批注翻译应使用 keys。');
 if(args.purpose!==undefined||args.framework!==undefined)
  issue(['purpose'],'批注翻译不接受写作 purpose 或 framework。');
 if(!args.keys?.length||args.keys.length>20)issue(['keys'],'批注翻译需指定 1–20 篇文献。');
 if(args.keys&&!unique(args.keys))issue(['keys'],'keys 不能重复。');
 if(!args.sourceIds?.length||args.sourceIds.length>20)issue(['sourceIds'],'批注翻译单批最多 20 条来源。');
 if(args.sourceIds&&!unique(args.sourceIds))issue(['sourceIds'],'sourceIds 不能重复。');
 if(args.sourceIds)exactVersions(args.sourceIds);
});
register('start_research_job','全文阅读、翻译或标注写作','按 kind 执行本机研究任务：fold 完整阅读单篇 PDF 并生成 TextFold 五层与研究导读；translate 生成单篇全文中文对照；translate_annotations 只翻译服务端核验的外文 highlight/underline，单批最多 20 条；draft 只使用研究者勾选的标注。任务调用本机已配置的 Codex CLI，结果仅保存为本机派生材料，不写 Zotero。返回任务 id，使用 research_job 查询结果。',startResearchJobSchema,args=>researchWorkspace.start(args),{readOnly:false});
register('research_job','读取研究任务','读取进度、完整的 TextFold 五层结果或带材料回链的初稿。失败/中断不能视为完成。',{id:z.string().regex(/^[a-f0-9]{24}$/)},args=>researchWorkspace.status(args.id));
register('cancel_research_job','取消研究任务','停止本宿主启动的后台 AI 任务，不删除 Zotero 内容。',{id:z.string().regex(/^[a-f0-9]{24}$/)},args=>researchWorkspace.cancel(args.id),{readOnly:false});

const collaborationSourceSchema = z.object({
  library: librarySchema,
  itemKey: keySchema,
  attachmentKey: keySchema.optional(),
  annotationKey: keySchema.optional(),
  noteKey: keySchema.optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const collaborationBlockSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  text: z.string().min(1).max(12000),
  sourceIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).min(1).max(200),
  claims: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    text: z.string().min(1).max(12000),
    sourceIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).min(1).max(200)
  }).strict()).max(500).optional()
}).strict();
register('collaboration_session', '跨会话研究协作', '显式创建、列出或恢复本机协作会话；不自动选择旧会话。默认只给最近草稿摘要，传 draftId 可读取某一份完整历史草稿；恢复时包含最近有限的人工反馈只读记录与当前来源指纹状态。', z.object({
  action: z.enum(['create', 'get', 'list']),
  title: z.string().min(1).max(200).optional(),
  projectPath: z.string().max(2048).optional(),
  id: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  draftId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict(), args => collaborationWorkspace.session(args), { readOnly: false });
register('collaboration_sources', '管理协作来源', '仅将用户在 Zotero 材料列表中明确选定的批注/笔记加入会话；服务端按真实父条目、附件、批注/笔记 key 和指纹重读 Zotero，内容变化时要求重新选择。', z.object({
  action: z.enum(['add', 'remove', 'clear']),
  id: z.string().regex(/^[a-f0-9]{24}$/),
  expectedRevision: z.number().int().min(1),
  sources: z.array(collaborationSourceSchema).min(1).max(200).optional(),
  sourceIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).min(1).max(200).optional()
}).strict(), args => collaborationWorkspace.sources(args), { readOnly: false });
register('collaboration_draft', '记录协作草稿', '记录当前 host agent 的逐段草稿、论断与所选 Zotero 来源关系；只存本机旁路证据关系，不修改稿件或引用格式。docPath（若提供）只读计算文件指纹。', z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  expectedRevision: z.number().int().min(1),
  title: z.string().max(200).optional(),
  paragraphs: z.array(collaborationBlockSchema).min(1).max(100),
  docPath: z.string().min(1).max(4096).optional()
}).strict(), args => collaborationWorkspace.draft(args), { readOnly: false });
register('collaboration_feedback', '记录人工协作反馈', '只通过 Codex 面板记录用户实际提交的草稿/论断反馈；不允许 Agent 写入人工已核字段。反馈绑定提交时草稿和目标文本指纹，不迁移到后续改写。', z.object({
  action: z.enum(['record', 'list']),
  id: z.string().regex(/^[a-f0-9]{24}$/),
  expectedRevision: z.number().int().min(1).optional(),
  draftId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  claimId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  sourceIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).max(200).optional(),
  decision: z.enum(['supports', 'needs_revision', 'unclear', 'contradicts']).optional(),
  comment: z.string().max(5000).optional()
}).strict(), args => collaborationWorkspace.feedback(args), { readOnly: false, appOnly: true });
register('collaboration_read', '全文续读进度', '按用户明确选择的 Zotero 条目逐页交付可提取全文，保存 PDF 指纹与已交付页范围；不调用 AI/OCR，不把已交付标作已理解。超限或指纹变化时拒绝续接。', z.object({
  action: z.enum(['read', 'get']),
  id: z.string().regex(/^[a-f0-9]{24}$/),
  expectedRevision: z.number().int().min(1).optional(),
  library: librarySchema.optional(),
  key: keySchema.optional(),
  cursor: z.number().int().min(1).optional(),
  maxPages: z.number().int().min(1).max(5).optional()
}).strict(), args => collaborationWorkspace.read(args), { readOnly: false });

const scopes = new Map();
register('collect_evidence', '批注与原文回链', '分批读取指定文献或分类（可含子分类）的真实批注。保留原文/评论、物理页/印刷页、PDF 指纹与回链；仅为阅读材料，不签发引用合格结论。首次返回 scopeId，续页必须保留。', {
  library: librarySchema, keys: z.array(keySchema).max(500).optional(), collection: keySchema.optional(), recursive: z.boolean().default(true),
  scopeId: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(10).default(5)
}, async args => {
  await session.ready(); libraryId(args.library);
  await session.library.checkVersion(args.library);
  const version = session.library.versionOf(args.library);
  let scope = args.scopeId && scopes.get(args.scopeId);
  if (args.scopeId && !scope) throw new Error('材料范围已过期，请从第一批重新读取。');
  if (scope && (scope.library !== args.library || scope.version !== version)) throw new Error('文库或分类已变化，请重新读取以免混合版本。');
  if (!scope) {
    if (args.offset) throw new Error('续页需要第一批返回的 scopeId。');
    const keys = await scopeKeys(session, args);
    scope = { library: args.library, version, keys };
    args.scopeId = createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24);
    scopes.set(args.scopeId, scope);
    if (scopes.size > 20) scopes.delete(scopes.keys().next().value);
  }
  const papers = [], errors = [];
  const selected = scope.keys.slice(args.offset, args.offset + args.limit);
  for (const key of selected) {
    try { papers.push(await paperEvidence(session, args.library, key)); }
    catch (error) { errors.push({ itemKey: key, message: error.message }); }
  }
  await session.library.checkVersion(args.library);
  if (session.library.versionOf(args.library) !== version) throw new Error('文库在读取期间发生变化，本批结果已舍弃，请刷新。');
  const processed = args.offset + selected.length;
  const packet = { scopeId: args.scopeId, library: args.library, version, total: scope.keys.length, offset: args.offset, processed,
    nextOffset: processed < scope.keys.length ? processed : null, papers, errors,
    incomplete: errors.length > 0 || papers.some(p => p.errors.length > 0), status: 'reading-material-not-citation-approval' };
  packet.markdown = evidenceMarkdown(packet); return packet;
});
const researchTools = ['semantic_search', 'semantic_status', 'find_similar', 'search_fulltext', 'get_content', 'get_annotations', 'search_annotations', 'get_item_details', 'get_operation_status'];
register('research_query', 'Zotero MCP 研究检索', '调用已经运行的 Zotero MCP 的只读研究能力。返回原始回执（包括排队/截断信息），不得把相似度当作引用支持。', {
  action: z.enum(researchTools), arguments: z.record(z.string(), z.unknown()).default({})
}, async args => {
  const upstream = await ricky.call(args.action, args.arguments, { readOnly: true });
  return { ...upstream, structuredContent: { upstream } };
});

register('review_evidence', '引用核查与待审高亮', '对 zotero-lattics v2 判断包运行 issue 和 preflight-bind，再把未改动的凭证交给现有 Zotero MCP。默认 dryRun。真实写入必须有用户授权、同一材料的 previewToken，并显式 dryRun=false、confirmWrite=true。脚本通过仅证明结构一致，语义由研究者和阅读审查负责。', {
  judgment: z.record(z.string(), z.unknown()), locators: z.array(z.string().min(2).max(100000)).min(1).max(12).describe('定位器的原始 JSON stdout 字符串数组，不可改写。'),
  libraryID: z.number().int().positive().optional(),
  previewToken: z.string().regex(/^[a-f0-9]{48}$/).optional(),
  dryRun: z.boolean().default(true), confirmWrite: z.boolean().default(false)
}, async ({ judgment, locators, libraryID, dryRun, confirmWrite, previewToken }) => {
  if (!dryRun && !confirmWrite) throw new Error('真实写入必须明确确认；未提交任何高亮。');
  const payload = { judgment, locators, libraryID: libraryID || null, endpoint: ricky.url, zotero: baseUrl };
  if (!dryRun) {
    const { result, operation } = await transactions.commit(payload, previewToken, confirmWrite, args => ricky.call('create_review_highlight', args));
    return { ...result, structuredContent: { upstream: result, operation } };
  }
  const dir = await mkdtemp(join(tmpdir(), 'zotero-evidence-'));
  try {
    const input = join(dir, 'judgment.json'), receiptPath = join(dir, 'receipt.json'), locatorPath = join(dir, 'locators.json');
    await writeFile(input, JSON.stringify(judgment), { mode: 0o600 });
    await writeFile(locatorPath, JSON.stringify(locators), { mode: 0o600 });
    const script = join(root, 'integrations/zotero-lattics/scripts/citation_evidence_audit.py');
    const issued = await run('python3', [script, 'issue', input, '--no-ledger'], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    const receipt = JSON.parse(issued.stdout); await writeFile(receiptPath, issued.stdout, { mode: 0o600 });
    const preflight = await run('python3', [script, 'preflight-bind', input, receiptPath, locatorPath], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    const binding = JSON.parse(preflight.stdout);
    if (!binding.valid) throw new Error(`原文定位与判断包未绑定：${JSON.stringify(binding)}`);
    const args = { locatorResults: locators, auditReceipt: issued.stdout.trim(), dryRun, confirmWrite: !dryRun && confirmWrite, ...(libraryID ? { libraryID } : {}) };
    const result = await ricky.call('create_review_highlight', args);
    const preview = transactions.prepare(payload, args, result);
    return { ...result, structuredContent: { upstream: result, preview }, _meta: { ...result._meta, workbench: { auditReceipt: receipt, binding, dryRun } } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}, { readOnly: false });

register('review_operation', '核查写入状态', '查询本机受控写入记录，包括引用高亮和阅读器批注回收站；服务回执不等于真实状态，outcome-unknown 时不得重试。', { operationId: z.string().regex(/^[a-f0-9]{64}$/) }, async ({ operationId }) =>
  (await annotationTrash.status(operationId)) ?? transactions.status(operationId));

register('inspect_item', '文献检查器', '读取当前条目的结构化元数据、附件身份与期刊等级（来自 Zotero extra 与标签），不把未读批注报告成零。', {library:librarySchema,key:keySchema}, async ({library,key}) => {
  await session.ready(); const {notes,...item}=await session.library.item(library,key);
  return {item,noteCount:notes.length,journalLevels:journalLevelsForItem(item).levels};
});
// Journal-rank lookup: Zotero data first; easyScholar is an explicit opt-in
// network query with in-process caching. Read-only; nothing is written back.
const easyScholarCache = new Map();
const EASYSCHOLAR_TTL = 30 * 24 * 60 * 60 * 1000, EASYSCHOLAR_MAX = 500;
async function easyScholarFor(venue, secretKey) {
  const cacheKey = normalizeVenue(venue);
  const hit = easyScholarCache.get(cacheKey);
  if (hit && Date.now() - hit.at < EASYSCHOLAR_TTL) return hit.value;
  const value = await fetchEasyScholarRank(venue, secretKey);
  easyScholarCache.set(cacheKey, { at: Date.now(), value });
  if (easyScholarCache.size > EASYSCHOLAR_MAX) easyScholarCache.delete(easyScholarCache.keys().next().value);
  return value;
}
register('lookup_journal_levels', '期刊等级查询', '识别文献的期刊等级标签（CSSCI、北大核心、AMI、SSCI、SCI、ESCI、A&HCI、中科院分区、JCR、影响因子）。默认只读 Zotero 条目自带的 extra 与标签；online=true 时对期刊名查询 easyScholar 开放接口（需要 secretKey，期刊名会发送到 easyscholar.cc，结果本地缓存 30 天）。只读，不写入文库。', {
  library: librarySchema.optional(), keys: z.array(keySchema).min(1).max(50).optional(),
  venue: z.string().min(1).max(200).optional(), online: z.boolean().default(false),
  secretKey: z.string().min(8).max(200).optional()
}, async ({library, keys, venue, online, secretKey}) => {
  if (venue !== undefined) {
    if (!online) throw new Error('查询期刊名需要 online=true；本地模式只识别条目自带的 extra 与标签。');
    return await easyScholarFor(venue, secretKey ?? process.env.ZOTERO_EASYSCHOLAR_KEY);
  }
  if (!keys?.length) throw new Error('指定 keys（文献条目）或 venue（期刊名）。');
  const scope = library ?? 'user'; libraryId(scope);
  await session.ready();
  const items = [];
  for (const key of keys) {
    const item = await session.library.item(scope, key);
    const entry = { key, title: item.title, venue: item.venue ?? '', levels: journalLevelsForItem(item).levels, source: ['zotero'] };
    if (online && item.venue) {
      try {
        const remote = await easyScholarFor(item.venue, secretKey ?? process.env.ZOTERO_EASYSCHOLAR_KEY);
        const seen = new Set(entry.levels.map(level => level.id));
        entry.remoteLevels = remote.levels.filter(level => !seen.has(level.id));
        entry.source = ['zotero', 'easyscholar'];
      } catch (error) { entry.remoteError = error.message; }
    }
    items.push(entry);
  }
  return { library: scope, online, items };
});
register('render_reading_card', '文献卡片模板导出', '从真实条目与可选批注生成 Markdown。支持变量与条件块，不运行模板代码；始终附带文献身份与阅读材料状态。', {
  library:librarySchema,key:keySchema,includeAnnotations:z.boolean().default(false),
  metadataTemplate:z.string().max(20000).optional(),annotationTemplate:z.string().max(20000).optional()
}, async ({library,key,includeAnnotations,metadataTemplate,annotationTemplate}) => {
  await session.ready(); const item=await session.library.item(library,key);
  const paper=includeAnnotations?await paperEvidence(library,key):null;
  const packet=paper?{papers:[paper],incomplete:paper.errors.length>0}:null;
  const text=renderReadingCard(item,packet,{metadataTemplate,annotationTemplate});
  return {library,key,text,annotationsIncluded:includeAnnotations,incomplete:packet?.incomplete||false,sha256:createHash('sha256').update(text).digest('hex')};
});
register('library_maintenance', '文库信息检查', '仅按用户主动选择检查元数据：未归类、缺少 DOI、缺少 PDF、疑似重复文献。重复候选附带匹配理由和字段差异，不代表确认重复，不自动合并。只读条目和附件元数据，不扫描 PDF 正文或批注。结果分页。', {
  library:librarySchema,view:z.enum(['unfiled','missingDOI','missingPDF','duplicates']),version:z.string().regex(/^\d+$/).optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50)
},async ({library,view,offset,limit,version:expectedVersion})=>{
  await session.ready(); const prefix=libraryPrefix(library);
  if(view==='duplicates') {
    if(offset>0&&!expectedVersion)throw new Error('继续读取需提供上一页的文库版本。');
    const result=await scanDuplicateCandidates(async path=>{const r=await session.client.getJson(path);return {data:r.data,headers:r.response.headers};},prefix,{version:expectedVersion});
    const total=result.items.length,items=result.items.slice(offset,offset+limit);
    return {...result,library,view,total,items,nextOffset:offset+items.length<total?offset+items.length:null};
  }
  const first=await session.client.getJson(`${prefix}/items/top`);
  const attachments=view==='missingPDF'?await session.client.getJson(`${prefix}/items?itemType=attachment`):null;
  const version=first.response.headers.get('last-modified-version');
  if(expectedVersion!==undefined&&expectedVersion!==version)throw new Error('文库已变化，请重新检查。');
  if(attachments && attachments.response.headers.get('last-modified-version')!==version)throw new Error('文库在检查期间发生变化，请重新检查。');
  await session.library.checkVersion(library);
  if(String(session.library.versionOf(library))!==version)throw new Error('文库在检查期间发生变化，请重新检查。');
  const result=maintenanceRows(first.data,attachments?.data||[],view),items=result.matches.slice(offset,offset+limit);
  return {library,view,version,regularCount:result.regularCount,total:result.matches.length,items,nextOffset:offset+items.length<result.matches.length?offset+items.length:null};
});

register('prepare_library_action', '预览条目操作', '为个人文库预览 DOI/arXiv 元数据导入、元数据修改或阅读笔记；不写入。修改和笔记需指定普通条目 key。返回供用户核对的内容与短期凭证。', {
  action: z.enum(['import', 'metadata', 'note']), identifier: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(), key: keySchema.optional(),
  text: z.string().max(100000).optional(), fields: z.record(z.string(), z.string()).optional()
}, args => libraryActions.prepare(args));
register('commit_library_action', '确认保存到 Zotero', '执行已经展示给用户并获授权的条目操作。使用原 previewToken；失败或超时不得自动重试。个人文库限定。', {
  previewToken: z.string().regex(/^[a-f0-9]{48}$/), confirmWrite: z.boolean().default(false)
}, ({previewToken,confirmWrite}) => libraryActions.commit(previewToken,confirmWrite), {readOnly:false});
register('export_selection', '引用与条目导出', '返回所选条目的引用或导出文本，供人和 Agent 使用；不修改 Zotero 或稿件。', {
  library: librarySchema, keys: z.array(keySchema).min(1).max(200),
  format: z.enum(['text','bibtex','biblatex','ris','csljson']).default('text'),
  style: z.string().max(200).default('apa'), locale: z.string().max(50).default('zh-CN')
}, async ({library,keys,format,style,locale}) => {
  await session.ready();
  if(format === 'text') {
    const entries=await session.library.cite(library,keys,style,locale);
    return {library,keys,format,style,entries,text:entries.map(e=>`${e.citation}\n${e.bib}`).join('\n\n')};
  }
  return {library,keys,format,notesIncluded:false,text:bibliographyOnly(await session.library.export(library,keys,format),format)};
});

// ---------------------------------------------------------------------------
// P2.6：登记表低频清理。register_citation 每次写入后调用；每 20 次写入或距上次
// 清理超过 10 分钟触发一次 pruneCitations（TTL/上限），失败静默、不影响登记。
// 清理只由 MCP 写进程执行（单写者约定），Host 只读，不在 Host 侧 prune。
// ---------------------------------------------------------------------------
const CITATION_PRUNE_EVERY_WRITES = 20;
const CITATION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let citationWritesSincePrune = 0;
let citationLastPruneAt = Date.now();
let citationPruneInFlight = false;

/** 测试用：重置清理节流状态。 */
export function resetCitationPruneState() {
  citationWritesSincePrune = 0;
  citationLastPruneAt = Date.now();
  citationPruneInFlight = false;
}

/** 写入后低频清理；返回 {pruned, ...pruneResult}，失败静默。 */
export async function maybePruneCitationRegistry() {
  citationWritesSincePrune += 1;
  const now = Date.now();
  const due = citationWritesSincePrune >= CITATION_PRUNE_EVERY_WRITES
    || now - citationLastPruneAt > CITATION_PRUNE_INTERVAL_MS;
  if (!due || citationPruneInFlight) return { pruned: false };
  citationPruneInFlight = true;
  citationWritesSincePrune = 0;
  citationLastPruneAt = now;
  try {
    const result = await pruneCitations();
    return { pruned: true, ...result };
  } catch {
    return { pruned: false, failed: true };
  } finally {
    citationPruneInFlight = false;
  }
}

register('register_citation', '登记逐字引文', '研究性回答中引用 Zotero 原文前必须先调用本工具：先用 read_fulltext/find_in_pdf 取逐字原文与物理页码，再登记；只有返回 citationId 才可在正文给角标，角标格式 [N](https://zotero-wb.invalid/c/<citationId> "题名")。逐字原文跨页、页码不符或匹配失败时本工具报错，此时不得给角标。只在会话中定位高亮并写入本机引文登记表，不写 Zotero。', {
  library: librarySchema, key: keySchema,
  page: z.number().int().min(1).describe('物理页码（1 起，来自 read_fulltext/find_in_pdf 的物理页）'),
  quote: z.string().min(8).max(2000).describe('从 PDF 复制的逐字原文（不要改写、不要跨页）'),
  comment: z.string().max(500).optional()
}, async ({ library, key, page, quote, comment }) => {
  await session.ready();
  const { item, attachment, pdf, path: pdfPath } = await session.pdfText(library, key);
  const pages = Array.isArray(pdf?.pages) ? pdf.pages : [];
  if (!Number.isInteger(page) || page < 1 || page > pages.length)
    throw new ZoteroError('page_not_found', `第 ${page} 页超出 PDF 范围（共 ${pages.length} 页）；用 read_fulltext/find_in_pdf 确认真实物理页后再登记。`);
  // pdfText 返回的 item 是 Zotero 原始条目 JSON（{key, meta, data}），元数据在 data 里。
  const rawItemRoot = item !== null && typeof item === 'object' ? item : {};
  const rawItem = rawItemRoot.data !== null && typeof rawItemRoot.data === 'object' ? rawItemRoot.data : rawItemRoot;
  const parentItemKey = rawItemRoot.key ?? attachment.key;
  const attachmentKey = attachment.key;
  // pdfjs 对部分 CID/嵌入字体中文 PDF 会丢字；退化页直接走 poppler。
  const pageDegraded = isPdfjsPageTextDegraded(pages[page - 1]?.text);

  const matchWithPdfjs = async () => {
    const matched = await session.highlight(library, key, { page, quote, comment, color: 'yellow' });
    const highlight = matched.highlight;
    if (highlight.pageIndex !== page - 1)
      throw new ZoteroError('quote_page_mismatch', `逐字原文实际位于第 ${highlight.pageIndex + 1} 页（印刷页 ${highlight.pageLabel}），不是第 ${page} 页；请用实际物理页重新登记。`);
    const exactCompact = compactQuote(highlight.quote), requestedCompact = compactQuote(quote);
    if (exactCompact !== requestedCompact && requestedCompact.startsWith(exactCompact))
      throw new ZoteroError('quote_not_found', '逐字原文跨越页边界，单页内无法给出完整 rects；请缩短到同一页内的句段后重试（不要跨页引用）。');
    return {
      quoteExact: highlight.quote, rects: highlight.rects ?? [],
      pageIndex: highlight.pageIndex, pageLabel: highlight.pageLabel,
      itemKey: highlight.itemKey ?? parentItemKey,
      attachmentKey: highlight.attachmentKey ?? attachmentKey,
      textSource: 'pdfjs'
    };
  };
  const matchWithPoppler = async () => {
    const matched = await verifyQuoteWithPoppler({ path: pdfPath, page, quote });
    return { ...matched, itemKey: parentItemKey, attachmentKey };
  };

  let verification = null, pdfjsError = null, popplerError = null;
  if (!pageDegraded) {
    try {
      verification = await matchWithPdfjs();
    } catch (error) {
      if (error instanceof ZoteroError && error.code === 'quote_not_found') pdfjsError = error;
      else throw error;
    }
  }
  if (verification === null) {
    try {
      verification = await matchWithPoppler();
    } catch (error) {
      popplerError = error;
      // poppler 不可用时退回 pdfjs 再试一次（低文本页仍可能命中的场景）。
      if (pageDegraded && error instanceof ZoteroError && error.code === 'quote_unverifiable') {
        try {
          verification = await matchWithPdfjs();
        } catch (pdfjsFallbackError) {
          if (!(pdfjsFallbackError instanceof ZoteroError && pdfjsFallbackError.code === 'quote_not_found'))
            throw pdfjsFallbackError;
        }
      }
    }
  }
  if (verification === null) {
    const reason = popplerError ?? pdfjsError;
    if (reason instanceof ZoteroError && reason.code === 'quote_unverifiable') throw reason;
    throw new ZoteroError('quote_not_found', `在第 ${page} 页找不到逐字原文“${String(quote).slice(0, 60)}”。请用 read_fulltext/find_in_pdf 复制逐字原文（不要改写、不要跨页）后重试。`);
  }

  const now = Date.now();
  const id = randomBytes(6).toString('hex');
  const authors = citationAuthorsFromCreators(rawItem.creators);
  const parsedDate = typeof rawItemRoot.meta?.parsedDate === 'string' ? rawItemRoot.meta.parsedDate : '';
  const yearMatch = /(\d{4})/.exec(parsedDate) ?? /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(String(rawItem.date ?? ''));
  const field = name => (typeof rawItem[name] === 'string' ? rawItem[name].trim() : '');
  const venue = ['publicationTitle', 'bookTitle', 'conferenceName', 'proceedingsTitle', 'university', 'institution', 'publisher', 'websiteTitle', 'blogTitle', 'forumTitle', 'repository']
    .map(field)
    .find(value => value !== '') ?? '';
  const record = {
    id, library, itemKey: verification.itemKey ?? parentItemKey, attachmentKey: verification.attachmentKey ?? attachmentKey,
    pageIndex: verification.pageIndex, pageLabel: verification.pageLabel,
    quote: verification.quoteExact, requestedQuote: quote, rects: verification.rects ?? [],
    title: field('title'), authors,
    year: yearMatch === null ? '' : yearMatch[1],
    venue, doi: field('DOI'), itemType: field('itemType'),
    textSource: verification.textSource,
    verifiedAt: now, createdAt: now, version: 1
  };
  await appendCitation(record);
  await maybePruneCitationRegistry();
  const links = citationLinks(record);
  return {
    citationId: id, href: links.href,
    itemKey: record.itemKey, attachmentKey: record.attachmentKey,
    page: record.pageIndex + 1, pageLabel: record.pageLabel, quoteExact: record.quote,
    title: record.title, authors: record.authors, year: record.year, venue: record.venue,
    doi: record.doi, itemType: record.itemType, textSource: record.textSource,
    zoteroItemUrl: links.zoteroItemUrl, zoteroPdfUrl: links.zoteroPdfUrl,
    verified: true
  };
}, { readOnly: false });

register('citation_source_list', '引文来源列表', '把 register_citation 返回的 citationId 与正文角标编号转成回复末尾的「来源」Markdown 区：保留题名、作者、年份、期刊/出版、页码与 zotero:// 深链。只读本机引文登记表；id 不存在时返回错误，不得伪造 citationId。', {
  items: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{12}$/),
    number: z.number().int().min(1)
  })).min(1).max(200)
}, async ({ items }) => {
  const sorted = [...items].sort((a, b) => a.number - b.number);
  const entries = [];
  for (const { id, number } of sorted) {
    const record = await getCitation(id);
    if (record === null)
      throw new ZoteroError('not_found', `引文登记 ${id} 不存在或已过期；请重新调用 register_citation，不得伪造 citationId。`);
    const links = citationLinks(record);
    entries.push({
      number, id,
      title: record.title ?? '', authors: Array.isArray(record.authors) ? record.authors : [],
      year: record.year ?? '', venue: record.venue ?? '',
      pages: record.pageLabel ?? String((Number.isInteger(record.pageIndex) ? record.pageIndex : 0) + 1),
      doi: record.doi ?? '',
      zoteroItemUrl: links.zoteroItemUrl, zoteroPdfUrl: links.zoteroPdfUrl
    });
  }
  return { text: entries.map(entry => citationSourceLine(entry)).join('\n'), entries };
});

// ---------------------------------------------------------------------------
// 引文-稿件绑定与稿件审计：让角标离开对话后仍可回读校验。
// 补的是「引文登记表不知道正文写在哪个文件」这个洞（research/04 §9 缺口 3）。
// 只读稿件与登记表，不写 vault、不写 Zotero。
// ---------------------------------------------------------------------------

const docPathSchema = z.string().min(1).max(4096)
  .describe('用户指定的绝对 Markdown 文件路径（.md 或 .markdown）');

function throwMarkdownDocumentError(error) {
  if (error?.code === 'document_not_found') throw new ZoteroError('not_found', error.message);
  if (error?.code === 'document_too_large') throw new ZoteroError('too_large', error.message);
  if (error?.code === 'invalid_document_path' || error?.code === 'document_not_regular')
    throw new ZoteroError('invalid_input', error.message);
  throw error;
}

register('bind_citation', '绑定引文到稿件论断', '把 register_citation 拿到的 citationId 绑定到用户指定的 Markdown 稿件中的某句论断，并由服务端读取文件、记录当时的稿件指纹。绑定后用 audit_doc 检查整篇稿件指纹是否变化。不写稿件、不写 Zotero，只写本机绑定表。', {
  citationId: z.string().regex(/^[a-f0-9]{12}$/).describe('register_citation 返回的 citationId'),
  docPath: docPathSchema,
  claim: z.string().max(2000).optional().describe('该角标支撑的论断原文（可空；只记「这篇稿件引用了它」）'),
  docHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('可选的当前稿件 SHA-256；服务端会自行读取文件并计算，若提供则必须与实际内容一致')
}, async ({ citationId, docPath, claim, docHash }) => {
  const citation = await getCitation(citationId);
  if (citation === null)
    throw new ZoteroError('not_found', `引文登记 ${citationId} 不存在或已过期；请重新调用 register_citation，不得伪造 citationId。`);
  let binding;
  try {
    binding = await bindCitationFromDocument({ citationId, docPath, claim, docHash });
  } catch (error) {
    if (error?.code === 'doc_hash_mismatch') throw new ZoteroError('invalid_input', error.message);
    throwMarkdownDocumentError(error);
  }
  return {
    ok: true, binding,
    citation: { title: citation.title ?? '', pageLabel: citation.pageLabel ?? '', venue: citation.venue ?? '' }
  };
}, { readOnly: false });

register('audit_doc', '审计稿件引文', '扫描用户指定的 Markdown 稿件里的工作台引文链接，检查 citationId 是否仍在登记表中、是否绑定过、绑定后整篇稿件指纹是否变化、是否有编号复用、格式损坏或角标被删。只读稿件与绑定表，不修改任何文件，也不判断论断是否被引文支持。', {
  docPath: docPathSchema,
  maxChars: z.number().int().min(1000).max(2000000).default(400000)
}, async ({ docPath, maxChars }) => {
  let document;
  try {
    document = await readMarkdownDocument(docPath, {
      maxBytes: Math.min(MAX_MARKDOWN_DOCUMENT_BYTES, maxChars * 4),
    });
  } catch (error) {
    throwMarkdownDocumentError(error);
  }
  const { docPath: absolute, text } = document;
  if (text.length > maxChars)
    throw new ZoteroError('too_large', `稿件 ${text.length} 字符超过上限 ${maxChars}；请先拆分或分段审计。`);
  const report = await auditDocument({
    docPath: absolute, text,
    lookupCitation: id => getCitation(id)
  });
  return {
    ...report,
    // 只回必要字段，避免把整份绑定表塞进上下文。
    bindings: report.bindings.map(({ citationId, claim, docHash, createdAt }) => ({ citationId, claim, docHash, createdAt })),
    markers: report.markers.map(({ number, citationId, title }) => ({ number, citationId, title }))
  };
});

register('read_page_text', '读取干净页文本', '当 read_fulltext 出现乱码、缺字或只有标点/数字（CID/嵌入字体 PDF）时，用本工具读取干净文本；引用前仍需 register_citation 验证逐字引文与物理页。优先用 poppler 的 pdftotext -layout 逐页提取，poppler 不可用时回退 pdfjs 页文本（textSource 标明来源）。', {
  library: librarySchema, key: keySchema,
  pages: z.string().max(200).default('1-3').describe("页码规格：'1'、'2-5'、'1,4-6'（物理页，1 起）"),
  maxChars: z.number().int().min(500).max(100000).default(30000)
}, async ({ library, key, pages: spec, maxChars }) => {
  await session.ready();
  const { item, attachment, pdf, path: pdfPath } = await session.pdfText(library, key);
  const pdfPages = Array.isArray(pdf?.pages) ? pdf.pages : [];
  const selected = parsePagesSpec(spec, pdfPages.length);
  const rawItemRoot = item !== null && typeof item === 'object' ? item : {};
  const collected = await collectPageTexts({ pdfPages, pdfPath, pageNumbers: selected, maxChars });
  return {
    library,
    itemKey: rawItemRoot.key ?? attachment.key,
    attachmentKey: attachment.key,
    pages: collected.pages,
    text: collected.text,
    textSource: collected.textSource,
    truncated: collected.truncated,
    ...(collected.fallbackReason === undefined ? {} : { fallbackReason: collected.fallbackReason })
  };
});

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; researchWorkspace.close(); session.close(); await ricky.close(); await server.close().catch(() => {}); process.exit(0);
}
// 只有作为入口（node src/server.mjs）时才连接 stdio；被测试 import 时保持纯模块，
// 这样 poppler 解析/匹配函数可以在离线单测里直接 import（不启动 MCP 服务）。
const entryPath = (() => {
  const candidate = process.argv[1];
  if (typeof candidate !== 'string' || candidate === '') return null;
  try { return resolve(candidate); } catch { return null; }
})();
const canonical = value => { try { return realpathSync(value); } catch { return null; } };
const invokedDirectly = entryPath !== null && canonical(entryPath) !== null && canonical(entryPath) === canonical(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown); process.stdin.once('end', shutdown);
  await server.connect(new StdioServerTransport());
}
