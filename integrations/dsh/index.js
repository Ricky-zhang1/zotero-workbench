import { ResearchWorkspace } from '../../src/domain/research-workspace.mjs'
import { CollaborationWorkspace } from '../../src/domain/collaboration-workspace.mjs'
import { AnnotationComment } from '../../src/domain/annotation-comment.mjs'
import { scanDuplicateCandidates, DuplicateScanError } from '../../src/domain/duplicates.mjs'
import { journalLevelsForItem } from '../../src/domain/journal-levels.mjs'
import { ZoteroSession } from '../../dist/runtime.mjs'
import { localAuthKeyFile } from '../../src/transports/local-auth.mjs'
/**
 * zotero-workbench-dsh — Host half（DSH 插件）。
 *
 * 职责：在 DSH 的同一个 Web 进程里提供 Zotero 文献阅读器后端，供
 * `/zotero-workbench/app/` 的全页工作台和右栏阅读器使用。文库与 PDF API 只读；
 * 独立的批注备注 API 仅更新已存在批注的 annotationComment，并由共享服务做来源/版本保护与回读核实。
 * Host 路由实现只用 Node 标准库（`node:fs`、`node:http`、全局 `fetch`），不依赖第三方包。
 *
 * 路由（全部挂在本插件自己的前缀下，避开 DSH 自带 `/` 与 `/api` 的 Cookie 鉴权）：
 *   GET  /zotero-workbench                     → 302 到阅读器
 *   GET  /zotero-workbench/app                 → 302 到 /zotero-workbench/app/
 *   GET  /zotero-workbench/app/*               → 静态提供 integrations/dsh/web/（index.html 为默认文档）
 *   GET  /zotero-workbench/pdfjs/*             → 静态提供仓库根 dist/pdfjs/（PDF.js 的 cmaps/字体/wasm 等）
 *   GET  /zotero-workbench/api/health          → {ok, version, zotero:{reachable, version?}}
 *   GET  /zotero-workbench/api/collections     → {libraries, collections, savedSearches}
 *   GET  /zotero-workbench/api/items           → {items, nextStart, total, ...}
 *   GET  /zotero-workbench/api/item?key=K      → 完整条目 + attachments/notes/annotations
 *   GET  /zotero-workbench/api/pdf?key=K       → application/pdf，支持 HEAD 与 Range
 *   GET  /zotero-workbench/api/citations?keys= → BibTeX/BibLaTeX/RIS/CSL-JSON/APA 文本导出
 *   GET  /zotero-workbench/api/maintenance?... → 未归类/缺 DOI/缺 PDF 信息检查（服务端扫描 + 120s 缓存）
 *   POST /zotero-workbench/api/open            → 用 zotero:// 深链在 Zotero 中定位条目/PDF（不写 Zotero）
 *   GET  /zotero-workbench/api/citation?id=    → 单条逐字引文登记（含角标 href 与 zotero:// 深链）
 *   GET  /zotero-workbench/api/citations?itemKey= → 同一文献的引文登记列表
 *   POST /zotero-workbench/api/annotation-comment → 版本保护的当前 PDF 批注备注读取/更新
 *   POST /zotero-workbench/api/citation/:id/annotation → 本地写入个人高亮（Zotero 10 前恒 501 占位）
 *
 * 安全边界：
 * - 浏览器信任围栏（官方/生态做法，参考 dsh-better-sidebar 的 /sidebar/*）：每个请求先调
 *   `ctx.connection.requestRejection(req)`，返回 undefined 才放行，否则 403 JSON
 *   （code 'forbidden'）。它负责 Host/Origin 围栏 + 已认证 Peer（同源 iframe 自带
 *   SameSite cookie）；裁剪环境没有 connection 服务时保持原行为（放行）。
 * - 每个 /zotero-workbench/* 请求都校验 Host 头（防 DNS rebinding，防御纵深）；DSH 的
 *   webServer 只负责端口绑定，不替插件做请求策略，因此这里按 ctx.webServer.getOrigin()
 *   得到的 host:port 做白名单（127.0.0.1 / localhost / [::1] + 同一端口）。
 * - DSH 的 webServer 用「URL 规范化后的 pathname」匹配路由（dsh-host-webserver
 *   lib/index.js:381 `new URL(req.url).pathname`），但把原始 req.url 原样交给 handler。
 *   因此请求目标里若含 `..` / `%2e%2e` 这类上级目录段，会被折叠后落到另一个合法路由上
 *   （例如 /app/../api/health → /api/health）。插件在入口统一按原始 req.url 拒绝这类
 *   请求（404），既避免跨前缀混淆，也保证静态路由不会被折叠后的空子路径意外命中 index。
 * - 静态路由做 decodeURIComponent 容错、dot-segment 拒绝与 realpath 前缀校验（防符号链接穿越）。
 * - PDF 只从 Zotero 条目 JSON 的 enclosure（或 file/view/url）读取，并要求 realpath 落在
 *   Zotero storage 目录内；另外校验文件头含 `%PDF-`，避免被伪造元数据骗读任意文件。
 * - 批注备注写入只允许个人库中精确匹配的 annotation/PDF；要求共享服务签发的短期凭证、旧备注与版本号，写后回读。未知结果不重发。
 * - API/PDF 响应统一 `Cache-Control: no-store`；错误统一 JSON `{error:{code,message}}`。
 *
 * 已知限制（MVP）：
 * - 只支持个人文库（library=user）；组库（library=g<id>）返回 501。`/api/users/0/groups`
 *   会出现在 libraries 列表中，但标记 supported:false。
 * - Zotero 数据目录默认取 `~/Zotero/storage`；自定义数据目录需要设置
 *   `ZOTERO_STORAGE_DIR` / `ZOTERO_DATA_DIR`，或给 apply 的 config 传 storageRoots。
 * - 链式文件（linkMode=linked_file）位于 storage 之外时，PDF 路由返回 403；如需读取，
 *   把其所在根目录加进 storageRoots。
 * - `dist/pdfjs/build/` 当前不存在（仓库里上游 build 是内联的），所以
 *   `/zotero-workbench/pdfjs/build/pdf.mjs` 会 404；前端有 web/vendor 兜底。
 */

import { execFile } from 'node:child_process'
import { createReadStream, readFileSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 引文登记表与 MCP 侧共用同一模块与文件格式（写入在 MCP 进程，读取在 Host 进程）。
import { getCitation, listCitationsByItem } from '../../src/domain/citation-registry.mjs'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const name = 'zotero-workbench-dsh'

/** DSH Host 服务：浏览器 HTTP 载体（见 cordis 的 webServer Service）。 */
export const inject = ['webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(PLUGIN_DIR, '..', '..')
const APP_DIR = join(PLUGIN_DIR, 'web')
const PDFJS_DIR = join(REPO_ROOT, 'dist', 'pdfjs')

const ROUTE_ROOT = '/zotero-workbench'
const APP_PATH = `${ROUTE_ROOT}/app`
const API_PATH = `${ROUTE_ROOT}/api`
const PDFJS_PATH = `${ROUTE_ROOT}/pdfjs`

const DEFAULT_ZOTERO_URL = 'http://127.0.0.1:23119'
/** Zotero 本地 API：0 是当前用户库的别名（与 Web API v3 一致）。 */
const ZOTERO_LIBRARY = '/api/users/0'

const DEFAULT_TIMEOUT_MS = 10_000
const HEALTH_TIMEOUT_MS = 3_000
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_STATIC_BYTES = 64 * 1024 * 1024
const MAX_NOTE_HTML = 100_000
const PDF_HEADER_PROBE = 1_024
const KEY_PATTERN = /^[A-Za-z0-9]{1,32}$/
/** Zotero API key 的严格形态（8 位大写字母数字）：用于 citations 与 open 的输入校验。 */
const ZOTERO_KEY_PATTERN = /^[A-Z0-9]{8}$/
const ANNOTATION_COMMENT_EDIT_TOKEN = /^[a-f0-9]{48}$/

const CITATION_FORMATS = new Set(['bibtex', 'biblatex', 'ris', 'csljson', 'text'])
const MAX_CITATION_KEYS = 200

const MAINTENANCE_VIEWS = new Set(['unfiled', 'missingDOI', 'missingPDF', 'duplicates'])
const MAINTENANCE_CACHE_MS = 120_000
const MAINTENANCE_PAGE_SIZE = 100
const MAINTENANCE_SCAN_LIMIT = 5_000

const MAX_OPEN_BODY_BYTES = 16 * 1024
const OPEN_TIMEOUT_MS = 5_000
const ALLOWED_SORTS = new Set([
  'dateModified',
  'dateAdded',
  'title',
  'creator',
  'year',
  'date',
  'itemType',
  'publisher',
])

/** 前端按语义传 sort（如 year），Zotero 本地 API 只接受它的字段名。 */
const SORT_ALIASES = new Map([['year', 'date']])

/** 非普通条目的 Zotero itemType：列表/搜索里一律过滤掉。 */
const NON_REGULAR_TYPES = new Set(['attachment', 'note', 'annotation'])

const MIME_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  }),
)

/** 注入 Agent 的引文角标协议（仅在研究性任务里适用；缺 systemPrompt 服务时跳过）。 */
const CITATION_PROTOCOL_TEXT = [
  '【Zotero 引文角标协议】仅当用户要求找文献、写文献综述、引用核查等研究任务时适用，其他对话忽略。',
  '引用 Zotero 原文前，必须先用 read_fulltext / find_in_pdf 取逐字原文与物理页码（若文本乱码/缺字，改用 read_page_text 读取干净文本），再调用 register_citation 登记；只有它返回 citationId 才可在正文给角标。',
  '正文角标格式：[N](https://zotero-wb.invalid/c/<citationId> "题名")。同一文献在同一回复内复用同一编号，每条回复的编号从 1 开始。',
  '回复末尾用 citation_source_list 生成「来源」区，保留 zotero:// 深链。',
  '验证失败（quote_not_found、页码不符、跨页）时不得给角标，须如实说明并改用逐字原文重试；不得伪造 citationId 或角标。',
].join('\n')

// ---------------------------------------------------------------------------
// 错误与响应工具
// ---------------------------------------------------------------------------

/** 可映射为固定 HTTP 状态 + JSON 错误码的业务错误。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { error: { code, message } }, extraHeaders)
}

function sendMethodNotAllowed(res, allowed) {
  sendError(res, 405, 'method_not_allowed', `只支持 ${allowed.join(' / ')} 请求。`, {
    allow: allowed.join(', '),
  })
}

function sendRedirect(res, location) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(302, { location, 'cache-control': 'no-store', 'content-length': 0 })
  res.end()
}

/** 统一异常出口：HttpError → JSON；其它 → 500 + 日志（不把内部细节吐给浏览器）。 */
function reportError(state, res, error) {
  if (!res || res.headersSent || res.writableEnded) {
    try {
      res?.destroy?.()
    } catch {
      // 连接已断开，无事可做。
    }
    return
  }
  if (error instanceof HttpError) {
    if (error.status >= 500) {
      try {
        state.ctx?.logger?.warn?.(`zotero-workbench: ${error.code}: ${error.message}`)
      } catch {
        // logger 不可用时忽略。
      }
    }
    sendError(res, error.status, error.code, error.message)
    return
  }
  try {
    state.ctx?.logger?.error?.(error)
  } catch {
    // logger 不可用时忽略。
  }
  sendError(res, 500, 'internal_error', 'Zotero 文献工作台后端发生内部错误。')
}

// ---------------------------------------------------------------------------
// 请求解析 / Host 校验
// ---------------------------------------------------------------------------

function requestUrl(req) {
  const raw = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
  try {
    return new URL(raw, 'http://127.0.0.1')
  } catch {
    throw new HttpError(400, 'invalid_request', '无法解析请求 URL。')
  }
}

/** 把 URL.hostname / Host 头统一成裸小写主机名（IPv6 去方括号）。 */
function normalizeHostname(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
}

/**
 * 解析 Host 头（RFC 7230 authority）。返回 { hostname, port } 或 null。
 * 空端口用 '' 表示；IPv6 必须使用方括号形式（浏览器/Node 都会这样发）。
 */
function parseHostHeader(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  if (raw === '') return null
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end === -1) return null
    const hostname = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (rest === '') return { hostname, port: '' }
    if (!rest.startsWith(':')) return null
    return { hostname, port: rest.slice(1) }
  }
  const colon = raw.lastIndexOf(':')
  if (colon === -1) return { hostname: raw, port: '' }
  const hostname = raw.slice(0, colon)
  const port = raw.slice(colon + 1)
  if (hostname === '') return null
  return { hostname, port }
}

/**
 * 创建 Host 白名单校验器：DSH 的 webServer 只绑定端口，DNS rebinding 防护必须由
 * 插件自己按 Host 头做。允许：getOrigin() 给出的 host:port、127.0.0.1:port、
 * localhost:port、[::1]:port（port 取 getOrigin 的端口）。
 */
function createHostChecker(ctx) {
  const allowedHostnames = new Set(['127.0.0.1', 'localhost', '::1'])
  let expectedPort = null
  let defaultPort = null
  let originResolved = false

  const refreshOrigin = () => {
    if (originResolved) return
    let origin = null
    try {
      const value = ctx?.webServer?.getOrigin?.()
      if (typeof value === 'string' && value !== '') origin = value
    } catch {
      // 监听尚未就绪时 getOrigin 会抛错；下次请求再试。
      return
    }
    if (origin === null) return
    originResolved = true
    try {
      const url = new URL(origin)
      allowedHostnames.add(normalizeHostname(url.hostname))
      defaultPort = url.protocol === 'https:' ? '443' : '80'
      expectedPort = url.port || defaultPort
    } catch {
      // origin 不是合法 URL：只保留本机回环白名单，并接受任意端口（退化模式）。
    }
  }

  return function checkHost(req, res) {
    refreshOrigin()
    const authority = parseHostHeader(req.headers?.host)
    const hostOk = authority !== null && allowedHostnames.has(authority.hostname)
    // 浏览器在默认端口（http:80 / https:443）时会省略 Host 里的端口。
    const portOk =
      expectedPort === null ||
      expectedPort === authority?.port ||
      (authority?.port === '' && expectedPort === defaultPort)
    if (!hostOk || !portOk) {
      sendError(res, 403, 'forbidden_host', '仅允许通过本机 DeepSeek Harness 界面访问 Zotero 文献工作台。')
      return false
    }
    return true
  }
}

/**
 * 拒绝请求目标里的上级目录段（`..`、`%2e%2e`、`.%2e` 等）。
 *
 * DSH 的 webServer 在匹配路由前会先用 WHATWG URL 规范化 pathname（`..` 被折叠），
 * 但 handler 收到的 req.url 仍是客户端发来的原始值。若不在这里拦截，
 * `/zotero-workbench/app/../api/health` 这类请求会被折叠成 `/api/health` 后
 * 命中另一个合法路由。正常浏览器发出的路径不会包含这些段；出现即视为攻击/误用。
 *
 * 只检查 path 部分（`?` 之前），query 里的百分号编码不参与判断。
 */
function hasForbiddenParentSegments(req) {
  const raw = typeof req?.url === 'string' && req.url !== '' ? req.url : '/'
  const queryIndex = raw.indexOf('?')
  const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex)
  for (const segment of rawPath.split('/')) {
    if (segment === '') continue
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    // 特殊 URL 里反斜杠等同分隔符；NUL 一律非法。
    if (decoded.includes('\\') || decoded.includes('\0')) return true
    // decode 后含编码过的 `/`（%2f）时，拆开再判断是否出现上级目录段。
    for (const part of decoded.split('/')) {
      if (part === '.' || part === '..') return true
    }
  }
  return false
}

/**
 * 浏览器信任围栏：照 dsh-better-sidebar 的 /sidebar/* 写法
 * （`ctx.connection.requestRejection(req) === undefined`）。
 * 返回 403 表示 Host/Origin 不受信，401 表示没有已认证的浏览器 Peer；
 * 两者都按拒绝处理。没有 connection 服务（mock / 极端裁剪环境）时放行。
 */
function createRequestFence(ctx) {
  let connection = null
  try {
    connection = ctx.connection ?? null
  } catch {
    connection = null
  }
  const resolve = () => {
    if (connection !== null) return connection
    try {
      connection = ctx.connection ?? null
    } catch {
      connection = null
    }
    if (connection === null && typeof ctx.get === 'function') {
      try {
        connection = ctx.get('connection') ?? null
      } catch {
        connection = null
      }
    }
    return connection
  }
  return (request) => {
    const service = resolve()
    if (service === null || typeof service.requestRejection !== 'function') return true
    try {
      return service.requestRejection(request) === undefined
    } catch {
      // 围栏自身异常时按拒绝处理（fail closed）。
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Zotero 本地 API 客户端（只读）
// ---------------------------------------------------------------------------

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, '')
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function collectStorageRoots(extra) {
  const roots = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed === '') return
    roots.add(resolve(expandHome(trimmed)))
  }
  push(process.env.ZOTERO_STORAGE_DIR)
  if (process.env.ZOTERO_DATA_DIR) push(join(resolve(expandHome(process.env.ZOTERO_DATA_DIR)), 'storage'))
  push(join(homedir(), 'Zotero', 'storage'))
  if (Array.isArray(extra)) {
    for (const entry of extra) push(entry)
  } else if (typeof extra === 'string') {
    for (const entry of extra.split(delimiter)) push(entry)
  }
  return [...roots]
}

function normalizeOptions(config) {
  const source = config && typeof config === 'object' ? config : {}
  const zoteroUrl = normalizeBaseUrl(
    (typeof source.zoteroUrl === 'string' && source.zoteroUrl) ||
      process.env.ZOTERO_URL ||
      process.env.ZOTERO_BASE_URL ||
      DEFAULT_ZOTERO_URL,
  )
  const configuredTimeout = Number(source.fetchTimeoutMs ?? process.env.ZOTERO_WORKBENCH_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(Math.max(configuredTimeout, 1_000), 120_000)
    : DEFAULT_TIMEOUT_MS
  return {
    zoteroUrl,
    timeoutMs,
    storageRoots: collectStorageRoots(source.storageRoots ?? process.env.ZOTERO_WORKBENCH_STORAGE_ROOTS),
  }
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const PLUGIN_VERSION = readPluginVersion()

function isTimeoutError(error) {
  return (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    error?.cause?.name === 'TimeoutError'
  )
}

/** 带 10s 超时的只读 GET；请求失败统一转成 5xx 的 HttpError。 */
async function zoteroRequest(state, apiPath, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? state.timeoutMs, state.timeoutMs)
  const allowStatus = Array.isArray(options.allowStatus) ? options.allowStatus : []
  const url = /^https?:\/\//i.test(apiPath) ? apiPath : `${state.zoteroUrl}${apiPath}`

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'Zotero-API-Version': '3', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new HttpError(
        504,
        'zotero_timeout',
        `读取 Zotero 本地 API 超时（${Math.round(timeoutMs / 1_000)} 秒）。`,
      )
    }
    throw new HttpError(
      503,
      'zotero_unreachable',
      `无法连接 Zotero 本地 API（${state.zoteroUrl}）；请确认 Zotero 已启动并已开启本地 API。`,
    )
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    throw new HttpError(503, 'zotero_unreachable', '读取 Zotero 响应失败。')
  }
  if (text.length > MAX_JSON_BYTES) {
    throw new HttpError(502, 'zotero_response_too_large', 'Zotero 返回的响应体过大，已拒绝处理。')
  }
  if (response.status === 403 && /local api is not enabled/i.test(text)) {
    throw new HttpError(
      503,
      'zotero_local_api_disabled',
      'Zotero 本地 API 未开启：请在 Zotero 设置 → 高级 中勾选「允许其他应用与 Zotero 通信」。',
    )
  }

  const allowed = allowStatus.includes(response.status)
  if (!response.ok && !allowed) {
    if (response.status === 404) throw new HttpError(404, 'not_found', 'Zotero 中找不到对应数据。')
    throw new HttpError(502, 'zotero_error', `Zotero 本地 API 返回 HTTP ${response.status}。`)
  }

  let json = null
  const contentType = response.headers.get('content-type') ?? ''
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (json === null && response.ok && contentType.includes('json') && !allowed) {
    throw new HttpError(502, 'zotero_error', 'Zotero 返回了无法解析的 JSON 响应。')
  }

  return { status: response.status, headers: response.headers, text, json }
}

/** 探测 Zotero 是否可达；永远不抛错，供 /api/health 使用。 */
async function probeZotero(state) {
  const timeoutMs = Math.min(HEALTH_TIMEOUT_MS, state.timeoutMs)
  try {
    const response = await fetch(`${state.zoteroUrl}/api/`, {
      method: 'GET',
      headers: { 'Zotero-API-Version': '3' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const version = response.headers.get('x-zotero-version') || null
    if (response.status === 403) {
      const text = await response.text().catch(() => '')
      if (/local api is not enabled/i.test(text)) {
        return {
          reachable: false,
          version,
          code: 'zotero_local_api_disabled',
          message: 'Zotero 本地 API 未开启（设置 → 高级 → 允许其他应用与 Zotero 通信）。',
        }
      }
      return { reachable: false, version, code: 'zotero_forbidden', message: 'Zotero 本地 API 拒绝了请求。' }
    }
    if (response.status === 404) {
      return {
        reachable: false,
        version,
        code: 'zotero_api_missing',
        message: '该 Zotero 版本没有本地 API（需要 Zotero 7 或更新版本）。',
      }
    }
    if (!response.ok) {
      return {
        reachable: false,
        version,
        code: 'zotero_error',
        message: `Zotero 本地 API 返回 HTTP ${response.status}。`,
      }
    }
    return { reachable: true, version }
  } catch (error) {
    return {
      reachable: false,
      version: null,
      code: isTimeoutError(error) ? 'zotero_timeout' : 'zotero_unreachable',
      message: isTimeoutError(error)
        ? '连接 Zotero 本地 API 超时。'
        : `无法连接 Zotero 本地 API（${state.zoteroUrl}）。`,
    }
  }
}

// ---------------------------------------------------------------------------
// Zotero 数据归一化
// ---------------------------------------------------------------------------

function creatorName(creator) {
  if (!creator || typeof creator !== 'object') return ''
  if (typeof creator.name === 'string' && creator.name.trim() !== '') return creator.name.trim()
  return [creator.firstName, creator.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ')
}

function yearOf(raw) {
  const parsedDate = typeof raw?.meta?.parsedDate === 'string' ? raw.meta.parsedDate : ''
  const fromParsed = /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(parsedDate)
  if (fromParsed) return fromParsed[1]
  const date = typeof raw?.data?.date === 'string' ? raw.data.date : ''
  const fromDate = /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(date)
  return fromDate ? fromDate[1] : ''
}

function tagList(rawTags) {
  if (!Array.isArray(rawTags)) return []
  return rawTags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.tag))
    .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
    .map((tag) => tag.trim())
}

/** 从条目 links.attachment（Zotero 给的首选附件）推断 PDF。 */
function pdfOf(raw) {
  const data = raw?.data ?? {}
  if (data.itemType === 'attachment') {
    return data.contentType === 'application/pdf' && data.linkMode !== 'linked_url'
      ? { key: String(raw.key) }
      : null
  }
  const attachment = raw?.links?.attachment
  if (!attachment || attachment.attachmentType !== 'application/pdf') return null
  const href = typeof attachment.href === 'string' ? attachment.href : ''
  const key = href.split('/').filter(Boolean).pop()
  if (!key) return null
  return typeof attachment.attachmentSize === 'number'
    ? { key, size: attachment.attachmentSize }
    : { key }
}

function summarizeItem(raw) {
  const data = raw?.data ?? {}
  const creators = Array.isArray(data.creators) ? data.creators : []
  const authors = creators
    .filter((creator) => creator && creator.creatorType === 'author')
    .map(creatorName)
    .filter(Boolean)
  const fallbackAuthors = authors.length > 0 ? authors : creators.map(creatorName).filter(Boolean)
  const title =
    typeof data.title === 'string' && data.title.trim() !== ''
      ? data.title.trim()
      : typeof data.filename === 'string' && data.filename.trim() !== ''
        ? data.filename.trim()
        : '(无标题)'
  const pdf = pdfOf(raw)
  return {
    key: raw?.key ?? String(data.key ?? ''),
    version: Number.isInteger(raw?.version) ? raw.version : null,
    itemType: String(data.itemType ?? ''),
    title,
    publicationTitle:
      typeof data.publicationTitle === 'string' && data.publicationTitle.trim() !== ''
        ? data.publicationTitle.trim()
        : typeof data.proceedingsTitle === 'string' && data.proceedingsTitle.trim() !== ''
          ? data.proceedingsTitle.trim()
          : '',
    creators: { authors: fallbackAuthors, year: yearOf(raw) },
    creatorSummary:
      typeof raw?.meta?.creatorSummary === 'string' ? raw.meta.creatorSummary : fallbackAuthors.join(', '),
    date: typeof data.date === 'string' ? data.date : '',
    dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : '',
    dateModified: typeof data.dateModified === 'string' ? data.dateModified : '',
    collectionKeys: Array.isArray(data.collections) ? data.collections.slice() : [],
    tags: tagList(data.tags),
    journalLevels: journalLevelsForItem(raw).levels,
    pdf,
    hasPdf: pdf !== null,
    numChildren: Number.isInteger(raw?.meta?.numChildren) ? raw.meta.numChildren : 0,
  }
}

function attachmentInfo(raw) {
  const data = raw?.data ?? {}
  const contentType = String(data.contentType ?? '')
  const linkMode = String(data.linkMode ?? '')
  const filename = typeof data.filename === 'string' ? data.filename : ''
  let path = null
  const enclosure = raw?.links?.enclosure
  if (typeof enclosure?.href === 'string' && enclosure.href.startsWith('file:')) {
    try {
      path = fileURLToPath(enclosure.href)
    } catch {
      path = null
    }
  }
  if (path === null && typeof data.path === 'string' && data.path !== '') path = data.path
  const enclosureLength = Number(enclosure?.length)
  return {
    key: String(raw?.key ?? data.key ?? ''),
    title: String(data.title || filename || '附件'),
    filename,
    contentType,
    linkMode,
    size: Number.isFinite(enclosureLength) && enclosureLength > 0 ? enclosureLength : null,
    isPdf: contentType === 'application/pdf' && linkMode !== 'linked_url',
    path,
    parent: typeof data.parentItem === 'string' ? data.parentItem : null,
  }
}

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function noteInfo(raw) {
  const data = raw?.data ?? {}
  const html = typeof data.note === 'string' ? data.note : ''
  return {
    key: String(raw?.key ?? ''),
    html: html.length > MAX_NOTE_HTML ? html.slice(0, MAX_NOTE_HTML) : html,
    excerpt: htmlToText(html).slice(0, 400),
    dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : '',
    dateModified: typeof data.dateModified === 'string' ? data.dateModified : '',
    tags: tagList(data.tags),
  }
}

/** 解析 annotation 子项；annotationPosition 是 JSON 字符串，坏数据按 0 处理。 */
function parseAnnotation(raw, attachmentKey) {
  const data = raw?.data ?? {}
  let position = null
  if (typeof data.annotationPosition === 'string' && data.annotationPosition !== '') {
    try {
      position = JSON.parse(data.annotationPosition)
    } catch {
      position = null
    }
  }
  const rawPageIndex = position && typeof position === 'object' ? position.pageIndex : undefined
  const pageIndex = Number.isInteger(rawPageIndex) && rawPageIndex >= 0 ? rawPageIndex : 0
  const rects =
    position && Array.isArray(position.rects)
      ? position.rects.filter((rect) => Array.isArray(rect) && rect.length === 4).slice(0, 200)
      : []
  const pageLabel =
    typeof data.annotationPageLabel === 'string' && data.annotationPageLabel !== ''
      ? data.annotationPageLabel
      : String(pageIndex + 1)
  return {
    key: String(raw?.key ?? ''),
    parentAttachment:
      attachmentKey ?? (typeof data.parentItem === 'string' ? data.parentItem : null),
    type: String(data.annotationType ?? 'highlight'),
    text: String(data.annotationText ?? ''),
    comment: String(data.annotationComment ?? ''),
    color: String(data.annotationColor ?? '#ffd400'),
    pageLabel,
    pageIndex,
    rects,
    sortIndex: String(data.annotationSortIndex ?? ''),
    tags: tagList(data.tags),
    dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : '',
    dateModified: typeof data.dateModified === 'string' ? data.dateModified : '',
  }
}

function librarySummary(collectionsRaw, groupsRaw) {
  const userLibrary = Array.isArray(collectionsRaw)
    ? collectionsRaw.find((raw) => raw?.library?.type === 'user')?.library ?? null
    : null
  const libraries = [
    {
      id: 'user',
      type: 'user',
      name: typeof userLibrary?.name === 'string' ? userLibrary.name : '我的文库',
      userId: Number.isInteger(userLibrary?.id) ? userLibrary.id : null,
      supported: true,
    },
  ]
  if (Array.isArray(groupsRaw)) {
    for (const group of groupsRaw) {
      const id = group?.id ?? group?.data?.id
      if (id === undefined || id === null) continue
      libraries.push({
        id: `g${id}`,
        type: 'group',
        name: String(group?.data?.name ?? `群组 ${id}`),
        userId: Number(id),
        supported: false,
        reason: '组库（group library）在本版本暂不支持，使用 library=user。',
      })
    }
  }
  return libraries
}

function normalizeCollections(collectionsRaw) {
  const nodes = []
  for (const raw of Array.isArray(collectionsRaw) ? collectionsRaw : []) {
    const data = raw?.data ?? {}
    const key = String(raw?.key ?? data.key ?? '')
    if (!key) continue
    const itemCount = Number(raw?.meta?.numItems)
    const numCollections = Number(raw?.meta?.numCollections)
    nodes.push({
      key,
      name: String(data.name ?? key),
      parentCollection:
        typeof data.parentCollection === 'string' && data.parentCollection !== ''
          ? data.parentCollection
          : null,
      itemCount: Number.isFinite(itemCount) ? itemCount : 0,
      numCollections: Number.isFinite(numCollections) ? numCollections : 0,
      depth: 0,
    })
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  for (const node of nodes) {
    let depth = 0
    let cursor = node.parentCollection
    const seen = new Set([node.key])
    while (cursor && byKey.has(cursor) && depth < 64 && !seen.has(cursor)) {
      seen.add(cursor)
      depth += 1
      cursor = byKey.get(cursor).parentCollection
    }
    node.depth = depth
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
  return nodes
}

function normalizeSavedSearches(searchesRaw) {
  return (Array.isArray(searchesRaw) ? searchesRaw : [])
    .map((raw) => ({ key: String(raw?.key ?? ''), name: String(raw?.data?.name ?? '') }))
    .filter((search) => search.key !== '')
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 文库结构（集合 + 保存的检索 + 库列表），带 10s 内存缓存。 */
async function loadLibrary(state) {
  const fresh = state.libraryCache
  if (fresh && Date.now() - fresh.at < state.libraryTtlMs) return fresh.value
  if (state.libraryPromise) return state.libraryPromise
  state.libraryPromise = (async () => {
    const [collectionsResponse, searchesResponse, groupsResponse] = await Promise.all([
      zoteroRequest(state, `${ZOTERO_LIBRARY}/collections`),
      zoteroRequest(state, `${ZOTERO_LIBRARY}/searches`),
      zoteroRequest(state, `${ZOTERO_LIBRARY}/groups`).catch(() => null),
    ])
    const collectionsRaw = Array.isArray(collectionsResponse.json) ? collectionsResponse.json : []
    const searchesRaw = Array.isArray(searchesResponse.json) ? searchesResponse.json : []
    const groupsRaw = Array.isArray(groupsResponse?.json) ? groupsResponse.json : []
    const version = Number(collectionsResponse.headers.get('last-modified-version'))
    return {
      libraries: librarySummary(collectionsRaw, groupsRaw),
      collections: normalizeCollections(collectionsRaw),
      savedSearches: normalizeSavedSearches(searchesRaw),
      version: Number.isFinite(version) && version > 0 ? version : null,
    }
  })()
    .then((value) => {
      state.libraryCache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      state.libraryPromise = null
    })
  return state.libraryPromise
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

function clampInt(raw, fallback, min, max) {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function trimTo(value, maxLength) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

/** MVP 只支持个人文库；组库显式 501，未知库 400。 */
function resolveLibrarySlug(url) {
  const raw = (url.searchParams.get('library') ?? 'user').trim()
  const value = raw === '' ? 'user' : raw
  if (value === 'user' || value === '0' || value === 'users/0') return 'user'
  if (/^g\d{1,12}$/i.test(value) || /^\d{1,12}$/.test(value)) {
    throw new HttpError(
      501,
      'library_not_supported',
      '组库/数字库 ID 在本版本暂不支持，请使用 library=user。',
    )
  }
  throw new HttpError(400, 'invalid_library', `无法识别的 library 参数：${value}`)
}

function requireItemKey(url) {
  const raw = (url.searchParams.get('key') ?? '').trim()
  if (!KEY_PATTERN.test(raw)) {
    throw new HttpError(400, 'invalid_key', '缺少或非法的 key 参数（Zotero 条目 key 为 8 位字母数字）。')
  }
  return raw.toUpperCase()
}

// ---------------------------------------------------------------------------
// PDF 文件定位与安全校验
// ---------------------------------------------------------------------------

async function allowedStorageRoots(state) {
  if (!state.storageRootsPromise) {
    state.storageRootsPromise = (async () => {
      const resolvedRoots = []
      for (const root of state.storageRoots) {
        try {
          resolvedRoots.push(await realpath(root))
        } catch {
          // 不存在的候选根目录（例如用户没有配置自定义数据目录）直接跳过。
        }
      }
      return resolvedRoots
    })()
  }
  return state.storageRootsPromise
}

/** 条目 key → PDF 附件 JSON（条目本身是 PDF 附件时直接用；否则取首个 PDF 子附件）。 */
async function resolvePdfAttachment(state, key) {
  const itemResponse = await zoteroRequest(state, `${ZOTERO_LIBRARY}/items/${encodeURIComponent(key)}`)
  const item = itemResponse.json
  if (!item || typeof item !== 'object') {
    throw new HttpError(502, 'zotero_error', 'Zotero 返回了空的条目数据。')
  }
  const data = item.data ?? {}
  if (data.itemType === 'attachment') {
    if (data.contentType !== 'application/pdf' || data.linkMode === 'linked_url') {
      throw new HttpError(415, 'not_pdf', '该附件不是可读取的 PDF。')
    }
    return item
  }
  if (data.itemType === 'note' || data.itemType === 'annotation') {
    throw new HttpError(415, 'not_pdf', `条目 ${key} 是 ${data.itemType}，没有 PDF。`)
  }
  const childrenResponse = await zoteroRequest(
    state,
    `${ZOTERO_LIBRARY}/items/${encodeURIComponent(key)}/children`,
  )
  const children = Array.isArray(childrenResponse.json) ? childrenResponse.json : []
  const pdfs = children.filter(
    (child) =>
      child?.data?.itemType === 'attachment' &&
      child.data.contentType === 'application/pdf' &&
      child.data.linkMode !== 'linked_url',
  )
  if (pdfs.length === 0) {
    throw new HttpError(404, 'pdf_not_found', '该条目没有可读取的 PDF 附件。')
  }
  const preferredKey =
    typeof item?.links?.attachment?.href === 'string'
      ? item.links.attachment.href.split('/').filter(Boolean).pop()
      : null
  return pdfs.find((child) => child.key === preferredKey) ?? pdfs[0]
}

/** 附件 JSON → 本机文件路径。只信任 Zotero 给出的 enclosure / file/view/url。 */
async function resolveEnclosurePath(state, attachment) {
  const attachmentKey = String(attachment?.key ?? '')
  let href = typeof attachment?.links?.enclosure?.href === 'string' ? attachment.links.enclosure.href : ''
  if (href === '') {
    const fallback = await zoteroRequest(
      state,
      `${ZOTERO_LIBRARY}/items/${encodeURIComponent(attachmentKey)}/file/view/url`,
      { allowStatus: [400] },
    )
    if (fallback.status === 400) {
      throw new HttpError(404, 'pdf_not_found', '该附件没有本地文件（可能是链接型附件）。')
    }
    href = fallback.text.trim()
  }
  if (!href.startsWith('file:')) {
    throw new HttpError(404, 'pdf_not_found', '该附件没有本地文件路径。')
  }
  try {
    return fileURLToPath(href)
  } catch {
    throw new HttpError(400, 'invalid_path', 'Zotero 返回的文件路径无法解析。')
  }
}

/**
 * 校验文件真实路径位于允许的 Zotero storage 根目录内（realpath 后再比较前缀，
 * 因此符号链接逃逸也会被拒绝）。返回 { path, size, mtime }。
 */
async function assertStorageFile(state, filePath) {
  const roots = await allowedStorageRoots(state)
  if (roots.length === 0) {
    throw new HttpError(
      403,
      'path_not_allowed',
      '无法确认 Zotero storage 目录，已拒绝读取该文件；可通过 ZOTERO_STORAGE_DIR 或插件 config.storageRoots 配置。',
    )
  }
  let resolvedPath
  try {
    resolvedPath = await realpath(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'pdf_file_missing', 'PDF 文件在磁盘上不存在。')
    throw new HttpError(500, 'internal_error', '解析 PDF 文件路径失败。')
  }
  const inside = roots.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root.endsWith(sep) ? root : root + sep),
  )
  if (!inside) {
    throw new HttpError(
      403,
      'path_not_allowed',
      'PDF 文件不在 Zotero storage 目录内，已拒绝读取。',
    )
  }
  let info
  try {
    info = await stat(resolvedPath)
  } catch {
    throw new HttpError(404, 'pdf_file_missing', '无法读取 PDF 文件。')
  }
  if (!info.isFile()) throw new HttpError(404, 'pdf_file_missing', 'PDF 路径不是普通文件。')
  return { path: resolvedPath, size: info.size, mtime: info.mtime }
}

/** 文件头校验：前 1 KiB 内必须出现 `%PDF-`（PDF 规范允许头部前有少量垃圾字节）。 */
async function verifyPdfMagic(filePath) {
  let handle = null
  try {
    handle = await open(filePath, 'r')
  } catch {
    throw new HttpError(404, 'pdf_file_missing', '无法打开 PDF 文件。')
  }
  try {
    const buffer = Buffer.alloc(PDF_HEADER_PROBE)
    const { bytesRead } = await handle.read(buffer, 0, PDF_HEADER_PROBE, 0)
    if (bytesRead <= 0 || buffer.subarray(0, bytesRead).indexOf('%PDF-') === -1) {
      throw new HttpError(415, 'not_pdf', '文件内容不是 PDF。')
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 解析单段 Range；非法返回 {invalid:true}，无 Range 返回 null。 */
function parseRangeHeader(value, size) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return { invalid: true }
  const startText = match[1]
  const endText = match[2]
  if (startText === '' && endText === '') return { invalid: true }
  let start
  let end
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { invalid: true }
  if (start < 0 || start >= size || end < start) return { invalid: true }
  return { start, end: Math.min(end, size - 1) }
}

function contentDispositionFor(attachment) {
  const raw = attachment?.data?.filename
  const filename = typeof raw === 'string' && raw !== '' ? raw : 'document.pdf'
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  let encoded = ''
  try {
    encoded = encodeURIComponent(filename)
  } catch {
    encoded = 'document.pdf'
  }
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------

function mimeFor(filePath) {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * 把 `/app/...` 里的相对路径解码、拒绝穿越。返回 '' 或规范的相对路径。
 * 失败的路径抛 400/403。
 */
function decodeStaticRelative(relative) {
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    throw new HttpError(400, 'invalid_path', '静态资源路径编码无效。')
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new HttpError(403, 'path_not_allowed', '静态资源路径非法。')
  }
  if (decoded === '') return ''
  for (const segment of decoded.split('/')) {
    if (segment === '..' || segment === '.') {
      throw new HttpError(403, 'path_not_allowed', '静态资源路径不允许包含上级目录。')
    }
  }
  const normalized = normalize(decoded).replace(/^[/\\]+/, '')
  if (normalized === '.' || normalized === '') return ''
  if (
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    isAbsolute(normalized) ||
    normalized.includes('\0')
  ) {
    throw new HttpError(403, 'path_not_allowed', '静态资源路径非法。')
  }
  return normalized
}

/** 解析 root 下的文件并做 realpath 前缀校验（防符号链接逃逸）。 */
async function resolveInsideRoot(rootDir, relativePath) {
  const base = resolve(rootDir)
  const candidate = resolve(base, relativePath)
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new HttpError(403, 'path_not_allowed', '静态资源路径越界。')
  }
  let realBase
  try {
    realBase = await realpath(base)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new HttpError(404, 'not_found', '静态资源目录不存在。')
    }
    throw new HttpError(500, 'internal_error', '读取静态资源目录失败。')
  }
  let realFile
  try {
    realFile = await realpath(candidate)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new HttpError(404, 'not_found', '静态文件不存在。')
    }
    throw new HttpError(500, 'internal_error', '读取静态文件失败。')
  }
  if (realFile !== realBase && !realFile.startsWith(`${realBase}${sep}`)) {
    throw new HttpError(403, 'path_not_allowed', '静态资源路径越界。')
  }
  return realFile
}

function isFresh(req, etag) {
  const header = req.headers?.['if-none-match']
  if (typeof header !== 'string' || header === '') return false
  return header.split(',').some((token) => {
    const value = token.trim()
    return value === '*' || value === etag
  })
}

async function sendStaticFile(req, res, filePath, options = {}) {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'not_found', '静态文件不存在。')
    throw new HttpError(500, 'internal_error', '读取静态文件失败。')
  }
  if (!info.isFile()) throw new HttpError(404, 'not_found', '静态文件不存在。')
  if (info.size > MAX_STATIC_BYTES) {
    throw new HttpError(413, 'file_too_large', '静态文件过大，拒绝返回。')
  }
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const cacheControl = options.cacheControl ?? 'no-cache'
  if ((req.method === 'GET' || req.method === 'HEAD') && isFresh(req, etag)) {
    res.writeHead(304, { etag, 'cache-control': cacheControl })
    res.end()
    return
  }
  const headers = {
    'content-type': mimeFor(filePath),
    'content-length': String(info.size),
    'cache-control': cacheControl,
    etag,
    'last-modified': info.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {
      // 响应已断开。
    }
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/**
 * 取 prefix 之后的子路径（以 '/' 开头）。
 *
 * 必须先断言 pathname 确实落在该 prefix 下，再取子路径：WHATWG URL 在解析时
 * 已经折叠过 `..` / `%2e%2e`，若省略这一步，越界请求折叠后算出的子路径可能是
 * 空串，最终意外命中 index.html 返回 200（而不是 404/403）。
 * 属于该 prefix 时返回 '/' 或 '/xxx'；不属于时返回 null（调用方直接 404）。
 */
function subPath(pathname, prefix) {
  if (pathname === prefix) return '/'
  if (!pathname.startsWith(`${prefix}/`)) return null
  return pathname.slice(prefix.length)
}

async function serveAppStatic(state, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res, ['GET', 'HEAD'])
    return
  }
  const url = requestUrl(req)
  // 先校验前缀命中，再取子路径；不命中一律 404，绝不把规范化后的空子路径当 index.html。
  const relative = subPath(url.pathname, APP_PATH)
  if (relative === null) throw new HttpError(404, 'not_found', '未知路径：不在 /zotero-workbench/app 之下。')
  const decoded = decodeStaticRelative(relative)
  const target = decoded === '' || decoded.endsWith('/') ? `${decoded}index.html` : decoded
  const filePath = await resolveInsideRoot(state.appDir, target)
  await sendStaticFile(req, res, filePath, { cacheControl: 'no-cache' })
}

async function servePdfjsStatic(state, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res, ['GET', 'HEAD'])
    return
  }
  const url = requestUrl(req)
  // 同 /app：先断言前缀命中，再取子路径；不命中直接 404。
  const relative = subPath(url.pathname, PDFJS_PATH)
  if (relative === null) throw new HttpError(404, 'not_found', '未知路径：不在 /zotero-workbench/pdfjs 之下。')
  const decoded = decodeStaticRelative(relative)
  if (decoded === '') throw new HttpError(404, 'not_found', '请指定 PDF.js 资源路径。')
  const filePath = await resolveInsideRoot(state.pdfjsDir, decoded)
  await sendStaticFile(req, res, filePath, { cacheControl: 'public, max-age=86400' })
}

// ---------------------------------------------------------------------------
// 引用与导出（BibTeX / BibLaTeX / RIS / CSL-JSON / APA 近似文本，纯 Node 标准库）
// ---------------------------------------------------------------------------

const BIBTEX_TYPES = new Map([
  ['journalArticle', 'article'],
  ['magazineArticle', 'article'],
  ['newspaperArticle', 'article'],
  ['book', 'book'],
  ['bookSection', 'incollection'],
  ['conferencePaper', 'inproceedings'],
  ['thesis', 'phdthesis'],
  ['report', 'techreport'],
  ['manuscript', 'unpublished'],
  ['preprint', 'misc'],
  ['webpage', 'misc'],
])
const BIBLATEX_TYPES = new Map([
  ['journalArticle', 'article'],
  ['magazineArticle', 'article'],
  ['newspaperArticle', 'article'],
  ['book', 'book'],
  ['bookSection', 'incollection'],
  ['conferencePaper', 'inproceedings'],
  ['thesis', 'thesis'],
  ['report', 'report'],
  ['manuscript', 'unpublished'],
  ['preprint', 'online'],
  ['webpage', 'online'],
])
const RIS_TYPES = new Map([
  ['journalArticle', 'JOUR'],
  ['magazineArticle', 'MGZN'],
  ['newspaperArticle', 'NEWS'],
  ['book', 'BOOK'],
  ['bookSection', 'CHAP'],
  ['conferencePaper', 'CONF'],
  ['thesis', 'THES'],
  ['report', 'RPRT'],
  ['preprint', 'GEN'],
  ['webpage', 'ELEC'],
])
const CSL_TYPES = new Map([
  ['journalArticle', 'article-journal'],
  ['magazineArticle', 'article-magazine'],
  ['newspaperArticle', 'article-newspaper'],
  ['book', 'book'],
  ['bookSection', 'chapter'],
  ['conferencePaper', 'paper-conference'],
  ['thesis', 'thesis'],
  ['report', 'report'],
  ['preprint', 'article'],
  ['webpage', 'webpage'],
  ['manuscript', 'manuscript'],
])

/** 取条目创作者数组（容错）。 */
function listCreators(raw) {
  return Array.isArray(raw?.data?.creators) ? raw.data.creators : []
}

/** 统一创作者姓名：Zotero 对中英文分别用 name 或 firstName/lastName。 */
function creatorParts(creator) {
  if (!creator || typeof creator !== 'object') return null
  const name = typeof creator.name === 'string' ? creator.name.trim() : ''
  const family = typeof creator.lastName === 'string' ? creator.lastName.trim() : ''
  const given = typeof creator.firstName === 'string' ? creator.firstName.trim() : ''
  if (name === '' && family === '' && given === '') return null
  return { name, family, given }
}

function creatorLastName(creator) {
  const parts = creatorParts(creator)
  if (parts === null) return ''
  return parts.family || parts.name || parts.given
}

const BIBTEX_ESCAPE_MAP = new Map([
  ['\\', '\\textbackslash{}'],
  ['{', '\\{'],
  ['}', '\\}'],
  ['%', '\\%'],
  ['&', '\\&'],
  ['#', '\\#'],
  ['_', '\\_'],
  ['$', '\\$'],
  ['~', '\\textasciitilde{}'],
  ['^', '\\textasciicircum{}'],
])

function escapeBibtex(value) {
  return String(value).replace(/[\\{}%&#_$~^]/g, (character) => BIBTEX_ESCAPE_MAP.get(character) ?? character)
}

/** 清理 RIS 字段：RIS 是逐行记录，字段值不能换行。 */
function risValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function bibtexName(creator) {
  const parts = creatorParts(creator)
  if (parts === null) return ''
  if (parts.family !== '') return parts.given !== '' ? `${parts.family}, ${parts.given}` : parts.family
  return parts.name
}

function citationAuthors(raw) {
  const creators = listCreators(raw)
  const authors = creators.filter((creator) => (creator?.creatorType ?? 'author') === 'author')
  return authors.length > 0 ? authors : creators.filter((creator) => creator?.creatorType === 'editor')
}

function bibtexCiteKey(raw) {
  const explicit = typeof raw?.data?.citationKey === 'string' ? raw.data.citationKey.trim() : ''
  const sanitize = (value) => String(value).replace(/[^A-Za-z0-9:_-]/g, '')
  if (explicit !== '') {
    const clean = sanitize(explicit)
    if (clean !== '') return clean
  }
  const first = creatorLastName(listCreators(raw)[0] ?? null) || 'item'
  const year = yearOf(raw) || 'nd'
  return sanitize(`${first}${year}${String(raw?.key ?? '').slice(0, 4)}`) || `item${String(raw?.key ?? '')}`
}

/** BibTeX / BibLaTeX 条目。缺失字段跳过，不抛错。 */
function buildBibEntry(raw, variant) {
  const data = raw?.data ?? {}
  const biblatex = variant === 'biblatex'
  const types = biblatex ? BIBLATEX_TYPES : BIBTEX_TYPES
  let type = types.get(data.itemType) ?? 'misc'
  if (data.itemType === 'thesis' && !biblatex) {
    type = /master/i.test(String(data.thesisType ?? '')) ? 'mastersthesis' : 'phdthesis'
  }
  const creators = listCreators(raw)
  const authors = creators.filter((creator) => (creator?.creatorType ?? 'author') === 'author').map(bibtexName).filter(Boolean)
  const editors = creators.filter((creator) => creator?.creatorType === 'editor').map(bibtexName).filter(Boolean)
  const fields = []
  const add = (name, value) => {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text !== '') fields.push(`  ${name} = {${escapeBibtex(text)}}`)
  }
  if (authors.length > 0) add('author', authors.join(' and '))
  else if (editors.length > 0) add('editor', editors.join(' and '))
  add('title', data.title ?? data.filename ?? '(untitled)')
  const year = yearOf(raw)
  if (biblatex) {
    if (year !== '') add('date', year)
    add('journaltitle', data.publicationTitle)
    add('booktitle', data.bookTitle)
    add('publisher', data.publisher)
    add('institution', data.institution ?? data.university)
    add('school', data.university)
    add('location', data.place)
  } else {
    if (year !== '') add('year', year)
    add('journal', data.publicationTitle)
    add('booktitle', data.bookTitle)
    add('publisher', data.publisher)
    add('institution', data.institution)
    add('school', data.university)
    add('address', data.place)
  }
  add('edition', data.edition)
  add('series', data.series)
  add('volume', data.volume)
  add('number', data.issue)
  add('pages', data.pages)
  add('doi', data.DOI)
  add('url', data.url)
  return `@${type}{${bibtexCiteKey(raw)},\n${fields.join(',\n')}\n}`
}

/** RIS 条目（TY/AU/TI/JO/PY/VL/IS/SP/EP/DO/UR）。 */
function buildRisEntry(raw) {
  const data = raw?.data ?? {}
  const lines = [`TY  - ${RIS_TYPES.get(data.itemType) ?? 'GEN'}`]
  for (const creator of citationAuthors(raw)) {
    const parts = creatorParts(creator)
    if (parts === null) continue
    const name = parts.family !== ''
      ? (parts.given !== '' ? `${parts.family}, ${parts.given}` : parts.family)
      : parts.name
    if (name !== '') lines.push(`AU  - ${risValue(name)}`)
  }
  const title = risValue(data.title ?? data.filename)
  if (title !== '') lines.push(`TI  - ${title}`)
  const journal = risValue(data.publicationTitle)
  if (journal !== '') lines.push(`JO  - ${journal}`)
  const booktitle = risValue(data.bookTitle)
  if (booktitle !== '') lines.push(`T2  - ${booktitle}`)
  const year = yearOf(raw)
  if (year !== '') lines.push(`PY  - ${year}`)
  const volume = risValue(data.volume)
  if (volume !== '') lines.push(`VL  - ${volume}`)
  const issue = risValue(data.issue)
  if (issue !== '') lines.push(`IS  - ${issue}`)
  const pages = risValue(data.pages)
  if (pages !== '') {
    const parts = pages.split(/[-\u2013\u2014]/).map((part) => part.trim()).filter(Boolean)
    if (parts.length > 0) lines.push(`SP  - ${parts[0]}`)
    if (parts.length > 1) lines.push(`EP  - ${parts[parts.length - 1]}`)
  }
  const doi = risValue(data.DOI)
  if (doi !== '') lines.push(`DO  - ${doi}`)
  const url = risValue(data.url)
  if (url !== '') lines.push(`UR  - ${url}`)
  lines.push('ER  - ')
  return lines.join('\n')
}

function cslName(creator) {
  const parts = creatorParts(creator)
  if (parts === null) return null
  if (parts.name !== '') return { literal: parts.name }
  const name = {}
  if (parts.family !== '') name.family = parts.family
  if (parts.given !== '') name.given = parts.given
  return Object.keys(name).length > 0 ? name : null
}

/** CSL-JSON 条目（type/title/author/issued/container-title/volume/issue/page/DOI/URL）。 */
function buildCslJsonEntry(raw) {
  const data = raw?.data ?? {}
  const creators = listCreators(raw)
  const authors = creators.filter((creator) => (creator?.creatorType ?? 'author') === 'author')
  const editors = creators.filter((creator) => creator?.creatorType === 'editor')
  const csl = {
    id: String(raw?.key ?? data.key ?? ''),
    type: CSL_TYPES.get(data.itemType) ?? 'document',
    title: String(data.title ?? data.filename ?? '(untitled)').trim() || '(untitled)',
  }
  const authorNames = (authors.length > 0 ? authors : []).map(cslName).filter(Boolean)
  if (authorNames.length > 0) csl.author = authorNames
  else {
    const editorNames = editors.map(cslName).filter(Boolean)
    if (editorNames.length > 0) csl.editor = editorNames
  }
  const year = yearOf(raw)
  if (year !== '') csl.issued = { 'date-parts': [[Number(year)]] }
  const container = data.publicationTitle || data.bookTitle || data.conferenceName || data.proceedingsTitle
  if (container) csl['container-title'] = String(container)
  const strings = [
    ['volume', data.volume],
    ['issue', data.issue],
    ['page', data.pages],
    ['publisher', data.publisher],
    ['DOI', data.DOI],
    ['URL', data.url],
    ['language', data.language],
  ]
  for (const [field, value] of strings) {
    if (value !== undefined && value !== null && String(value).trim() !== '') csl[field] = String(value).trim()
  }
  return csl
}

function apaAuthorName(creator) {
  const parts = creatorParts(creator)
  if (parts === null) return ''
  if (parts.family === '') return parts.name
  if (parts.given === '') return parts.family
  const initials = parts.given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ')
  return `${parts.family}, ${initials}`
}

/** APA 近似文本：作者. (year). title. journal, volume(issue), pages. https://doi.org/... */
function buildApaEntry(raw) {
  const data = raw?.data ?? {}
  const authors = citationAuthors(raw).map(apaAuthorName).filter(Boolean)
  let authorPart
  if (authors.length === 0) authorPart = 'Anon.'
  else if (authors.length === 1) authorPart = authors[0]
  else if (authors.length <= 20) authorPart = `${authors.slice(0, -1).join(', ')}, & ${authors[authors.length - 1]}`
  else authorPart = `${authors[0]} et al.`
  const year = yearOf(raw) || 'n.d.'
  const title = String(data.title ?? data.filename ?? '(untitled)').trim() || '(untitled)'
  const parts = [`${authorPart} (${year}). ${title}.`]
  const journal = String(data.publicationTitle || data.bookTitle || data.conferenceName || '').trim()
  const volume = String(data.volume ?? '').trim()
  const issue = String(data.issue ?? '').trim()
  const pages = String(data.pages ?? '').trim()
  let source = journal
  if (volume !== '') source += `${source !== '' ? ', ' : ''}${volume}`
  if (issue !== '') source += `(${issue})`
  if (pages !== '') source += `${source !== '' ? ', ' : ''}${pages}`
  if (source !== '') parts.push(`${source}.`)
  const doi = String(data.DOI ?? '').trim()
  if (doi !== '') parts.push(`https://doi.org/${doi}`)
  else if (String(data.url ?? '').trim() !== '') parts.push(String(data.url).trim())
  return parts.join(' ')
}

function buildCitationEntry(raw, format) {
  const data = raw?.data ?? {}
  const entry = { key: String(raw?.key ?? data.key ?? ''), itemType: String(data.itemType ?? '') }
  if (format === 'bibtex') entry.bib = buildBibEntry(raw, 'bibtex')
  else if (format === 'biblatex') entry.bib = buildBibEntry(raw, 'biblatex')
  else if (format === 'ris') entry.ris = buildRisEntry(raw)
  else if (format === 'csljson') entry.csljson = buildCslJsonEntry(raw)
  else entry.citation = buildApaEntry(raw)
  return entry
}

/** 逐个取条目（Zotero 本地 API 的 itemKey 批量过滤会连子项一起返回，不能依赖）。 */
async function fetchItemsByKey(state, keys) {
  const found = new Map()
  const chunkSize = 8
  for (let index = 0; index < keys.length; index += chunkSize) {
    const chunk = keys.slice(index, index + chunkSize)
    const results = await Promise.all(
      chunk.map(async (key) => {
        try {
          const response = await zoteroRequest(state, `${ZOTERO_LIBRARY}/items/${encodeURIComponent(key)}`)
          return { key, raw: response.json }
        } catch (error) {
          return { key, error }
        }
      }),
    )
    for (const result of results) {
      if (result.error !== undefined) {
        if (result.error instanceof HttpError && result.error.status === 404) {
          throw new HttpError(404, 'not_found', `Zotero 中找不到条目 ${result.key}。`)
        }
        throw result.error
      }
      if (!result.raw || typeof result.raw !== 'object') {
        throw new HttpError(502, 'zotero_error', `条目 ${result.key} 的数据为空。`)
      }
      found.set(result.key, result.raw)
    }
  }
  return found
}

/**
 * 引文登记路由用的角标 href 与两种 zotero:// 深链（与 MCP register_citation 返回一致）。
 */
function citationLinksForRecord(record) {
  const id = typeof record?.id === 'string' ? record.id : ''
  const page = Number.isInteger(record?.pageIndex) ? Math.max(1, record.pageIndex + 1) : 1
  const itemKey = typeof record?.itemKey === 'string' ? record.itemKey : ''
  const attachmentKey = typeof record?.attachmentKey === 'string' ? record.attachmentKey : ''
  return {
    href: `https://zotero-wb.invalid/c/${id}`,
    zoteroItemUrl: itemKey === '' ? null : `zotero://select/library/items/${itemKey}`,
    zoteroPdfUrl:
      attachmentKey === ''
        ? null
        : `zotero://open-pdf/library/items/${attachmentKey}?page=${page}`,
  }
}

/** Zotero 主版本 ≥10 才支持本地写入个人高亮（annotation）。 */
function citationWriteCapability(version) {
  const major = Number.parseInt(String(version ?? '').split('.')[0], 10)
  if (Number.isInteger(major) && major >= 10) return { annotations: true }
  return { annotations: false, reason: 'requires-zotero-10' }
}

/** GET /api/citation?id=<12hex>：单条登记记录 + 计算出的链接。 */
async function handleCitation(state, res, url) {
  resolveLibrarySlug(url)
  const id = (url.searchParams.get('id') ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{12}$/.test(id)) {
    throw new HttpError(400, 'invalid_id', 'id 必须是 12 位小写十六进制的 citationId。')
  }
  const record = await getCitation(id)
  if (record === null) {
    throw new HttpError(404, 'not_found', '引文登记不存在（可能已过期或被清理），请重新登记。')
  }
  sendJson(res, 200, { ...record, ...citationLinksForRecord(record) })
}

/** GET /api/citations?itemKey=<8位key>&limit=20：同一文献的多条引文登记（前端做选择器）。 */
async function handleCitationList(state, res, url) {
  resolveLibrarySlug(url)
  const itemKey = (url.searchParams.get('itemKey') ?? '').trim().toUpperCase()
  if (!ZOTERO_KEY_PATTERN.test(itemKey)) {
    throw new HttpError(
      400,
      'invalid_item_key',
      'itemKey 必须是 8 位大写字母数字的 Zotero 条目 key。',
    )
  }
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200)
  const all = await listCitationsByItem(itemKey, 1_000_000)
  const records = all.slice(0, limit).map((record) => ({ ...record, ...citationLinksForRecord(record) }))
  sendJson(res, 200, { itemKey, total: all.length, limit, records })
}

/** POST /api/citation/:id/annotation：Zotero 10 前的占位；绝不绕过写入网关。 */
function handleCitationAnnotation(res, message) {
  sendJson(res, 501, {
    error: {
      code: 'unsupported',
      message: message ?? '需要 Zotero 10 才能在本地写入个人高亮；当前 Zotero 9 不支持。',
    },
  })
}

/** P2.3：兼容旧前端路径 POST /api/citation/annotation（缺少 id）——501 说明，不是 405。 */
const CITATION_ANNOTATION_MISSING_ID_MESSAGE =
  '缺少 citationId，前端应使用 /api/citation/<id>/annotation；Zotero 10 前不可写。'

async function handleCitationExport(state, res, url) {
  resolveLibrarySlug(url)
  const rawKeys = (url.searchParams.get('keys') ?? '').trim()
  if (rawKeys === '') throw new HttpError(400, 'missing_keys', '必须提供 keys 参数（逗号分隔的 Zotero 条目 key）。')
  const keys = rawKeys.split(',').map((key) => key.trim()).filter(Boolean)
  if (keys.length === 0) throw new HttpError(400, 'missing_keys', '必须提供至少一个 Zotero 条目 key。')
  if (keys.length > MAX_CITATION_KEYS) {
    throw new HttpError(400, 'too_many_keys', `一次最多导出 ${MAX_CITATION_KEYS} 个条目。`)
  }
  const normalizedKeys = []
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new HttpError(400, 'invalid_key', `非法的 Zotero 条目 key：${key}`)
    const normalized = key.toUpperCase()
    if (!normalizedKeys.includes(normalized)) normalizedKeys.push(normalized)
  }
  const format = (url.searchParams.get('format') ?? 'text').trim().toLowerCase()
  if (!CITATION_FORMATS.has(format)) {
    throw new HttpError(400, 'invalid_format', `format 只支持 ${[...CITATION_FORMATS].join(' / ')}。`)
  }
  const style = trimTo(url.searchParams.get('style'), 40) || 'apa'
  const locale = trimTo(url.searchParams.get('locale'), 40) || 'zh-CN'
  const rawItems = await fetchItemsByKey(state, normalizedKeys)
  const entries = normalizedKeys.map((key) => buildCitationEntry(rawItems.get(key), format))
  let text
  if (format === 'csljson') text = JSON.stringify(entries.map((entry) => entry.csljson), null, 2)
  else if (format === 'ris') text = entries.map((entry) => entry.ris).join('\n\n')
  else if (format === 'text') text = entries.map((entry) => entry.citation).join('\n')
  else text = entries.map((entry) => entry.bib).join('\n\n')
  sendJson(res, 200, {
    library: 'user',
    format,
    style,
    locale,
    count: entries.length,
    entries,
    text,
  })
}

// ---------------------------------------------------------------------------
// 信息检查（未归类 / 缺 DOI / 缺 PDF）：服务端扫描 + 120 秒缓存
// ---------------------------------------------------------------------------

function maintenanceItem(raw, pdfParents) {
  const data = raw?.data ?? {}
  const summary = summarizeItem(raw)
  return {
    key: summary.key,
    title: summary.title,
    creators: summary.creators,
    itemType: summary.itemType,
    hasPdf: Boolean(summary.pdf) || pdfParents.has(summary.key),
    hasDOI: String(data.DOI ?? '').trim() !== '',
    collectionsCount: summary.collectionKeys.length,
  }
}

/** 分页扫描 top-level 普通条目；最多 MAINTENANCE_SCAN_LIMIT 条，超出时 truncated=true。 */
async function loadTopLevelScan(state) {
  const cached = state.maintenanceCache.get('topItems')
  if (cached !== undefined && Date.now() - cached.at < MAINTENANCE_CACHE_MS) return cached.value
  if (state.topItemsPromise !== null) return state.topItemsPromise
  state.topItemsPromise = (async () => {
    const raws = []
    let start = 0
    let truncated = false
    while (start < MAINTENANCE_SCAN_LIMIT) {
      const limit = Math.min(MAINTENANCE_PAGE_SIZE, MAINTENANCE_SCAN_LIMIT - start)
      const response = await zoteroRequest(
        state,
        `${ZOTERO_LIBRARY}/items/top?limit=${limit}&start=${start}&itemType=-attachment`,
      )
      const page = Array.isArray(response.json) ? response.json : []
      for (const raw of page) {
        const itemType = raw?.data?.itemType
        if (typeof itemType !== 'string' || NON_REGULAR_TYPES.has(itemType)) continue
        raws.push(raw)
      }
      start += page.length
      if (page.length === 0 || page.length < limit) break
      if (start >= MAINTENANCE_SCAN_LIMIT) {
        truncated = true
        break
      }
    }
    return { raws, truncated, scanned: start }
  })()
    .then((value) => {
      state.maintenanceCache.set('topItems', { at: Date.now(), value })
      return value
    })
    .finally(() => {
      state.topItemsPromise = null
    })
  return state.topItemsPromise
}

/** 扫描全部附件，记录「拥有 PDF 附件的父条目 key」集合。 */
async function loadPdfParentScan(state) {
  const cached = state.maintenanceCache.get('pdfParents')
  if (cached !== undefined && Date.now() - cached.at < MAINTENANCE_CACHE_MS) return cached.value
  if (state.pdfParentsPromise !== null) return state.pdfParentsPromise
  state.pdfParentsPromise = (async () => {
    const parents = new Set()
    let start = 0
    let truncated = false
    while (start < MAINTENANCE_SCAN_LIMIT) {
      const limit = Math.min(MAINTENANCE_PAGE_SIZE, MAINTENANCE_SCAN_LIMIT - start)
      const response = await zoteroRequest(
        state,
        `${ZOTERO_LIBRARY}/items?itemType=attachment&limit=${limit}&start=${start}`,
      )
      const page = Array.isArray(response.json) ? response.json : []
      for (const raw of page) {
        const data = raw?.data ?? {}
        const parentKey = typeof data.parentItem === 'string' ? data.parentItem : ''
        if (parentKey === '') continue
        if (String(data.linkMode ?? '') === 'linked_url') continue
        const filename = String(data.filename ?? data.title ?? '')
        if (String(data.contentType ?? '') === 'application/pdf' || /\.pdf$/i.test(filename)) {
          parents.add(parentKey)
        }
      }
      start += page.length
      if (page.length === 0 || page.length < limit) break
      if (start >= MAINTENANCE_SCAN_LIMIT) {
        truncated = true
        break
      }
    }
    return { parents, truncated, scanned: start }
  })()
    .then((value) => {
      state.maintenanceCache.set('pdfParents', { at: Date.now(), value })
      return value
    })
    .finally(() => {
      state.pdfParentsPromise = null
    })
  return state.pdfParentsPromise
}

async function handleCitations(state, res, url) {
  if ((url.searchParams.get('itemKey') ?? '').trim() !== '') {
    return handleCitationList(state, res, url)
  }
  return handleCitationExport(state, res, url)
}

async function handleMaintenance(state, res, url) {
  resolveLibrarySlug(url)
  const view = (url.searchParams.get('view') ?? '').trim()
  if (!MAINTENANCE_VIEWS.has(view)) {
    throw new HttpError(400, 'invalid_view', `view 只支持 ${[...MAINTENANCE_VIEWS].join(' / ')}。`)
  }
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000)
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200)
  if (view === 'duplicates') {
    const version = url.searchParams.get('version') ?? undefined
    if (offset > 0 && !version) throw new HttpError(400, 'missing_version', '继续读取需提供上一页的文库版本。')
    const result = await scanDuplicateCandidates(async path => {
      const r = await zoteroRequest(state, path)
      return { data: r.json, headers: r.headers }
    }, ZOTERO_LIBRARY, { version, maxItems: MAINTENANCE_SCAN_LIMIT }).catch(error => {
      if(error instanceof DuplicateScanError)throw new HttpError(409, 'scan_changed', error.message)
      throw error
    })
    const total = result.items.length, items = result.items.slice(offset, offset + limit)
    return sendJson(res, 200, { ...result, view, total, offset, limit, items,
      nextOffset: offset + items.length < total ? offset + items.length : null })
  }
  const [topScan, pdfScan] = await Promise.all([loadTopLevelScan(state), loadPdfParentScan(state)])
  const filtered = []
  for (const raw of topScan.raws) {
    const item = maintenanceItem(raw, pdfScan.parents)
    if (view === 'unfiled' && item.collectionsCount !== 0) continue
    if (view === 'missingDOI' && item.hasDOI) continue
    if (view === 'missingPDF' && item.hasPdf) continue
    filtered.push(item)
  }
  sendJson(res, 200, {
    view,
    total: filtered.length,
    offset,
    limit,
    items: filtered.slice(offset, offset + limit),
    truncated: topScan.truncated || pdfScan.truncated,
    scanned: { items: topScan.scanned, attachments: pdfScan.scanned },
  })
}

// ---------------------------------------------------------------------------
// 打开 Zotero（zotero:// 深链，只启动客户端，不写 Zotero）
// ---------------------------------------------------------------------------

/**
 * 仅允许构造两种 zotero:// 深链（供测试直接 import 校验）。
 * 非法输入抛 Error（handler 会转成 400 JSON）。
 */
export function buildZoteroUrl(input) {
  const kind = typeof input?.kind === 'string' ? input.kind : ''
  if (kind !== 'item' && kind !== 'pdf') throw new Error('kind 必须是 item 或 pdf。')
  const key = typeof input?.key === 'string' ? input.key.trim() : ''
  if (!ZOTERO_KEY_PATTERN.test(key)) throw new Error('key 必须是 8 位大写字母数字的 Zotero 条目 key。')
  if (kind === 'item') return `zotero://select/library/items/${key}`

  let attachmentKey = key
  const attachmentCandidate = typeof input?.attachmentKey === 'string' ? input.attachmentKey.trim() : ''
  if (attachmentCandidate !== '') {
    if (!ZOTERO_KEY_PATTERN.test(attachmentCandidate)) {
      throw new Error('attachmentKey 必须是 8 位大写字母数字的 Zotero 附件 key。')
    }
    attachmentKey = attachmentCandidate
  }

  let page = 1
  if (input?.page !== undefined && input?.page !== null && String(input.page).trim() !== '') {
    const value = Number(input.page)
    if (!Number.isInteger(value) || value < 1 || value > 100000) {
      throw new Error('page 必须是 1..100000 的整数。')
    }
    page = value
  }

  let annotationKey = ''
  const annotationCandidate = typeof input?.annotationKey === 'string' ? input.annotationKey.trim() : ''
  if (annotationCandidate !== '') {
    if (!ZOTERO_KEY_PATTERN.test(annotationCandidate)) {
      throw new Error('annotationKey 必须是 8 位大写字母数字的 Zotero 批注 key。')
    }
    annotationKey = annotationCandidate
  }

  let url = `zotero://open-pdf/library/items/${attachmentKey}?page=${page}`
  if (annotationKey !== '') url += `&annotation=${annotationKey}`
  return url
}

/** 用 macOS 的 open 命令打开 zotero:// URL；失败 reject（handler 转成 JSON 错误，不向外抛）。 */
function openZoteroUrl(url, timeoutMs = OPEN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('open', [url], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

/** 读取小 JSON 请求体：限长、超时、非法 JSON 都转成 HttpError。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    function onData(chunk) {
      size += chunk.length
      if (size > MAX_OPEN_BODY_BYTES) {
        // 不再累计，直接按 413 结束；保留 socket 让错误响应还能写出。
        finish(new HttpError(413, 'body_too_large', '请求体过大。'))
        return
      }
      chunks.push(chunk)
    }
    function onEnd() {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        finish(null, null)
        return
      }
      try {
        finish(null, JSON.parse(text))
      } catch {
        finish(new HttpError(400, 'invalid_json', '请求体必须是合法 JSON。'))
      }
    }
    function onError() {
      finish(new HttpError(400, 'invalid_request', '读取请求体失败。'))
    }
    const timer = setTimeout(() => finish(new HttpError(408, 'request_timeout', '读取请求体超时。')), 10_000)
    req.on?.('data', onData)
    req.on?.('end', onEnd)
    req.on?.('error', onError)
  })
}

async function handleOpen(_state, req, res) {
  const body = await readJsonBody(req)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_open_request', '请求体必须是 JSON 对象。')
  }
  let url
  try {
    url = buildZoteroUrl(body)
  } catch (error) {
    throw new HttpError(400, 'invalid_open_request', error instanceof Error ? error.message : String(error))
  }
  if (process.env.ZOTERO_WORKBENCH_DSH_OPEN === '0') {
    sendJson(res, 200, { ok: true, url, opened: false })
    return
  }
  try {
    await openZoteroUrl(url)
    sendJson(res, 200, { ok: true, url, opened: true })
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      url,
      error: {
        code: 'open_failed',
        message: `无法调用 macOS open 打开 Zotero：${error instanceof Error ? error.message : String(error)}`,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// API 处理
// ---------------------------------------------------------------------------

async function handleHealth(state, res) {
  const zotero = await probeZotero(state)
  const reachable = zotero.reachable === true
  sendJson(res, 200, {
    ok: reachable,
    name,
    version: PLUGIN_VERSION,
    zotero: {
      reachable,
      baseUrl: state.zoteroUrl,
      ...(zotero.version ? { version: zotero.version } : {}),
      ...(zotero.code ? { code: zotero.code } : {}),
      ...(zotero.message ? { message: zotero.message } : {}),
    },
    library: { id: 'user', type: 'user', supported: true },
    // 本地写入个人高亮的 Capability：Zotero 10 起本地 API 才支持注释写入；9.x 只读。
    writes: citationWriteCapability(zotero.version),
    storage: { configuredRoots: state.storageRoots.length },
    routes: { app: `${APP_PATH}/`, api: API_PATH, pdfjs: `${PDFJS_PATH}/` },
  })
}

async function handleCollections(state, res, url) {
  const library = resolveLibrarySlug(url)
  const document = await loadLibrary(state)
  sendJson(res, 200, {
    library,
    libraryId: 'user',
    userId: document.libraries[0]?.userId ?? null,
    version: document.version,
    libraries: document.libraries,
    collections: document.collections,
    savedSearches: document.savedSearches,
    collectionsCount: document.collections.length,
    savedSearchesCount: document.savedSearches.length,
  })
}

async function handleItems(state, res, url) {
  const library = resolveLibrarySlug(url)
  const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100)
  const start = clampInt(url.searchParams.get('start'), 0, 0, 1_000_000)
  const q = trimTo(url.searchParams.get('q'), 200)
  const tag = trimTo(url.searchParams.get('tag'), 100)
  const mode = (url.searchParams.get('mode') ?? '').trim() === 'everything'
    ? 'everything'
    : 'titleCreatorYear'
  const sortRaw = (url.searchParams.get('sort') ?? '').trim()
  // 排序白名单：白名单外的值回退默认排序（前端不必为此处理错误态），
  // 前端语义排序（year）映射到 Zotero 本地 API 认可的字段（date）。
  const sortRequested = ALLOWED_SORTS.has(sortRaw) ? sortRaw : 'dateModified'
  const sort = SORT_ALIASES.get(sortRequested) ?? sortRequested
  const directionRaw = (url.searchParams.get('direction') ?? '').trim().toLowerCase()
  const direction =
    directionRaw === 'asc' || directionRaw === 'desc'
      ? directionRaw
      : sortRequested === 'title' || sortRequested === 'creator'
        ? 'asc'
        : 'desc'

  const collectionRaw = (url.searchParams.get('collection') ?? '').trim()
  let collection = null
  if (collectionRaw !== '') {
    if (!KEY_PATTERN.test(collectionRaw)) {
      throw new HttpError(400, 'invalid_collection', 'collection 参数必须是 Zotero 集合 key。')
    }
    collection = collectionRaw.toUpperCase()
  }

  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('start', String(start))
  params.set('itemType', '-attachment')
  params.set('sort', sort)
  params.set('direction', direction)
  if (q !== '') {
    params.set('q', q)
    if (mode === 'everything') params.set('qmode', 'everything')
  }
  if (tag !== '') params.set('tag', tag)

  const apiPath = collection
    ? `${ZOTERO_LIBRARY}/collections/${encodeURIComponent(collection)}/items`
    : `${ZOTERO_LIBRARY}/items/top`
  const response = await zoteroRequest(state, `${apiPath}?${params.toString()}`)
  const rawItems = Array.isArray(response.json) ? response.json : []

  const items = []
  for (const raw of rawItems) {
    const itemType = raw?.data?.itemType
    if (typeof itemType !== 'string' || NON_REGULAR_TYPES.has(itemType)) continue
    items.push(summarizeItem(raw))
  }

  const totalHeader = Number(response.headers.get('total-results'))
  const total = Number.isFinite(totalHeader) ? totalHeader : null
  let nextStart = null
  if (rawItems.length > 0) {
    const next = start + rawItems.length
    if ((total !== null && next < total) || (total === null && rawItems.length >= limit)) {
      nextStart = next
    }
  }

  sendJson(res, 200, {
    library,
    items,
    nextStart,
    total,
    start,
    limit,
    sort: sortRequested,
    zoteroSort: sort,
    direction,
    mode,
    ...(collection !== null ? { collection } : {}),
    ...(q !== '' ? { q } : {}),
    ...(tag !== '' ? { tag } : {}),
  })
}

async function handleItem(state, res, url) {
  const library = resolveLibrarySlug(url)
  const key = requireItemKey(url)
  const itemResponse = await zoteroRequest(
    state,
    `${ZOTERO_LIBRARY}/items/${encodeURIComponent(key)}`,
  )
  const raw = itemResponse.json
  if (!raw || typeof raw !== 'object' || typeof raw.data !== 'object') {
    throw new HttpError(502, 'zotero_error', 'Zotero 返回了空的条目数据。')
  }
  const itemType = raw.data.itemType

  const attachments = []
  const notes = []
  let children = []
  if (!NON_REGULAR_TYPES.has(itemType)) {
    const childrenResponse = await zoteroRequest(
      state,
      `${ZOTERO_LIBRARY}/items/${encodeURIComponent(key)}/children`,
    )
    children = Array.isArray(childrenResponse.json) ? childrenResponse.json : []
  }
  if (itemType === 'attachment') {
    attachments.push(attachmentInfo(raw))
  } else if (itemType === 'note') {
    notes.push(noteInfo(raw))
  }
  for (const child of children) {
    const childType = child?.data?.itemType
    if (childType === 'attachment') attachments.push(attachmentInfo(child))
    else if (childType === 'note') notes.push(noteInfo(child))
  }
  attachments.sort(
    (a, b) => Number(b.isPdf) - Number(a.isPdf) || a.title.localeCompare(b.title),
  )

  // 批注是 PDF 附件（attachment）的子项，每个附件单独取一次 children。
  const annotationGroups = await Promise.all(
    attachments
      .filter((attachment) => attachment.isPdf)
      .map(async (attachment) => {
        try {
          const response = await zoteroRequest(
            state,
            `${ZOTERO_LIBRARY}/items/${encodeURIComponent(attachment.key)}/children?itemType=annotation`,
          )
          const rawAnnotations = Array.isArray(response.json) ? response.json : []
          return rawAnnotations
            .filter((annotation) => annotation?.data?.itemType === 'annotation')
            .map((annotation) => parseAnnotation(annotation, attachment.key))
        } catch {
          // 单个附件的批注读取失败不应让整个条目详情失败。
          return []
        }
      }),
  )
  const annotations = annotationGroups
    .flat()
    .sort(
      (a, b) => a.sortIndex.localeCompare(b.sortIndex) || a.pageIndex - b.pageIndex,
    )

  const collectionNames = {}
  try {
    const document = await loadLibrary(state)
    for (const collection of document.collections) collectionNames[collection.key] = collection.name
  } catch {
    // 集合名只是展示增强，Zotero 暂时不可用时降级为空映射。
  }

  sendJson(res, 200, {
    ...raw,
    item: raw,
    libraryKey: library,
    attachments,
    notes,
    annotations,
    collectionNames,
    journalLevels: journalLevelsForItem(raw).levels,
  })
}

async function handlePdf(state, req, res, url) {
  const library = resolveLibrarySlug(url)
  const key = requireItemKey(url)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res, ['GET', 'HEAD'])
    return
  }

  const attachment = await resolvePdfAttachment(state, key)
  const configuredPath = await resolveEnclosurePath(state, attachment)
  const file = await assertStorageFile(state, configuredPath)
  await verifyPdfMagic(file.path)

  const etagSource = typeof attachment?.data?.md5 === 'string' ? attachment.data.md5 : ''
  const etag = etagSource !== ''
    ? `"${etagSource}"`
    : `W/"${file.size.toString(16)}-${Math.floor(file.mtime.getTime()).toString(16)}"`

  const headers = {
    'content-type': 'application/pdf',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    etag,
    'last-modified': file.mtime.toUTCString(),
    'content-disposition': contentDispositionFor(attachment),
    'x-content-type-options': 'nosniff',
  }

  if (isFresh(req, etag)) {
    res.writeHead(304, { etag, 'cache-control': 'no-store' })
    res.end()
    return
  }

  const range = parseRangeHeader(req.headers?.range, file.size)
  if (range && range.invalid) {
    sendError(res, 416, 'invalid_range', '请求的 Range 超出文件范围。', {
      'content-range': `bytes */${file.size}`,
    })
    return
  }

  let status = 200
  let start = 0
  let end = file.size - 1
  if (range) {
    status = 206
    start = range.start
    end = range.end
  }
  const length = end - start + 1
  const responseHeaders = { ...headers, 'content-length': String(length) }
  if (status === 206) responseHeaders['content-range'] = `bytes ${start}-${end}/${file.size}`
  res.writeHead(status, responseHeaders)

  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(file.path, { start, end })
  stream.on('error', () => {
    try {
      res.destroy()
    } catch {
      // 响应已断开。
    }
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

function exactObjectKeys(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}

/** Narrow DSH bridge for the shared annotation-comment domain service. */
export async function dispatchReaderAnnotationCommentRequest(service, request) {
  const readOnly = request?.readOnly === true
  const requestFields = readOnly ? ['tool', 'args', 'readOnly'] : ['tool', 'args']
  if (!exactObjectKeys(request, requestFields) || !['read_reader_annotation_comment', 'update_reader_annotation_comment'].includes(request.tool) ||
      (readOnly && request.tool !== 'read_reader_annotation_comment'))
    throw new HttpError(400, 'invalid_annotation_comment_request', '批注备注请求格式无效。')
  const readFields = ['library', 'annotationKey', 'attachmentKey']
  const updateFields = [...readFields, 'editToken', 'expectedVersion', 'expectedComment', 'comment']
  const fields = request.tool === 'read_reader_annotation_comment' ? readFields : updateFields
  const args = request.args
  if (!exactObjectKeys(args, fields) || args.library !== 'user' ||
      typeof args.annotationKey !== 'string' || !ZOTERO_KEY_PATTERN.test(args.annotationKey) ||
      typeof args.attachmentKey !== 'string' || !ZOTERO_KEY_PATTERN.test(args.attachmentKey))
    throw new HttpError(400, 'invalid_annotation_comment_request', '批注备注身份或参数字段无效。')

  try {
    if (request.tool === 'read_reader_annotation_comment') {
      const result = await service.read(args)
      const hasEditToken = typeof result.editToken === 'string' && ANNOTATION_COMMENT_EDIT_TOKEN.test(result.editToken)
      return {
        status: result.status,
        library: result.library,
        annotationKey: result.annotationKey,
        attachmentKey: result.attachmentKey,
        comment: result.comment,
        annotationVersion: result.annotationVersion,
        attachmentVersion: result.attachmentVersion,
        editable: !readOnly && result.editable === true && hasEditToken,
        ...(readOnly ? { readOnly: true } : hasEditToken ? { editToken: result.editToken } : {}),
        ...(!readOnly && Number.isSafeInteger(result.editTokenExpiresAt) ? { editTokenExpiresAt: result.editTokenExpiresAt } : {}),
        ...(result.editBlockedBy ? { editBlockedBy: safeAnnotationCommentBlocker(result.editBlockedBy) } : {}),
        ...(result.lastOperation ? { lastOperation: safeAnnotationCommentOperation(result.lastOperation) } : {}),
      }
    }

    if (!ANNOTATION_COMMENT_EDIT_TOKEN.test(args.editToken) ||
        !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0 ||
        typeof args.expectedComment !== 'string' || args.expectedComment.length > 20_000 ||
        typeof args.comment !== 'string' || args.comment.length > 20_000)
      throw new HttpError(400, 'invalid_annotation_comment_request', '备注更新缺少有效的版本、旧备注、新备注或 editToken。')

    const result = await service.update(args)
    return {
      status: result.status,
      verified: result.verified === true,
      changed: result.changed,
      operationId: result.operationId,
      library: result.library,
      annotationKey: result.annotationKey,
      attachmentKey: result.attachmentKey,
      comment: result.comment,
      annotationVersion: result.annotationVersion,
      attachmentVersion: result.attachmentVersion,
      ...(typeof result.message === 'string' ? { message: result.message } : {}),
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error?.name !== 'AnnotationCommentError')
      throw new HttpError(500, 'annotation_comment_error', '批注备注服务暂不可用。')
    const status = error.code === 'not_found' ? 404
      : error.code === 'zotero_unavailable' || error.code === 'read_failed' ? 503
        : error.code === 'writes_unsupported' ? 501
          : error.code === 'invalid_input' ? 400 : 409
    throw new HttpError(status, 'annotation_comment_error', error.message)
  }
}

function safeAnnotationCommentOperation(operation) {
  const fields = ['operationId', 'status', 'submittedAt', 'verifiedAt', 'annotationVersion',
    'currentCommentMatchesRequested', 'immutableSourceMatches', 'reconciliationPending', 'message']
  return Object.fromEntries(fields.filter(field => operation[field] !== undefined).map(field => [field, operation[field]]))
}

function safeAnnotationCommentBlocker(blocker) {
  return Object.fromEntries(['operationId', 'status', 'message']
    .filter(field => blocker[field] !== undefined).map(field => [field, blocker[field]]))
}

async function readerAnnotationCommentService(state) {
  if (state.annotationCommentService) return state.annotationCommentService
  state.annotationCommentServicePromise ||= (async () => {
    const keyFile = await localAuthKeyFile()
    const session = new ZoteroSession({
      baseUrl: new URL(state.zoteroUrl).origin,
      keyFile,
      workspaceRoot: REPO_ROOT,
      pdfjsDataDir: PDFJS_DIR,
      log: () => {},
    })
    state.annotationCommentSession = session
    state.annotationCommentService = new AnnotationComment({
      session,
      directory: readerAnnotationCommentOperationsDirectory(keyFile),
    })
    return state.annotationCommentService
  })()
  try {
    return await state.annotationCommentServicePromise
  } catch (error) {
    state.annotationCommentServicePromise = null
    throw error
  }
}

export function readerAnnotationCommentOperationsDirectory(keyFile, env = process.env) {
  const stateRoot = dirname(resolve(keyFile))
  return env?.ZOTERO_WORKBENCH_STATE_DIR ? stateRoot : join(stateRoot, 'operations')
}

async function handleApi(state, req, res) {
  const url = requestUrl(req)
  const { pathname } = url
  if (pathname !== API_PATH && !pathname.startsWith(`${API_PATH}/`)) {
    throw new HttpError(404, 'not_found', '未知路径。')
  }
  const endpoint = pathname.slice(API_PATH.length).replace(/\/+$/, '')
  if (endpoint === '/annotation-comment') {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, ['POST']); return }
    const body = await readJsonBody(req)
    const result = await dispatchReaderAnnotationCommentRequest(await readerAnnotationCommentService(state), body)
    return sendJson(res, 200, result)
  }
  if(endpoint === '/research') {
    if(req.method !== 'POST'){sendMethodNotAllowed(res,['POST']);return}
    const body=await readJsonBody(req)
    if(body===null||typeof body!=='object'||Array.isArray(body))
      throw new HttpError(400,'invalid_research_request','研究请求体必须是 JSON 对象。')
    const action=body.action
    if(!['materials','start','status','cancel'].includes(action))throw new HttpError(400,'invalid_action','无效研究操作。')
    const allowed=action==='status'||action==='cancel'?new Set(['action','id']):new Set(['action','args'])
    if(Object.keys(body).some(key=>!allowed.has(key)))
      throw new HttpError(400,'invalid_research_request','研究请求包含不支持的字段。')
    if(action==='status'||action==='cancel'){
      if(typeof body.id!=='string'||!/^[a-f0-9]{24}$/.test(body.id))
        throw new HttpError(400,'invalid_research_request','研究任务编号无效。')
    }else if(body.args===null||typeof body.args!=='object'||Array.isArray(body.args))
      throw new HttpError(400,'invalid_research_request','研究参数必须是 JSON 对象。')
    state.research ||= new ResearchWorkspace()
    try { const result=await state.research[action](action==='status'||action==='cancel'?body.id:body.args);return sendJson(res,200,result) }
    catch(error){throw new HttpError(400,'research_error',error.message)}
  }
  if (endpoint === '/collaboration') {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, ['POST']); return }
    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['action', 'args'].includes(key)) ||
        !['session', 'sources', 'draft', 'feedback', 'read'].includes(body.action) ||
        body.args === null || typeof body.args !== 'object' || Array.isArray(body.args)) {
      throw new HttpError(400, 'invalid_collaboration_request', '协作请求格式无效。')
    }
    state.research ||= new ResearchWorkspace()
    state.collaboration ||= new CollaborationWorkspace({ researchWorkspace: state.research })
    try {
      const result = await state.collaboration[body.action](body.args)
      return sendJson(res, 200, result)
    } catch (error) {
      throw new HttpError(400, 'collaboration_error', error?.message || '协作操作失败。')
    }
  }
  // 动态路径：POST /citation/<12hex>/annotation —— Zotero 10 前的 501 占位（不做写入）。
  const annotationRoute = /^\/citation\/([a-f0-9]{12})\/annotation$/.exec(endpoint)
  if (annotationRoute !== null) {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST'])
      return
    }
    return handleCitationAnnotation(res)
  }
  // P2.3：旧前端路径（无 citationId）返回 501 说明，避免落到 GET-only 分支变 405。
  if (endpoint === '/citation/annotation') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST'])
      return
    }
    return handleCitationAnnotation(res, CITATION_ANNOTATION_MISSING_ID_MESSAGE)
  }
  // 只读 API 默认只接受 GET（/pdf 额外允许 HEAD）；
  // /open 是唯一会启动本机 Zotero 客户端的动作，只接受 POST（不写 Zotero 数据）。
  if (endpoint === '/open') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST'])
      return
    }
  } else {
    const headAllowed = req.method === 'HEAD' && endpoint === '/pdf'
    if (req.method !== 'GET' && !headAllowed) {
      sendMethodNotAllowed(res, endpoint === '/pdf' ? ['GET', 'HEAD'] : ['GET'])
      return
    }
  }
  switch (endpoint) {
    case '/health':
      return handleHealth(state, res)
    case '/collections':
      return handleCollections(state, res, url)
    case '/items':
      return handleItems(state, res, url)
    case '/item':
      return handleItem(state, res, url)
    case '/pdf':
      return handlePdf(state, req, res, url)
    case '/citation':
      return handleCitation(state, res, url)
    case '/citations':
      return handleCitations(state, res, url)
    case '/maintenance':
      return handleMaintenance(state, res, url)
    case '/open':
      return handleOpen(state, req, res)
    default:
      throw new HttpError(404, 'not_found', `未知 API 路径：${endpoint || '/'}。`)
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

function createState(ctx, config) {
  const options = normalizeOptions(config)
  const state = {
    ctx,
    ...options,
    appDir: APP_DIR,
    pdfjsDir: PDFJS_DIR,
    libraryTtlMs: 10_000,
    libraryCache: null,
    libraryPromise: null,
    storageRootsPromise: null,
    // 信息检查（maintenance）的服务端扫描缓存：top-level 条目与 PDF 附件父项各一份，120s。
    maintenanceCache: new Map(),
    topItemsPromise: null,
    pdfParentsPromise: null,
    annotationCommentService: null,
    annotationCommentServicePromise: null,
    annotationCommentSession: null,
  }
  state.checkHost = createHostChecker(ctx)
  return state
}

/**
 * 插件入口。所有资源都在 `ctx.effect` 里注册，并返回组合后的 dispose：
 * DSH 的热重载/禁用会调用它，避免旧路由留在同一张路由表里造成 (kind,path) 冲突。
 */
export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('zotero-workbench-dsh: apply(ctx) 需要 DSH 插件上下文。')
  }
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new TypeError('zotero-workbench-dsh: 缺少 webServer 服务（inject: [\'webServer\']）。')
  }
  if (typeof ctx.effect !== 'function') {
    throw new TypeError('zotero-workbench-dsh: 缺少 ctx.effect，无法管理路由生命周期。')
  }

  const state = createState(ctx, config)
  const disposers = []

  const register = (route, label) => {
    const disposer = ctx.effect(
      () => ctx.webServer.register(route),
      `zotero-workbench: ${label}`,
    )
    if (typeof disposer === 'function') {
      disposers.push(disposer)
    } else if (disposer && typeof disposer.dispose === 'function') {
      disposers.push(() => disposer.dispose())
    }
  }

  const requestFence = createRequestFence(ctx)
  const guarded = (handler) => async (req, res) => {
    try {
      // 1) 原始请求目标里的上级目录段（详见 hasForbiddenParentSegments 注释）。
      //    DSH 会先用规范化 pathname 匹配路由，这类请求折叠后会落到另一个合法前缀，
      //    必须在进入业务逻辑前按 404 拒绝。
      if (hasForbiddenParentSegments(req)) {
        throw new HttpError(404, 'not_found', '请求路径包含非法的上级目录段。')
      }
      // 2) 官方信任围栏：Host/Origin 围栏 + 已认证浏览器 Peer（同源 iframe 自带 cookie）。
      //    没有 connection 服务时（mock / 极端裁剪环境）保持放行。
      if (!requestFence(req)) {
        sendError(res, 403, 'forbidden', '请求未通过本机信任围栏（Host/Origin 或登录凭证校验失败）。')
        return
      }
      // 3) 插件自己的 Host 白名单（防御纵深；connection 缺省时它是唯一围栏）。
      if (!state.checkHost(req, res)) return
      await handler(req, res)
    } catch (error) {
      reportError(state, res, error)
    }
  }

  register(
    {
      kind: 'exact',
      path: ROUTE_ROOT,
      handler: guarded((_req, res) => sendRedirect(res, `${APP_PATH}/`)),
    },
    'root redirect',
  )
  register(
    {
      kind: 'exact',
      path: APP_PATH,
      handler: guarded((_req, res) => sendRedirect(res, `${APP_PATH}/`)),
    },
    'app redirect',
  )
  register(
    {
      kind: 'prefix',
      path: APP_PATH,
      handler: guarded((req, res) => serveAppStatic(state, req, res)),
    },
    'app static',
  )
  register(
    {
      kind: 'prefix',
      path: API_PATH,
      handler: guarded((req, res) => handleApi(state, req, res)),
    },
    'api',
  )
  register(
    {
      kind: 'prefix',
      path: PDFJS_PATH,
      handler: guarded((req, res) => servePdfjsStatic(state, req, res)),
    },
    'pdfjs static',
  )

  // 引文角标协议段：可选注入，缺少 systemPrompt 服务（或测试 mock）不影响插件激活。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (sctx) => {
        try {
          sctx?.systemPrompt?.section?.({
            name: 'zotero-workbench:citation-protocol',
            order: 5000,
            text: CITATION_PROTOCOL_TEXT,
          })
        } catch {
          // 协议注入失败不影响路由与阅读器。
        }
      })
    }
  } catch {
    // 没有 systemPrompt 服务的裁剪环境：跳过协议段。
  }

  return () => {
    state.research?.close()
    state.annotationCommentSession?.close()
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // dispose 失败不应阻断其它路由的清理。
      }
    }
  }
}
