/**
 * 引文-稿件绑定（citation bindings）与稿件审计。
 *
 * 解决的问题（research/04 §9 缺口 3）：
 *   register_citation 只记 itemKey/attachmentKey/页码，**不知道正文写在哪个文件**。
 *   于是引文角标一旦离开对话就失效：稿件里的 [N](.../c/<id> "题名") 无从回读校验。
 *
 * 本模块只做两件事：
 *   1. bindCitation — 把 citationId 绑到用户指定 Markdown 文件中的某个论断上；
 *   2. auditDoc     — 扫稿件里所有角标，检查 citationId 是否仍有效、绑定是否漂移。
 *
 * 设计约束：
 * - Node 标准库，无第三方依赖；与 citation-registry 同样的追加写 JSONL + fsync 纪律；
 * - **不做语义判断**：本模块只回答"角标指向的引文是否还存在、稿件是否变过"，
 *   不回答"这句论断是否被该引文支持"（那是 research.verify 的职责，需外部锚点）；
 * - 不写任何 vault 文件（只读），不写 Zotero。
 *
 * 目录：同 citation-registry，`$ZOTERO_WORKBENCH_STATE_DIR || ~/.local/share/zotero-workbench`
 * 文件：<目录>/citations/bindings.jsonl
 */

import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const BINDING_VERSION = 1
export const MAX_MARKDOWN_DOCUMENT_BYTES = 8 * 1024 * 1024

/** 角标格式：[N](https://zotero-wb.invalid/c/<citationId> "题名") */
const CITATION_MARKER = /\[(\d+)\]\((https:\/\/zotero-wb\.invalid\/c\/([a-f0-9]{12}))(?:\s+"((?:\\.|[^"\\])*)")?\)/g
const CITATION_URL_PREFIX = 'https://zotero-wb.invalid/c/'
const CITATION_URL_PREFIX_PATTERN = /https:\/\/zotero-wb\.invalid\/c\//g

/**
 * 识别本文明确支持的 Markdown 排除区：围栏代码、反引号行内代码和 HTML 注释。
 * 这是角标扫描所需的局部过滤，不是完整 Markdown 解析器。
 */
function markdownExcludedRanges(source) {
  const fenced = []
  let opening = null
  let lineStart = 0

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? source.length : newline + 1
    const line = source.slice(lineStart, newline < 0 ? source.length : newline).replace(/\r$/, '')
    let indent = 0
    while (indent < line.length && line[indent] === ' ' && indent < 4) indent += 1
    const fenceChar = line[indent]
    let runEnd = indent
    while (runEnd < line.length && line[runEnd] === fenceChar) runEnd += 1
    const runLength = runEnd - indent
    const rest = line.slice(runEnd)

    if (opening !== null) {
      if (
        indent <= 3 && fenceChar === opening.char && runLength >= opening.length &&
        /^[\t ]*$/.test(rest)
      ) {
        fenced.push({ start: opening.start, end: lineEnd })
        opening = null
      }
    } else if (
      indent <= 3 && (fenceChar === '`' || fenceChar === '~') && runLength >= 3 &&
      !(fenceChar === '`' && rest.includes('`'))
    ) {
      opening = { start: lineStart, char: fenceChar, length: runLength }
    }

    lineStart = lineEnd
  }
  if (opening !== null) fenced.push({ start: opening.start, end: source.length })

  const comments = []
  const inline = []
  let cursor = 0
  while (cursor < source.length) {
    const containingFence = rangeAt(fenced, cursor)
    if (containingFence !== undefined) {
      cursor = containingFence.end
      continue
    }
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4)
      const end = close < 0 ? source.length : close + 3
      comments.push({ start: cursor, end })
      cursor = end
      continue
    }
    if (source[cursor] !== '`') {
      cursor += 1
      continue
    }

    const start = cursor
    while (cursor < source.length && source[cursor] === '`') cursor += 1
    const delimiterLength = cursor - start
    let search = cursor
    let closing = -1
    while (search < source.length) {
      const blocked = rangeAt(fenced, search)
      if (blocked !== undefined) {
        search = blocked.end
        continue
      }
      if (source[search] !== '`') {
        search += 1
        continue
      }
      let runStop = search
      while (runStop < source.length && source[runStop] === '`') runStop += 1
      if (runStop - search === delimiterLength) {
        closing = runStop
        break
      }
      search = runStop
    }
    if (closing >= 0) {
      inline.push({ start, end: closing })
      cursor = closing
    }
  }

  return mergeRanges([...fenced, ...comments, ...inline])
}

function rangeAt(ranges, offset) {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const range = ranges[middle]
    if (offset < range.start) high = middle - 1
    else if (offset >= range.end) low = middle + 1
    else return range
  }
  return undefined
}

function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((left, right) => left.start - right.start)
  const merged = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

const cache = new Map()

function stateDir() {
  const configured = process.env.ZOTERO_WORKBENCH_STATE_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.local/share/zotero-workbench')
}

export function bindingsFile() {
  return join(stateDir(), 'citations', 'bindings.jsonl')
}

/** 稿件内容指纹：用于判断"绑定之后稿件变没变"。 */
export function documentFingerprint(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function documentPathError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

/**
 * Read a user-specified absolute Markdown file through one open handle. fstat and the byte limit
 * run before content is read, so directories and unexpectedly large files fail without loading.
 */
export async function readMarkdownDocument(docPath, {
  maxBytes = MAX_MARKDOWN_DOCUMENT_BYTES,
  openDocument = open,
} = {}) {
  if (typeof docPath !== 'string' || docPath === '' || !isAbsolute(docPath)) {
    throw documentPathError('invalid_document_path', '稿件路径必须是用户指定的绝对路径。')
  }
  const extension = extname(docPath).toLowerCase()
  if (extension !== '.md' && extension !== '.markdown') {
    throw documentPathError('invalid_document_path', '稿件必须是 .md 或 .markdown 文件。')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes 必须是正的安全整数。')
  }

  const absolute = resolve(docPath)
  let handle
  try {
    handle = await openDocument(absolute, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw documentPathError('document_not_found', `稿件不存在：${absolute}。请确认指定的 Markdown 文件路径。`, error)
    }
    throw error
  }

  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw documentPathError('document_not_regular', `指定稿件不是常规文件：${absolute}。`)
    }
    if (Number(info.size) > maxBytes) {
      throw documentPathError('document_too_large', `稿件为 ${info.size} 字节，超过读取上限 ${maxBytes} 字节。`)
    }
    const contents = await handle.readFile()
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents ?? ''), 'utf8')
    if (bytes.byteLength > maxBytes) {
      throw documentPathError('document_too_large', `稿件读取后为 ${bytes.byteLength} 字节，超过上限 ${maxBytes} 字节。`)
    }
    return { docPath: absolute, text: bytes.toString('utf8'), byteSize: bytes.byteLength }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 从 Markdown 正文里抽出全部引文角标。
 * 返回 [{ number, citationId, href, title, offset }]，按出现顺序。
 * 同一 citationId 重复出现会各算一条——审计需要知道"引了几次"。
 */
export function extractCitationMarkers(text) {
  const source = String(text ?? '')
  const markers = []
  const excluded = markdownExcludedRanges(source)
  let excludedIndex = 0
  CITATION_MARKER.lastIndex = 0
  let match
  while ((match = CITATION_MARKER.exec(source)) !== null) {
    while (excludedIndex < excluded.length && excluded[excludedIndex].end <= match.index) {
      excludedIndex += 1
    }
    const range = excluded[excludedIndex]
    if (range !== undefined && range.start <= match.index && match.index < range.end) continue
    markers.push({
      number: Number(match[1]),
      href: match[2],
      citationId: match[3],
      title: typeof match[4] === 'string' ? match[4].replace(/\\(["\\])/g, '$1') : '',
      offset: match.index,
    })
  }
  return markers
}

/** Identify workbench citation URL prefixes that were not part of a valid marker. */
export function extractMalformedCitationMarkers(text) {
  const source = String(text ?? '')
  const excluded = markdownExcludedRanges(source)
  const validRanges = []
  CITATION_MARKER.lastIndex = 0
  let valid
  while ((valid = CITATION_MARKER.exec(source)) !== null) {
    const range = rangeAt(excluded, valid.index)
    if (range === undefined) validRanges.push({ start: valid.index, end: CITATION_MARKER.lastIndex })
  }

  const malformed = []
  CITATION_URL_PREFIX_PATTERN.lastIndex = 0
  let match
  while ((match = CITATION_URL_PREFIX_PATTERN.exec(source)) !== null) {
    const offset = match.index
    if (rangeAt(excluded, offset) !== undefined) continue
    if (rangeAt(validRanges, offset) !== undefined) continue
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1
    const before = source.slice(lineStart, offset)
    const numberMatch = /\[(\d+)\]\(\s*$/.exec(before)
    malformed.push({
      number: numberMatch === null ? null : Number(numberMatch[1]),
      hrefPrefix: CITATION_URL_PREFIX,
      offset,
    })
  }
  return malformed
}

async function readBindings() {
  const file = bindingsFile()
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      cache.delete(file)
      return []
    }
    throw error
  }
  const hit = cache.get(file)
  if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.records
  const text = await readFile(file, 'utf8')
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (typeof record.citationId !== 'string' || record.citationId === '') continue
    if (typeof record.docPath !== 'string' || record.docPath === '') continue
    records.push(record)
  }
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, records })
  return records
}

function normalizeBinding(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('citation binding 必须是对象。')
  }
  for (const field of ['citationId', 'docPath']) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new TypeError(`citation binding 缺少非空的 ${field}。`)
    }
  }
  if (!/^[a-f0-9]{12}$/.test(record.citationId)) {
    throw new TypeError('citation binding 的 citationId 必须是 12 位小写十六进制。')
  }
  const now = Date.now()
  return {
    ...record,
    version: BINDING_VERSION,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now,
  }
}

/**
 * 把一条 citationId 绑定到稿件里的一个论断。
 * claim 可为空（此时只记录"这篇稿件引用了它"）；旧记录缺少 docHash 时审计会报告 fingerprint_missing。
 */
export async function bindCitation(record) {
  const stored = normalizeBinding(record)
  const file = bindingsFile()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(file, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(stored)}\n`, 'utf8')
    await handle.sync().catch(() => {})
  } finally {
    await handle.close().catch(() => {})
  }
  cache.delete(file)
  return stored
}

/**
 * Server-facing helper: read the caller's explicitly named document and derive its hash.
 * openDocument can be injected in tests so this behavior does not need a real vault file.
 */
export async function bindCitationFromDocument(record, { openDocument = open } = {}) {
  const normalized = normalizeBinding(record)
  const { docPath, text } = await readMarkdownDocument(normalized.docPath, { openDocument })
  const docHash = documentFingerprint(text)
  if (normalized.docHash !== undefined && normalized.docHash !== docHash) {
    throw documentPathError('doc_hash_mismatch', '调用方提供的 docHash 与指定稿件当前 SHA-256 指纹不匹配。')
  }
  return bindCitation({ ...normalized, docPath, docHash })
}

/** 某篇稿件下最新的绑定；同一 citationId 以最后一条为准。 */
export async function listBindingsByDoc(docPath) {
  if (typeof docPath !== 'string' || docPath === '') return []
  const target = resolve(docPath)
  const records = await readBindings()
  const latest = new Map()
  for (const record of records) {
    if (resolve(record.docPath) !== target) continue
    latest.set(record.citationId, record)
  }
  return [...latest.values()]
}

/**
 * 审计一篇稿件里的引文角标。
 *
 * @param {object} params
 * @param {string} params.docPath       稿件绝对路径（仅用于报告与绑定匹配）
 * @param {string} params.text          稿件正文
 * @param {(id:string)=>Promise<object|null>} params.lookupCitation  按 id 查引文登记表
 * @param {object[]=} params.bindings   预先取好的绑定（省略则自行读取）
 * @returns {Promise<object>} { docPath, total, unique, markers, malformedMarkers, bindings, issues, summary }
 *
 * issue.code 取值：
 *   citation_missing     角标指向的 citationId 在登记表里不存在（或已过期清理）
 *   doc_changed          整篇稿件指纹与绑定时不一致；不定位具体改动或判断论断语义
 *   fingerprint_missing  绑定缺少稿件指纹，无法检查稿件是否漂移
 *   malformed_marker     存在格式损坏或 citationId 非法的工作台引文链接
 *   unbound              有角标但没有对应绑定记录（未走 bindCitation）
 *   binding_orphaned     有绑定但稿件里已无该角标（角标被删）
 *   duplicate_number     同一编号指向不同 citationId（编号复用，读者会看错）
 */
export async function auditDocument({ docPath, text, lookupCitation, bindings }) {
  const markers = extractCitationMarkers(text)
  const malformedMarkers = extractMalformedCitationMarkers(text)
  const bindingsList = Array.isArray(bindings) ? bindings : await listBindingsByDoc(docPath)
  const bindingById = new Map(bindingsList.map((record) => [record.citationId, record]))
  const docHash = documentFingerprint(text)
  const issues = []
  const fingerprintWarnings = new Set()

  for (const malformed of malformedMarkers) {
    issues.push({
      code: 'malformed_marker',
      number: malformed.number,
      offset: malformed.offset,
      message: `稿件中存在格式损坏或 citationId 非法的 Zotero Workbench 引文链接${malformed.number === null ? '' : ` [${malformed.number}]`}；请修复该角标后重新审计。`,
    })
  }

  const unique = new Set()
  const numberToIds = new Map()

  for (const marker of markers) {
    unique.add(marker.citationId)
    const seen = numberToIds.get(marker.number) ?? new Set()
    seen.add(marker.citationId)
    numberToIds.set(marker.number, seen)

    const citation = typeof lookupCitation === 'function' ? await lookupCitation(marker.citationId) : null
    if (citation === null || citation === undefined) {
      issues.push({
        code: 'citation_missing',
        citationId: marker.citationId,
        number: marker.number,
        title: marker.title,
        message: `角标 [${marker.number}] 指向的引文 ${marker.citationId} 不在登记表中，可能已被 TTL 清理；需要重新 register_citation。`,
      })
      continue
    }

    const binding = bindingById.get(marker.citationId)
    if (binding === undefined) {
      issues.push({
        code: 'unbound',
        citationId: marker.citationId,
        number: marker.number,
        title: marker.title,
        message: `角标 [${marker.number}] 有登记但未绑定到本稿件；论断归属不明。`,
      })
      continue
    }
    if (typeof binding.docHash === 'string' && binding.docHash !== '' && binding.docHash !== docHash) {
      issues.push({
        code: 'doc_changed',
        citationId: marker.citationId,
        number: marker.number,
        title: marker.title,
        message: `角标 [${marker.number}] 绑定后整篇稿件的内容指纹已变化；本检查未定位具体改动，也未判断论断语义，需要人工复核。`,
      })
    } else if (
      (typeof binding.docHash !== 'string' || binding.docHash === '') &&
      !fingerprintWarnings.has(marker.citationId)
    ) {
      fingerprintWarnings.add(marker.citationId)
      issues.push({
        code: 'fingerprint_missing',
        citationId: marker.citationId,
        number: marker.number,
        message: `绑定 ${marker.citationId} 缺少稿件指纹，无法检查绑定后稿件是否发生漂移。`,
      })
    }
  }

  for (const [number, ids] of numberToIds) {
    if (ids.size > 1) {
      issues.push({
        code: 'duplicate_number',
        number,
        citationIds: [...ids],
        message: `编号 [${number}] 指向了 ${ids.size} 个不同引文，读者无法判断指的是哪一篇。`,
      })
    }
  }

  const cited = new Set(markers.map((marker) => marker.citationId))
  for (const binding of bindingsList) {
    if (!cited.has(binding.citationId)) {
      issues.push({
        code: 'binding_orphaned',
        citationId: binding.citationId,
        message: `绑定 ${binding.citationId} 在稿件中已无对应角标（角标被删或段落被移除）。`,
      })
    }
  }

  const blocking = issues.filter((issue) =>
    ['citation_missing', 'duplicate_number', 'binding_orphaned', 'malformed_marker'].includes(issue.code),
  )

  return {
    docPath,
    docHash,
    total: markers.length + malformedMarkers.length,
    unique: unique.size,
    markers,
    malformedMarkers,
    bindings: bindingsList,
    issues,
    summary: {
      ok: blocking.length === 0,
      blocking: blocking.length,
      warnings: issues.length - blocking.length,
      checked: markers.length + malformedMarkers.length,
    },
  }
}

/** 仅用于测试/诊断：丢掉读取缓存。 */
export function clearBindingCache() {
  cache.clear()
}
