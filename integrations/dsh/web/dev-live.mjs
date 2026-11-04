/**
 * dev-server 的「真实 Zotero 代理」后端（--mode live）。
 *
 * 直接把本机 Zotero 本地 API（默认 http://127.0.0.1:23119）映射成 Host half 的
 * 只读契约，并从 ~/Zotero/storage/<attachmentKey>/<filename> 读取 PDF 字节。
 * 仅用于本地自测：不写 Zotero、不调用 Zotero MCP、不做任何写操作。
 *
 * 已知限制（dev-only，不影响真实 Host half）：
 * - Zotero API 的 itemType=-attachment 只支持单值排除，note 可能混入列表后被本地过滤，
 *   因此「一页不满」时 nextStart 可能提前结束；真实宿主实现不受此影响。
 * - 只读取 storage 目录或 enclosure file:// 指向的 PDF。
 */

import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildCitations } from './dev-export.mjs';

const DEFAULT_ZOTERO_URL = process.env.ZOTERO_URL || 'http://127.0.0.1:23119';
const DEFAULT_STORAGE_DIR = process.env.ZOTERO_STORAGE || path.join(homedir(), 'Zotero', 'storage');

const SORT_MAP = {
  dateModified: 'dateModified',
  dateAdded: 'dateAdded',
  title: 'title',
  creator: 'creator',
  year: 'date',
  date: 'date',
  itemType: 'itemType',
  publisher: 'publisher',
};

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAnnotationPosition(position) {
  try {
    const parsed = typeof position === 'string' ? JSON.parse(position) : position;
    const pageIndex = Number(parsed?.pageIndex);
    const rects = Array.isArray(parsed?.rects)
      ? parsed.rects
          .filter((rect) => Array.isArray(rect) && rect.length >= 4)
          .map((rect) => rect.slice(0, 4).map(Number))
          .filter((rect) => rect.every((value) => Number.isFinite(value)))
      : [];
    return { pageIndex: Number.isFinite(pageIndex) ? pageIndex : null, rects };
  } catch {
    return { pageIndex: null, rects: [] };
  }
}

function creatorNames(creators) {
  return (creators || [])
    .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(' '))
    .filter(Boolean);
}

function isPdfAttachment(attachment) {
  const data = attachment?.data || attachment || {};
  const filename = String(data.filename || '');
  return String(data.contentType || '') === 'application/pdf' || /\.pdf$/i.test(filename);
}

function annotationToContract(annotation) {
  const data = annotation.data || {};
  const position = parseAnnotationPosition(data.annotationPosition);
  const parentAttachment = data.parentItem || '';
  return {
    key: data.key,
    parentAttachment,
    type: data.annotationType || 'highlight',
    text: data.annotationText || '',
    comment: data.annotationComment || '',
    color: data.annotationColor || '#ffd400',
    pageLabel: data.annotationPageLabel || '',
    pageIndex: position.pageIndex,
    rects: position.rects,
    tags: (data.tags || []).map((tag) => tag.tag).filter(Boolean),
    dateAdded: data.dateAdded || '',
    sortIndex: data.annotationSortIndex || '',
  };
}

/**
 * @param {{zoteroUrl?:string, storageDir?:string}} options
 */
export function createLiveBackend({ zoteroUrl = DEFAULT_ZOTERO_URL, storageDir = DEFAULT_STORAGE_DIR } = {}) {
  const base = String(zoteroUrl).replace(/\/+$/, '');
  let collectionCache = null;
  let collectionCacheAt = 0;
  let maintenanceCache = null;
  let maintenanceCacheAt = 0;

  async function request(pathname, { query = {}, timeout = 12000 } = {}) {
    const url = new URL(`${base}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw httpError(
        503,
        'zotero_unreachable',
        `无法连接 Zotero 本地 API（${base}）：${error && error.message ? error.message : error}`,
      );
    }
    if (!response.ok) {
      throw httpError(
        502,
        'zotero_http_error',
        `Zotero 本地 API 返回 HTTP ${response.status}（${pathname}）`,
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw httpError(502, 'zotero_bad_json', `Zotero 本地 API 返回的不是 JSON：${error.message}`);
    }
    return { data, headers: response.headers };
  }

  async function fetchAllPages(pathname, { limit = 100, max = 1000, query = {} } = {}) {
    const all = [];
    let start = 0;
    while (start < max) {
      const { data } = await request(pathname, { query: { ...query, limit, start } });
      if (!Array.isArray(data)) break;
      all.push(...data);
      if (data.length < limit) break;
      start += limit;
    }
    return all.slice(0, max);
  }

  async function getCollections() {
    if (collectionCache && Date.now() - collectionCacheAt < 5 * 60 * 1000) return collectionCache;
    const raw = await fetchAllPages('/api/users/0/collections');
    const list = raw.map((collection) => {
      const data = collection.data || collection;
      return {
        key: data.key,
        name: data.name,
        parentCollection: data.parentCollection || null,
        itemCount: Number(collection.meta?.numItems ?? 0) || 0,
      };
    });
    const byKey = new Map(list.map((collection) => [collection.key, collection]));
    for (const collection of list) {
      let depth = 0;
      let cursor = collection;
      const seen = new Set();
      while (cursor && cursor.parentCollection && !seen.has(cursor.key)) {
        seen.add(cursor.key);
        cursor = byKey.get(cursor.parentCollection);
        if (cursor) depth += 1;
        else break;
      }
      collection.depth = depth;
    }
    collectionCache = list;
    collectionCacheAt = Date.now();
    return list;
  }

  async function getAttachmentFile(attachment) {
    const data = attachment?.data || attachment || {};
    const href = attachment?.links?.enclosure?.href || data.enclosureHref || '';
    if (href && href.startsWith('file://')) {
      try {
        const filePath = fileURLToPath(href);
        const info = await stat(filePath).catch(() => null);
        if (info && info.isFile()) return { filePath, size: info.size };
      } catch {
        /* 继续尝试 storage 目录 */
      }
    }
    const filename = String(data.filename || '');
    if (!filename) return null;
    const filePath = path.join(storageDir, String(data.key || attachment.key || ''), filename);
    const info = await stat(filePath).catch(() => null);
    if (info && info.isFile()) return { filePath, size: info.size };
    return null;
  }

  async function scanMaintenanceData() {
    if (maintenanceCache && Date.now() - maintenanceCacheAt < 120000) return maintenanceCache;
    const [topItems, attachments] = await Promise.all([
      fetchAllPages('/api/users/0/items/top', { limit: 100, max: 2000 }),
      fetchAllPages('/api/users/0/items', { limit: 100, max: 5000, query: { itemType: 'attachment' } }),
    ]);
    const pdfParents = new Set();
    for (const attachment of attachments) {
      const data = attachment.data || {};
      const isPdf = String(data.contentType || '') === 'application/pdf' || /\.pdf$/i.test(String(data.filename || ''));
      if (isPdf && data.parentItem) pdfParents.add(String(data.parentItem));
    }
    maintenanceCache = {
      topItems,
      pdfParents,
      truncated: topItems.length >= 2000,
      at: Date.now(),
    };
    maintenanceCacheAt = Date.now();
    return maintenanceCache;
  }

  async function getItemChildren(key, query = {}) {
    return fetchAllPages(`/api/users/0/items/${encodeURIComponent(key)}/children`, { limit: 100, max: 500, query });
  }

  const citationCache = new Map();

  function citationIdFor(annotationKey) {
    return createHash('sha1').update(String(annotationKey || '')).digest('hex').slice(0, 12);
  }

  async function buildCitationRecordsForItem(itemKey, limit = 20) {
    const { data: item } = await request(`/api/users/0/items/${encodeURIComponent(itemKey)}`);
    if (!item || !item.data) throw httpError(404, 'item_not_found', `Zotero 中找不到条目 ${itemKey}`);
    const children = await getItemChildren(item.key);
    const attachments = children.filter((child) => child.data?.itemType === 'attachment' && isPdfAttachment(child));
    const records = [];
    for (const attachment of attachments) {
      const annotations = await getItemChildren(attachment.data.key, { itemType: 'annotation' });
      for (const annotation of annotations) {
        const contract = annotationToContract(annotation);
        if (!contract.rects || !contract.rects.length) continue;
        const pageIndex = Number.isFinite(contract.pageIndex) ? contract.pageIndex : 0;
        const record = {
          id: citationIdFor(contract.key),
          itemKey: item.key,
          attachmentKey: attachment.data.key,
          pageIndex,
          pageLabel: contract.pageLabel || String(pageIndex + 1),
          quote: contract.text || '',
          rects: contract.rects,
          title: item.data.title || '',
          authors: creatorNames(item.data.creators).join('、'),
          year: (String(item.data.date || '').match(/\d{4}/) || [''])[0],
          venue: item.data.publicationTitle || '',
          doi: item.data.DOI || '',
          verifiedAt: new Date().toISOString(),
          zoteroItemUrl: `zotero://select/library/items/${item.key}`,
          zoteroPdfUrl: `zotero://open-pdf/library/items/${attachment.data.key}?page=${pageIndex + 1}`,
        };
        citationCache.set(record.id, record);
        records.push(record);
        if (records.length >= limit) return records;
      }
    }
    return records;
  }

  async function resolvePdfAttachment(key) {
    let item = null;
    try {
      const { data } = await request(`/api/users/0/items/${encodeURIComponent(key)}`);
      item = data;
    } catch (error) {
      if (error.status === 502) throw error;
      throw httpError(404, 'item_not_found', `Zotero 中找不到条目 ${key}`);
    }
    if (item.data?.itemType === 'attachment') {
      const file = await getAttachmentFile(item);
      if (file) return { attachment: item, file };
      throw httpError(404, 'pdf_not_found', `附件 ${key} 在 Zotero storage 中没有可读取的文件`);
    }
    const children = await getItemChildren(item.key);
    const attachments = children.filter((child) => child.data?.itemType === 'attachment');
    for (const attachment of attachments) {
      if (!isPdfAttachment(attachment)) continue;
      const file = await getAttachmentFile(attachment);
      if (file) return { attachment, file };
    }
    throw httpError(404, 'pdf_not_found', `条目 ${key} 没有可读取的 PDF 附件`);
  }

  return {
    mode: 'live',

    async health() {
      try {
        await request('/api/users/0/items', { query: { limit: 1 }, timeout: 4000 });
        return {
          ok: true,
          version: '0.10.0-dev-live',
          mode: 'live',
          zotero: { reachable: true },
          writes: { annotations: false, reason: 'requires-zotero-10' },
        };
      } catch (error) {
        return {
          ok: true,
          version: '0.10.0-dev-live',
          mode: 'live',
          zotero: { reachable: false },
          writes: { annotations: false, reason: 'requires-zotero-10' },
          error: { code: error.code || 'zotero_unreachable', message: error.message },
        };
      }
    },

    async collections(library) {
      const [collections, searches] = await Promise.all([
        getCollections(),
        fetchAllPages('/api/users/0/searches', { limit: 100, max: 200 }).catch(() => []),
      ]);
      return {
        library: library || 'user',
        libraries: [{ id: 'user', type: 'user', name: '我的文库' }],
        collections: collections.map((collection) => ({
          ...collection,
          meta: { numItems: collection.itemCount },
        })),
        savedSearches: searches.map((search) => ({
          key: search.data?.key || search.key,
          name: search.data?.name || search.name || '(未命名搜索)',
        })),
      };
    },

    async items({ q = '', collection = '', sort = 'dateModified', direction = '', start = 0, limit = 25, mode = 'all', tag = '' } = {}) {
      const zoteroSort = SORT_MAP[sort] || 'dateModified';
      const defaultDirection = zoteroSort === 'title' || zoteroSort === 'creator' ? 'asc' : 'desc';
      const requestedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
      const startIndex = Math.max(0, Number(start) || 0);
      const pathname = collection
        ? `/api/users/0/collections/${encodeURIComponent(collection)}/items`
        : '/api/users/0/items';
      const query = {
        limit: requestedLimit,
        start: startIndex,
        sort: zoteroSort,
        direction: direction || defaultDirection,
        itemType: '-attachment',
      };
      if (q) query.q = q;
      if (mode === 'everything') query.qmode = 'everything';
      if (tag) query.tag = tag;

      const { data, headers } = await request(pathname, { query });
      const raw = Array.isArray(data) ? data : [];
      const filtered = raw.filter(
        (entry) => entry?.data && entry.data.itemType !== 'note' && entry.data.itemType !== 'annotation',
      );
      const totalHeader = headers.get('Total-Results');
      const total = totalHeader !== null && totalHeader !== '' ? Number(totalHeader) : null;
      const nextStart = raw.length < requestedLimit ? null : startIndex + raw.length;

      return {
        library: 'user',
        items: filtered.map((entry) => {
          const item = entry.data;
          const yearMatch = String(item.date || '').match(/\d{4}/);
          const attachmentHref = entry.links?.attachment?.href || '';
          const attachmentKeyMatch = attachmentHref.match(/\/items\/([A-Z0-9]{8})$/);
          return {
            key: item.key,
            version: entry.version,
            itemType: item.itemType,
            title: item.title,
            creators: {
              authors: creatorNames(item.creators),
              year: yearMatch ? yearMatch[0] : '',
            },
            date: item.date || '',
            dateAdded: item.dateAdded || '',
            dateModified: item.dateModified || '',
            collectionKeys: item.collections || [],
            tags: (item.tags || []).map((tagEntry) => tagEntry.tag).filter(Boolean),
            pdf: attachmentKeyMatch ? { key: attachmentKeyMatch[1] } : null,
            numChildren: entry.meta?.numChildren ?? 0,
          };
        }),
        nextStart,
        total: Number.isFinite(total) ? total : null,
        start: startIndex,
        limit: requestedLimit,
        sort: zoteroSort,
        direction: direction || defaultDirection,
      };
    },

    async item({ key } = {}) {
      const requested = String(key || '');
      if (!requested) throw httpError(400, 'bad_request', '缺少 key 参数');
      const { data: rawItem } = await request(`/api/users/0/items/${encodeURIComponent(requested)}`);
      let item = rawItem;
      if (item?.data?.itemType === 'attachment' && item.data.parentItem) {
        const parent = await request(`/api/users/0/items/${encodeURIComponent(item.data.parentItem)}`);
        item = parent.data;
      }
      if (!item?.data) throw httpError(404, 'item_not_found', `Zotero 中找不到条目 ${requested}`);

      const [children, collections] = await Promise.all([getItemChildren(item.key), getCollections()]);
      const attachments = [];
      const notes = [];
      const annotations = [];
      for (const child of children) {
        if (child.data?.itemType === 'attachment') {
          const data = child.data;
          attachments.push({
            key: data.key,
            title: data.title || data.filename || '附件',
            filename: data.filename || '',
            contentType: data.contentType || '',
            path: data.path || '',
            isPdf: isPdfAttachment(child),
            linkMode: data.linkMode || '',
          });
        } else if (child.data?.itemType === 'note') {
          notes.push({
            key: child.data.key,
            html: child.data.note || '',
            excerpt: stripHtml(child.data.note || '').slice(0, 160),
            dateModified: child.data.dateModified || '',
          });
        }
      }
      for (const attachment of attachments) {
        if (!attachment.isPdf) continue;
        // 关键：Zotero 本地 API 的 children 端点默认过滤掉 annotation，
        // 必须显式 itemType=annotation 才能拿到批注子项（实测 Zotero 9.0.6）。
        const subChildren = await getItemChildren(attachment.key, { itemType: 'annotation' });
        for (const child of subChildren) {
          if (child.data?.itemType === 'annotation') annotations.push(annotationToContract(child));
        }
      }

      const collectionNames = {};
      for (const collection of collections) collectionNames[collection.key] = collection.name;
      return {
        key: item.key,
        version: item.version,
        meta: item.meta,
        data: item.data,
        attachments,
        notes,
        annotations,
        collectionNames,
        // 与 Host half 一致：item 别名指向原始 Zotero item JSON（不循环引用）
        item: { key: item.key, version: item.version, meta: item.meta, data: item.data, links: item.links },
      };
    },

    async pdf({ key } = {}) {
      const requested = String(key || '');
      if (!requested) throw httpError(400, 'bad_request', '缺少 key 参数');
      const { attachment, file } = await resolvePdfAttachment(requested);
      // 只允许读取 Zotero 数据目录内的 PDF。
      const resolved = path.resolve(file.filePath);
      const allowedRoots = [path.resolve(storageDir), path.resolve(homedir(), 'Zotero')];
      if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
        throw httpError(403, 'forbidden_path', 'PDF 路径不在允许的 Zotero 数据目录内');
      }
      return { filePath: resolved, attachmentKey: attachment.data?.key || attachment.key };
    },

    async citations({ keys = [], format = 'bibtex', style = 'apa', locale = 'zh-CN' } = {}) {
      const list = String(keys || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
      if (!list.length) throw httpError(400, 'bad_request', '缺少 keys 参数');
      if (list.length > 200) throw httpError(400, 'too_many_keys', 'keys 最多 200 个');
      const results = await Promise.all(
        list.map(async (key) => {
          if (!/^[A-Z0-9]{8}$/.test(key)) return null;
          try {
            const { data } = await request(`/api/users/0/items/${encodeURIComponent(key)}`);
            return data;
          } catch {
            return null;
          }
        }),
      );
      const found = results.filter(Boolean);
      const missing = list.filter((key, index) => !results[index]);
      if (!found.length) throw httpError(404, 'items_not_found', '找不到任何匹配的条目');
      const payload = buildCitations(found, { format, style, locale });
      return { ...payload, missing };
    },

    async citation({ id } = {}) {
      const record = citationCache.get(String(id || ''));
      if (!record) {
        throw httpError(
          404,
          'citation_not_found',
          `dev-live 找不到引文 id=${id}（可用 GET /api/citations?itemKey=K 生成并缓存）`,
        );
      }
      return record;
    },

    async citationsForItem({ itemKey = '', limit = 20 } = {}) {
      if (!/^[A-Z0-9]{8}$/.test(String(itemKey || ''))) {
        throw httpError(400, 'bad_request', 'itemKey 必须是 8 位 Zotero key');
      }
      const records = await buildCitationRecordsForItem(itemKey, Math.max(1, Math.min(100, Number(limit) || 20)));
      if (!records.length) {
        throw httpError(404, 'citations_not_found', `该文献没有带 rects 的批注，无法生成引文记录：${itemKey}`);
      }
      return { itemKey, total: records.length, records };
    },

    async saveCitationAnnotation() {
      throw httpError(501, 'requires-zotero-10', '需要 Zotero 10 才能写入阅读高亮（dev-live 占位接口）');
    },

    async maintenance({ view = 'unfiled', offset = 0, limit = 50 } = {}) {
      const validViews = new Set(['unfiled', 'missingDOI', 'missingPDF']);
      if (!validViews.has(view)) throw httpError(400, 'bad_request', `未知视图：${view}`);
      const start = Math.max(0, Number(offset) || 0);
      const size = Math.max(1, Math.min(100, Number(limit) || 50));
      const { topItems, pdfParents, truncated } = await scanMaintenanceData();
      const candidates = topItems
        .map((entry) => {
          const item = entry.data || {};
          const yearMatch = String(item.date || '').match(/\d{4}/);
          return {
            key: item.key,
            title: item.title || '(无标题)',
            creators: {
              authors: creatorNames(item.creators),
              year: yearMatch ? yearMatch[0] : '',
            },
            itemType: item.itemType,
            hasPdf: pdfParents.has(item.key),
            hasDOI: Boolean(item.DOI),
            collectionsCount: Array.isArray(item.collections) ? item.collections.length : 0,
          };
        })
        .filter((entry) => {
          if (view === 'unfiled') return entry.collectionsCount === 0;
          if (view === 'missingDOI') return !entry.hasDOI;
          return !entry.hasPdf;
        });
      return {
        view,
        total: candidates.length,
        offset: start,
        limit: size,
        truncated,
        items: candidates.slice(start, start + size),
      };
    },

    async open({ kind = 'item', key = '', attachmentKey = '', page = 0, annotationKey = '' } = {}) {
      const keyPattern = /^[A-Z0-9]{8}$/;
      if (!keyPattern.test(String(key || ''))) throw httpError(400, 'bad_request', 'key 必须是 8 位 Zotero key');
      if (page && (!Number.isInteger(Number(page)) || Number(page) < 1 || Number(page) > 100000)) {
        throw httpError(400, 'bad_request', 'page 必须是 1..100000 的整数');
      }
      let url;
      if (kind === 'pdf') {
        const target = keyPattern.test(String(attachmentKey || '')) ? attachmentKey : key;
        const params = [];
        if (page) params.push(`page=${Number(page)}`);
        if (annotationKey) params.push(`annotation=${String(annotationKey).replace(/[^A-Z0-9]/g, '')}`);
        url = `zotero://open-pdf/library/items/${target}${params.length ? `?${params.join('&')}` : ''}`;
      } else if (kind === 'item') {
        url = `zotero://select/library/items/${key}`;
      } else {
        throw httpError(400, 'bad_request', 'kind 只支持 item 或 pdf');
      }
      // dev-live 不真正启动 Zotero（避免打断用户）；真实 Host half 会 execFile('open')。
      return { ok: true, url, opened: false, dev: true };
    },

    async paperTitleFor(key) {
      const { data } = await request(`/api/users/0/items/${encodeURIComponent(key)}`);
      return data?.data?.title || '';
    },
  };
}

/** 在 ~/Zotero/storage 中找一份真实 PDF，供 mock 模式使用。 */
export async function findAnyZoteroPdf(storageDir = DEFAULT_STORAGE_DIR) {
  const stack = [storageDir];
  let visited = 0;
  while (stack.length && visited < 4000) {
    const current = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.pdf$/i.test(entry.name)) {
        const info = await stat(full).catch(() => null);
        if (info && info.isFile() && info.size > 1024) return full;
      }
    }
  }
  return '';
}
