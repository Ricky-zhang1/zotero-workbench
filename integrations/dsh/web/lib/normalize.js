/**
 * Host half 只读 API 返回数据的归一化（workspace 模式共用）。
 * 兼容 Host 契约形状与 Zotero 原生 JSON 形状；所有字段缺失时给安全默认值。
 */

import { creatorsText, normalizeTags, plainText, safeCssColor, yearText } from './dom.js';

export function normalizeLibraries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      if (!entry) return null;
      const library = entry.library && typeof entry.library === 'object' ? entry.library : entry;
      const id = library.id ?? library.libraryID ?? entry.id ?? index;
      const name = library.name || entry.name || `文库 ${id}`;
      const type = library.type || entry.type || 'user';
      return { id: String(id), name, type };
    })
    .filter(Boolean);
}

export function normalizeCollections(raw) {
  if (!Array.isArray(raw)) return [];
  const list = raw
    .map((entry) => {
      if (!entry || !entry.key) return null;
      return {
        key: String(entry.key),
        name: String(entry.name || '(未命名分类)'),
        itemCount: Number(entry.itemCount ?? entry.meta?.numItems ?? 0) || 0,
        parentCollection: entry.parentCollection ? String(entry.parentCollection) : null,
        depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : null,
      };
    })
    .filter(Boolean);
  const byKey = new Map(list.map((collection) => [collection.key, collection]));
  for (const collection of list) {
    if (collection.depth !== null) continue;
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
  return list;
}

export function normalizeSavedSearches(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry) return null;
      const key = entry.key || entry.id;
      const name = entry.name || entry.title;
      if (!name && !key) return null;
      return { key: String(key || name), name: String(name || key) };
    })
    .filter(Boolean);
}

export function normalizeItemSummary(raw) {
  const data = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw || {};
  const rawCreators = raw?.creators || {};
  const authors = Array.isArray(rawCreators.authors)
    ? rawCreators.authors
    : Array.isArray(data.creators)
      ? creatorsText(data.creators).split('、')
      : [];
  return {
    key: String(raw?.key || data.key || ''),
    title: String(raw?.title || data.title || '(无标题)'),
    itemType: String(raw?.itemType || data.itemType || 'document'),
    authors: Array.isArray(authors) ? authors.filter(Boolean) : [],
    year: rawCreators.year ? String(rawCreators.year) : yearText({}, raw?.date || data.date),
    date: String(raw?.date || data.date || ''),
    publicationTitle: String(
      raw?.publicationTitle || data.publicationTitle || data.proceedingsTitle || data.bookTitle || '',
    ),
    DOI: String(raw?.DOI || data.DOI || ''),
    tags: normalizeTags(raw?.tags ?? data.tags),
    journalLevels: Array.isArray(raw?.journalLevels) ? raw.journalLevels : [],
    collectionKeys: Array.isArray(raw?.collectionKeys)
      ? raw.collectionKeys.map(String)
      : Array.isArray(data.collections)
        ? data.collections.map(String)
        : [],
    dateAdded: raw?.dateAdded || data.dateAdded || '',
    dateModified: raw?.dateModified || data.dateModified || '',
    hasPdf: Boolean(raw?.pdf) || raw?.hasPdf === true || Boolean(raw?.numChildren) || false,
    hasDOI: Boolean(raw?.DOI || data.DOI || raw?.hasDOI),
    collectionsCount: Number.isFinite(Number(raw?.collectionsCount))
      ? Number(raw.collectionsCount)
      : Array.isArray(data.collections)
        ? data.collections.length
        : null,
    // live/mock 模式的 PDF 附件 key（Host 列表接口可能提供，用于快速打开）
    pdfKey: raw?.pdf?.key || raw?.pdfKey || '',
    duplicateMatches: Array.isArray(raw?.duplicateMatches) ? raw.duplicateMatches : [],
    duplicateCount: raw?.duplicateCount || 0,
    peersTruncated: Boolean(raw?.peersTruncated),
  };
}

export function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || !entry.key) return null;
      const filename = String(entry.filename || entry.title || '附件');
      const contentType = String(entry.contentType || '');
      const isPdf =
        entry.isPdf === true ||
        contentType === 'application/pdf' ||
        /\.pdf$/i.test(filename) ||
        /\.pdf$/i.test(String(entry.title || ''));
      return {
        key: String(entry.key),
        title: String(entry.title || filename),
        filename,
        contentType,
        linkMode: String(entry.linkMode || ''),
        isPdf,
        path: entry.path || '',
        parent: String(entry.parent || ''),
        size: Number(entry.size) || 0,
      };
    })
    .filter(Boolean);
}

function normalizeRects(raw) {
  if (!Array.isArray(raw)) return [];
  const rects = [];
  for (const rect of raw) {
    if (!Array.isArray(rect) || rect.length < 4) continue;
    const numbers = rect.slice(0, 4).map(Number);
    if (!numbers.every((value) => Number.isFinite(value))) continue;
    rects.push(numbers);
  }
  return rects;
}

export function normalizeAnnotations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      if (!entry) return null;
      const pageIndexValue = Number(entry.pageIndex);
      const pageIndex = Number.isFinite(pageIndexValue) ? Math.max(0, pageIndexValue) : null;
      const rects = normalizeRects(entry.rects || entry.rectsList || []);
      return {
        key: String(entry.key || `annotation-${index}`),
        type: String(entry.type || entry.annotationType || 'highlight'),
        parentAttachment: entry.parentAttachment ? String(entry.parentAttachment) : '',
        text: String(entry.text || entry.annotationText || ''),
        comment: String(entry.comment || entry.annotationComment || ''),
        color: safeCssColor(entry.color || entry.annotationColor, '#ffd400'),
        pageLabel: String(entry.pageLabel || entry.annotationPageLabel || ''),
        pageIndex,
        rects,
        tags: normalizeTags(entry.tags),
        dateAdded: entry.dateAdded || '',
        sortIndex: String(entry.sortIndex || entry.key || ''),
      };
    })
    .filter(Boolean);
}

export function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      if (!entry) return null;
      const html = String(entry.html || entry.note || '');
      const text = plainText(html);
      if (!text) return null;
      return {
        key: String(entry.key || `note-${index}`),
        title: String(entry.title || '笔记'),
        text,
        dateModified: entry.dateModified || '',
      };
    })
    .filter(Boolean);
}

export function normalizeDetail(raw, collections) {
  const container = raw && raw.item && typeof raw.item === 'object' ? raw.item : raw || {};
  const data = container.data && typeof container.data === 'object' ? container.data : container;
  const collectionKeys = Array.isArray(data.collections)
    ? data.collections.map(String)
    : Array.isArray(container.collectionKeys)
      ? container.collectionKeys.map(String)
      : [];
  const collectionNameMap = {};
  if (raw && raw.collectionNames && typeof raw.collectionNames === 'object') {
    for (const [key, name] of Object.entries(raw.collectionNames)) collectionNameMap[String(key)] = String(name);
  }
  const collectionNames = collectionKeys
    .map((key) => collectionNameMap[key] || (collections || []).find((item) => item.key === key)?.name || '')
    .filter(Boolean);
  const creators = data.creators || container.creators || [];
  return {
    key: String(container.key || data.key || ''),
    title: String(data.title || container.title || '(无标题)'),
    itemType: String(data.itemType || 'document'),
    fields: { ...data },
    authors: creatorsText(creators),
    creators,
    year: yearText({}, data.date),
    date: String(data.date || ''),
    language: String(data.language || ''),
    publicationTitle: String(
      data.publicationTitle || data.proceedingsTitle || data.bookTitle || data.websiteTitle || '',
    ),
    publisher: String(data.publisher || ''),
    volume: String(data.volume || ''),
    issue: String(data.issue || ''),
    pages: String(data.pages || ''),
    DOI: String(data.DOI || container.DOI || ''),
    url: String(data.url || ''),
    abstractNote: String(data.abstractNote || ''),
    extra: String(data.extra || ''),
    tags: normalizeTags(data.tags ?? container.tags),
    journalLevels: Array.isArray(raw?.journalLevels) ? raw.journalLevels : [],
    collectionKeys,
    collectionNames,
    dateAdded: data.dateAdded || container.dateAdded || '',
    dateModified: data.dateModified || container.dateModified || '',
    attachments: normalizeAttachments(raw?.attachments),
    annotations: normalizeAnnotations(raw?.annotations).sort((left, right) => {
      const pageDelta = (left.pageIndex ?? 0) - (right.pageIndex ?? 0);
      if (pageDelta !== 0) return pageDelta;
      return String(left.sortIndex).localeCompare(String(right.sortIndex));
    }),
    notes: normalizeNotes(raw?.notes),
  };
}

export function venueLine(detail) {
  const parts = [];
  if (detail.publicationTitle) parts.push(detail.publicationTitle);
  if (detail.volume) parts.push(`第 ${detail.volume} 卷`);
  if (detail.issue) parts.push(`第 ${detail.issue} 期`);
  if (detail.pages) parts.push(`第 ${detail.pages} 页`);
  return parts.join('，');
}

export function doiHref(doi) {
  const text = String(doi || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `https://doi.org/${text.replace(/^doi:\s*/i, '')}`;
}

export function zoteroItemUrl(key) {
  const safe = String(key || '').replace(/[^A-Z0-9]/g, '');
  return safe ? `zotero://select/library/items/${safe}` : '';
}

export function zoteroPdfUrl({ key = '', attachmentKey = '', page = 0, annotationKey = '' } = {}) {
  const target = String(attachmentKey || key || '').replace(/[^A-Z0-9]/g, '');
  if (!target) return '';
  const params = [];
  if (page > 0) params.push(`page=${Math.trunc(page)}`);
  if (annotationKey) params.push(`annotation=${String(annotationKey).replace(/[^A-Z0-9]/g, '')}`);
  const query = params.length ? `?${params.join('&')}` : '';
  return `zotero://open-pdf/library/items/${target}${query}`;
}
