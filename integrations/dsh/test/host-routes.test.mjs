/**
 * zotero-workbench-dsh Host half 路由测试（node:test，无第三方依赖）。
 *
 * 运行：`node integrations/dsh/test/host-routes.test.mjs`
 *
 * 做法：
 * - 用任务约定的 mock ctx 调 apply()，收集它注册的 (kind, path, handler)；
 * - 起一个临时 node:http server，按 DSH 的语义（exact / prefix 边界）把请求分发给
 *   插件注册的 handler，从而以真实 HTTP 请求覆盖状态码、头、Range、流式响应；
 * - 数据源是真实的本机 Zotero 本地 API（只读）。开始前先用 /api/health 探测，
 *   Zotero 未运行时真数据用例给 skip 而不是假通过；
 * - 少数对用户文库内容敏感的断言会先通过 Zotero API 取 ground truth，取不到就给 skip；
 * - connection 围栏与原始路径穿越守卫的用例用 fake ServerResponse 直接调 handler
 *   （不需要 socket，也不受 mock ctx 是否有 connection 服务影响）。
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, buildZoteroUrl, inject, name } from '../index.js'
import { appendCitation } from '../../../src/domain/citation-registry.mjs'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const ORIGIN_AUTHORITY = '127.0.0.1:56470'
const ORIGIN = `http://${ORIGIN_AUTHORITY}`
const ZOTERO_URL = (process.env.ZOTERO_URL ?? 'http://127.0.0.1:23119').replace(/\/+$/, '')

/** 本机已知条目/附件/集合 key（写进测试常量，同时对库变化保持容错）。 */
const KNOWN = {
  item: '3DWU883L',
  attachment: '4GCTAFMJ',
  collection: 'MQV8FPQU',
  nonPdfAttachment: 'NJCP84ZW',
  annotatedItem: 'N3Y39CW3',
  annotatedAttachment: '7DC4GPU8',
  annotation: 'A8UWKEXW',
  /** 导出/引用测试用的第二条目（英文期刊论文，有 DOI）。 */
  citationItem: 'NBTPKHRF',
}

// ---------------------------------------------------------------------------
// 引文登记表：把状态目录指到临时目录，避免污染 ~/.local/share/zotero-workbench
// ---------------------------------------------------------------------------

const PREVIOUS_STATE_DIR = process.env.ZOTERO_WORKBENCH_STATE_DIR
const CITATION_STATE_DIR = await mkdtemp(join(tmpdir(), 'zotero-wb-host-routes-'))
process.env.ZOTERO_WORKBENCH_STATE_DIR = CITATION_STATE_DIR

const CITATION_FIXTURE_ID = 'abc123def456'
const CITATION_FIXTURE = {
  id: CITATION_FIXTURE_ID,
  library: 'user',
  itemKey: KNOWN.item,
  attachmentKey: KNOWN.attachment,
  pageIndex: 4,
  pageLabel: '5',
  quote: '高中阶段学龄人口波动较小',
  requestedQuote: '高中阶段学龄人口波动较小',
  rects: [
    [275.285, 238.313, 296.439, 248.824],
    [51.425, 221.526, 296.439, 232.037],
  ],
  title: '编外用师问题治理：结构矛盾与制度突破',
  authors: ['李畇赟', '刘善槐'],
  year: '2022',
  venue: '教师教育研究',
  doi: '',
  itemType: 'journalArticle',
  verifiedAt: Date.now(),
  createdAt: Date.now(),
  version: 1,
}
await appendCitation(CITATION_FIXTURE)

// ---------------------------------------------------------------------------
// mock ctx：按任务约定只实现 webServer.register / getOrigin、effect
// ---------------------------------------------------------------------------

const routes = []
const mockCtx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        route.disposed = true
      }
    },
    getOrigin() {
      return ORIGIN
    },
  },
  effect(run) {
    return run()
  },
  logger: {
    error() {},
    warn() {},
  },
}

const dispose = apply(mockCtx)
assert.equal(typeof dispose, 'function')

// ---------------------------------------------------------------------------
// 临时 HTTP server + 请求工具
// ---------------------------------------------------------------------------

function matchRoute(pathname) {
  for (const route of routes) {
    if (route.kind === 'exact') {
      if (pathname === route.path) return route
      continue
    }
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) return route
  }
  return null
}

// 与 dsh-host-webserver 一致：用 WHATWG URL 规范化后的 pathname 匹配路由
// （lib/index.js:381 `new URL(req.url).pathname`），但 req 原样交给 handler。
function dispatch(req, res) {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'bad_request', message: 'bad url' } }))
    return
  }
  const route = matchRoute(pathname)
  if (route === null) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'no_route', message: '测试 dispatcher 未命中路由' } }))
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'handler_error', message: String(error) } }))
  })
}

const server = createServer(dispatch)
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const PORT = server.address().port

/**
 * 发一个真实 HTTP 请求。默认 Host 用 mock getOrigin() 的 authority（127.0.0.1:56470），
 * 即使实际连的是临时端口 —— 这正是 Host 白名单要校验的值。
 */
function request(path, options = {}) {
  const method = options.method ?? 'GET'
  const payload =
    options.body === undefined
      ? null
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(String(options.body))
  const headers = {
    host: options.host ?? ORIGIN_AUTHORITY,
    connection: 'close',
    ...(payload === null ? {} : { 'content-length': payload.length }),
    ...(options.headers ?? {}),
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path, method, headers, timeout: 20_000 },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时：${path}`))
    })
    req.on('error', reject)
    req.end(payload === null ? undefined : payload)
  })
}

async function requestJson(path, options) {
  const response = await request(path, options)
  let json = null
  try {
    json = JSON.parse(response.body.toString('utf8'))
  } catch {
    json = null
  }
  return { ...response, json }
}

/**
 * 伪造一个最小 ServerResponse，用于直接调用 route.handler（不经过真实 socket）。
 * 只覆盖路由里会走到的 writeHead/end/on/destroy。
 */
function createFakeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headersSent = true
      this.headers = { ...(headers ?? {}) }
    },
    end(body) {
      if (body !== undefined && body !== null) {
        chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
      }
      this.writableEnded = true
    },
    on() {},
    destroy() {},
    bodyText() {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

function routeFor(routeList, kind, path) {
  const route = routeList.find((candidate) => candidate.kind === kind && candidate.path === path)
  assert.ok(route !== undefined, `找不到路由 ${kind} ${path}`)
  return route
}

/** 直接以给定原始 req.url 调 handler（模拟宿主把原始请求交给匹配到的路由）。 */
async function invokeRoute(route, rawUrl, { method = 'GET', host = ORIGIN_AUTHORITY } = {}) {
  const req = { method, url: rawUrl, headers: { host } }
  const res = createFakeResponse()
  await route.handler(req, res)
  return res
}

/**
 * 带 connection 服务的独立 harness：用于验证 ctx.connection.requestRejection 围栏。
 * rejection 可变：返回非 undefined 即拒绝（403），undefined 即放行。
 */
function createFencedHarness() {
  const fencedRoutes = []
  let rejection
  const fencedCtx = {
    webServer: {
      register(route) {
        fencedRoutes.push(route)
        return () => {}
      },
      getOrigin() {
        return ORIGIN
      },
    },
    effect(run) {
      return run()
    },
    connection: {
      requestRejection() {
        return rejection
      },
    },
    logger: { error() {}, warn() {} },
  }
  const disposeHarness = apply(fencedCtx)
  return {
    routes: fencedRoutes,
    setRejection(value) {
      rejection = value
    },
    dispose: disposeHarness,
  }
}

/** 直接读 Zotero API 作为 ground truth（只读；失败返回 null）。 */
async function zoteroDirect(apiPath) {
  try {
    const response = await fetch(`${ZOTERO_URL}${apiPath}`, {
      headers: { 'Zotero-API-Version': '3' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 探测 Zotero：未运行时真数据用例 skip
// ---------------------------------------------------------------------------

const healthProbe = await requestJson('/zotero-workbench/api/health')
const zoteroUp = healthProbe.status === 200 && healthProbe.json?.zotero?.reachable === true
const skipLive = zoteroUp
  ? false
  : 'Zotero 本地 API 不可用（请先启动 Zotero 并开启本地 API 再跑真实数据断言）'

after(async () => {
  try {
    dispose()
  } catch {
    // 忽略重复 dispose。
  }
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  try {
    await rm(CITATION_STATE_DIR, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响测试结论。
  }
  if (PREVIOUS_STATE_DIR === undefined) delete process.env.ZOTERO_WORKBENCH_STATE_DIR
  else process.env.ZOTERO_WORKBENCH_STATE_DIR = PREVIOUS_STATE_DIR
})

// ---------------------------------------------------------------------------
// 导出契约与路由注册
// ---------------------------------------------------------------------------

test('导出契约与路由注册', () => {
  assert.equal(name, 'zotero-workbench-dsh')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof dispose, 'function')

  const registered = routes.map((route) => `${route.kind} ${route.path}`)
  for (const expected of [
    'exact /zotero-workbench',
    'exact /zotero-workbench/app',
    'prefix /zotero-workbench/app',
    'prefix /zotero-workbench/api',
    'prefix /zotero-workbench/pdfjs',
  ]) {
    assert.ok(registered.includes(expected), `缺少路由：${expected}`)
  }
  for (const route of routes) {
    assert.ok(['exact', 'prefix'].includes(route.kind), `未知 route.kind：${route.kind}`)
    assert.equal(typeof route.path, 'string')
    assert.equal(typeof route.handler, 'function')
  }
  assert.equal(new Set(registered).size, registered.length, '路由 (kind, path) 不允许重复')
})

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('GET /api/health 返回健康 JSON（含 Zotero 可达性）', async () => {
  const res = await requestJson('/zotero-workbench/api/health')
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /^application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(typeof res.json.ok, 'boolean')
  assert.equal(typeof res.json.version, 'string')
  assert.ok(res.json.version.length > 0)
  assert.equal(typeof res.json.zotero, 'object')
  assert.equal(typeof res.json.zotero.reachable, 'boolean')
  assert.equal(res.json.zotero.reachable, zoteroUp)
  assert.equal(res.json.library.id, 'user')
  // 本地写入能力：Zotero 10 起支持 annotation 写入；9.x 固定 false + reason。
  assert.equal(typeof res.json.writes, 'object')
  assert.equal(typeof res.json.writes.annotations, 'boolean')
  if (zoteroUp && String(res.json.zotero.version ?? '').startsWith('9.')) {
    assert.equal(res.json.writes.annotations, false)
    assert.equal(res.json.writes.reason, 'requires-zotero-10')
  }
  if (zoteroUp) {
    assert.match(String(res.json.zotero.version), /^\d+\.\d+/)
    assert.equal(res.json.ok, true)
  } else {
    assert.equal(res.json.ok, false)
    assert.equal(typeof res.json.zotero.code, 'string')
  }
})

test('Host 头校验：非本机 Host 返回 403 JSON', async () => {
  const evil = await requestJson('/zotero-workbench/api/health', { host: 'evil.example:56470' })
  assert.equal(evil.status, 403)
  assert.equal(evil.json?.error?.code, 'forbidden_host')

  const wrongPort = await requestJson('/zotero-workbench/api/health', { host: '127.0.0.1:9999' })
  assert.equal(wrongPort.status, 403)

  // 本机回调 host 的另外两种写法也要放行（端口仍是 getOrigin 的端口）。
  const localhost = await requestJson('/zotero-workbench/api/health', { host: 'localhost:56470' })
  assert.equal(localhost.status, 200)
  const ipv6 = await requestJson('/zotero-workbench/api/health', { host: '[::1]:56470' })
  assert.equal(ipv6.status, 200)

  // 静态/PDF 路由同样受 Host 校验保护。
  const evilStatic = await requestJson('/zotero-workbench/app/', { host: 'evil.example:56470' })
  assert.equal(evilStatic.status, 403)
})

// ---------------------------------------------------------------------------
// connection 围栏（ctx.connection.requestRejection）
// ---------------------------------------------------------------------------

test('connection 围栏：requestRejection 拒绝 → 403 forbidden，放行 → 200', async () => {
  const harness = createFencedHarness()
  try {
    const apiRoute = routeFor(harness.routes, 'prefix', '/zotero-workbench/api')
    const appRoute = routeFor(harness.routes, 'prefix', '/zotero-workbench/app')

    harness.setRejection({ rejection: 403 })
    const deniedApi = await invokeRoute(apiRoute, '/zotero-workbench/api/health')
    assert.equal(deniedApi.statusCode, 403)
    assert.equal(JSON.parse(deniedApi.bodyText()).error.code, 'forbidden')
    const deniedStatic = await invokeRoute(appRoute, '/zotero-workbench/app/')
    assert.equal(deniedStatic.statusCode, 403)
    assert.equal(JSON.parse(deniedStatic.bodyText()).error.code, 'forbidden')
    // POST /api/open 与 GET 路由同样受围栏保护（handler 之前就拒绝，不读 body）。
    const deniedPost = await invokeRoute(apiRoute, '/zotero-workbench/api/open', { method: 'POST' })
    assert.equal(deniedPost.statusCode, 403)
    assert.equal(JSON.parse(deniedPost.bodyText()).error.code, 'forbidden')
    // 引文登记的 POST 占位路由同样先过围栏。
    const deniedAnnotation = await invokeRoute(
      apiRoute,
      `/zotero-workbench/api/citation/${CITATION_FIXTURE_ID}/annotation`,
      { method: 'POST' },
    )
    assert.equal(deniedAnnotation.statusCode, 403)
    assert.equal(JSON.parse(deniedAnnotation.bodyText()).error.code, 'forbidden')

    harness.setRejection(undefined)
    const allowed = await invokeRoute(apiRoute, '/zotero-workbench/api/health')
    assert.equal(allowed.statusCode, 200)
    const body = JSON.parse(allowed.bodyText())
    assert.equal(typeof body.ok, 'boolean')
    assert.equal(typeof body.zotero.reachable, 'boolean')
  } finally {
    harness.dispose()
  }
})

test('mock ctx 缺少 connection 服务时保持原行为（放行）', async () => {
  // 主 harness 的 mockCtx 没有 connection（任务约定的 mock ctx），现有测试全部走这条路径。
  const apiRoute = routeFor(routes, 'prefix', '/zotero-workbench/api')
  const res = await invokeRoute(apiRoute, '/zotero-workbench/api/health')
  assert.equal(res.statusCode, 200)
  assert.equal(typeof JSON.parse(res.bodyText()).ok, 'boolean')
})

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

test('GET /api/collections 返回库列表/集合树/保存检索', { skip: skipLive }, async (t) => {
  const res = await requestJson('/zotero-workbench/api/collections')
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = res.json
  assert.equal(body.library, 'user')
  assert.ok(Array.isArray(body.libraries))
  assert.ok(body.libraries.length >= 1)
  assert.equal(body.libraries[0].type, 'user')
  assert.equal(body.libraries[0].supported, true)
  assert.ok(Array.isArray(body.collections))
  assert.ok(Array.isArray(body.savedSearches))
  assert.equal(body.collectionsCount, body.collections.length)
  if (body.collections.length === 0) {
    t.skip('个人文库当前没有集合，跳过集合形状断言')
    return
  }
  const keys = new Set(body.collections.map((collection) => collection.key))
  for (const collection of body.collections) {
    assert.equal(typeof collection.key, 'string')
    assert.ok(collection.key.length > 0)
    assert.equal(typeof collection.name, 'string')
    assert.equal(typeof collection.itemCount, 'number')
    assert.ok(Number.isInteger(collection.depth) && collection.depth >= 0)
    assert.ok(
      collection.parentCollection === null || typeof collection.parentCollection === 'string',
      'parentCollection 必须是 null 或 key 字符串',
    )
    if (collection.parentCollection !== null) {
      assert.ok(keys.has(collection.parentCollection), '父集合必须出现在同一列表里')
    }
  }
  const known = body.collections.find((collection) => collection.key === KNOWN.collection)
  if (known !== undefined) assert.ok(known.itemCount >= 0)
})

// ---------------------------------------------------------------------------
// items：列表 / 搜索 / 集合过滤 / 分页 / 排序白名单
// ---------------------------------------------------------------------------

test('GET /api/items 默认列表字段形状', { skip: skipLive }, async () => {
  const res = await requestJson('/zotero-workbench/api/items?limit=5')
  assert.equal(res.status, 200)
  const body = res.json
  assert.equal(body.library, 'user')
  assert.equal(body.limit, 5)
  assert.equal(body.start, 0)
  assert.ok(Array.isArray(body.items))
  assert.ok(body.items.length > 0, '个人文库应有条目')
  assert.ok(body.items.length <= 5)
  assert.ok(body.nextStart === null || Number.isInteger(body.nextStart))
  for (const item of body.items) {
    assert.equal(typeof item.key, 'string')
    assert.ok(item.key.length > 0)
    assert.equal(typeof item.title, 'string')
    assert.ok(!['note', 'attachment', 'annotation'].includes(item.itemType))
    assert.ok(Array.isArray(item.creators.authors))
    assert.equal(typeof item.creators.year, 'string')
    assert.ok(Array.isArray(item.collectionKeys))
    assert.ok(Array.isArray(item.tags))
    assert.equal(typeof item.date, 'string')
    assert.equal(typeof item.dateAdded, 'string')
    assert.equal(typeof item.dateModified, 'string')
    assert.ok(item.pdf === null || typeof item.pdf.key === 'string')
    assert.equal(item.numChildren >= 0, true)
  }
})

test('GET /api/items?q= 走 Zotero 搜索（含 mode=everything）', { skip: skipLive }, async () => {
  const titleSearch = await requestJson(
    `/zotero-workbench/api/items?q=${encodeURIComponent('编外用师')}&limit=5`,
  )
  assert.equal(titleSearch.status, 200)
  assert.ok(Array.isArray(titleSearch.json.items))
  assert.ok(
    titleSearch.json.items.some((item) => item.key === KNOWN.item),
    `标题检索应命中已知条目 ${KNOWN.item}`,
  )

  const everythingSearch = await requestJson(
    `/zotero-workbench/api/items?q=${encodeURIComponent('教师')}&mode=everything&limit=3`,
  )
  assert.equal(everythingSearch.status, 200)
  assert.equal(everythingSearch.json.mode, 'everything')
  assert.ok(everythingSearch.json.items.length > 0)
})

test('GET /api/items?collection= 用集合端点过滤', { skip: skipLive }, async (t) => {
  const collectionsResponse = await requestJson('/zotero-workbench/api/collections')
  const collections = collectionsResponse.json?.collections ?? []
  const target =
    collections.find((collection) => collection.key === KNOWN.collection) ??
    collections.find((collection) => collection.itemCount > 0)
  if (target === undefined) {
    t.skip('没有可用的非空集合')
    return
  }
  const res = await requestJson(
    `/zotero-workbench/api/items?collection=${encodeURIComponent(target.key)}&limit=5`,
  )
  assert.equal(res.status, 200)
  assert.equal(res.json.collection, target.key)
  assert.ok(Array.isArray(res.json.items))
  assert.ok(res.json.items.length > 0, '非空集合应返回至少一个普通条目')

  // 集合成员关系用 Zotero 原始端点做 ground truth 校验（format=keys 只返回 key）。
  try {
    const keysResponse = await fetch(
      `${ZOTERO_URL}/api/users/0/collections/${encodeURIComponent(target.key)}/items?format=keys`,
      { headers: { 'Zotero-API-Version': '3' }, signal: AbortSignal.timeout(5_000) },
    )
    if (keysResponse.ok) {
      const memberKeys = new Set(
        (await keysResponse.text())
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      )
      if (memberKeys.size > 0) {
        for (const item of res.json.items) {
          assert.ok(memberKeys.has(item.key), `条目 ${item.key} 不属于集合 ${target.key}`)
        }
      }
    }
  } catch {
    // ground truth 不可得时不强断言。
  }
})

test('GET /api/items 分页：nextStart 与两页不重复', { skip: skipLive }, async (t) => {
  const first = await requestJson('/zotero-workbench/api/items?limit=2&start=0')
  assert.equal(first.status, 200)
  assert.ok(first.json.items.length <= 2)
  assert.equal(first.json.start, 0)
  if (first.json.nextStart === null) {
    t.skip('当前文库结果不足两页')
    return
  }
  // nextStart 按 Zotero 原始分页条数推进（note/annotation 会被过滤掉，所以可能大于 items.length）。
  assert.ok(first.json.nextStart > 0)
  assert.ok(first.json.nextStart <= 2)
  const second = await requestJson(
    `/zotero-workbench/api/items?limit=2&start=${first.json.nextStart}`,
  )
  assert.equal(second.status, 200)
  assert.equal(second.json.start, first.json.nextStart)
  const firstKeys = new Set(first.json.items.map((item) => item.key))
  for (const item of second.json.items) {
    assert.ok(!firstKeys.has(item.key), '第二页不应重复第一页的条目')
  }
})

test('GET /api/items 限制 limit 上限 100 且排序走白名单', { skip: skipLive }, async () => {
  const clamped = await requestJson('/zotero-workbench/api/items?limit=1000')
  assert.equal(clamped.status, 200)
  assert.equal(clamped.json.limit, 100)
  assert.ok(clamped.json.items.length <= 100)

  const byYear = await requestJson('/zotero-workbench/api/items?sort=year&limit=3')
  assert.equal(byYear.status, 200)
  assert.equal(byYear.json.sort, 'year')

  // 白名单外的排序值回退默认值而不是报错（前端不需要处理额外错误态）。
  const fallback = await requestJson('/zotero-workbench/api/items?sort=definitely-not-a-sort&limit=1')
  assert.equal(fallback.status, 200)
  assert.equal(fallback.json.sort, 'dateModified')
  assert.equal(fallback.json.direction, 'desc')
})

// ---------------------------------------------------------------------------
// item：详情 + attachments/notes/annotations
// ---------------------------------------------------------------------------

test('GET /api/item 返回完整条目 + 附件 + 笔记', { skip: skipLive }, async (t) => {
  const res = await requestJson(`/zotero-workbench/api/item?key=${KNOWN.item}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = res.json
  assert.equal(body.key, KNOWN.item)
  assert.equal(typeof body.data, 'object')
  assert.equal(body.data.itemType, 'journalArticle')
  assert.equal(typeof body.data.title, 'string')
  assert.ok(body.data.title.length > 0)
  assert.ok(Array.isArray(body.data.creators))
  assert.ok(Array.isArray(body.data.tags))
  assert.ok(Array.isArray(body.attachments))
  assert.ok(Array.isArray(body.notes))
  assert.ok(Array.isArray(body.annotations))
  assert.equal(typeof body.collectionNames, 'object')
  assert.ok(body.item !== undefined, '保留原样 item JSON 的别名')

  if (body.attachments.length === 0) {
    t.skip(`已知条目 ${KNOWN.item} 没有附件（文库可能已变化）`)
    return
  }
  const pdf = body.attachments.find((attachment) => attachment.key === KNOWN.attachment)
  if (pdf === undefined) {
    t.diagnostic(`已知 PDF 附件 ${KNOWN.attachment} 不在此条目下（文库可能已变化）`)
  } else {
    assert.equal(pdf.isPdf, true)
    assert.match(String(pdf.contentType), /application\/pdf/)
    assert.equal(typeof pdf.filename, 'string')
    assert.ok(pdf.filename.length > 0)
    assert.equal(typeof pdf.path, 'string')
    assert.ok(pdf.path.length > 0)
  }
})

test('GET /api/item 批注 pageIndex 与 Zotero annotationPosition 一致', { skip: skipLive }, async (t) => {
  const rawAnnotations = await zoteroDirect(
    `/api/users/0/items/${KNOWN.annotatedAttachment}/children?itemType=annotation`,
  )
  if (!Array.isArray(rawAnnotations) || rawAnnotations.length === 0) {
    t.skip('已知 PDF 附件在当前文库中没有批注')
    return
  }
  const res = await requestJson(`/zotero-workbench/api/item?key=${KNOWN.annotatedItem}`)
  assert.equal(res.status, 200)
  const annotations = res.json.annotations
  assert.ok(Array.isArray(annotations))
  assert.ok(annotations.length >= 1, '条目详情应包含 PDF 批注')
  for (const annotation of annotations) {
    assert.equal(typeof annotation.key, 'string')
    assert.equal(typeof annotation.parentAttachment, 'string')
    assert.equal(typeof annotation.text, 'string')
    assert.equal(typeof annotation.comment, 'string')
    assert.equal(typeof annotation.color, 'string')
    assert.equal(typeof annotation.pageLabel, 'string')
    assert.ok(Number.isInteger(annotation.pageIndex) && annotation.pageIndex >= 0)
    assert.ok(Array.isArray(annotation.tags))
  }
  const first = annotations[0]
  const raw = rawAnnotations.find((annotation) => annotation.key === first.key) ?? rawAnnotations[0]
  let position = null
  try {
    position = JSON.parse(raw.data.annotationPosition)
  } catch {
    position = null
  }
  if (position && Number.isInteger(position.pageIndex)) {
    assert.equal(first.pageIndex, position.pageIndex, 'pageIndex 必须是 0 起的原始 pageIndex')
  }
})

// ---------------------------------------------------------------------------
// pdf：200 / 附件 key / Range 206 / HEAD / 非 PDF / 404
// ---------------------------------------------------------------------------

test('GET /api/pdf 以 application/pdf 返回 PDF 字节', { skip: skipLive }, async () => {
  const res = await request(`/zotero-workbench/api/pdf?key=${KNOWN.item}`)
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /^application\/pdf/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(Number(res.headers['content-length']), res.body.length)
  assert.ok(res.body.length > 1_000, 'PDF 至少应大于 1KB')
  assert.equal(res.body.subarray(0, 4).toString('latin1'), '%PDF')
  assert.ok(String(res.headers['content-disposition'] ?? '').startsWith('inline;'))
})

test('GET /api/pdf 支持直接传 PDF 附件 key', { skip: skipLive }, async () => {
  const res = await request(`/zotero-workbench/api/pdf?key=${KNOWN.attachment}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.subarray(0, 4).toString('latin1'), '%PDF')
})

test('GET /api/pdf 支持 Range（206 + Content-Range）', { skip: skipLive }, async () => {
  const full = await request(`/zotero-workbench/api/pdf?key=${KNOWN.item}`)
  assert.equal(full.status, 200)
  const size = full.body.length

  const head = await request(`/zotero-workbench/api/pdf?key=${KNOWN.item}`, {
    headers: { range: 'bytes=0-3' },
  })
  assert.equal(head.status, 206)
  assert.equal(head.headers['content-range'], `bytes 0-3/${size}`)
  assert.equal(head.body.length, 4)
  assert.equal(head.body.toString('latin1'), '%PDF')

  const tail = await request(`/zotero-workbench/api/pdf?key=${KNOWN.item}`, {
    headers: { range: 'bytes=10-' },
  })
  assert.equal(tail.status, 206)
  assert.equal(tail.body.length, size - 10)
  assert.equal(Number(tail.headers['content-length']), size - 10)

  const invalid = await requestJson(`/zotero-workbench/api/pdf?key=${KNOWN.item}`, {
    headers: { range: `bytes=${size + 10}-${size + 20}` },
  })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.json.error.code, 'invalid_range')
})

test('HEAD /api/pdf 返回头且无响应体', { skip: skipLive }, async () => {
  const res = await request(`/zotero-workbench/api/pdf?key=${KNOWN.item}`, { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /^application\/pdf/)
  assert.ok(Number(res.headers['content-length']) > 1_000)
  assert.equal(res.body.length, 0)
})

test('GET /api/pdf 非 PDF 附件返回 415', { skip: skipLive }, async (t) => {
  const attachment = await zoteroDirect(`/api/users/0/items/${KNOWN.nonPdfAttachment}`)
  if (
    attachment === null ||
    attachment.data?.itemType !== 'attachment' ||
    attachment.data?.contentType === 'application/pdf'
  ) {
    t.skip('已知非 PDF 附件不在当前文库')
    return
  }
  const res = await requestJson(`/zotero-workbench/api/pdf?key=${KNOWN.nonPdfAttachment}`)
  assert.equal(res.status, 415)
  assert.equal(res.json.error.code, 'not_pdf')
})

// ---------------------------------------------------------------------------
// 错误 JSON / 参数校验 / 404
// ---------------------------------------------------------------------------

test('非法 key、未知 API、组库、错误方法都返回统一 JSON 错误', async () => {
  const invalidKey = await requestJson(
    `/zotero-workbench/api/pdf?key=${encodeURIComponent('../../etc/passwd')}`,
  )
  assert.equal(invalidKey.status, 400)
  assert.equal(invalidKey.json.error.code, 'invalid_key')

  const invalidCollection = await requestJson(
    `/zotero-workbench/api/items?collection=${encodeURIComponent('/etc/passwd')}`,
  )
  assert.equal(invalidCollection.status, 400)
  assert.equal(invalidCollection.json.error.code, 'invalid_collection')

  const unknownLibrary = await requestJson('/zotero-workbench/api/collections?library=unknown-lib')
  assert.equal(unknownLibrary.status, 400)
  assert.equal(unknownLibrary.json.error.code, 'invalid_library')

  const groupLibrary = await requestJson('/zotero-workbench/api/collections?library=g123')
  assert.equal(groupLibrary.status, 501)
  assert.equal(groupLibrary.json.error.code, 'library_not_supported')

  const unknownApi = await requestJson('/zotero-workbench/api/nope')
  assert.equal(unknownApi.status, 404)
  assert.equal(unknownApi.json.error.code, 'not_found')

  const wrongMethod = await requestJson('/zotero-workbench/api/health', { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.error.code, 'method_not_allowed')
})

test('POST /api/research rejects malformed envelopes with 400 before starting work', async () => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async (...args) => {
    networkCalls++
    return originalFetch(...args)
  }
  try {
    const cases = [
      { body: 'null', code: 'invalid_research_request' },
      { body: '[]', code: 'invalid_research_request' },
      { body: JSON.stringify({ action: 'start', args: null }), code: 'invalid_research_request' },
      { body: JSON.stringify({ action: 'materials', args: 'invalid' }), code: 'invalid_research_request' },
      { body: JSON.stringify({ action: 'start', args: { kind: 'invalid' } }), code: 'research_error' },
      { body: JSON.stringify({ action: 'status', id: null }), code: 'invalid_research_request' },
      { body: JSON.stringify({ action: 'no-such-action', args: {} }), code: 'invalid_action' },
      { body: JSON.stringify({ action: 'start', args: {}, token: 'unexpected' }), code: 'invalid_research_request' },
      { body: '{', code: 'invalid_json' },
    ]
    for (const sample of cases) {
      const res = await requestJson('/zotero-workbench/api/research', { method: 'POST', body: sample.body })
      assert.equal(res.status, 400, sample.body)
      assert.equal(res.json?.error?.code, sample.code, sample.body)
      assert.equal(res.headers['cache-control'], 'no-store')
    }
    assert.equal(networkCalls, 0, 'invalid request bodies must not reach Zotero or start an AI job')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST /api/collaboration creates and resumes a shared session without a Zotero write', async () => {
  const created = await requestJson('/zotero-workbench/api/collaboration', {
    method: 'POST',
    body: JSON.stringify({ action: 'session', args: { action: 'create', title: 'DSH 协作路由回归' } }),
  })
  assert.equal(created.status, 200)
  assert.match(created.json?.session?.id || '', /^[a-f0-9]{24}$/)
  assert.equal(created.json.session.revision, 1)

  const resumed = await requestJson('/zotero-workbench/api/collaboration', {
    method: 'POST',
    body: JSON.stringify({ action: 'session', args: { action: 'get', id: created.json.session.id } }),
  })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.json.session.id, created.json.session.id)
  assert.deepEqual(resumed.json.session.sources, [])
  assert.deepEqual(resumed.json.session.draftSummaries, [])

  const rejected = await requestJson('/zotero-workbench/api/collaboration', {
    method: 'POST',
    body: JSON.stringify({ action: 'draft', args: { id: created.json.session.id } }),
  })
  assert.equal(rejected.status, 400)
})

test('GET /api/pdf 未知条目返回 404', { skip: skipLive }, async () => {
  const res = await requestJson('/zotero-workbench/api/pdf?key=ZZZZZZZZ')
  assert.equal(res.status, 404)
  assert.equal(typeof res.json.error.code, 'string')
})

// ---------------------------------------------------------------------------
// 静态路由：/app 与 /pdfjs
// ---------------------------------------------------------------------------

test('GET /app → 302；/app/ 返回阅读器或 404（web 未构建时）', async (t) => {
  const redirect = await request('/zotero-workbench/app')
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, '/zotero-workbench/app/')

  const index = await request('/zotero-workbench/app/')
  assert.ok([200, 404].includes(index.status), `/app/ 状态码 ${index.status} 不在契约内`)
  if (index.status === 200) {
    assert.match(String(index.headers['content-type']), /^text\/html/)
    assert.ok(index.body.length > 0)
  } else {
    const body = JSON.parse(index.body.toString('utf8'))
    assert.equal(body.error.code, 'not_found')
    t.diagnostic('integrations/dsh/web/index.html 尚未写入：/app/ 当前按 404 契约返回')
  }
})

test('GET /app/* 静态 MIME：.mjs 必须是 JavaScript', async (t) => {
  const response = await request('/zotero-workbench/app/vendor/pdfjs/pdf.min.mjs')
  if (response.status === 404) {
    t.skip('前端兜底 vendor/pdfjs/pdf.min.mjs 尚未写入')
    return
  }
  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /^(text|application)\/javascript/)
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
})

test('GET /pdfjs/* 静态服务：真实 cmap 可读，缺失文件 404', async () => {
  const cmap = await request('/zotero-workbench/pdfjs/cmaps/H.bcmap')
  assert.equal(cmap.status, 200)
  assert.match(String(cmap.headers['content-type']), /^application\/octet-stream/)
  assert.ok(cmap.body.length > 0)

  const build = await request('/zotero-workbench/pdfjs/build/pdf.mjs')
  assert.ok([200, 404].includes(build.status), 'build/pdf.mjs 存在与否都必须按契约响应')
  if (build.status === 200) {
    assert.match(String(build.headers['content-type']), /^(text|application)\/javascript/)
  }

  const missing = await request('/zotero-workbench/pdfjs/definitely-missing.bin')
  assert.equal(missing.status, 404)
  const missingJson = JSON.parse(missing.body.toString('utf8'))
  assert.equal(missingJson.error.code, 'not_found')
})

test('路径穿越防护：/app 与 /pdfjs 拒绝越界读取', async () => {
  const attempts = [
    // 编码的 ../：URL 解析后仍是字面量，进入 handler 解码后必须被拒绝。
    '/zotero-workbench/app/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/zotero-workbench/pdfjs/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    // 反斜杠变体（Windows 分隔符）同样拒绝。
    '/zotero-workbench/app/..%5c..%5cetc%5cpasswd',
    '/zotero-workbench/pdfjs/..%5c..%5cetc%5cpasswd',
    // NUL 字节。
    '/zotero-workbench/app/%00index.html',
    // 未编码的 ../ 会被 URL 规范化，最终由路由/防护拒绝（403 或 404 均可）。
    '/zotero-workbench/app/../../etc/passwd',
  ]
  for (const attempt of attempts) {
    const res = await request(attempt)
    assert.ok(
      res.status === 403 || res.status === 404,
      `${attempt} 应被拒绝，实际状态码 ${res.status}`,
    )
    assert.ok(
      !res.body.toString('latin1').includes('root:'),
      `${attempt} 不应返回系统文件内容`,
    )
  }
})

test('越界路径在 HTTP 层一律 404（DSH 规范化后不会落到 index.html/其他 API）', async () => {
  const attempts = [
    '/zotero-workbench/app/../api/health',
    '/zotero-workbench/app/%2e%2e/api/health',
    '/zotero-workbench/pdfjs/../api/health',
  ]
  for (const attempt of attempts) {
    const res = await requestJson(attempt)
    assert.equal(res.status, 404, `${attempt} 应返回 404，实际 ${res.status}`)
    assert.match(String(res.headers['content-type']), /^application\/json/)
    const text = res.body.toString('utf8')
    assert.ok(!text.toLowerCase().includes('<!doctype html'), `${attempt} 不应返回 index.html`)
    assert.equal(res.json?.error?.code, 'not_found')
  }
})

test('静态前缀守卫：handler 收到越界/相邻前缀路径时返回 404', async () => {
  const appRoute = routeFor(routes, 'prefix', '/zotero-workbench/app')
  const pdfjsRoute = routeFor(routes, 'prefix', '/zotero-workbench/pdfjs')
  const cases = [
    [appRoute, '/zotero-workbench/app/../api/health'],
    [appRoute, '/zotero-workbench/app/%2e%2e/api/health'],
    [pdfjsRoute, '/zotero-workbench/pdfjs/../api/health'],
    [appRoute, '/zotero-workbench/app/../../etc/passwd'],
    // 前缀边界：app 不能吃掉 application，pdfjs 不能吃掉 pdfjsx（subPath 必须校验 '/边界'）。
    [appRoute, '/zotero-workbench/application'],
    [pdfjsRoute, '/zotero-workbench/pdfjsx/cmaps/H.bcmap'],
  ]
  for (const [route, rawUrl] of cases) {
    const res = await invokeRoute(route, rawUrl)
    assert.equal(res.statusCode, 404, `${rawUrl} 应返回 404，实际 ${res.statusCode}`)
    assert.ok(!res.bodyText().toLowerCase().includes('<html'), `${rawUrl} 不应返回 HTML`)
  }
})

// ---------------------------------------------------------------------------
// citations：引用与导出（BibTeX / BibLaTeX / RIS / CSL-JSON / APA 文本）
// ---------------------------------------------------------------------------

test('GET /api/citations 导出 BibTeX / BibLaTeX / RIS / CSL-JSON / APA 文本', { skip: skipLive }, async () => {
  const keys = `${KNOWN.item},${KNOWN.citationItem}`

  const bibtex = await requestJson(`/zotero-workbench/api/citations?keys=${keys}&format=bibtex`)
  assert.equal(bibtex.status, 200)
  assert.equal(bibtex.headers['cache-control'], 'no-store')
  assert.equal(bibtex.json.format, 'bibtex')
  assert.equal(bibtex.json.style, 'apa')
  assert.equal(bibtex.json.locale, 'zh-CN')
  assert.equal(bibtex.json.count, 2)
  assert.equal(bibtex.json.entries.length, 2)
  assert.match(bibtex.json.text, /@article\{/)
  assert.ok(bibtex.json.text.includes('author = {'))
  assert.ok(bibtex.json.text.includes('title = {'))
  for (const entry of bibtex.json.entries) {
    assert.equal(typeof entry.bib, 'string')
    assert.ok(entry.bib.startsWith('@'))
    assert.ok(entry.bib.trim().endsWith('}'))
  }
  const knownBib = bibtex.json.entries.find((entry) => entry.key === KNOWN.item)
  assert.ok(knownBib !== undefined)
  assert.ok(knownBib.bib.includes('2022'))
  assert.ok(knownBib.bib.includes('编外用师问题治理'))

  const biblatex = await requestJson(
    `/zotero-workbench/api/citations?keys=${KNOWN.citationItem}&format=biblatex`,
  )
  assert.equal(biblatex.status, 200)
  assert.equal(biblatex.json.format, 'biblatex')
  assert.match(biblatex.json.text, /@article\{/)
  assert.ok(biblatex.json.text.includes('date = {'))
  assert.ok(biblatex.json.text.includes('journaltitle = {'))

  const ris = await requestJson(`/zotero-workbench/api/citations?keys=${KNOWN.citationItem}&format=ris`)
  assert.equal(ris.status, 200)
  assert.match(ris.json.text, /TY  - JOUR/)
  assert.match(ris.json.text, /AU  - /)
  assert.match(ris.json.text, /TI  - /)
  assert.match(ris.json.text, /PY  - \d{4}/)
  assert.match(ris.json.text, /ER  -/)
  assert.ok(ris.json.text.includes('DO  - 10.1002/rev3.70021'))

  const csl = await requestJson(`/zotero-workbench/api/citations?keys=${keys}&format=csljson`)
  assert.equal(csl.status, 200)
  const parsed = JSON.parse(csl.json.text)
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 2)
  const englishEntry = parsed.find((entry) => entry.id === KNOWN.citationItem)
  assert.ok(englishEntry !== undefined)
  assert.equal(englishEntry.type, 'article-journal')
  assert.equal(englishEntry['container-title'], 'Review of Education')
  assert.ok(Array.isArray(englishEntry.author))
  assert.deepEqual(englishEntry.issued['date-parts'][0], [2025])
  assert.equal(englishEntry.DOI, '10.1002/rev3.70021')
  // 无 DOI 的条目容错：不崩溃、也不输出假 DOI。
  const chineseEntry = parsed.find((entry) => entry.id === KNOWN.item)
  assert.ok(chineseEntry !== undefined)
  assert.equal(chineseEntry.DOI, undefined)

  const text = await requestJson(`/zotero-workbench/api/citations?keys=${keys}&format=text`)
  assert.equal(text.status, 200)
  assert.equal(text.json.entries.length, 2)
  assert.ok(text.json.text.includes('(2022)'))
  assert.ok(text.json.text.includes('(2025)'))
  assert.ok(text.json.text.includes('https://doi.org/10.1002/rev3.70021'))
  assert.ok(text.json.entries[0].citation.includes('编外用师问题治理'))
})

test('GET /api/citations 参数校验与未知条目', { skip: skipLive }, async () => {
  const missing = await requestJson('/zotero-workbench/api/citations')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'missing_keys')

  const badFormat = await requestJson(`/zotero-workbench/api/citations?keys=${KNOWN.item}&format=xml`)
  assert.equal(badFormat.status, 400)
  assert.equal(badFormat.json.error.code, 'invalid_format')

  const badKey = await requestJson('/zotero-workbench/api/citations?keys=bad%20key&format=bibtex')
  assert.equal(badKey.status, 400)
  assert.equal(badKey.json.error.code, 'invalid_key')

  const tooManyKeys = Array.from({ length: 201 }, (_, index) => `K${String(index).padStart(7, '0')}`).join(',')
  const tooMany = await requestJson(`/zotero-workbench/api/citations?keys=${tooManyKeys}&format=bibtex`)
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.json.error.code, 'too_many_keys')

  const unknown = await requestJson('/zotero-workbench/api/citations?keys=ZZZZZZZZ&format=bibtex')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'not_found')
})

// ---------------------------------------------------------------------------
// maintenance：未归类 / 缺 DOI / 缺 PDF 信息检查
// ---------------------------------------------------------------------------

test('GET /api/maintenance 三视图 + 服务端分页', { skip: skipLive }, async () => {
  for (const view of ['unfiled', 'missingDOI', 'missingPDF']) {
    const res = await requestJson(`/zotero-workbench/api/maintenance?view=${view}&limit=5`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.json.view, view)
    assert.equal(typeof res.json.total, 'number')
    assert.equal(res.json.offset, 0)
    assert.equal(res.json.limit, 5)
    assert.ok(Array.isArray(res.json.items))
    assert.ok(res.json.items.length <= 5)
    assert.equal(typeof res.json.truncated, 'boolean')
    for (const item of res.json.items) {
      assert.equal(typeof item.key, 'string')
      assert.equal(typeof item.title, 'string')
      assert.equal(typeof item.itemType, 'string')
      assert.equal(typeof item.hasPdf, 'boolean')
      assert.equal(typeof item.hasDOI, 'boolean')
      assert.equal(typeof item.collectionsCount, 'number')
      assert.ok(Array.isArray(item.creators.authors))
      assert.equal(typeof item.creators.year, 'string')
      if (view === 'unfiled') assert.equal(item.collectionsCount, 0)
      if (view === 'missingDOI') assert.equal(item.hasDOI, false)
      if (view === 'missingPDF') assert.equal(item.hasPdf, false)
    }
  }

  const first = await requestJson('/zotero-workbench/api/maintenance?view=unfiled&limit=2&offset=0')
  const second = await requestJson('/zotero-workbench/api/maintenance?view=unfiled&limit=2&offset=2')
  assert.equal(second.json.offset, 2)
  if (first.json.total > 2) {
    assert.equal(second.json.items.length, Math.min(2, first.json.total - 2))
    const firstKeys = new Set(first.json.items.map((item) => item.key))
    for (const item of second.json.items) assert.ok(!firstKeys.has(item.key), '分页不应重复')
  } else {
    assert.equal(second.json.items.length, 0)
  }

  const bad = await requestJson('/zotero-workbench/api/maintenance?view=nope')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid_view')
})

// ---------------------------------------------------------------------------
// open：zotero:// 深链（构造 + 不真正启动 + 失败 JSON）
// ---------------------------------------------------------------------------

test('buildZoteroUrl 只允许两种 zotero:// 深链并严格校验参数', () => {
  assert.equal(
    buildZoteroUrl({ kind: 'item', key: '3DWU883L' }),
    'zotero://select/library/items/3DWU883L',
  )
  assert.equal(
    buildZoteroUrl({ kind: 'pdf', key: '3DWU883L', attachmentKey: '4GCTAFMJ' }),
    'zotero://open-pdf/library/items/4GCTAFMJ?page=1',
  )
  assert.equal(
    buildZoteroUrl({ kind: 'pdf', key: '4GCTAFMJ' }),
    'zotero://open-pdf/library/items/4GCTAFMJ?page=1',
  )
  assert.equal(
    buildZoteroUrl({ kind: 'pdf', key: '3DWU883L', attachmentKey: '4GCTAFMJ', page: 7, annotationKey: 'C8YZTS2R' }),
    'zotero://open-pdf/library/items/4GCTAFMJ?page=7&annotation=C8YZTS2R',
  )
  assert.throws(() => buildZoteroUrl({ kind: 'evil', key: '3DWU883L' }))
  assert.throws(() => buildZoteroUrl({ kind: 'item', key: '../etc/passwd' }))
  assert.throws(() => buildZoteroUrl({ kind: 'item', key: '3dwu883l' }), 'key 必须严格 A-Z0-9')
  assert.throws(() => buildZoteroUrl({ kind: 'pdf', key: '3DWU883L', page: 0 }))
  assert.throws(() => buildZoteroUrl({ kind: 'pdf', key: '3DWU883L', page: 100001 }))
  assert.throws(() => buildZoteroUrl({ kind: 'pdf', key: '3DWU883L', attachmentKey: 'bad' }))
  assert.throws(() => buildZoteroUrl({ kind: 'pdf', key: '3DWU883L', annotationKey: 'bad' }))
})

test('POST /api/open：ZOTERO_WORKBENCH_DSH_OPEN=0 只返回 URL 不启动', async () => {
  const previous = process.env.ZOTERO_WORKBENCH_DSH_OPEN
  process.env.ZOTERO_WORKBENCH_DSH_OPEN = '0'
  try {
    const pdf = await requestJson('/zotero-workbench/api/open', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'pdf',
        key: KNOWN.item,
        attachmentKey: KNOWN.attachment,
        page: 5,
        annotationKey: 'C8YZTS2R',
      }),
    })
    assert.equal(pdf.status, 200)
    assert.deepEqual(pdf.json, {
      ok: true,
      url: 'zotero://open-pdf/library/items/4GCTAFMJ?page=5&annotation=C8YZTS2R',
      opened: false,
    })
    const item = await requestJson('/zotero-workbench/api/open', {
      method: 'POST',
      body: JSON.stringify({ kind: 'item', key: KNOWN.item }),
    })
    assert.equal(item.status, 200)
    assert.equal(item.json.url, 'zotero://select/library/items/3DWU883L')
    assert.equal(item.json.opened, false)
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_WORKBENCH_DSH_OPEN
    else process.env.ZOTERO_WORKBENCH_DSH_OPEN = previous
  }

  const invalid = await requestJson('/zotero-workbench/api/open', {
    method: 'POST',
    body: JSON.stringify({ kind: 'evil', key: KNOWN.item }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error.code, 'invalid_open_request')

  const invalidJson = await requestJson('/zotero-workbench/api/open', {
    method: 'POST',
    body: '{not valid json',
  })
  assert.equal(invalidJson.status, 400)
  assert.equal(invalidJson.json.error.code, 'invalid_json')

  const wrongMethod = await requestJson('/zotero-workbench/api/open')
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.error.code, 'method_not_allowed')
})

test('POST /api/open：启动失败返回 JSON 错误而不是抛异常', async () => {
  const previousPath = process.env.PATH
  const previousOpen = process.env.ZOTERO_WORKBENCH_DSH_OPEN
  delete process.env.ZOTERO_WORKBENCH_DSH_OPEN
  // 把 PATH 清空让 execFile('open') 以 ENOENT 失败：验证失败分支返回 JSON 而不是崩溃/抛错。
  process.env.PATH = ''
  try {
    const failed = await requestJson('/zotero-workbench/api/open', {
      method: 'POST',
      body: JSON.stringify({ kind: 'item', key: KNOWN.item }),
    })
    assert.equal(failed.status, 502)
    assert.equal(failed.json.ok, false)
    assert.equal(failed.json.url, 'zotero://select/library/items/3DWU883L')
    assert.equal(failed.json.error.code, 'open_failed')
  } finally {
    process.env.PATH = previousPath
    if (previousOpen !== undefined) process.env.ZOTERO_WORKBENCH_DSH_OPEN = previousOpen
  }
})

// ---------------------------------------------------------------------------
// /api/item：批注 rects 与附件 size（使用已知附件 4GCTAFMJ 的真实批注）
// ---------------------------------------------------------------------------

test('/api/item 批注含 rects/sortIndex/type，附件含 size', { skip: skipLive }, async (t) => {
  const groundTruth = await zoteroDirect(
    `/api/users/0/items/${KNOWN.attachment}/children?itemType=annotation`,
  )
  if (!Array.isArray(groundTruth) || groundTruth.length === 0) {
    t.skip(`已知附件 ${KNOWN.attachment} 当前没有批注`)
    return
  }
  const res = await requestJson(`/zotero-workbench/api/item?key=${KNOWN.item}`)
  assert.equal(res.status, 200)
  const annotations = res.json.annotations
  assert.ok(Array.isArray(annotations))
  assert.ok(annotations.length >= 1, `条目应包含 ${KNOWN.attachment} 的批注`)
  for (const annotation of annotations) {
    assert.equal(typeof annotation.key, 'string')
    assert.equal(typeof annotation.parentAttachment, 'string')
    assert.equal(typeof annotation.text, 'string')
    assert.equal(typeof annotation.comment, 'string')
    assert.equal(typeof annotation.color, 'string')
    assert.equal(typeof annotation.pageLabel, 'string')
    assert.ok(Number.isInteger(annotation.pageIndex) && annotation.pageIndex >= 0)
    assert.ok(Array.isArray(annotation.rects), 'annotation.rects 必须是数组')
    for (const rect of annotation.rects) {
      assert.ok(Array.isArray(rect) && rect.length === 4, 'rect 必须是 [x1, y1, x2, y2]')
      for (const coordinate of rect) assert.equal(typeof coordinate, 'number')
    }
    assert.equal(typeof annotation.sortIndex, 'string')
    assert.equal(typeof annotation.type, 'string')
    assert.ok(Array.isArray(annotation.tags))
    assert.equal(typeof annotation.dateAdded, 'string')
    assert.equal(typeof annotation.dateModified, 'string')
  }
  // 与 Zotero annotationPosition 对齐（不做坐标变换）。
  const first = annotations[0]
  const raw = groundTruth.find((annotation) => annotation.key === first.key)
  if (raw !== undefined) {
    const position = JSON.parse(raw.data.annotationPosition)
    assert.deepEqual(first.rects, position.rects)
    assert.equal(first.pageIndex, position.pageIndex)
  }

  const pdfAttachment = res.json.attachments.find((attachment) => attachment.key === KNOWN.attachment)
  assert.ok(pdfAttachment !== undefined)
  assert.equal(pdfAttachment.isPdf, true)
  assert.equal(typeof pdfAttachment.filename, 'string')
  assert.equal(typeof pdfAttachment.contentType, 'string')
  assert.equal(typeof pdfAttachment.title, 'string')
  assert.equal(typeof pdfAttachment.size, 'number')
  assert.ok(pdfAttachment.size > 1000)
})

// ---------------------------------------------------------------------------
// 引文登记：Host 查询路由 + systemPrompt 协议段
// ---------------------------------------------------------------------------

test('GET /api/citation 返回登记记录与角标/深链，未知 id 404，非法 id 400', async () => {
  const res = await requestJson(`/zotero-workbench/api/citation?id=${CITATION_FIXTURE_ID}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json.id, CITATION_FIXTURE_ID)
  assert.equal(res.json.itemKey, KNOWN.item)
  assert.equal(res.json.attachmentKey, KNOWN.attachment)
  assert.equal(res.json.pageIndex, 4)
  assert.equal(res.json.pageLabel, '5')
  assert.equal(res.json.quote, CITATION_FIXTURE.quote)
  assert.deepEqual(res.json.rects, CITATION_FIXTURE.rects)
  assert.deepEqual(res.json.authors, CITATION_FIXTURE.authors)
  assert.equal(res.json.href, `https://zotero-wb.invalid/c/${CITATION_FIXTURE_ID}`)
  assert.equal(res.json.zoteroItemUrl, `zotero://select/library/items/${KNOWN.item}`)
  assert.equal(
    res.json.zoteroPdfUrl,
    `zotero://open-pdf/library/items/${KNOWN.attachment}?page=5`,
  )

  const missing = await requestJson('/zotero-workbench/api/citation?id=000000000000')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'not_found')

  const invalid = await requestJson('/zotero-workbench/api/citation?id=not-an-id')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error.code, 'invalid_id')
})

test('GET /api/citations?itemKey= 返回同一文献的引文登记列表', async () => {
  const res = await requestJson(`/zotero-workbench/api/citations?itemKey=${KNOWN.item}&limit=10`)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json.itemKey, KNOWN.item)
  assert.equal(res.json.total, 1)
  assert.equal(res.json.limit, 10)
  assert.equal(res.json.records.length, 1)
  assert.equal(res.json.records[0].id, CITATION_FIXTURE_ID)
  assert.equal(
    res.json.records[0].href,
    `https://zotero-wb.invalid/c/${CITATION_FIXTURE_ID}`,
  )

  const empty = await requestJson('/zotero-workbench/api/citations?itemKey=ZZZZZZZZ')
  assert.equal(empty.status, 200)
  assert.equal(empty.json.total, 0)
  assert.deepEqual(empty.json.records, [])

  const invalid = await requestJson('/zotero-workbench/api/citations?itemKey=bad-key')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error.code, 'invalid_item_key')
})

test('POST /api/citation/:id/annotation 在 Zotero 10 前返回 501 占位，GET 405', async () => {
  const res = await requestJson(
    `/zotero-workbench/api/citation/${CITATION_FIXTURE_ID}/annotation`,
    { method: 'POST', body: '{}' },
  )
  assert.equal(res.status, 501)
  assert.equal(res.json.error.code, 'unsupported')
  assert.match(res.json.error.message, /Zotero 10/)

  const wrongMethod = await requestJson(
    `/zotero-workbench/api/citation/${CITATION_FIXTURE_ID}/annotation`,
  )
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.error.code, 'method_not_allowed')
})

test('apply 可选注册 systemPrompt 引文协议段（缺服务不影响激活）', () => {
  const sections = []
  const promptRoutes = []
  const promptCtx = {
    webServer: {
      register(route) {
        promptRoutes.push(route)
        return () => {}
      },
      getOrigin() {
        return ORIGIN
      },
    },
    effect(run) {
      return run()
    },
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            section(section) {
              sections.push(section)
            },
          },
        })
      }
    },
    logger: { error() {}, warn() {} },
  }
  const disposePrompt = apply(promptCtx)
  try {
    assert.equal(sections.length, 1)
    const section = sections[0]
    assert.equal(section.name, 'zotero-workbench:citation-protocol')
    assert.equal(section.order, 5000)
    assert.equal(typeof section.text, 'string')
    assert.match(section.text, /register_citation/)
    assert.match(section.text, /citation_source_list/)
    assert.match(section.text, /zotero-wb\.invalid\/c\//)
    assert.match(section.text, /read_fulltext/)
    assert.match(section.text, /read_page_text/)
    assert.match(section.text, /不得伪造/)
    assert.ok(promptRoutes.length >= 5, '协议注入不应影响路由注册')
  } finally {
    disposePrompt()
  }
})

test('POST /api/citation/annotation 旧前端路径返回 501 兼容提示（不是 405）', async () => {
  const compat = await requestJson('/zotero-workbench/api/citation/annotation', {
    method: 'POST',
    body: '{}',
  })
  assert.equal(compat.status, 501)
  assert.notEqual(compat.status, 405)
  assert.equal(compat.json.error.code, 'unsupported')
  assert.match(compat.json.error.message, /citationId/)
  assert.match(compat.json.error.message, /\/api\/citation\/<id>\/annotation/)
  assert.match(compat.json.error.message, /Zotero 10/)

  // 正确路径行为不变：仍是 501 unsupported，不是 405。
  const correct = await requestJson(
    `/zotero-workbench/api/citation/${CITATION_FIXTURE_ID}/annotation`,
    { method: 'POST', body: '{}' },
  )
  assert.equal(correct.status, 501)
  assert.notEqual(correct.status, 405)
  assert.equal(correct.json.error.code, 'unsupported')
  assert.match(correct.json.error.message, /Zotero 10/)
})

// ---------------------------------------------------------------------------
// dispose（放最后：会注销所有路由）
// ---------------------------------------------------------------------------

test('dispose 注销全部路由', () => {
  assert.ok(routes.length > 0)
  assert.ok(routes.every((route) => route.disposed !== true))
  dispose()
  assert.ok(routes.every((route) => route.disposed === true), 'dispose 后所有路由都应被移除')
  assert.equal(typeof dispose, 'function')
})

test('duplicates: versioned read-only candidates match the shared scanner', { skip: skipLive }, async () => {
  const {scanDuplicateCandidates}=await import('../../../src/domain/duplicates.mjs');
  const ground=await scanDuplicateCandidates(async path=>{const r=await fetch(ZOTERO_URL+path);assert.ok(r.ok);return {data:await r.json(),headers:r.headers};},'/api/users/0');
  const first=await requestJson('/zotero-workbench/api/maintenance?view=duplicates&limit=2');
  assert.equal(first.status,200,JSON.stringify(first.json));
  assert.equal(first.json.version,ground.version);assert.equal(first.json.total,ground.items.length);assert.deepEqual(first.json.items,ground.items.slice(0,2));
  assert.equal(first.json.status,'candidates-only');assert.equal(first.headers['cache-control'],'no-store');
  if(first.json.nextOffset!==null){
    const next=await requestJson(`/zotero-workbench/api/maintenance?view=duplicates&offset=2&limit=2&version=${ground.version}`);
    assert.equal(next.status,200);assert.deepEqual(next.json.items,ground.items.slice(2,4));
  }
  const unbound=await requestJson('/zotero-workbench/api/maintenance?view=duplicates&offset=2');assert.equal(unbound.status,400);
  const stale=await requestJson('/zotero-workbench/api/maintenance?view=duplicates&offset=2&version=0');assert.equal(stale.status,409);assert.match(stale.json.error.message,/重新检查/);
});
