import { journalLevelsForItem } from './journal-levels.mjs';

export const KEY = /^[A-Z0-9]{8}$/;
export function libraryId(value = 'user') {
  if (!/^(user|g[1-9]\d*)$/.test(value)) throw new Error('Invalid Zotero library');
  return value;
}
export function itemKey(value) {
  if (!KEY.test(value)) throw new Error('Invalid Zotero item key');
  return value;
}
export function localUrl(value, defaultUrl) {
  const url = new URL(value || defaultUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('Zotero endpoint must be a loopback HTTP address without credentials');
  return url;
}
export function annotationLink(library, attachmentKey, annotationKey, pageIndex) {
  libraryId(library); itemKey(attachmentKey); itemKey(annotationKey);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error('Physical PDF page is unavailable');
  const scope = library === 'user' ? 'library' : `groups/${library.slice(1)}`;
  return `zotero://open-pdf/${scope}/items/${attachmentKey}?page=${pageIndex + 1}&annotation=${annotationKey}`;
}
export function annotationFingerprint(text) {
  // Strip ALL whitespace: PDF text layers insert arbitrary spaces/newlines, esp. in CJK.
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}
export function annotationPageIndex(raw) {
  try { const p = JSON.parse(String(raw ?? ''))?.pageIndex; return Number.isInteger(p) && p >= 0 ? p : null; }
  catch { return null; }
}
// Idempotence guard for user highlights: same attachment+page+normalized text already saved.
// Tool input `page` is 1-based; stored annotationPosition.pageIndex is 0-based.
export function findExistingAnnotation(children, page, text) {
  const wanted = annotationFingerprint(text);
  if (!wanted) return null;
  for (const row of children ?? []) {
    if (row?.data?.annotationType !== 'highlight') continue;
    const at = annotationPageIndex(row.data.annotationPosition);
    if (Number.isInteger(page) && at !== page - 1) continue;
    if (annotationFingerprint(row.data.annotationText) === wanted) return row;
  }
  return null;
}
// The inherited list requests cumulative batches and used to stop at 500 items.
// Retain already fetched pages so subsequent "load more" requests fetch only new pages.
export function installCumulativeItems(library) {
  const original = library.items.bind(library), cache = new Map(), queues = new WeakMap();
  library.items = async (id, query) => {
    if (query.keys?.length || (query.limit || 50) <= 500) return original(id, query);
    const requested = Math.min(Math.max(query.limit, 1), 100000);
    const { limit, ...filter } = query;
    const key = JSON.stringify([id, library.versionOf(id), filter]);
    let entry = cache.get(key);
    if (!entry) {
      const first = await original(id, { ...query, limit: 500 });
      entry = { ...first, items: [...first.items] }; cache.set(key, entry);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    let release;
    const previous = queues.get(entry) || Promise.resolve();
    queues.set(entry, new Promise(resolve => { release = resolve; }));
    await previous;
    try {
    const start = query.start || 0;
    while (entry.items.length < requested && start + entry.items.length < entry.total) {
      const page = await original(id, { ...query, start: start + entry.items.length, limit: Math.min(500, requested - entry.items.length) });
      if (!page.items.length || page.total !== entry.total || page.version !== entry.version) {
        cache.delete(key); throw new Error('文库在加载期间变化或分页不完整，请刷新列表。');
      }
      const seen = new Set(entry.items.map(i => i.key));
      if (page.items.some(i => seen.has(i.key))) { cache.delete(key); throw new Error('文库返回重复页，请刷新列表。'); }
      entry.items.push(...page.items);
    }
    return { ...entry, query, items: entry.items.slice(0, requested) };
    } finally { release(); }
  };
}

// Add rank pills to existing list summaries without a second round of Zotero
// requests. The pinned runtime's summary() must retain `extra` from raw.data;
// parsing here keeps list rows and item details on the same rank rules.
export function installJournalLevelSummaries(library, parseLevels = journalLevelsForItem) {
  const original = library.items.bind(library);
  library.items = async (id, query) => {
    const result = await original(id, query ?? {});
    if (!Array.isArray(result?.items) || result.items.length === 0) return result;
    return {
      ...result,
      items: result.items.map(item => {
        const extra = typeof item.extra === 'string' ? item.extra : '';
        const tags = Array.isArray(item.tags) ? item.tags : [];
        return {
          ...item,
          extra,
          journalLevels: parseLevels({ extra, tags }).levels
        };
      })
    };
  };
}
