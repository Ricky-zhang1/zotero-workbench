/**
 * 引文登记表离线测试（node:test，无第三方依赖、无 Zotero）。
 *
 * 运行：`node tests/citation-registry.test.mjs`（或 `node --test tests/*.test.mjs`）
 *
 * 覆盖：默认路径/env 覆盖、append/get/list、坏行容忍、外部追加后缓存失效、
 * TTL 清理、上限清理、env 覆盖清理参数、并发追加。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendCitation,
  clearCitationCache,
  getCitation,
  listCitationsByItem,
  pruneCitations,
  registryFile,
  stateDir,
} from '../src/domain/citation-registry.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

async function withStateDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-citations-'))
  const previous = process.env.ZOTERO_WORKBENCH_STATE_DIR
  process.env.ZOTERO_WORKBENCH_STATE_DIR = dir
  clearCitationCache()
  try {
    return await run(dir)
  } finally {
    clearCitationCache()
    if (previous === undefined) delete process.env.ZOTERO_WORKBENCH_STATE_DIR
    else process.env.ZOTERO_WORKBENCH_STATE_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}

function record(overrides = {}) {
  const now = Date.now()
  return {
    id: 'aaaaaaaaaaaa',
    library: 'user',
    itemKey: '3DWU883L',
    attachmentKey: '4GCTAFMJ',
    pageIndex: 4,
    pageLabel: '5',
    quote: '逐字引文',
    requestedQuote: '逐字引文',
    rects: [[1, 2, 3, 4]],
    title: '题名',
    authors: ['作者'],
    year: '2022',
    venue: '期刊',
    doi: '10.1000/example',
    itemType: 'journalArticle',
    verifiedAt: now,
    createdAt: now,
    version: 1,
    ...overrides,
  }
}

test('registryFile 默认在 ~/.local/share/zotero-workbench，可被 env 覆盖', async () => {
  const previous = process.env.ZOTERO_WORKBENCH_STATE_DIR
  delete process.env.ZOTERO_WORKBENCH_STATE_DIR
  try {
    assert.equal(
      registryFile(),
      join(homedir(), '.local/share/zotero-workbench', 'citations', 'registry.jsonl'),
    )
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_WORKBENCH_STATE_DIR
    else process.env.ZOTERO_WORKBENCH_STATE_DIR = previous
  }

  await withStateDir(async (dir) => {
    assert.equal(stateDir(), dir)
    assert.equal(registryFile(), join(dir, 'citations', 'registry.jsonl'))
  })
})

test('appendCitation 落盘并规范化版本/时间/rects，getCitation 按 id 读回', async () => {
  await withStateDir(async () => {
    const stored = await appendCitation(
      record({
        id: '0123456789ab',
        rects: [
          [1, 2, 3, 4],
          [9, 8, 7], // 不完整 rect 会被丢弃
        ],
      }),
    )
    assert.equal(stored.version, 1)
    assert.equal(typeof stored.createdAt, 'number')
    assert.equal(typeof stored.verifiedAt, 'number')
    assert.deepEqual(stored.rects, [[1, 2, 3, 4]])

    const loaded = await getCitation('0123456789ab')
    assert.equal(loaded.id, '0123456789ab')
    assert.equal(loaded.quote, '逐字引文')
    assert.equal(loaded.itemKey, '3DWU883L')
    assert.equal(loaded.attachmentKey, '4GCTAFMJ')
    assert.equal(loaded.pageIndex, 4)
    assert.equal(loaded.pageLabel, '5')
    assert.equal(await getCitation('ffffffffffff'), null)
    assert.equal(await getCitation(''), null)

    // 文件是 JSONL：一行一条记录。
    const lines = (await readFile(registryFile(), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).id, '0123456789ab')
  })
})

test('appendCitation 拒绝没有 id 的记录', async () => {
  await withStateDir(async () => {
    await assert.rejects(() => appendCitation({ quote: 'x' }), /id/)
    await assert.rejects(() => appendCitation(null), TypeError)
  })
})

test('listCitationsByItem 按条目过滤、最新在前、limit 生效', async () => {
  await withStateDir(async () => {
    await appendCitation(record({ id: '111111111111', createdAt: 1_000 }))
    await appendCitation(record({ id: '222222222222', createdAt: 2_000 }))
    await appendCitation(record({ id: '333333333333', itemKey: 'NBTPKHRF', createdAt: 3_000 }))

    assert.deepEqual(
      (await listCitationsByItem('3DWU883L')).map((entry) => entry.id),
      ['222222222222', '111111111111'],
    )
    assert.deepEqual(
      (await listCitationsByItem('3DWU883L', 1)).map((entry) => entry.id),
      ['222222222222'],
    )
    assert.deepEqual(await listCitationsByItem('ZZZZZZZZ'), [])
    assert.deepEqual(await listCitationsByItem('', 10), [])
  })
})

test('坏行跳过，且外部进程追加后按 mtime/size 失效缓存', async () => {
  await withStateDir(async () => {
    await appendCitation(record({ id: 'aaaaaaaaaaaa' }))
    const file = registryFile()
    // 坏行：非 JSON、缺 id、以及最后一个没有换行的半截行。
    await appendFile(file, 'not json\n{"id":"","broken":true}\n{"half":\n')
    assert.equal((await getCitation('aaaaaaaaaaaa')).id, 'aaaaaaaaaaaa')

    // 模拟 MCP 进程（另一进程）直接追加：缓存应因文件变化而失效。
    const external = record({ id: 'bbbbbbbbbbbb', itemKey: 'NBTPKHRF', quote: '外部追加' })
    await appendFile(file, `${JSON.stringify(external)}\n`)
    assert.equal((await getCitation('bbbbbbbbbbbb')).id, 'bbbbbbbbbbbb')
    assert.equal((await listCitationsByItem('NBTPKHRF')).length, 1)

    // 清理触发原子重写时，坏行一并被丢弃。
    const pruned = await pruneCitations({ max: 1, ttlMs: 365 * DAY_MS })
    assert.equal(pruned.removed, 1)
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).id, 'bbbbbbbbbbbb')
  })
})

test('pruneCitations 默认按 90 天 TTL 清理过期记录', async () => {
  await withStateDir(async () => {
    const now = Date.now()
    await appendCitation(
      record({ id: 'oldoldoldold', createdAt: now - 100 * DAY_MS, verifiedAt: now - 100 * DAY_MS }),
    )
    await appendCitation(record({ id: 'newnewnewnew', createdAt: now }))
    const result = await pruneCitations()
    assert.equal(result.removed, 1)
    assert.equal(result.kept, 1)
    assert.equal(result.ttlMs, 90 * DAY_MS)
    assert.equal(await getCitation('oldoldoldold'), null)
    assert.equal((await getCitation('newnewnewnew')).id, 'newnewnewnew')
    // 无变化时再清理不重复计数、不重写
    const again = await pruneCitations()
    assert.equal(again.removed, 0)
    assert.equal(again.kept, 1)
  })
})

test('pruneCitations 上限清理保留最新 max 条', async () => {
  await withStateDir(async () => {
    const now = Date.now()
    for (let index = 0; index < 5; index += 1) {
      await appendCitation(
        record({ id: `${String(index).padStart(12, '0')}`, createdAt: now - (5 - index) * 1_000 }),
      )
    }
    const result = await pruneCitations({ max: 2, ttlMs: 365 * DAY_MS })
    assert.equal(result.removed, 3)
    assert.equal(result.kept, 2)
    assert.equal(await getCitation('000000000000'), null)
    assert.equal((await getCitation('000000000003')).id, '000000000003')
    assert.equal((await getCitation('000000000004')).id, '000000000004')
  })
})

test('ZOTERO_WORKBENCH_CITATION_MAX / TTL_DAYS 覆盖默认清理参数', async () => {
  await withStateDir(async () => {
    const previousMax = process.env.ZOTERO_WORKBENCH_CITATION_MAX
    const previousTtl = process.env.ZOTERO_WORKBENCH_CITATION_TTL_DAYS
    process.env.ZOTERO_WORKBENCH_CITATION_MAX = '2'
    process.env.ZOTERO_WORKBENCH_CITATION_TTL_DAYS = '30'
    try {
      const now = Date.now()
      await appendCitation(
        record({ id: 'oldoldoldold', createdAt: now - 100 * DAY_MS, verifiedAt: now - 100 * DAY_MS }),
      )
      for (let index = 0; index < 4; index += 1) {
        await appendCitation(record({ id: `n${String(index).padStart(11, '0')}`, createdAt: now }))
      }
      const result = await pruneCitations()
      assert.equal(result.max, 2)
      assert.equal(result.ttlMs, 30 * DAY_MS)
      assert.equal(result.removed, 3) // 1 条 TTL 过期 + 2 条超出上限
      assert.equal(result.kept, 2)
    } finally {
      if (previousMax === undefined) delete process.env.ZOTERO_WORKBENCH_CITATION_MAX
      else process.env.ZOTERO_WORKBENCH_CITATION_MAX = previousMax
      if (previousTtl === undefined) delete process.env.ZOTERO_WORKBENCH_CITATION_TTL_DAYS
      else process.env.ZOTERO_WORKBENCH_CITATION_TTL_DAYS = previousTtl
    }
  })
})

test('并发追加（O_APPEND 单行写）不丢记录', async () => {
  await withStateDir(async () => {
    const now = Date.now()
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendCitation(record({ id: `c${String(index).padStart(11, '0')}`, createdAt: now + index })),
      ),
    )
    const all = await listCitationsByItem('3DWU883L', 100)
    assert.equal(all.length, 20)
    assert.equal(new Set(all.map((entry) => entry.id)).size, 20)
    const lines = (await readFile(registryFile(), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 20)
  })
})
