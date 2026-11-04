/**
 * Zotero 文献工作台 · 侧边栏阅读器入口。
 *
 * 组成：
 *   左侧文库（搜索 / 分类树 / 结果分页） · 中间阅读区（条目头 + PDF.js 画布 + 工具栏）
 *   右侧批注面板（真实批注 + 笔记）。
 * 数据只来自宿主同源只读 API；本应用不写 Zotero、不做高亮写入。
 */

import {
  $,
  clamp,
  copyText,
  creatorsText,
  debounce,
  escapeHtml,
  formatDate,
  icon,
  itemTypeLabel,
  normalizeTags,
  plainText,
  safeCssColor,
  skeletonRows,
  toast,
  yearText,
} from './dom.js';
import { ApiClient } from './api.js';
import { initTheme } from './theme.js';
import { PdfViewer } from './pdf-viewer.js';
import { createHostBridge } from './host-bridge.js';
import { CitationRevealController } from './citation-reveal.js';

const PAGE_SIZE = 50;
const READ_STORAGE_KEY = 'zotero-workbench:read-items';
const PANEL_STORAGE_KEY = 'zotero-workbench:annotation-panel';
const MAX_READ_KEYS = 800;

const api = new ApiClient();
const theme = initTheme();
const bridge = createHostBridge({ mode: 'sidebar' });
let citationReveal = null;
const pendingRevealIds = [];
let revealFlushCount = 0;

/* ============================== 状态 ============================== */

const state = {
  library: 'user',
  libraries: [],
  collections: [],
  collectionsStatus: 'idle', // idle | loading | ready | error
  collectionsError: '',
  savedSearches: [],
  expandedCollections: new Set(),
  collectionKey: '',
  query: '',
  fulltext: false,
  sort: 'dateModified',

  items: [],
  itemStatus: 'idle', // idle | loading | loading-more | ready | error
  itemError: '',
  nextStart: null,
  total: null,

  selectedKey: '',
  detailStatus: 'idle', // idle | loading | ready | error
  detailError: '',
  detail: null,
  attachments: [],
  annotations: [],
  notes: [],
  annotationActiveIndex: -1,

  attachmentKey: '',
  pdfStatus: 'empty', // empty | loading | ready | error | nopdf
  pdfError: '',
  pdfSource: '',
  pdfVersion: '',
  pdfProgress: null,
  page: 1,
  numPages: 0,
  scale: 1,
  fitMode: 'width',

  annotationsOpen: true,
  libraryOpen: false,
  readKeys: loadReadKeys(),
  selectionText: '',
  health: null,
  booted: false,
};

let viewer = null;
let itemsAbort = null;
let detailAbort = null;
let copyPopTimer = null;

/* ============================== DOM ============================== */

const el = {
  app: $('#app'),
  body: $('#app-body'),
  libraryPanel: $('#library-panel'),
  toggleLibrary: $('#toggle-library'),
  drawerScrim: $('#drawer-scrim'),

  librarySelect: $('#library-select'),
  health: $('#health-status'),
  refreshBtn: $('#refresh-btn'),
  toggleAnnotations: $('#toggle-annotations'),
  openWorkspace: $('#open-workspace'),

  searchInput: $('#search-input'),
  searchIcon: $('.search-icon'),
  clearSearch: $('#clear-search'),
  fulltextToggle: $('#fulltext-toggle'),
  collections: $('#collections'),
  sortSelect: $('#sort-select'),
  resultCount: $('#result-count'),
  itemsScroll: $('#items-scroll'),
  itemList: $('#item-list'),
  itemsFooter: $('#items-footer'),

  readerHead: $('#reader-head'),
  toolbar: $('#reader-toolbar'),
  prevPage: $('#prev-page'),
  nextPage: $('#next-page'),
  pageInput: $('#page-input'),
  pageTotal: $('#page-total'),
  zoomOut: $('#zoom-out'),
  zoomIn: $('#zoom-in'),
  zoomLabel: $('#zoom-label'),
  fitWidth: $('#fit-width'),
  attachmentSelect: $('#attachment-select'),
  openPdf: $('#open-pdf'),

  pdfStage: $('#pdf-stage'),
  pdfScroll: $('#pdf-scroll'),
  pdfPage: $('#pdf-page'),
  stageOverlay: $('#stage-overlay'),
  stageOverlayText: $('#stage-overlay-text'),
  stageEmpty: $('#stage-empty'),
  stageError: $('#stage-error'),
  stageErrorTitle: $('#stage-error-title'),
  stageErrorMessage: $('#stage-error-message'),
  stageRetry: $('#stage-retry'),

  annotationPanel: $('#annotation-panel'),
  annotationCount: $('#annotation-count'),
  annotationBody: $('#annotation-body'),
  annotationList: $('#annotation-list'),
  notesSection: $('#notes-section'),
  annotationClose: $('#annotation-close'),

  copyPop: $('#copy-pop'),
  copySelectionBtn: $('#copy-selection-btn'),
  toast: $('#toast'),

  bootScreen: $('#boot-screen'),
  bootSpinner: $('#boot-spinner'),
  bootIcon: $('#boot-icon'),
  bootTitle: $('#boot-title'),
  bootMessage: $('#boot-message'),
  bootHint: $('#boot-hint'),
  bootRetry: $('#boot-retry'),
};

/* ============================== 存储 ============================== */

function loadReadKeys() {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveReadKeys() {
  try {
    const keys = Array.from(state.readKeys).slice(-MAX_READ_KEYS);
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* 隐私模式 / 配额不足时忽略 */
  }
}

function markRead(key) {
  if (!key || state.readKeys.has(key)) return;
  state.readKeys.add(key);
  saveReadKeys();
}

function loadPanelPreference() {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw === 'closed') return false;
    if (raw === 'open') return true;
  } catch {
    /* ignore */
  }
  return null;
}

function savePanelPreference(open) {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    /* ignore */
  }
}

/* ============================== 数据归一化 ============================== */

function normalizeLibraries(raw) {
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

function normalizeCollections(raw) {
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

function normalizeSavedSearches(raw) {
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

function normalizeItemSummary(raw) {
  const data = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw || {};
  return {
    key: String(raw?.key || data.key || ''),
    title: String(raw?.title || data.title || '(无标题)'),
    itemType: String(raw?.itemType || data.itemType || 'document'),
    creators: raw?.creators || {},
    authors: creatorsText(raw?.creators || data.creators),
    year: yearText(raw?.creators || {}, raw?.date || data.date),
    date: String(raw?.date || data.date || ''),
    tags: normalizeTags(raw?.tags ?? data.tags),
    collectionKeys: Array.isArray(raw?.collectionKeys)
      ? raw.collectionKeys
      : Array.isArray(data.collections)
        ? data.collections
        : [],
    dateAdded: raw?.dateAdded || data.dateAdded || '',
    dateModified: raw?.dateModified || data.dateModified || '',
    hasPdf: Boolean(raw?.pdf) || Boolean(raw?.numChildren) || false,
  };
}

function normalizeAttachments(raw) {
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
        isPdf,
        path: entry.path || '',
      };
    })
    .filter(Boolean);
}

function normalizeAnnotations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      if (!entry) return null;
      const pageIndexValue = Number(entry.pageIndex);
      const pageIndex = Number.isFinite(pageIndexValue) ? Math.max(0, pageIndexValue) : null;
      return {
        key: String(entry.key || `annotation-${index}`),
        type: String(entry.type || 'highlight'),
        parentAttachment: entry.parentAttachment ? String(entry.parentAttachment) : '',
        text: String(entry.text || entry.annotationText || ''),
        comment: String(entry.comment || ''),
        color: safeCssColor(entry.color, '#f5d24a'),
        pageLabel: String(entry.pageLabel || ''),
        pageIndex,
        tags: normalizeTags(entry.tags),
        dateAdded: entry.dateAdded || '',
        sortIndex: String(entry.sortIndex || entry.key || ''),
      };
    })
    .filter(Boolean);
}

function normalizeNotes(raw) {
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

function normalizeDetail(raw, collections) {
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
    authors: creatorsText(creators),
    year: yearText({}, data.date),
    date: String(data.date || ''),
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
    tags: normalizeTags(data.tags ?? container.tags),
    collectionKeys,
    collectionNames,
    dateAdded: data.dateAdded || container.dateAdded || '',
    dateModified: data.dateModified || container.dateModified || '',
    attachments: normalizeAttachments(raw?.attachments),
    annotations: normalizeAnnotations(raw?.annotations)
      .sort((left, right) => {
        const pageDelta = (left.pageIndex ?? 0) - (right.pageIndex ?? 0);
        if (pageDelta !== 0) return pageDelta;
        return String(left.sortIndex).localeCompare(String(right.sortIndex));
      }),
    notes: normalizeNotes(raw?.notes),
  };
}

/* ============================== 启动 ============================== */

function injectStaticIcons() {
  if (el.toggleLibrary) el.toggleLibrary.innerHTML = icon('book');
  if (el.openWorkspace) el.openWorkspace.innerHTML = icon('external');
  if (el.refreshBtn) el.refreshBtn.innerHTML = icon('refresh');
  if (el.toggleAnnotations) el.toggleAnnotations.innerHTML = icon('quote');
  if (el.searchIcon) el.searchIcon.innerHTML = icon('search');
  if (el.clearSearch) el.clearSearch.innerHTML = icon('x');
  if (el.prevPage) el.prevPage.innerHTML = icon('arrowLeft');
  if (el.nextPage) el.nextPage.innerHTML = icon('arrowRight');
  if (el.zoomOut) el.zoomOut.innerHTML = icon('zoomOut');
  if (el.zoomIn) el.zoomIn.innerHTML = icon('zoomIn');
  if (el.annotationClose) el.annotationClose.innerHTML = icon('x');
  if (el.copySelectionBtn) el.copySelectionBtn.innerHTML = `${icon('copy', 13)}<span>复制</span>`;
}

function setHealthStatus(kind, text) {
  if (!el.health) return;
  el.health.className = `health-status is-${kind}`;
  const label = el.health.querySelector('.health-text');
  if (label) label.textContent = text;
}

async function boot() {
  injectStaticIcons();
  bindEvents();
  setupViewer();
  applyPanelPreference();
  syncNarrowLayout();
  renderLibrarySelect();
  renderCollections();
  renderItems();
  renderReaderHead();
  renderToolbar();
  updateStage();
  renderAnnotations();
  showBootLoading('正在连接本机 Zotero…');
  await refreshAll({ initial: true });
}

async function refreshAll({ initial = false } = {}) {
  theme.refresh();
  setHealthStatus('loading', '连接中…');
  el.refreshBtn.disabled = true;
  try {
    let health = null;
    try {
      health = await api.health();
    } catch (error) {
      if (initial) {
        showBootError(error);
        return;
      }
      setHealthStatus('error', '连接失败');
      toast(`刷新失败：${error.message}`, { tone: 'error' });
      return;
    }
    state.health = health;
    const zotero = health && health.zotero;
    const reachable = !zotero || zotero.reachable !== false;
    if (!reachable) {
      setHealthStatus('warn', 'Zotero 未启动');
      if (initial) hideBoot();
      toast('Zotero 未启动或不可达：文库可能为空，请启动 Zotero 后刷新。', { tone: 'error', timeout: 4800 });
    } else {
      setHealthStatus('ok', zotero?.version ? `已连接 · ${zotero.version}` : '已连接');
      if (initial) hideBoot();
    }
    state.booted = true;

    await loadCollections();
    await loadItems({ reset: true, autoSelect: initial });
    if (!initial && state.selectedKey) {
      await selectItem(state.selectedKey, { force: true });
    }
  } finally {
    el.refreshBtn.disabled = false;
  }
}

function showBootLoading(message) {
  el.app.dataset.boot = 'loading';
  el.bootScreen.classList.remove('is-hidden', 'is-error');
  el.bootSpinner.hidden = false;
  el.bootIcon.hidden = true;
  el.bootRetry.hidden = true;
  el.bootTitle.textContent = 'Zotero 文献工作台';
  el.bootMessage.textContent = message;
  el.bootHint.textContent = '';
}

function hideBoot() {
  el.app.dataset.boot = 'ready';
  el.bootScreen.classList.add('is-hidden');
}

function showBootError(error) {
  el.app.dataset.boot = 'error';
  setHealthStatus('error', '连接失败');
  el.bootScreen.classList.remove('is-hidden');
  el.bootScreen.classList.add('is-error');
  el.bootSpinner.hidden = true;
  el.bootIcon.hidden = false;
  el.bootIcon.innerHTML = icon('warn', 22);
  el.bootTitle.textContent = '无法连接 Zotero 文献工作台';
  el.bootMessage.textContent = (error && error.message) || '未知错误';
  el.bootRetry.hidden = false;
  el.bootHint.innerHTML =
    '请确认：① 本机 Zotero 已启动；② DSH 中「Zotero 文献」插件已启用；③ 宿主插件提供 /zotero-workbench/api/health。';
}

/* ============================== 角标跳转定位（reveal-citation） ============================== */

/* 角标定位打开流程串行化：并发/慢请求下避免 selectItem/openPdf 互相 abort（P1.1）。 */
let revealOpenChain = Promise.resolve();

async function performCitationOpen(record) {
  if (!record || !record.itemKey) throw new Error('引文记录缺少条目信息');
  const sameItem = state.selectedKey === record.itemKey && state.detailStatus === 'ready' && Boolean(state.detail);
  if (!sameItem) {
    await selectItem(record.itemKey, { force: true, preserveCitationReveal: true });
  }
  if (state.detailStatus !== 'ready' || !state.detail) {
    throw new Error(state.detailError || '条目详情加载失败');
  }
  // 统一数据源：state.attachments 是 selectItem 时 detail.attachments 的快照；
  // 这里直接使用 detail.attachments，与 workspace 的 performCitationOpen 保持一致。
  const pdfAttachments = state.detail.attachments.filter((attachment) => attachment.isPdf);
  if (!pdfAttachments.length) throw new Error('该条目没有 PDF 附件');
  const attachment =
    pdfAttachments.find((entry) => entry.key === record.attachmentKey) || pdfAttachments[0];
  // P3.4：附件回退时同步 state，避免工具栏下拉与实际加载的附件不一致。
  const needsReload = state.attachmentKey !== attachment.key || state.pdfStatus !== 'ready' || !viewer?.isOpen;
  state.attachmentKey = attachment.key;
  if (needsReload) await openPdf();
  if (!viewer || !viewer.isOpen) throw new Error(state.pdfError || 'PDF 未加载完成');

  const pageIndex = Number(record.pageIndex);
  if (!Number.isFinite(pageIndex) || pageIndex < 0) throw new Error('引文记录页码无效');
  const numPages = viewer.numPages || 0;
  if (!numPages) throw new Error('PDF 页数未知，无法定位');
  // P2.1：越界直接报错，绝不进入轮询/假成功。
  if (pageIndex >= numPages) {
    throw new Error(`登记页码 ${pageIndex + 1} 超出 PDF 共 ${numPages} 页，请重新登记`);
  }
  const target = pageIndex + 1;
  if (viewer.pageNumber !== target) await viewer.goToPage(target);
  if (!viewer.isOpen || viewer.pageNumber !== target) {
    throw new Error(`无法跳转到第 ${target} 页`);
  }
}

function openCitationInReader(record) {
  const run = revealOpenChain.then(
    () => performCitationOpen(record),
    () => performCitationOpen(record),
  );
  revealOpenChain = run.catch(() => {});
  return run;
}

function handleHostMessage(data) {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'visibility') {
    // P3.1：tab 隐藏时暂停高亮闪动等动画（无轮询，不阻塞）。
    const visible = !data.payload || data.payload.visible !== false;
    document.documentElement.classList.toggle('is-page-hidden', !visible);
    return;
  }
  if (data.type === 'reveal-citation' && data.payload && data.payload.id) {
    queueOrRevealCitation(String(data.payload.id), data.payload.nonce ? String(data.payload.nonce) : '');
  }
}

function queueOrRevealCitation(id, nonce = '') {
  if (!id) return;
  const entry = { id: String(id), nonce: nonce ? String(nonce) : '' };
  if (!state.booted || !citationReveal) {
    if (!pendingRevealIds.some((pending) => pending.id === entry.id && pending.nonce === entry.nonce)) {
      pendingRevealIds.push(entry);
    }
    return;
  }
  citationReveal.revealQueued(entry.id, entry.nonce);
}

function flushPendingReveals() {
  if (!citationReveal) return;
  const pending = pendingRevealIds.splice(0);
  revealFlushCount += pending.length;
  for (const entry of pending) citationReveal.revealQueued(entry.id, entry.nonce);
}

/* ============================== 打开完整工作台 ============================== */

async function openFullWorkspace() {
  // DSH 内：由宿主切换 main 槽到全页工作区；独立打开：新标签页打开 ?mode=workspace。
  if (bridge.connected) {
    try {
      const ack = await bridge.request('open-workspace', {});
      toast(ack?.ok === false ? ack.message || '打开失败' : '已请求打开完整工作台', {
        tone: ack?.ok === false ? 'error' : 'info',
      });
      return;
    } catch (error) {
      if (error?.code !== 'host-unavailable' && error?.code !== 'host-timeout') {
        toast(`打开失败：${error?.message || error}`, { tone: 'error' });
        return;
      }
    }
  }
  const url = new URL(window.location.href);
  url.search = '?mode=workspace';
  url.hash = '';
  window.open(url.toString(), '_blank', 'noopener');
  toast('已在新标签页打开完整工作台');
}

/* ============================== 窄宽文库抽屉（DSH 右栏 ≈600px） ============================== */

function isNarrowLayout() {
  try {
    return window.matchMedia('(max-width: 760px)').matches;
  } catch {
    return false;
  }
}

function toggleLibraryDrawer(open = !state.libraryOpen) {
  const shouldOpen = Boolean(open) && isNarrowLayout();
  state.libraryOpen = shouldOpen;
  el.body.classList.toggle('library-open', shouldOpen);
  el.toggleLibrary.setAttribute('aria-expanded', String(shouldOpen));
  el.toggleLibrary.setAttribute('aria-label', shouldOpen ? '收起文库' : '展开文库');
  if (el.drawerScrim) el.drawerScrim.hidden = !shouldOpen;
  if (el.libraryPanel) {
    // 收起时让抽屉里的控件退出 Tab 顺序；宽屏始终保持可访问。
    if (isNarrowLayout()) el.libraryPanel.inert = !shouldOpen;
    else el.libraryPanel.inert = false;
  }
  if (shouldOpen) {
    const active = el.itemList?.querySelector('.item-row.is-selected');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

function syncNarrowLayout() {
  if (!isNarrowLayout()) {
    toggleLibraryDrawer(false);
    if (el.libraryPanel) el.libraryPanel.inert = false;
  } else {
    toggleLibraryDrawer(state.libraryOpen);
  }
}

/* ============================== 文库：分类 ============================== */

function renderLibrarySelect() {
  if (!el.librarySelect) return;
  const name = state.libraries[0]?.name || '我的文库';
  el.librarySelect.innerHTML = `<option value="user">${escapeHtml(name)}</option>`;
  el.librarySelect.value = state.library;
  el.librarySelect.disabled = true;
  el.librarySelect.title = `文库：${name}`;
}

function buildCollectionTree() {
  const byKey = new Map(state.collections.map((collection) => [collection.key, { ...collection, children: [] }]));
  const roots = [];
  for (const collection of byKey.values()) {
    if (collection.parentCollection && byKey.has(collection.parentCollection)) {
      byKey.get(collection.parentCollection).children.push(collection);
    } else {
      roots.push(collection);
    }
  }
  const sortNodes = (nodes) => {
    nodes.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

function renderCollections() {
  if (!el.collections) return;
  if (state.collectionsStatus === 'loading' || state.collectionsStatus === 'idle') {
    el.collections.innerHTML = `<div class="skeleton-row" aria-hidden="true"><div class="skeleton-line" style="width:62%"></div><div class="skeleton-line" style="width:48%"></div><div class="skeleton-line" style="width:71%"></div></div>`;
    return;
  }
  if (state.collectionsStatus === 'error') {
    el.collections.innerHTML = `
      <div class="items-message is-error">
        分类加载失败：${escapeHtml(state.collectionsError)}
        <div><button class="btn" type="button" data-retry-collections>重试</button></div>
      </div>`;
    return;
  }

  // 默认展开全部分类（分类数通常不多）；用户折叠状态单独记录。
  if (state.expandedCollections.size === 0) {
    for (const collection of state.collections) {
      if (!collection.parentCollection) state.expandedCollections.add(collection.key);
    }
  }

  const rows = [];
  rows.push(`
    <div class="tree-item ${state.collectionKey === '' ? 'is-active' : ''}" role="treeitem" aria-selected="${state.collectionKey === ''}">
      <span class="tree-toggle is-leaf" aria-hidden="true"></span>
      <button class="tree-label" type="button" data-collection-key="">
        ${icon('book')}<span class="tree-name">全部文献</span>
      </button>
    </div>`);

  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const open = state.expandedCollections.has(node.key);
      rows.push(`
        <div class="tree-item ${state.collectionKey === node.key ? 'is-active' : ''} ${open ? 'is-open' : ''}" role="treeitem" aria-selected="${state.collectionKey === node.key}">
          <button class="tree-toggle ${hasChildren ? '' : 'is-leaf'}" type="button" data-toggle-collection="${escapeHtml(node.key)}" aria-label="${open ? '折叠' : '展开'}分类 ${escapeHtml(node.name)}" aria-expanded="${open}" ${hasChildren ? '' : 'tabindex="-1"'}>${icon('chevronRight', 12)}</button>
          <button class="tree-label" type="button" data-collection-key="${escapeHtml(node.key)}" title="${escapeHtml(node.name)}">
            ${icon('collection')}<span class="tree-name" style="padding-left:${depth * 2}px">${escapeHtml(node.name)}</span>
            ${node.itemCount ? `<span class="tree-count">${node.itemCount}</span>` : ''}
          </button>
        </div>`);
      if (hasChildren && open) walk(node.children, depth + 1);
    }
  };
  walk(buildCollectionTree(), 0);

  if (state.savedSearches.length) {
    rows.push('<div class="saved-searches" role="group" aria-label="已保存搜索">');
    for (const search of state.savedSearches.slice(0, 6)) {
      rows.push(
        `<button class="saved-chip" type="button" data-saved-search="${escapeHtml(search.name)}" title="用该名称搜索">${escapeHtml(search.name)}</button>`,
      );
    }
    rows.push('</div>');
  }
  el.collections.innerHTML = rows.join('');
}

function selectCollection(key) {
  state.collectionKey = key;
  if (key) {
    // 自动展开选中分类的祖先，避免选中后“看不见”。
    let cursor = state.collections.find((collection) => collection.key === key);
    const seen = new Set();
    while (cursor && cursor.parentCollection && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      state.expandedCollections.add(cursor.parentCollection);
      cursor = state.collections.find((collection) => collection.key === cursor.parentCollection);
    }
  }
  renderCollections();
  loadItems({ reset: true });
}

async function loadCollections() {
  state.collectionsStatus = 'loading';
  renderCollections();
  try {
    const data = await api.collections(state.library);
    state.libraries = normalizeLibraries(data?.libraries);
    state.collections = normalizeCollections(data?.collections);
    state.savedSearches = normalizeSavedSearches(data?.savedSearches);
    state.collectionsStatus = 'ready';
    state.collectionsError = '';
    renderLibrarySelect();
  } catch (error) {
    state.collectionsStatus = 'error';
    state.collectionsError = error.message || '未知错误';
  }
  renderCollections();
}

/* ============================== 文库：条目列表 ============================== */

async function loadItems({ reset = false, autoSelect = false } = {}) {
  if (itemsAbort) itemsAbort.abort();
  const controller = new AbortController();
  itemsAbort = controller;
  const start = reset ? 0 : state.nextStart ?? state.items.length;

  if (reset) {
    state.itemStatus = 'loading';
    state.itemError = '';
    state.items = [];
    state.nextStart = null;
    state.total = null;
  } else {
    if (state.nextStart === null && state.itemStatus === 'ready') return;
    state.itemStatus = 'loading-more';
  }
  renderItems();

  try {
    const data = await api.items({
      library: state.library,
      q: state.query,
      collection: state.collectionKey,
      sort: state.sort,
      start,
      limit: PAGE_SIZE,
      mode: state.fulltext ? 'everything' : 'all',
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const items = (Array.isArray(data?.items) ? data.items : []).map(normalizeItemSummary).filter((item) => item.key);
    state.items = reset ? items : state.items.concat(items);
    const next = data?.nextStart;
    if (next === null || next === undefined) {
      state.nextStart = items.length >= PAGE_SIZE ? start + items.length : null;
    } else {
      state.nextStart = Number(next);
      if (!Number.isFinite(state.nextStart)) state.nextStart = null;
    }
    if (Number.isFinite(data?.total)) state.total = Number(data.total);
    state.itemStatus = 'ready';
    state.itemError = '';
    renderItems();
    if (autoSelect && !state.selectedKey && state.items.length) {
      await selectItem(state.items[0].key);
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return;
    state.itemStatus = 'error';
    state.itemError = error.message || '未知错误';
    renderItems();
  }
}

function renderReadState(item) {
  if (!state.readKeys.has(item.key)) return '';
  return '<span class="item-read-dot" title="已打开过" aria-label="已读"></span>';
}

function renderItemRows() {
  const rows = state.items.map((item) => {
    const selected = item.key === state.selectedKey;
    const creators = item.authors || '未知作者';
    const year = item.year || '';
    const tags = item.tags.slice(0, 3);
    return `
      <li role="option" aria-selected="${selected}">
        <button class="item-row ${selected ? 'is-selected' : ''}" type="button" data-item-key="${escapeHtml(item.key)}">
          ${renderReadState(item)}
          <span class="item-title">${escapeHtml(item.title)}</span>
          <span class="item-meta">
            <span class="item-creators" title="${escapeHtml(creators)}">${escapeHtml(creators)}</span>
            ${year ? `<span class="dot"></span><span class="item-year">${escapeHtml(year)}</span>` : ''}
            <span class="item-type-chip">${escapeHtml(itemTypeLabel(item.itemType))}</span>
            ${item.hasPdf ? `<span class="item-pdf-badge" title="有 PDF 附件">${icon('doc', 12)}</span>` : ''}
          </span>
          ${
            tags.length
              ? `<span class="item-tag-row">${tags.map((tag) => `<span class="item-tag">${escapeHtml(tag)}</span>`).join('')}</span>`
              : ''
          }
        </button>
      </li>`;
  });
  el.itemList.innerHTML = rows.join('');
}

function renderItems() {
  if (!el.itemList || !el.itemsFooter) return;
  if (state.itemStatus === 'loading' || state.itemStatus === 'idle') {
    el.itemList.innerHTML = skeletonRows(6);
    el.itemsFooter.innerHTML = '';
    updateResultCount();
    return;
  }
  if (state.itemStatus === 'error') {
    el.itemList.innerHTML = '';
    el.itemsFooter.innerHTML = `
      <div class="items-message is-error">
        文献列表加载失败：${escapeHtml(state.itemError)}
        <div><button class="btn" type="button" data-retry-items>重试</button></div>
      </div>`;
    updateResultCount();
    return;
  }
  if (!state.items.length) {
    el.itemList.innerHTML = '';
    const reason = state.query
      ? `没有匹配「${escapeHtml(state.query)}」的文献`
      : state.fulltext
        ? '当前分类下没有全文匹配的文献'
        : '这个分类下还没有文献';
    el.itemsFooter.innerHTML = `<div class="items-message">${reason}<br /><span style="color:var(--rb-fg-subtle)">试试清空搜索或切换分类</span></div>`;
    updateResultCount();
    return;
  }
  renderItemRows();
  if (state.itemStatus === 'loading-more') {
    el.itemsFooter.innerHTML = `<div class="items-message" aria-live="polite">正在加载更多…</div>`;
  } else if (state.nextStart !== null && state.nextStart !== undefined) {
    el.itemsFooter.innerHTML = `<button class="btn load-more" type="button" data-load-more>加载更多</button>`;
  } else {
    el.itemsFooter.innerHTML = `<div class="items-message" style="padding:10px;font-size:11px">已加载全部 ${state.items.length} 条</div>`;
  }
  updateResultCount();
}

function updateResultCount() {
  if (!el.resultCount) return;
  if (state.itemStatus === 'loading' || state.itemStatus === 'idle') {
    el.resultCount.textContent = '加载中…';
    return;
  }
  if (state.itemStatus === 'error') {
    el.resultCount.textContent = '加载失败';
    return;
  }
  const loaded = state.items.length;
  const total = Number.isFinite(state.total) ? state.total : null;
  el.resultCount.textContent = total !== null && total > loaded ? `${loaded}/${total}` : `${loaded} 条`;
}

/* ============================== 条目详情 ============================== */

function findSummary(key) {
  return state.items.find((item) => item.key === key) || null;
}

async function selectItem(key, { force = false, scrollIntoView = true, preserveCitationReveal = false } = {}) {
  if (!key) return;
  // 用户切到另一篇文献时清掉上一处引文定位；reveal 自己的加载流程传 preserveCitationReveal
  // 跳过这里，浮层生命周期完全由 CitationRevealController 管理（P1.2 修复）。
  if (
    !preserveCitationReveal &&
    citationReveal &&
    citationReveal.isVisible() &&
    citationReveal.currentRecord?.itemKey !== key
  ) {
    citationReveal.hide();
  }
  // 窄侧边栏：点选条目（包括当前已选条目）都收起文库抽屉。
  if (isNarrowLayout()) toggleLibraryDrawer(false);
  if (!force && state.selectedKey === key && state.detailStatus === 'ready') {
    if (scrollIntoView) scrollItemIntoView(key);
    return;
  }
  state.selectedKey = key;
  markRead(key);
  renderItemRows();
  if (scrollIntoView) scrollItemIntoView(key);

  if (detailAbort) detailAbort.abort();
  const controller = new AbortController();
  detailAbort = controller;

  state.detailStatus = 'loading';
  state.detailError = '';
  state.detail = null;
  state.attachments = [];
  state.annotations = [];
  state.notes = [];
  state.annotationActiveIndex = -1;
  state.attachmentKey = '';
  state.pdfStatus = 'idle';
  state.pdfError = '';
  state.pdfProgress = null;
  state.pdfSource = '';
  state.page = 1;
  state.numPages = 0;
  if (viewer) viewer.close();

  renderReaderHead();
  renderToolbar();
  renderAnnotations();
  updateStage();

  try {
    const raw = await api.item({ library: state.library, key, signal: controller.signal });
    if (controller.signal.aborted) return;
    const detail = normalizeDetail(raw, state.collections);
    state.detail = detail;
    state.attachments = detail.attachments;
    state.annotations = detail.annotations;
    state.notes = detail.notes;
    state.detailStatus = 'ready';
    const pdfs = detail.attachments.filter((attachment) => attachment.isPdf);
    if (!pdfs.length) {
      state.pdfStatus = 'nopdf';
    } else {
      state.attachmentKey = pdfs[0].key;
      state.pdfStatus = 'loading';
    }
    renderReaderHead();
    renderToolbar();
    renderAnnotations();
    updateStage();
    if (pdfs.length) await openPdf();
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return;
    state.detailStatus = 'error';
    state.detailError = error.message || '未知错误';
    renderReaderHead();
    renderToolbar();
    renderAnnotations();
    updateStage();
  }
}

function scrollItemIntoView(key) {
  const active = el.itemList.querySelector(`[data-item-key="${CSS.escape(key)}"]`);
  if (!active) return;
  const listRect = el.itemsScroll.getBoundingClientRect();
  const rowRect = active.getBoundingClientRect();
  if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function venueText(detail) {
  const parts = [];
  if (detail.publicationTitle) parts.push(detail.publicationTitle);
  if (detail.volume) parts.push(`第 ${detail.volume} 卷`);
  if (detail.issue) parts.push(`第 ${detail.issue} 期`);
  if (detail.pages) parts.push(`第 ${detail.pages} 页`);
  return parts.join('，');
}

function doiHref(doi) {
  const text = String(doi || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `https://doi.org/${text.replace(/^doi:\s*/i, '')}`;
}

function renderReaderHead() {
  if (!el.readerHead) return;
  if (!state.selectedKey) {
    el.readerHead.innerHTML = `<div class="reader-head-empty">${icon('doc')}<span>未选择文献 · 从左侧文库打开一篇文献</span></div>`;
    return;
  }
  const summary = findSummary(state.selectedKey);
  if (state.detailStatus === 'loading' || state.detailStatus === 'idle') {
    el.readerHead.classList.add('is-loading');
    el.readerHead.innerHTML = `
      <div class="skeleton-line" style="width:68%;height:13px"></div>
      <div class="skeleton-line" style="width:42%;margin-top:8px"></div>`;
    return;
  }
  el.readerHead.classList.remove('is-loading');
  if (state.detailStatus === 'error') {
    el.readerHead.innerHTML = `
      <div class="detail-title">${escapeHtml(summary?.title || '条目加载失败')}</div>
      <div class="detail-sub"><span style="color:var(--rb-danger)">详情加载失败：${escapeHtml(state.detailError)}</span></div>`;
    return;
  }

  const detail = state.detail;
  if (!detail) {
    el.readerHead.innerHTML = `<div class="reader-head-empty">未选择文献</div>`;
    return;
  }
  const doi = doiHref(detail.DOI);
  const venue = venueText(detail);
  const collectionChips = detail.collectionNames
    .slice(0, 2)
    .map((name) => `<span class="chip" title="${escapeHtml(name)}">${icon('collection', 12)}${escapeHtml(name)}</span>`)
    .join('');
  const extraCollections =
    detail.collectionNames.length > 2
      ? `<span class="chip" title="${escapeHtml(detail.collectionNames.slice(2).join('、'))}">+${detail.collectionNames.length - 2}</span>`
      : '';
  const tags = detail.tags.slice(0, 6);
  el.readerHead.innerHTML = `
    <h1 class="detail-title" title="${escapeHtml(detail.title)}">${escapeHtml(detail.title)}</h1>
    <div class="detail-sub">
      ${detail.authors ? `<span class="detail-authors" title="${escapeHtml(detail.authors)}">${escapeHtml(detail.authors)}</span>` : ''}
      ${detail.year ? `<span class="dot"></span><span>${escapeHtml(detail.year)}</span>` : ''}
      ${venue ? `<span class="dot"></span><span class="detail-venue" title="${escapeHtml(venue)}">${escapeHtml(venue)}</span>` : ''}
      <span class="chip">${escapeHtml(itemTypeLabel(detail.itemType))}</span>
      ${doi ? `<a class="chip chip-doi" href="${escapeHtml(doi)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(doi)}">DOI ${icon('external', 12)}</a>` : ''}
      ${collectionChips}${extraCollections}
    </div>
    ${
      tags.length
        ? `<div class="detail-tags">${tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}${
            detail.tags.length > tags.length ? `<span class="chip">+${detail.tags.length - tags.length}</span>` : ''
          }</div>`
        : ''
    }`;
}

/* ============================== PDF 阅读 ============================== */

function setupViewer() {
  viewer = new PdfViewer({
    scrollEl: el.pdfScroll,
    pageEl: el.pdfPage,
    onStatus(status) {
      if (status.status === 'loading') {
        state.pdfStatus = 'loading';
        state.pdfProgress = null;
      } else if (status.status === 'ready') {
        state.pdfStatus = 'ready';
        state.numPages = status.numPages || 0;
        state.pdfSource = status.source || '';
        state.pdfVersion = status.version || '';
        state.page = viewer.pageNumber;
        state.scale = viewer.scale;
        if (state.pdfSource === 'bundled') {
          console.info('[zotero-workbench] 使用应用内置 pdf.js 兜底构建', state.pdfVersion);
        }
      } else if (status.status === 'error') {
        state.pdfStatus = 'error';
        state.pdfError = status.message || 'PDF 加载失败';
      }
      renderToolbar();
      updateStage();
    },
    onProgress(progress) {
      state.pdfProgress = progress;
      if (state.pdfStatus === 'loading') updateStage();
    },
    onPageChange(info) {
      state.page = info.page;
      state.numPages = info.numPages;
      state.scale = info.scale;
      state.fitMode = info.fitMode;
      hideCopyPopover();
      renderToolbar();
    },
    onTextLayer(ok, error) {
      if (!ok) console.warn('[zotero-workbench] 文字层渲染失败（不影响阅读）', error);
    },
  });
}

async function openPdf() {
  if (!state.detail) return;
  const attachment = state.attachments.find((entry) => entry.key === state.attachmentKey);
  if (!attachment || !attachment.isPdf) {
    state.pdfStatus = state.attachments.some((entry) => entry.isPdf) ? 'error' : 'nopdf';
    state.pdfError = state.pdfStatus === 'error' ? '未找到选中的 PDF 附件' : '';
    renderToolbar();
    updateStage();
    return;
  }
  state.pdfStatus = 'loading';
  state.pdfError = '';
  state.pdfProgress = null;
  state.page = 1;
  state.numPages = 0;
  renderToolbar();
  updateStage();
  const url = api.pdfUrl({ library: state.library, key: attachment.key });
  await viewer.open(url);
}

function renderToolbar() {
  if (!el.toolbar) return;
  const visible =
    state.detailStatus === 'ready' && (state.pdfStatus !== 'nopdf' || state.attachments.some((entry) => entry.isPdf));
  el.toolbar.hidden = !visible;
  if (!visible) return;

  const ready = state.pdfStatus === 'ready';
  const numPages = state.numPages || 0;
  const page = clamp(state.page || 1, 1, Math.max(1, numPages));

  el.prevPage.disabled = !ready || page <= 1;
  el.nextPage.disabled = !ready || page >= numPages;
  el.pageInput.value = ready ? String(page) : '—';
  el.pageInput.disabled = !ready;
  el.pageTotal.textContent = ready ? String(numPages) : '—';
  el.zoomLabel.textContent = ready ? `${Math.round((state.scale || 1) * 100)}%` : '—';
  el.fitWidth.setAttribute('aria-pressed', String(state.fitMode === 'width'));
  el.fitWidth.disabled = !ready;
  el.zoomIn.disabled = !ready;
  el.zoomOut.disabled = !ready;

  const pdfs = state.attachments.filter((entry) => entry.isPdf);
  if (pdfs.length > 1) {
    el.attachmentSelect.hidden = false;
    el.attachmentSelect.innerHTML = pdfs
      .map(
        (entry) =>
          `<option value="${escapeHtml(entry.key)}" ${entry.key === state.attachmentKey ? 'selected' : ''}>${escapeHtml(
            entry.title || entry.filename,
          )}</option>`,
      )
      .join('');
    el.attachmentSelect.value = state.attachmentKey;
  } else {
    el.attachmentSelect.hidden = true;
    el.attachmentSelect.innerHTML = '';
  }

  const activeAttachment = state.attachments.find((entry) => entry.key === state.attachmentKey);
  if (activeAttachment) {
    el.openPdf.href = api.pdfUrl({ library: state.library, key: activeAttachment.key });
    el.openPdf.setAttribute('aria-disabled', 'false');
    el.openPdf.style.pointerEvents = '';
    el.openPdf.style.opacity = '';
  } else {
    el.openPdf.href = '#';
    el.openPdf.setAttribute('aria-disabled', 'true');
    el.openPdf.style.pointerEvents = 'none';
    el.openPdf.style.opacity = '0.5';
  }
}

function stageEmptyTemplate(kind) {
  if (kind === 'nopdf') {
    return `
      <div class="stage-empty-icon">${icon('doc', 22)}</div>
      <h2>该条目没有 PDF 附件</h2>
      <p>可以查看右侧的批注与笔记，或从左侧换一篇文献。</p>
      <ul class="tips"><li>Zotero 中该条目的附件可能只有元数据或链接附件</li></ul>`;
  }
  if (kind === 'detail-loading') {
    return `
      <div class="stage-empty-icon">${icon('doc', 22)}</div>
      <h2>正在读取条目…</h2>
      <p>正在向宿主请求条目详情与批注。</p>`;
  }
  return `
    <div class="stage-empty-icon">${icon('book', 22)}</div>
    <h2>打开一篇文献</h2>
    <p>从左侧文库选择文献，这里会显示 PDF 页面与批注。</p>
    <ul class="tips">
      <li><kbd>/</kbd> 聚焦搜索</li>
      <li><kbd>←</kbd> <kbd>→</kbd> 翻页</li>
      <li>选中 PDF 文字后可复制</li>
    </ul>`;
}

function updateStage() {
  if (!el.stageOverlay) return;
  const hasSelection = Boolean(state.selectedKey);
  el.toolbar.hidden = !(state.detailStatus === 'ready' && state.attachments.some((entry) => entry.isPdf));

  // 详情错误
  if (state.detailStatus === 'error') {
    el.stageEmpty.hidden = true;
    el.stageOverlay.hidden = true;
    el.stageError.hidden = false;
    el.stageErrorTitle.textContent = '无法加载条目';
    el.stageErrorMessage.textContent = state.detailError;
    el.stageRetry.textContent = '重试';
    el.stageRetry.dataset.retryKind = 'detail';
    return;
  }
  // 详情加载中
  if (hasSelection && state.detailStatus === 'loading') {
    el.stageEmpty.hidden = true;
    el.stageError.hidden = true;
    el.stageOverlay.hidden = false;
    el.stageOverlayText.textContent = '正在读取条目详情…';
    return;
  }
  // PDF 加载中
  if (state.pdfStatus === 'loading') {
    el.stageEmpty.hidden = true;
    el.stageError.hidden = true;
    el.stageOverlay.hidden = false;
    const progress = state.pdfProgress;
    let text = '正在加载 PDF…';
    if (progress && progress.percent !== null) text = `正在加载 PDF… ${progress.percent}%`;
    else if (progress && progress.loaded > 0) text = `正在加载 PDF… ${Math.round(progress.loaded / 1024)} KB`;
    el.stageOverlayText.textContent = text;
    return;
  }
  // PDF 错误
  if (state.pdfStatus === 'error') {
    el.stageEmpty.hidden = true;
    el.stageOverlay.hidden = true;
    el.stageError.hidden = false;
    el.stageErrorTitle.textContent = 'PDF 加载失败';
    el.stageErrorMessage.textContent = state.pdfError;
    el.stageRetry.textContent = '重试';
    el.stageRetry.dataset.retryKind = 'pdf';
    return;
  }
  // 无 PDF
  if (state.detailStatus === 'ready' && state.pdfStatus === 'nopdf') {
    el.stageOverlay.hidden = true;
    el.stageError.hidden = true;
    el.stageEmpty.hidden = false;
    el.stageEmpty.innerHTML = stageEmptyTemplate('nopdf');
    return;
  }
  // PDF 就绪 / 未选择
  el.stageError.hidden = true;
  el.stageOverlay.hidden = true;
  el.stageEmpty.hidden = state.pdfStatus === 'ready';
  if (state.pdfStatus !== 'ready') el.stageEmpty.innerHTML = stageEmptyTemplate('none');
}

/* ============================== 批注面板 ============================== */

function applyPanelPreference() {
  const stored = loadPanelPreference();
  // 没有历史偏好时：窄侧边栏默认收起批注面板（否则会盖住阅读区）。
  state.annotationsOpen =
    stored === null ? !window.matchMedia('(max-width: 980px)').matches : stored;
  el.body.classList.toggle('annotations-open', state.annotationsOpen);
  el.toggleAnnotations.setAttribute('aria-pressed', String(state.annotationsOpen));
}

function toggleAnnotationsPanel(open = !state.annotationsOpen) {
  state.annotationsOpen = open;
  el.body.classList.toggle('annotations-open', open);
  el.toggleAnnotations.setAttribute('aria-pressed', String(open));
  savePanelPreference(open);
}

function annotationTypeLabel(type) {
  const map = {
    highlight: '高亮',
    underline: '下划线',
    note: '便签',
    text: '文本',
    image: '图片',
    ink: '手绘',
  };
  return map[type] || '批注';
}

function renderAnnotations() {
  if (!el.annotationCount || !el.annotationList || !el.notesSection) return;
  const detailReady = state.detailStatus === 'ready';
  const annotations = detailReady ? state.annotations : [];
  el.annotationCount.textContent = String(annotations.length);

  if (state.detailStatus === 'loading' || state.detailStatus === 'idle') {
    el.annotationList.innerHTML = skeletonRows(3);
    el.notesSection.innerHTML = '';
    return;
  }
  if (state.detailStatus === 'error') {
    el.annotationList.innerHTML = `<div class="annotation-empty">条目详情不可用，暂时无法读取批注。</div>`;
    el.notesSection.innerHTML = '';
    return;
  }
  if (!annotations.length) {
    el.annotationList.innerHTML = `<div class="annotation-empty">${
      state.pdfStatus === 'nopdf' ? '该条目没有 PDF 附件，因此没有 PDF 批注。' : '这份 PDF 暂无批注。'
    }<br />批注来自你在 Zotero 中的真实高亮。</div>`;
  } else {
    el.annotationList.innerHTML = annotations
      .map((annotation, index) => {
        const pageText = annotation.pageLabel
          ? `第 ${annotation.pageLabel} 页`
          : annotation.pageIndex !== null
            ? `第 ${annotation.pageIndex + 1} 页`
            : '未知页码';
        const tags = annotation.tags
          .slice(0, 2)
          .map((tag) => `<span class="annotation-tag">${escapeHtml(tag)}</span>`)
          .join('');
        return `
          <div role="listitem">
            <button class="annotation-item ${index === state.annotationActiveIndex ? 'is-active' : ''}" type="button" data-annotation-index="${index}"
              style="--ann-color:${annotation.color}" title="跳转到 ${escapeHtml(pageText)}">
              <span class="annotation-quote">${escapeHtml(annotation.text || `（${annotationTypeLabel(annotation.type)}，无原文）`)}</span>
              ${annotation.comment ? `<span class="annotation-comment">${escapeHtml(annotation.comment)}</span>` : ''}
              <span class="annotation-meta">
                <span class="annotation-page">${escapeHtml(pageText)}</span>
                <span>${escapeHtml(annotationTypeLabel(annotation.type))}</span>
                ${annotation.dateAdded ? `<span>${formatDate(annotation.dateAdded)}</span>` : ''}
                ${tags}
              </span>
            </button>
          </div>`;
      })
      .join('');
  }

  if (state.notes.length) {
    el.notesSection.innerHTML = `
      <div class="panel-title" style="margin-bottom:6px">条目笔记 <span class="count-badge">${state.notes.length}</span></div>
      ${state.notes
        .map(
          (note, index) => `
        <div class="note-card">
          <div class="note-text is-clamped" data-note-text="${index}">${escapeHtml(note.text)}</div>
          <button class="note-more" type="button" data-toggle-note="${index}" aria-expanded="false">展开全文</button>
        </div>`,
        )
        .join('')}`;
  } else {
    el.notesSection.innerHTML = '';
  }
}

async function jumpToAnnotation(index) {
  const annotation = state.annotations[index];
  if (!annotation) return;
  state.annotationActiveIndex = index;
  renderAnnotations();
  if (state.pdfStatus !== 'ready') {
    toast('PDF 尚未加载完成，无法跳转页码', { tone: 'error' });
    return;
  }
  if (annotation.pageIndex === null) {
    toast('该批注没有页码信息', { tone: 'error' });
    return;
  }
  const target = annotation.pageIndex + 1;
  if (target < 1 || target > state.numPages) {
    toast(`批注页码 ${target} 超出 PDF 总页数（${state.numPages}）`, { tone: 'error' });
    return;
  }
  await viewer.goToPage(target);
  toast(`已跳到第 ${annotation.pageLabel || target} 页`);
}

/* ============================== 选中文字复制 ============================== */

function currentPdfSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const node = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  if (!node || !node.closest || !node.closest('.textLayer')) return null;
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return { text, rect };
}

function hideCopyPopover() {
  if (!el.copyPop) return;
  el.copyPop.hidden = true;
  state.selectionText = '';
}

function updateCopyPopover() {
  if (!el.copyPop) return;
  const found = currentPdfSelection();
  if (!found) {
    hideCopyPopover();
    return;
  }
  state.selectionText = found.text;
  const width = Math.min(260, window.innerWidth - 24);
  const centerX = clamp(found.rect.left + found.rect.width / 2, width / 2 + 12, window.innerWidth - width / 2 - 12);
  const topY = Math.max(found.rect.top - 6, 44);
  el.copyPop.style.left = `${centerX}px`;
  el.copyPop.style.top = `${topY}px`;
  el.copyPop.hidden = false;
}

async function copyCurrentSelection() {
  if (!state.selectionText) return;
  const ok = await copyText(state.selectionText);
  toast(ok ? '已复制选中文本' : '复制失败，请手动选择后复制', { tone: ok ? 'info' : 'error' });
  if (ok) hideCopyPopover();
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  el.refreshBtn.addEventListener('click', () => refreshAll({ initial: false }));

  el.openWorkspace?.addEventListener('click', () => openFullWorkspace());

  el.toggleAnnotations.addEventListener('click', () => toggleAnnotationsPanel());
  el.annotationClose.addEventListener('click', () => toggleAnnotationsPanel(false));

  el.toggleLibrary.addEventListener('click', () => toggleLibraryDrawer());
  el.drawerScrim.addEventListener('click', () => toggleLibraryDrawer(false));
  try {
    const narrowMedia = window.matchMedia('(max-width: 760px)');
    const onNarrowChange = () => syncNarrowLayout();
    if (typeof narrowMedia.addEventListener === 'function') narrowMedia.addEventListener('change', onNarrowChange);
    else if (typeof narrowMedia.addListener === 'function') narrowMedia.addListener(onNarrowChange);
  } catch {
    /* 不支持 matchMedia 时忽略 */
  }

  el.searchInput.addEventListener(
    'input',
    debounce(() => {
      state.query = el.searchInput.value.trim();
      el.clearSearch.hidden = !el.searchInput.value;
      loadItems({ reset: true });
    }, 260),
  );
  el.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      state.query = el.searchInput.value.trim();
      loadItems({ reset: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (el.searchInput.value) {
        el.searchInput.value = '';
        state.query = '';
        el.clearSearch.hidden = true;
        loadItems({ reset: true });
      } else {
        el.searchInput.blur();
      }
    }
  });
  el.clearSearch.addEventListener('click', () => {
    el.searchInput.value = '';
    state.query = '';
    el.clearSearch.hidden = true;
    loadItems({ reset: true });
    el.searchInput.focus();
  });
  el.fulltextToggle.addEventListener('change', () => {
    state.fulltext = el.fulltextToggle.checked;
    loadItems({ reset: true });
  });
  el.sortSelect.addEventListener('change', () => {
    state.sort = el.sortSelect.value || 'dateModified';
    loadItems({ reset: true });
  });

  el.collections.addEventListener('click', (event) => {
    const target = event.target.closest('button, [data-collection-key]');
    if (!target) return;
    if (target.matches('[data-retry-collections]')) {
      loadCollections();
      return;
    }
    const saved = target.closest('[data-saved-search]');
    if (saved) {
      el.searchInput.value = saved.dataset.savedSearch || '';
      state.query = el.searchInput.value.trim();
      el.clearSearch.hidden = !el.searchInput.value;
      loadItems({ reset: true });
      return;
    }
    const toggle = target.closest('[data-toggle-collection]');
    if (toggle) {
      const key = toggle.dataset.toggleCollection;
      if (state.expandedCollections.has(key)) state.expandedCollections.delete(key);
      else state.expandedCollections.add(key);
      renderCollections();
      return;
    }
    const collection = target.closest('[data-collection-key]');
    if (collection) selectCollection(collection.dataset.collectionKey || '');
  });

  el.itemList.addEventListener('click', (event) => {
    const row = event.target.closest('[data-item-key]');
    if (row) selectItem(row.dataset.itemKey);
  });

  el.itemsFooter.addEventListener('click', (event) => {
    if (event.target.closest('[data-load-more]')) loadItems({ reset: false });
    if (event.target.closest('[data-retry-items]')) loadItems({ reset: true });
  });

  el.prevPage.addEventListener('click', () => viewer?.prevPage());
  el.nextPage.addEventListener('click', () => viewer?.nextPage());
  el.pageInput.addEventListener('focus', () => el.pageInput.select());
  el.pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitPageInput();
      el.pageInput.blur();
    }
  });
  el.pageInput.addEventListener('blur', () => {
    if (state.pdfStatus !== 'ready') return;
    el.pageInput.value = String(state.page);
  });
  el.zoomIn.addEventListener('click', () => viewer?.zoomIn());
  el.zoomOut.addEventListener('click', () => viewer?.zoomOut());
  el.fitWidth.addEventListener('click', () => viewer?.setFitWidth());
  el.attachmentSelect.addEventListener('change', async () => {
    state.attachmentKey = el.attachmentSelect.value;
    await openPdf();
  });
  el.openPdf.addEventListener('click', (event) => {
    if (el.openPdf.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      toast('当前条目没有可打开的 PDF 附件', { tone: 'error' });
    }
  });

  el.stageRetry.addEventListener('click', () => {
    if (el.stageRetry.dataset.retryKind === 'pdf') openPdf();
    else selectItem(state.selectedKey, { force: true });
  });

  el.annotationList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-annotation-index]');
    if (item) jumpToAnnotation(Number(item.dataset.annotationIndex));
  });
  el.notesSection.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle-note]');
    if (!toggle) return;
    const index = Number(toggle.dataset.toggleNote);
    const text = el.notesSection.querySelector(`[data-note-text="${index}"]`);
    if (!text) return;
    const expanded = text.classList.toggle('is-clamped');
    toggle.setAttribute('aria-expanded', String(!expanded));
    toggle.textContent = expanded ? '展开全文' : '收起';
  });

  el.copySelectionBtn.addEventListener('click', copyCurrentSelection);
  document.addEventListener('selectionchange', () => {
    if (copyPopTimer) clearTimeout(copyPopTimer);
    copyPopTimer = setTimeout(() => {
      copyPopTimer = null;
      updateCopyPopover();
    }, 60);
  });
  document.addEventListener('mousedown', (event) => {
    if (!el.copyPop.hidden && !el.copyPop.contains(event.target)) hideCopyPopover();
  });
  el.pdfScroll.addEventListener('scroll', hideCopyPopover, { passive: true });
  window.addEventListener('resize', hideCopyPopover);
  window.addEventListener('beforeunload', () => viewer?.dispose());

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const inField =
      target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    if (event.key === 'Escape') {
      hideCopyPopover();
      if (state.libraryOpen) {
        toggleLibraryDrawer(false);
        return;
      }
      if (inField) {
        target.blur();
        return;
      }
      if (window.matchMedia('(max-width: 980px)').matches && state.annotationsOpen) {
        toggleAnnotationsPanel(false);
        return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
      return;
    }
    if (inField) return;
    if (event.key === 'ArrowLeft') {
      if (state.pdfStatus === 'ready') {
        event.preventDefault();
        viewer?.prevPage();
      }
    } else if (event.key === 'ArrowRight') {
      if (state.pdfStatus === 'ready') {
        event.preventDefault();
        viewer?.nextPage();
      }
    } else if (event.key === '/') {
      event.preventDefault();
      if (isNarrowLayout() && !state.libraryOpen) toggleLibraryDrawer(true);
      el.searchInput.focus();
      el.searchInput.select();
    }
  });
}

function commitPageInput() {
  if (state.pdfStatus !== 'ready') return;
  const value = Number.parseInt(el.pageInput.value, 10);
  if (!Number.isFinite(value)) {
    el.pageInput.value = String(state.page);
    return;
  }
  const target = clamp(value, 1, state.numPages);
  el.pageInput.value = String(target);
  viewer?.goToPage(target);
}

/* ============================== 启动入口 ============================== */

/** 由 app.js 按 ?mode 决定是否启动 sidebar 模式。 */
export function startSidebarApp() {
  citationReveal = new CitationRevealController({
    mount: document.body,
    api,
    bridge,
    getViewer: () => viewer,
    getWritesAnnotations: () => Boolean(state.health?.writes?.annotations),
    openInReader: openCitationInReader,
  });
  bridge.onHostMessage = handleHostMessage;
  bridge.start();
  boot()
    .catch((error) => {
      console.error('[zotero-workbench] 启动失败', error);
      showBootError(error);
    })
    .finally(() => flushPendingReveals());
}

// 供自动化自测（Chrome headless / 控制台）读取运行状态，不参与业务逻辑。
window.__ZOTERO_WORKBENCH__ = {
  state,
  get viewer() {
    return viewer;
  },
  refreshAll,
  bridge,
  get citationReveal() {
    return citationReveal;
  },
  queueOrRevealCitation,
  get revealFlushCount() {
    return revealFlushCount;
  },
  version: '0.10.0-web.1',
};
