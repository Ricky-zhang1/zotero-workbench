/**
 * 审计 P2 修复的离线测试（node:test，无 Zotero、无网络）。
 *
 * 覆盖：
 * - P2.6：register_citation 写入后的低频 registry 清理（20 次阈值触发 TTL 清理）；
 * - P2.7：pdftotext 默认 4s 超时（PDFTOTEXT_TIMEOUT_MS 可覆盖）、卡死回退耗时 <4.5s、
 *         read_page_text 逐页 textSource 与混合来源 'mixed' + fallbackReason。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ZoteroError } from '../dist/runtime.mjs'
import { appendCitation, registryFile } from '../src/domain/citation-registry.mjs'
import {
  collectPageTexts,
  extractPageTextWithPoppler,
  maybePruneCitationRegistry,
  popplerTimeoutMs,
  resetCitationPruneState,
} from '../src/server.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

function makeFallbackError(reason) {
  const error = new ZoteroError('quote_unverifiable', `mock poppler failure: ${reason}`)
  error.fallbackReason = reason
  return error
}

function record(index, createdAt) {
  return {
    id: String(index).padStart(12, '0'),
    library: 'user',
    itemKey: '3DWU883L',
    attachmentKey: '4GCTAFMJ',
    pageIndex: 0,
    pageLabel: '1',
    quote: `逐字引文 ${index}`,
    requestedQuote: `逐字引文 ${index}`,
    rects: [],
    title: '题名',
    authors: [],
    year: '2022',
    venue: '',
    doi: '',
    itemType: 'journalArticle',
    verifiedAt: createdAt,
    createdAt,
    version: 1,
  }
}

test('P2.7 popplerTimeoutMs 默认 4s，PDFTOTEXT_TIMEOUT_MS 可覆盖', () => {
  const previous = process.env.PDFTOTEXT_TIMEOUT_MS
  try {
    delete process.env.PDFTOTEXT_TIMEOUT_MS
    assert.equal(popplerTimeoutMs(), 4000)
    process.env.PDFTOTEXT_TIMEOUT_MS = '600'
    assert.equal(popplerTimeoutMs(), 600)
    process.env.PDFTOTEXT_TIMEOUT_MS = '120000'
    assert.equal(popplerTimeoutMs(), 60000)
    process.env.PDFTOTEXT_TIMEOUT_MS = 'not-a-number'
    assert.equal(popplerTimeoutMs(), 4000)
  } finally {
    restoreEnv('PDFTOTEXT_TIMEOUT_MS', previous)
  }
})

test('P2.7 pdftotext 卡住时默认 4s 内回退（elapsed < 4.5s，fallbackReason=poppler_timeout）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-slow-poppler-'))
  const previousPath = process.env.PDFTOTEXT_PATH
  const previousTimeout = process.env.PDFTOTEXT_TIMEOUT_MS
  delete process.env.PDFTOTEXT_TIMEOUT_MS
  try {
    const binary = join(dir, 'pdftotext')
    await writeFile(binary, '#!/bin/sh\nsleep 30\nexit 0\n', 'utf8')
    await chmod(binary, 0o755)
    process.env.PDFTOTEXT_PATH = binary
    const startedAt = Date.now()
    await assert.rejects(
      () => extractPageTextWithPoppler({ path: join(dir, 'fake.pdf'), page: 1 }),
      (error) => {
        assert.equal(error.code, 'quote_unverifiable')
        assert.equal(error.fallbackReason, 'poppler_timeout')
        return true
      },
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 4500, `慢 poppler 应在 4.5s 内回退，实际 ${elapsed}ms`)
    assert.ok(elapsed >= 3000, `应先等约 4s 超时再回退，实际 ${elapsed}ms`)
  } finally {
    restoreEnv('PDFTOTEXT_PATH', previousPath)
    restoreEnv('PDFTOTEXT_TIMEOUT_MS', previousTimeout)
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2.7 pdftotext 非超时失败标记 poppler_error（不是 poppler_timeout）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-fail-poppler-'))
  const previousPath = process.env.PDFTOTEXT_PATH
  const previousTimeout = process.env.PDFTOTEXT_TIMEOUT_MS
  delete process.env.PDFTOTEXT_TIMEOUT_MS
  try {
    const binary = join(dir, 'pdftotext')
    await writeFile(binary, '#!/bin/sh\necho "injected per-page failure" >&2\nexit 2\n', 'utf8')
    await chmod(binary, 0o755)
    process.env.PDFTOTEXT_PATH = binary
    await assert.rejects(
      () => extractPageTextWithPoppler({ path: join(dir, 'fake.pdf'), page: 1 }),
      (error) => {
        assert.equal(error.code, 'quote_unverifiable')
        assert.equal(error.fallbackReason, 'poppler_error')
        return true
      },
    )
  } finally {
    restoreEnv('PDFTOTEXT_PATH', previousPath)
    restoreEnv('PDFTOTEXT_TIMEOUT_MS', previousTimeout)
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2.7 PDFTOTEXT_TIMEOUT_MS 覆盖后快速回退（<2s）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-slow-poppler-override-'))
  const previousPath = process.env.PDFTOTEXT_PATH
  const previousTimeout = process.env.PDFTOTEXT_TIMEOUT_MS
  try {
    const binary = join(dir, 'pdftotext')
    await writeFile(binary, '#!/bin/sh\nsleep 30\nexit 0\n', 'utf8')
    await chmod(binary, 0o755)
    process.env.PDFTOTEXT_PATH = binary
    process.env.PDFTOTEXT_TIMEOUT_MS = '600'
    const startedAt = Date.now()
    await assert.rejects(
      () => extractPageTextWithPoppler({ path: join(dir, 'fake.pdf'), page: 1 }),
      (error) => error.fallbackReason === 'poppler_timeout',
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 2000, `覆盖超时后应在 2s 内回退，实际 ${elapsed}ms`)
  } finally {
    restoreEnv('PDFTOTEXT_PATH', previousPath)
    restoreEnv('PDFTOTEXT_TIMEOUT_MS', previousTimeout)
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2.7 collectPageTexts 逐页 textSource：全 poppler / 全 pdfjs / 混合 mixed', async () => {
  const pdfPages = [
    { label: '1', text: 'pdfjs 第一页' },
    { label: '2', text: 'pdfjs 第二页' },
    { label: '3', text: 'pdfjs 第三页' },
  ]

  const mixed = await collectPageTexts({
    pdfPages,
    pdfPath: '/tmp/fake.pdf',
    pageNumbers: [1, 2, 3],
    maxChars: 10000,
    extractPageText: async ({ page }) => {
      if (page === 1) return 'poppler 第一页'
      throw makeFallbackError('poppler_error')
    },
  })
  assert.equal(mixed.textSource, 'mixed')
  assert.deepEqual(mixed.pages.map((entry) => entry.textSource), ['poppler', 'pdfjs', 'pdfjs'])
  assert.equal(mixed.pages[0].fallbackReason, undefined)
  assert.equal(mixed.pages[1].fallbackReason, 'poppler_error')
  assert.equal(mixed.fallbackReason, 'poppler_error')
  assert.match(mixed.text, /--- page 1 ---\npoppler 第一页/)
  assert.match(mixed.text, /--- page 2 ---\npdfjs 第二页/)
  assert.deepEqual(mixed.pages.map((entry) => entry.page), [1, 2, 3])

  const allPoppler = await collectPageTexts({
    pdfPages,
    pdfPath: '/tmp/fake.pdf',
    pageNumbers: [1, 2],
    maxChars: 10000,
    extractPageText: async ({ page }) => `poppler ${page}`,
  })
  assert.equal(allPoppler.textSource, 'poppler')
  assert.equal(allPoppler.fallbackReason, undefined)
  assert.deepEqual(allPoppler.pages.map((entry) => entry.textSource), ['poppler', 'poppler'])

  const allPdfjs = await collectPageTexts({
    pdfPages,
    pdfPath: '/tmp/fake.pdf',
    pageNumbers: [1, 2],
    maxChars: 10000,
    extractPageText: async () => {
      throw makeFallbackError('poppler_unavailable')
    },
  })
  assert.equal(allPdfjs.textSource, 'pdfjs')
  assert.equal(allPdfjs.fallbackReason, 'poppler_unavailable')
  assert.deepEqual(allPdfjs.pages.map((entry) => entry.textSource), ['pdfjs', 'pdfjs'])
  assert.deepEqual(allPdfjs.pages.map((entry) => entry.fallbackReason), ['poppler_unavailable', 'poppler_unavailable'])
  assert.match(allPdfjs.text, /pdfjs 第一页/)
})

test('P2.6 第 20 次写入触发 registry 清理，TTL 过期记录被删除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-prune-'))
  const previousStateDir = process.env.ZOTERO_WORKBENCH_STATE_DIR
  process.env.ZOTERO_WORKBENCH_STATE_DIR = dir
  resetCitationPruneState()
  try {
    const now = Date.now()
    const expired = now - 100 * DAY_MS
    for (let index = 0; index < 25; index += 1) await appendCitation(record(index, expired))
    const file = registryFile()
    const lineCount = async () => (await readFile(file, 'utf8')).split('\n').filter(Boolean).length
    assert.equal(await lineCount(), 25)

    for (let index = 0; index < 19; index += 1) {
      const outcome = await maybePruneCitationRegistry()
      assert.equal(outcome.pruned, false)
    }
    assert.equal(await lineCount(), 25, '前 19 次写入不应触发清理')

    const twentieth = await maybePruneCitationRegistry()
    assert.equal(twentieth.pruned, true)
    assert.equal(twentieth.removed, 25)
    assert.equal(twentieth.kept, 0)
    assert.equal(await lineCount(), 0, '第 20 次写入应触发清理并删掉全部过期记录')
  } finally {
    restoreEnv('ZOTERO_WORKBENCH_STATE_DIR', previousStateDir)
    resetCitationPruneState()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2.6 清理失败不抛出（静默）', async () => {
  // 把状态目录指到不可写路径（文件而非目录）让 mkdir/append 或 prune 失败；
  // 这里直接用一个不存在的可执行 pdftotext 无关，构造 prune 抛错场景：
  // ZOTERO_WORKBENCH_STATE_DIR 指向 /dev/null 下的子路径时 readRecords/stat 会报错。
  const previousStateDir = process.env.ZOTERO_WORKBENCH_STATE_DIR
  process.env.ZOTERO_WORKBENCH_STATE_DIR = '/dev/null/zotero-wb-prune-fail'
  resetCitationPruneState()
  try {
    const outcome = await maybePruneCitationRegistry()
    // 第一次调用未到阈值 → pruned:false；随后强制到阈值也不会抛异常。
    assert.equal(typeof outcome, 'object')
    let last
    for (let index = 0; index < 20; index += 1) last = await maybePruneCitationRegistry()
    assert.equal(typeof last, 'object')
  } finally {
    restoreEnv('ZOTERO_WORKBENCH_STATE_DIR', previousStateDir)
    resetCitationPruneState()
  }
})
