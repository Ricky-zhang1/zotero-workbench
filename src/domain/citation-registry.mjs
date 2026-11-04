/**
 * 引文登记表（citation registry）：逐字引文角标的本机持久化。
 *
 * 设计约束（task-12）：
 * - Node 标准库，无第三方依赖；单进程追加写、多进程读（DSH Host 读取）；
 * - 追加写 JSONL（每行一条记录），写入后 fsync（失败容错，不因文件系统不支持而报错）；
 * - 读取按文件 mtime+size 缓存，外部进程追加后自动失效；坏行（半行、非 JSON）跳过；
 * - 记录格式版本 1：
 *   { id, library, itemKey, attachmentKey, pageIndex (0-based), pageLabel, quote (exact),
 *     requestedQuote, rects: [[x1,y1,x2,y2], ...] (PDF 用户空间), title, authors: [],
 *     year, venue, doi, itemType, verifiedAt, createdAt, version: 1 }
 *
 * 目录：$ZOTERO_WORKBENCH_STATE_DIR || ~/.local/share/zotero-workbench
 * 文件：<目录>/citations/registry.jsonl
 * 环境可覆盖：ZOTERO_WORKBENCH_CITATION_MAX（默认 5000）、
 *             ZOTERO_WORKBENCH_CITATION_TTL_DAYS（默认 90）。
 *
 * 本模块不做校验语义判断（quote 是否逐字、页码是否正确由 MCP 工具在登记前完成），
 * 只保证「记录能可靠落盘、按 id/条目读回、按上限与 TTL 清理」。
 */

import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_MAX = 5_000
const DEFAULT_TTL_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const RECORD_VERSION = 1

/** 读取缓存的键是登记文件路径（状态目录可被 env 改到临时目录，避免串数据）。 */
const cache = new Map()

/** 当前状态目录（每次调用时解析 env，测试可随时覆盖）。 */
export function stateDir() {
  const configured = process.env.ZOTERO_WORKBENCH_STATE_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.local/share/zotero-workbench')
}

/** 登记表文件路径：<stateDir>/citations/registry.jsonl。 */
export function registryFile() {
  return join(stateDir(), 'citations', 'registry.jsonl')
}

function readLimit(envValue, fallback) {
  const value = Number(envValue)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function readTtlMs(envValue) {
  const days = Number(envValue)
  return Number.isFinite(days) && days >= 0 ? days * DAY_MS : DEFAULT_TTL_DAYS * DAY_MS
}

/**
 * 读取全部登记记录（按文件顺序，旧→新）。
 * 坏行跳过：半截行、非 JSON、缺少 id 的对象都不影响其它记录。
 */
async function readRecords() {
  const file = registryFile()
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
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') continue
    records.push(record)
  }
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, records })
  return records
}

function normalizeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('citation record 必须是对象。')
  }
  if (typeof record.id !== 'string' || record.id === '') {
    throw new TypeError('citation record 缺少非空的 id。')
  }
  const now = Date.now()
  const rects = Array.isArray(record.rects)
    ? record.rects
        .filter((rect) => Array.isArray(rect) && rect.length >= 4)
        .map((rect) => rect.slice(0, 4).map((value) => Number(value)))
    : []
  return {
    ...record,
    version: RECORD_VERSION,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now,
    verifiedAt: Number.isFinite(record.verifiedAt) ? record.verifiedAt : now,
    rects,
  }
}

/**
 * 追加一条引文记录，返回实际落盘的规范化记录。
 * 用 O_APPEND 单行写入 + fsync；fsync 在部分文件系统上可能不支持，失败不阻断登记。
 */
export async function appendCitation(record) {
  const stored = normalizeRecord(record)
  const file = registryFile()
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

/** 按 id 取最新一条记录；不存在返回 null。 */
export async function getCitation(id) {
  if (typeof id !== 'string' || id === '') return null
  const records = await readRecords()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].id === id) return records[index]
  }
  return null
}

/** 同一文献（itemKey）下的引文，最新登记在前；limit 默认 50。 */
export async function listCitationsByItem(itemKey, limit = 50) {
  if (typeof itemKey !== 'string' || itemKey === '') return []
  const capped = Number.isInteger(limit) && limit > 0 ? limit : 50
  const records = await readRecords()
  const matching = []
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].itemKey === itemKey) matching.push(records[index])
  }
  return matching.slice(0, capped)
}

/**
 * 清理登记表：先按 TTL 去掉过期记录，再保留最新的 max 条。
 * 有删除时原子重写文件（临时文件 + rename）；没有删除时不动文件。
 * 返回 { removed, kept, total, max, ttlMs }。
 */
export async function pruneCitations(options = {}) {
  const envMax = process.env.ZOTERO_WORKBENCH_CITATION_MAX
  const envTtlDays = process.env.ZOTERO_WORKBENCH_CITATION_TTL_DAYS
  const max =
    Number.isInteger(options.max) && options.max > 0 ? options.max : readLimit(envMax, DEFAULT_MAX)
  const ttlMs =
    Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : readTtlMs(envTtlDays)
  const records = await readRecords()
  const now = Date.now()
  const fresh = records.filter((record) => {
    const createdAt = Number(record?.createdAt)
    return !Number.isFinite(createdAt) || now - createdAt <= ttlMs
  })
  const kept = fresh.slice(Math.max(0, fresh.length - max))
  const removed = records.length - kept.length
  if (removed > 0) {
    const file = registryFile()
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.${now}.tmp`
    const text = kept.length === 0 ? '' : `${kept.map((record) => JSON.stringify(record)).join('\n')}\n`
    await writeFile(temp, text, { mode: 0o600 })
    await rename(temp, file)
    cache.delete(file)
  }
  return { removed, kept: kept.length, total: records.length, max, ttlMs }
}

/** 仅用于测试/诊断：丢掉读取缓存。 */
export function clearCitationCache() {
  cache.clear()
}
