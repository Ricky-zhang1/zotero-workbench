/**
 * 全页 Zotero 工作区（?mode=workspace）。
 *
 * 布局：顶栏（视图 tabs / 连接状态） + 左侧导航 + 中间列表或阅读区 + 右侧详情栏。
 * 能力：
 *  - 文库浏览 / 分类树 / 保存搜索 / 信息检查（/api/maintenance）
 *  - 多选 + [加入对话] [提问] [清除]（DSH postMessage 桥，独立打开时降级复制）
 *  - 条目详情（元数据/摘要/批注/笔记）+ 引用与导出 tab（/api/citations）
 *  - 中心区 PDF 阅读（pdf.js）+ Zotero 真实批注矩形覆盖层 + 批注浮层
 *  - [在 Zotero 中显示] 走宿主 /api/open 或复制 zotero:// 深链
 */

import {
  $,
  clamp,
  copyText,
  debounce,
  escapeHtml,
  icon,
  itemTypeLabel,
  skeletonRows,
  toast,
} from './dom.js';
import { ApiClient } from './api.js';
import { createHostBridge } from './host-bridge.js';
import { initTheme } from './theme.js';
import { PdfViewer } from './pdf-viewer.js';
import { CitationRevealController } from './citation-reveal.js';
import { mountResearchWorkbench } from './research-view.js';
import { mountCollaborationWorkbench } from './collaboration-view.js';
import { collaborationRequestEnvelope } from './collaboration-api.js';
import {
  doiHref,
  normalizeCollections,
  normalizeDetail,
  normalizeItemSummary,
  normalizeLibraries,
  normalizeSavedSearches,
  venueLine,
  zoteroItemUrl,
  zoteroPdfUrl,
} from './normalize.js';

const PAGE_SIZE = 50;
const CITATION_FORMATS = [
  { value: 'bibtex', label: 'BibTeX' },
  { value: 'biblatex', label: 'BibLaTeX' },
  { value: 'ris', label: 'RIS' },
  { value: 'csljson', label: 'CSL JSON' },
  { value: 'text', label: '纯文本（APA）' },
];
const CITATION_STYLES = [
  { value: 'apa', label: 'APA' },
  { value: 'chicago-author-date', label: 'Chicago' },
  { value: 'modern-language-association', label: 'MLA' },
];
const MAINTENANCE_LABELS = {
  unfiled: '未归类',
  missingDOI: '缺少 DOI',
  missingPDF: '缺少 PDF',
  duplicates: '疑似重复',
};
const NAV_MAINTENANCE = [
  { view: 'unfiled', label: '未归类' },
  { view: 'missingDOI', label: '缺少 DOI' },
  { view: 'missingPDF', label: '缺少 PDF' },
  { view: 'duplicates', label: '疑似重复' },
];

const LAYOUT_STORAGE_KEY = 'zotero-workbench:workspace-layout:v1';
const LAYOUT_DEFAULTS = Object.freeze({ navWidth: 224, detailWidth: 304, navCollapsed: false, detailCollapsed: false });
const LAYOUT_LIMITS = Object.freeze({ nav: { min: 160, max: 420 }, detail: { min: 240, max: 560 } });
const LAYOUT_MIN_CENTER = 300;
const LAYOUT_HANDLES_TOTAL = 12;

const api = new ApiClient();

const state = {
  view: 'library', // library | citations | research
  center: 'list', // list | reader
  nav: { kind: 'all', key: '', view: '' },
  collections: [],
  savedSearches: [],
  expandedCollections: new Set(),

  query: '',
  fulltext: false,
  sort: 'dateModified',

  items: [],
  itemStatus: 'idle', // idle | loading | loading-more | ready | error
  itemError: '',
  nextStart: null,
  total: null,
  maintenanceTruncated: false,
  maintenanceVersion: null,

  selection: new Set(),
  // 跨视图保留勾选：保存 key → 摘要，避免切换导航后加入对话/引用丢条目。
  selectionCache: new Map(),
  currentKey: '',
  detail: null,
  detailStatus: 'idle', // idle | loading | ready | error
  detailError: '',

  reader: {
    open: false,
    attachmentKey: '',
    status: 'empty', // empty | loading | ready | error | nopdf
    error: '',
    page: 1,
    numPages: 0,
    scale: 1,
    fitMode: 'width',
    progress: null,
    overlayCount: 0,
  },

  citations: {
    status: 'idle', // idle | loading | ready | error
    format: 'bibtex',
    style: 'apa',
    text: '',
    error: '',
  },

  health: null,
  bridge: { connected: false, embedded: false },
  popoverAnnotationKey: '',
  annotationCommentEdit: null,
  annotationCommentRequest: 0,
  booted: false,
};

let root = null;
let viewer = null;
let bridge = null;
let theme = null;
let el = {};
let itemsAbort = null;
let detailAbort = null;
let citationsAbort = null;
let askContextText = '';
let selectedAnnotationIndex = -1;
let citationReveal = null;
const pendingRevealIds = [];
/** 角标定位打开流程串行化（并发/慢请求下避免 selectItem/openReader 互相打断） */
let revealOpenChain = Promise.resolve();
/** 最近一次 openReader promise（便于 citation 流程等待真实加载结果） */
let readerOpenPromise = null;
let revealFlushCount = 0;
/** 桌面宽屏左右栏布局状态（localStorage 持久化；窄屏不使用但保留值） */
let layoutState = { ...LAYOUT_DEFAULTS };
let layoutDrag = null;
let layoutResizeTimer = null;
let researchDisposer = null;
let researchScopeKey = '';
let collaborationDisposer = null;
let pendingResearchNoteKey = '';

/* ============================== HTML 骨架 ============================== */

function shellHtml() {
  const formatOptions = CITATION_FORMATS.map(
    (entry) => `<option value="${entry.value}" ${entry.value === 'bibtex' ? 'selected' : ''}>${entry.label}</option>`,
  ).join('');
  const styleOptions = CITATION_STYLES.map(
    (entry) => `<option value="${entry.value}" ${entry.value === 'apa' ? 'selected' : ''}>${entry.label}</option>`,
  ).join('');
  return `
  <div class="ws-topbar">
    <div class="ws-brand" aria-hidden="true"><span class="brand-mark">Z</span><span class="ws-brand-name">Zotero</span></div>
    <nav class="ws-tabs" role="tablist" aria-label="工作区视图">
      <button class="ws-tab is-active" type="button" role="tab" aria-selected="true" data-ws-tab="library">文库与阅读</button>
      <button class="ws-tab" type="button" role="tab" aria-selected="false" data-ws-tab="research">笔记与写作</button>
      <button class="ws-tab" type="button" role="tab" aria-selected="false" data-ws-tab="collaboration">会话协作</button>
      <button class="ws-tab" type="button" role="tab" aria-selected="false" data-ws-tab="citations">条目与引用<span class="ws-tab-badge" id="ws-tab-badge" hidden>0</span></button>
    </nav>
    <div class="ws-topbar-spacer"></div>
    <span class="ws-bridge-chip" id="ws-bridge-chip" title="与 DSH 宿主对话桥的连接状态">连接中…</span>
    <div class="health-status" id="ws-health"><span class="health-dot"></span><span class="health-text">连接中…</span></div>
    <button class="icon-btn ws-nav-toggle" type="button" data-ws-action="nav-toggle" aria-label="显示或隐藏左侧导航" title="导航">${icon('book')}</button>
    <button class="icon-btn ws-detail-toggle" type="button" data-ws-action="detail-toggle" aria-label="显示或隐藏详情栏" title="详情">${icon('doc')}</button>
    <button class="icon-btn" type="button" id="ws-refresh" aria-label="刷新文库" title="刷新">${icon('refresh')}</button>
    <button class="btn btn-quiet ws-compact-switch" type="button" data-ws-action="to-sidebar" title="切换到紧凑侧边栏模式">紧凑模式</button>
  </div>
  <div class="ws-body" id="ws-body">
    <aside class="ws-nav" id="ws-nav" aria-label="导航">
      <div class="ws-nav-scroll" id="ws-nav-scroll"></div>
      <div class="ws-nav-footer">
        <button class="ws-reset-layout" type="button" data-ws-action="reset-layout" title="恢复默认栏宽并展开左右栏">重置布局</button>
      </div>
    </aside>
    <div
      class="ws-resize-handle ws-resize-nav"
      id="ws-resize-nav"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整左侧导航宽度：←/→ 调整 16px，Home/End 到极限，双击恢复默认"
      aria-controls="ws-nav"
      tabindex="0"
      data-ws-resize="nav"
    ></div>
    <section class="ws-center" id="ws-center" aria-label="文献区">
      <div class="ws-list-view" id="ws-list-view">
        <div class="ws-searchbar">
          <span class="search-icon">${icon('search')}</span>
          <input id="ws-search" class="ws-search-input" type="search" placeholder="搜索标题、作者、年份…（/）" autocomplete="off" spellcheck="false" aria-label="搜索文献" />
          <button class="search-clear" type="button" id="ws-search-clear" aria-label="清空搜索" hidden>${icon('x')}</button>
          <label class="check ws-fulltext" title="同时搜索全文与笔记">
            <input type="checkbox" id="ws-fulltext" /><span>全文与笔记</span>
          </label>
          <label class="sr-only" for="ws-sort">排序</label>
          <select id="ws-sort" class="select">
            <option value="dateModified">最近修改</option>
            <option value="dateAdded">最近添加</option>
            <option value="title">标题</option>
            <option value="year">年份</option>
          </select>
        </div>
        <div class="ws-list-head">
          <label class="check"><input type="checkbox" id="ws-select-all" /><span>全选本页</span></label>
          <span class="ws-result-count" id="ws-result-count" role="status" aria-live="polite"></span>
        </div>
        <div class="ws-list-scroll" id="ws-list-scroll">
          <ol class="ws-item-list" id="ws-item-list" role="listbox" aria-multiselectable="true" aria-label="文献列表"></ol>
          <div class="ws-list-footer" id="ws-list-footer"></div>
        </div>
        <div class="ws-selection-bar" id="ws-selection-bar" hidden>
          <span class="ws-selection-count" id="ws-selection-count">已选 0 项</span>
          <div class="ws-selection-actions">
            <button class="btn btn-primary" type="button" data-ws-action="add-to-chat">加入对话</button>
            <button class="btn" type="button" data-ws-action="ask">提问</button>
            <button class="btn btn-quiet" type="button" data-ws-action="clear-selection">清除</button>
          </div>
        </div>
      </div>

      <div class="ws-citations-view" id="ws-citations-view" hidden>
        <div class="ws-citations-toolbar">
          <label class="sr-only" for="ws-citation-format">引用格式</label>
          <select id="ws-citation-format" class="select">${formatOptions}</select>
          <label class="sr-only" for="ws-citation-style">引用样式</label>
          <select id="ws-citation-style" class="select" title="纯文本格式的引用样式">${styleOptions}</select>
          <button class="btn" type="button" data-ws-action="citation-refresh">${'重新生成'}</button>
          <span class="tool-spacer"></span>
          <button class="btn" type="button" data-ws-action="citation-copy">${icon('copy', 13)}<span>复制</span></button>
        </div>
        <div class="ws-citations-body">
          <div class="ws-citations-hint" id="ws-citations-hint"></div>
          <pre class="ws-citations-output" id="ws-citations-output" tabindex="0"></pre>
        </div>
      </div>

      <div class="ws-research-view" id="ws-research-view" hidden aria-label="笔记与写作"></div>
      <div class="ws-collaboration-view" id="ws-collaboration-view" hidden aria-label="DSH 会话协作"></div>

      <div class="ws-reader-view" id="ws-reader-view" hidden>
        <div class="ws-reader-head">
          <button class="btn btn-quiet ws-back-btn" type="button" data-ws-action="reader-back">${icon('arrowLeft')}<span>返回文库</span></button>
          <div class="ws-reader-title" id="ws-reader-title"></div>
      <span class="ws-status-badge ws-ann-count" id="ws-reader-ann-count" title="本 PDF 批注数">批注 0</span>
        </div>
        <div class="ws-reader-toolbar" id="ws-reader-toolbar">
          <div class="tool-group" role="group" aria-label="翻页">
            <button class="icon-btn" type="button" id="ws-prev-page" aria-label="上一页（←）" title="上一页（←）">${icon('arrowLeft')}</button>
            <div class="page-box">
              <label class="sr-only" for="ws-page-input">页码</label>
              <input id="ws-page-input" class="page-input" type="text" inputmode="numeric" value="1" aria-label="当前页码" />
              <span class="page-total">/ <span id="ws-page-total">1</span></span>
            </div>
            <button class="icon-btn" type="button" id="ws-next-page" aria-label="下一页（→）" title="下一页（→）">${icon('arrowRight')}</button>
          </div>
          <div class="tool-sep" aria-hidden="true"></div>
          <div class="tool-group" role="group" aria-label="缩放">
            <button class="icon-btn" type="button" id="ws-zoom-out" aria-label="缩小">${icon('zoomOut')}</button>
            <span class="zoom-label" id="ws-zoom-label">—</span>
            <button class="icon-btn" type="button" id="ws-zoom-in" aria-label="放大">${icon('zoomIn')}</button>
            <button class="btn btn-quiet" type="button" id="ws-fit-width" aria-pressed="true">适合宽度</button>
          </div>
          <div class="tool-sep" aria-hidden="true"></div>
          <label class="sr-only" for="ws-attachment-select">PDF 附件</label>
          <select id="ws-attachment-select" class="select" hidden></select>
          <span class="tool-spacer"></span>
          <button class="btn btn-quiet" type="button" data-ws-action="reader-open-zotero">${icon('external', 13)}<span>在 Zotero 中显示</span></button>
        </div>
        <div class="ws-reader-stage" id="ws-reader-stage">
          <div class="pdf-scroll" id="ws-pdf-scroll"><div id="ws-pdf-page" class="pdf-page" aria-label="PDF 页面"></div></div>
          <div class="stage-overlay" id="ws-stage-overlay" hidden><div class="stage-card"><div class="spinner" aria-hidden="true"></div><p id="ws-stage-overlay-text" class="stage-text">正在加载…</p></div></div>
          <div class="stage-empty" id="ws-stage-empty" hidden></div>
          <div class="stage-error" id="ws-stage-error" hidden>
            <div class="stage-error-icon">${icon('warn', 22)}</div>
            <h2 id="ws-stage-error-title">加载失败</h2>
            <p id="ws-stage-error-message"></p>
            <button class="btn" type="button" data-ws-action="reader-retry">重试</button>
          </div>
        </div>
      </div>
    </section>
    <div
      class="ws-resize-handle ws-resize-detail"
      id="ws-resize-detail"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右侧详情栏宽度：←/→ 调整 16px，Home/End 到极限，双击恢复默认"
      aria-controls="ws-detail"
      tabindex="0"
      data-ws-resize="detail"
    ></div>
    <aside class="ws-detail" id="ws-detail" aria-label="条目详情">
      <div class="ws-detail-head">
        <span class="panel-title">条目详情</span>
        <button class="icon-btn ws-detail-close" type="button" data-ws-action="detail-close" aria-label="关闭详情栏">${icon('x')}</button>
      </div>
      <div class="ws-detail-scroll" id="ws-detail-scroll"></div>
    </aside>
  </div>

  <div class="ws-ann-popover" id="ws-ann-popover" role="dialog" aria-label="批注详情" hidden>
    <div class="ws-ann-popover-inner">
      <div class="ws-ann-popover-head">
        <span class="ws-ann-color" id="ws-ann-color"></span>
        <span class="ws-ann-page" id="ws-ann-page"></span>
        <button class="icon-btn" type="button" data-ws-action="ann-close" aria-label="关闭批注浮层">${icon('x')}</button>
      </div>
      <blockquote class="ws-ann-quote" id="ws-ann-quote"></blockquote>
      <p class="ws-ann-comment" id="ws-ann-comment"></p>
      <button class="btn btn-quiet ws-ann-comment-edit" type="button" id="ws-ann-comment-edit" data-ws-action="ann-comment-edit">添加备注</button>
      <div class="ws-ann-comment-editor" id="ws-ann-comment-editor" hidden>
        <label class="ws-ann-comment-label" for="ws-ann-comment-input">阅读者备注（写入当前 Zotero 批注）</label>
        <textarea class="ws-ann-comment-input" id="ws-ann-comment-input" rows="3" maxlength="20000"></textarea>
        <div class="ws-ann-comment-observed" id="ws-ann-comment-observed" hidden>
          <span class="ws-ann-comment-label">Zotero 当前备注（只读）</span>
          <p id="ws-ann-comment-observed-text"></p>
        </div>
        <p class="ws-ann-comment-status" id="ws-ann-comment-status" role="status" aria-live="polite" hidden></p>
        <div class="ws-ann-comment-actions">
          <button class="btn btn-quiet" type="button" id="ws-ann-comment-reconcile" data-ws-action="ann-comment-reconcile" hidden>只读核对</button>
          <button class="btn btn-quiet" type="button" data-ws-action="ann-comment-cancel">取消</button>
          <button class="btn btn-primary" type="button" id="ws-ann-comment-save" data-ws-action="ann-comment-save">保存备注</button>
        </div>
      </div>
      <div class="ws-ann-tags" id="ws-ann-tags"></div>
      <div class="ws-ann-popover-actions">
        <button class="btn btn-primary" type="button" data-ws-action="ann-open-zotero">${icon('external', 13)}<span>在 Zotero 中显示</span></button>
        <button class="btn btn-quiet" type="button" data-ws-action="ann-copy">${icon('copy', 13)}<span>复制原文</span></button>
      </div>
    </div>
  </div>

  <div class="ws-modal" id="ws-ask-modal" hidden>
    <div class="ws-modal-card" role="dialog" aria-modal="true" aria-labelledby="ws-ask-title">
      <div class="ws-modal-head"><h2 id="ws-ask-title">向对话提问</h2><button class="icon-btn" type="button" data-ws-action="ask-cancel" aria-label="取消">${icon('x')}</button></div>
      <p class="ws-modal-desc">问题与选中文献的上下文会一起交给宿主；独立打开（非 DSH）时改为复制到剪贴板。</p>
      <label class="sr-only" for="ws-ask-input">问题</label>
      <textarea id="ws-ask-input" class="ws-modal-input" rows="3" placeholder="想就这些文献问什么？例如：这几篇文献在教师编制问题上的共识与分歧是什么？"></textarea>
      <details class="ws-context-preview">
        <summary>上下文预览（<span id="ws-context-count">0</span> 条文献）</summary>
        <pre id="ws-ask-context"></pre>
      </details>
      <div class="ws-modal-actions">
        <button class="btn btn-quiet" type="button" data-ws-action="ask-cancel">取消</button>
        <button class="btn btn-primary" type="button" data-ws-action="ask-send">发送提问</button>
      </div>
    </div>
  </div>`;
}

/* ============================== 启动 ============================== */

export async function startWorkspaceApp({ root: rootNode }) {
  root = rootNode;
  window.addEventListener('pagehide', () => {
    researchDisposer?.();
    researchDisposer = null;
    collaborationDisposer?.();
    collaborationDisposer = null;
  }, { once: true });
  root.innerHTML = shellHtml();
  el = {
    root,
    body: $('#ws-body', root),
    nav: $('#ws-nav', root),
    navScroll: $('#ws-nav-scroll', root),
    navHandle: $('#ws-resize-nav', root),
    detailHandle: $('#ws-resize-detail', root),
    navToggleBtn: $('.ws-nav-toggle', root),
    detailToggleBtn: $('.ws-detail-toggle', root),
    resetLayoutBtn: $('.ws-reset-layout', root),
    listView: $('#ws-list-view', root),
    citationsView: $('#ws-citations-view', root),
    researchView: $('#ws-research-view', root),
    collaborationView: $('#ws-collaboration-view', root),
    readerView: $('#ws-reader-view', root),
    detail: $('#ws-detail', root),
    detailScroll: $('#ws-detail-scroll', root),
    itemList: $('#ws-item-list', root),
    listScroll: $('#ws-list-scroll', root),
    listFooter: $('#ws-list-footer', root),
    search: $('#ws-search', root),
    searchClear: $('#ws-search-clear', root),
    fulltext: $('#ws-fulltext', root),
    sort: $('#ws-sort', root),
    selectAll: $('#ws-select-all', root),
    resultCount: $('#ws-result-count', root),
    selectionBar: $('#ws-selection-bar', root),
    selectionCount: $('#ws-selection-count', root),
    health: $('#ws-health', root),
    bridgeChip: $('#ws-bridge-chip', root),
    tabBadge: $('#ws-tab-badge', root),
    refresh: $('#ws-refresh', root),
    citationFormat: $('#ws-citation-format', root),
    citationStyle: $('#ws-citation-style', root),
    citationsOutput: $('#ws-citations-output', root),
    citationsHint: $('#ws-citations-hint', root),
    readerTitle: $('#ws-reader-title', root),
    readerAnnCount: $('#ws-reader-ann-count', root),
    prevPage: $('#ws-prev-page', root),
    nextPage: $('#ws-next-page', root),
    pageInput: $('#ws-page-input', root),
    pageTotal: $('#ws-page-total', root),
    zoomIn: $('#ws-zoom-in', root),
    zoomOut: $('#ws-zoom-out', root),
    zoomLabel: $('#ws-zoom-label', root),
    fitWidth: $('#ws-fit-width', root),
    attachmentSelect: $('#ws-attachment-select', root),
    pdfScroll: $('#ws-pdf-scroll', root),
    pdfPage: $('#ws-pdf-page', root),
    stageOverlay: $('#ws-stage-overlay', root),
    stageOverlayText: $('#ws-stage-overlay-text', root),
    stageEmpty: $('#ws-stage-empty', root),
    stageError: $('#ws-stage-error', root),
    stageErrorTitle: $('#ws-stage-error-title', root),
    stageErrorMessage: $('#ws-stage-error-message', root),
    annPopover: $('#ws-ann-popover', root),
    annColor: $('#ws-ann-color', root),
    annPage: $('#ws-ann-page', root),
    annQuote: $('#ws-ann-quote', root),
    annComment: $('#ws-ann-comment', root),
    annCommentEditBtn: $('#ws-ann-comment-edit', root),
    annCommentEditor: $('#ws-ann-comment-editor', root),
    annCommentInput: $('#ws-ann-comment-input', root),
    annCommentObserved: $('#ws-ann-comment-observed', root),
    annCommentObservedText: $('#ws-ann-comment-observed-text', root),
    annCommentStatus: $('#ws-ann-comment-status', root),
    annCommentReconcile: $('#ws-ann-comment-reconcile', root),
    annCommentSave: $('#ws-ann-comment-save', root),
    annTags: $('#ws-ann-tags', root),
    askModal: $('#ws-ask-modal', root),
    askInput: $('#ws-ask-input', root),
    askContext: $('#ws-ask-context', root),
    contextCount: $('#ws-context-count', root),
  };

  theme = initTheme();
  bridge = createHostBridge({
    mode: 'workspace',
    onHello: () => {
      updateHostUi();
      toast('已连接 DSH 对话桥');
    },
    onStatus: () => updateHostUi(),
  });
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

  setupViewer();
  bindEvents();
  initWorkspaceLayout();
  updateHostUi();
  renderNav();
  renderList();
  renderDetail();
  showBootLoading('正在连接 Zotero…');

  try {
    await refreshAll({ initial: true });
  } catch (error) {
    showBootError(error);
  } finally {
    flushPendingReveals();
  }
}

/* ============================== 角标跳转定位（reveal-citation） ============================== */

function waitForReaderPage(targetPage, { timeout = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let done = false;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
    };
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error('PDF 页面定位已取消'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {
      /* ignore */
    }
    const started = Date.now();
    const tick = () => {
      if (done) return;
      if (state.reader.status === 'ready' && state.reader.page === targetPage) {
        finish(resolve, { page: state.reader.page, numPages: state.reader.numPages });
        return;
      }
      if (state.reader.status === 'error') {
        finish(reject, new Error(state.reader.error || 'PDF 加载失败'));
        return;
      }
      // P2.1：页数已知且目标越界时立即失败，不空转 30s。
      if (state.reader.numPages && targetPage > state.reader.numPages) {
        finish(reject, new Error(`登记页码 ${targetPage} 超出 PDF 共 ${state.reader.numPages} 页，请重新登记`));
        return;
      }
      if (Date.now() - started > timeout) {
        finish(reject, new Error('PDF 页面定位超时'));
        return;
      }
      timer = setTimeout(tick, 150);
    };
    tick();
  });
}

/* 角标定位：串行化打开流程，await 真实结果而不是轮询状态标志（P1.1/P2.1/P3.3）。 */
async function performCitationOpen(record) {
  if (!record || !record.itemKey) throw new Error('引文记录缺少条目信息');
  const sameItem =
    state.currentKey === record.itemKey && state.detailStatus === 'ready' && Boolean(state.detail);
  if (!sameItem) {
    await selectItem(record.itemKey, { preserveCitationReveal: true });
  }
  if (state.detailStatus !== 'ready' || !state.detail) {
    throw new Error(state.detailError || '条目详情加载失败');
  }
  const pdfAttachments = state.detail.attachments.filter((attachment) => attachment.isPdf);
  if (!pdfAttachments.length) throw new Error('该条目没有 PDF 附件');
  const attachment = pdfAttachments.find((entry) => entry.key === record.attachmentKey) || pdfAttachments[0];
  const pageIndex = Number(record.pageIndex);
  if (!Number.isFinite(pageIndex) || pageIndex < 0) throw new Error('引文记录页码无效');
  const target = pageIndex + 1;

  // 复用路径：文档已在 viewer 中打开且正是目标附件 → 先用 numPages 校验，越界立即报错（<1s）。
  // 若当前打开的是同一条目的另一个 PDF，则不能复用（否则页数/高亮会错配），走 openReader 重载。
  const targetUrl = api.pdfUrl({ library: 'user', key: attachment.key });
  const readerOpen =
    state.center === 'reader' && state.reader.open && viewer?.isOpen && viewer.currentUrl === targetUrl;
  if (readerOpen) {
    const numPages = viewer.numPages || 0;
    if (!numPages) throw new Error('PDF 页数未知，无法定位');
    if (pageIndex >= numPages) {
      throw new Error(`登记页码 ${target} 超出 PDF 共 ${numPages} 页，请重新登记`);
    }
    if (state.reader.attachmentKey !== attachment.key) state.reader.attachmentKey = attachment.key;
    if (viewer.pageNumber !== target) await viewer.goToPage(target);
    state.reader.status = 'ready';
    renderReaderStage();
    renderReaderToolbar();
    return;
  }

  // 先加载到第 1 页拿到真实 numPages，再校验/跳页；越界时报精确的登记页码错误（P2.1）。
  const result = await openReader({ page: 1, attachmentKey: attachment.key });
  const numPages = result?.numPages || viewer?.numPages || 0;
  if (!numPages) throw new Error('PDF 页数未知，无法定位');
  if (pageIndex >= numPages) {
    throw new Error(`登记页码 ${target} 超出 PDF 共 ${numPages} 页，请重新登记`);
  }
  if (viewer.pageNumber !== target) await viewer.goToPage(target);
  if (viewer.pageNumber !== target) throw new Error(`无法跳转到第 ${target} 页`);
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

/* ============================== 启动状态 ============================== */

function setHealth(kind, text) {
  if (!el.health) return;
  el.health.className = `health-status is-${kind}`;
  const label = el.health.querySelector('.health-text');
  if (label) label.textContent = text;
  el.root.dataset.health = kind;
}

function showBootLoading(message) {
  root.dataset.boot = 'loading';
  const boot = document.getElementById('boot-screen');
  if (!boot) return;
  boot.classList.remove('is-hidden', 'is-error');
  const spinner = document.getElementById('boot-spinner');
  const bootIcon = document.getElementById('boot-icon');
  const retry = document.getElementById('boot-retry');
  if (spinner) spinner.hidden = false;
  if (bootIcon) bootIcon.hidden = true;
  if (retry) retry.hidden = true;
  const title = document.getElementById('boot-title');
  const text = document.getElementById('boot-message');
  const hint = document.getElementById('boot-hint');
  if (title) title.textContent = 'Zotero 工作台';
  if (text) text.textContent = message || '正在加载…';
  if (hint) hint.textContent = '';
}

function hideBoot() {
  root.dataset.boot = 'ready';
  state.booted = true;
  document.getElementById('boot-screen')?.classList.add('is-hidden');
}

function showBootError(error) {
  root.dataset.boot = 'error';
  setHealth('error', '连接失败');
  const boot = document.getElementById('boot-screen');
  if (!boot) return;
  boot.classList.remove('is-hidden');
  boot.classList.add('is-error');
  const spinner = document.getElementById('boot-spinner');
  const bootIcon = document.getElementById('boot-icon');
  const retry = document.getElementById('boot-retry');
  if (spinner) spinner.hidden = true;
  if (bootIcon) {
    bootIcon.hidden = false;
    bootIcon.innerHTML = icon('warn', 22);
  }
  if (retry) {
    retry.hidden = false;
    retry.onclick = () => refreshAll({ initial: true }).catch((err) => showBootError(err));
  }
  const title = document.getElementById('boot-title');
  const message = document.getElementById('boot-message');
  const hint = document.getElementById('boot-hint');
  if (title) title.textContent = '无法连接 Zotero 工作台';
  if (message) message.textContent = (error && error.message) || '未知错误';
  if (hint) {
    hint.innerHTML =
      '请确认：① 本机 Zotero 已启动；② DSH 中「Zotero 文献」插件已启用；③ 宿主提供 /zotero-workbench/api/health。';
  }
}

/* ============================== 与宿主的连接状态 ============================== */

function updateHostUi() {
  const connected = Boolean(bridge && bridge.connected);
  state.bridge = { connected, embedded: Boolean(bridge && bridge.embedded) };
  if (el.bridgeChip) {
    el.bridgeChip.className = `ws-bridge-chip ${connected ? 'is-connected' : ''}`;
    el.bridgeChip.textContent = connected
      ? '对话已连接'
      : bridge && bridge.embedded
        ? '对话连接中…（未连接时复制）'
        : '独立模式（复制）';
    el.bridgeChip.title = connected
      ? `DSH 宿主已就绪（能力：${(bridge.capabilities || []).join('、') || '未声明'}）`
      : '未检测到 DSH 宿主对话桥：加入对话/提问/在 Zotero 中显示会降级为复制到剪贴板';
  }
  const suffix = connected ? '' : '（复制）';
  for (const button of root.querySelectorAll('[data-ws-action="add-to-chat"]')) {
    button.textContent = `加入对话${suffix}`;
  }
  for (const button of root.querySelectorAll('[data-ws-action="ask"]')) {
    button.textContent = `提问${suffix}`;
  }
  for (const button of root.querySelectorAll('[data-ws-action="ann-open-zotero"], [data-ws-action="reader-open-zotero"], [data-ws-action="open-zotero-current"]')) {
    const textNode = button.querySelector('span');
    if (textNode) textNode.textContent = `在 Zotero 中显示${suffix}`;
    else button.textContent = `在 Zotero 中显示${suffix}`;
  }
}

/* ============================== 刷新 / 健康 ============================== */

async function refreshAll({ initial = false } = {}) {
  theme.refresh();
  setHealth('loading', '连接中…');
  el.refresh.disabled = true;
  try {
    let health;
    try {
      health = await api.health();
    } catch (error) {
      setHealth('error', '连接失败');
      if (initial) showBootError(error);
      else toast(`刷新失败：${error.message}`, { tone: 'error' });
      return;
    }
    state.health = health;
    const reachable = !health?.zotero || health.zotero.reachable !== false;
    if (!reachable) {
      setHealth('warn', 'Zotero 未启动');
      if (initial) hideBoot();
      toast('Zotero 未启动或不可达：文库可能为空，请启动 Zotero 后刷新。', { tone: 'error', timeout: 4800 });
    } else {
      setHealth('ok', health?.zotero?.version ? `已连接 · ${health.zotero.version}` : '已连接');
      if (initial) hideBoot();
    }
    await loadCollections();
    await loadItems({ reset: true, autoSelect: initial });
    if (initial) hideBoot();
    if (state.currentKey && state.detailStatus !== 'loading') {
      await loadDetail(state.currentKey, { silent: true });
    }
  } finally {
    el.refresh.disabled = false;
  }
}

/* ============================== 左侧导航 ============================== */

function renderNav() {
  const nav = state.nav;
  const rows = [];
  const activeAll = nav.kind === 'all';
  rows.push(`
    <div class="ws-nav-group">
      <button class="ws-nav-item ${activeAll ? 'is-active' : ''}" type="button" data-ws-nav="all" aria-current="${activeAll ? 'true' : 'false'}">
        ${icon('book')}<span class="ws-nav-text">全部文献</span>${Number.isFinite(state.total) ? `<span class="ws-count">${state.total}</span>` : ''}
      </button>
    </div>`);

  rows.push('<div class="ws-nav-group"><div class="ws-nav-label">信息检查</div>');
  for (const entry of NAV_MAINTENANCE) {
    const active = nav.kind === 'maintenance' && nav.view === entry.view;
    rows.push(`
      <button class="ws-nav-item ${active ? 'is-active' : ''}" type="button" data-ws-nav="maintenance" data-ws-view="${entry.view}">
        ${icon('warn')}<span class="ws-nav-text">${entry.label}</span>
      </button>`);
  }
  rows.push('</div>');

  rows.push('<div class="ws-nav-group" id="ws-collection-nav"></div>');
  rows.push('<div class="ws-nav-group" id="ws-saved-nav"></div>');
  el.navScroll.innerHTML = rows.join('');

  renderCollectionNav();
  renderSavedSearchNav();
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

function renderCollectionNav() {
  const holder = el.navScroll.querySelector('#ws-collection-nav');
  if (!holder) return;
  if (!state.collections.length) {
    holder.innerHTML = '';
    return;
  }
  const rows = ['<div class="ws-nav-label">分类</div>'];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const open = state.expandedCollections.has(node.key);
      const active = state.nav.kind === 'collection' && state.nav.key === node.key;
      rows.push(`
        <div class="ws-nav-tree-row ${open ? 'is-open' : ''}" style="--depth:${depth}">
          <button class="tree-toggle ${hasChildren ? '' : 'is-leaf'}" type="button" data-ws-toggle-collection="${escapeHtml(node.key)}" aria-label="${open ? '折叠' : '展开'}分类 ${escapeHtml(node.name)}" aria-expanded="${open}" ${hasChildren ? '' : 'tabindex="-1"'} style="margin-left:${depth * 12}px">${icon('chevronRight', 12)}</button>
          <button class="ws-nav-item ws-nav-collection ${active ? 'is-active' : ''}" type="button" data-ws-collection="${escapeHtml(node.key)}" title="${escapeHtml(node.name)}">
            ${icon('collection')}<span class="ws-nav-text">${escapeHtml(node.name)}</span>
            ${node.itemCount ? `<span class="ws-count">${node.itemCount}</span>` : ''}
          </button>
        </div>`);
      if (hasChildren && open) walk(node.children, depth + 1);
    }
  };
  walk(buildCollectionTree(), 0);
  holder.innerHTML = rows.join('');
}

function renderSavedSearchNav() {
  const holder = el.navScroll.querySelector('#ws-saved-nav');
  if (!holder) return;
  if (!state.savedSearches.length) {
    holder.innerHTML = '';
    return;
  }
  holder.innerHTML = `<div class="ws-nav-label">保存的搜索</div>${state.savedSearches
    .slice(0, 8)
    .map(
      (search) => `
      <button class="ws-nav-item" type="button" data-ws-saved-search="${escapeHtml(search.name)}">
        ${icon('search')}<span class="ws-nav-text">${escapeHtml(search.name)}</span>
      </button>`,
    )
    .join('')}`;
}

function setNav(next) {
  if (state.annotationCommentEdit?.status === 'saving') {
    setAnnotationCommentStatus('Zotero 备注写入请求仍在处理；请先等待回执，当前草稿会保留。', 'info');
    return;
  }
  state.nav = next;
  if (next.kind === 'collection') {
    let cursor = state.collections.find((collection) => collection.key === next.key);
    const seen = new Set();
    while (cursor && cursor.parentCollection && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      state.expandedCollections.add(cursor.parentCollection);
      cursor = state.collections.find((collection) => collection.key === cursor.parentCollection);
    }
  }
  renderNav();
  if (state.center === 'reader') closeReader({ preserveCitationReveal });
  loadItems({ reset: true });
}

async function loadCollections() {
  try {
    const data = await api.collections('user');
    state.collections = normalizeCollections(data?.collections);
    state.savedSearches = normalizeSavedSearches(data?.savedSearches);
    normalizeLibraries(data?.libraries); // 单用户库：当前 UI 只展示“我的文库”
    for (const collection of state.collections) {
      if (!collection.parentCollection) state.expandedCollections.add(collection.key);
    }
  } catch (error) {
    state.collections = [];
    state.savedSearches = [];
    toast(`分类加载失败：${error.message}`, { tone: 'error' });
  }
  renderNav();
}

/* ============================== 文献列表 ============================== */

async function loadItems({ reset = false, autoSelect = false } = {}) {
  if (itemsAbort) itemsAbort.abort();
  const controller = new AbortController();
  itemsAbort = controller;

  const isMaintenance = state.nav.kind === 'maintenance';
  const start = reset ? 0 : state.nextStart ?? state.items.length;
  if (reset) {
    state.itemStatus = 'loading';
    state.itemError = '';
    state.items = [];
    state.nextStart = null;
    state.total = null;
    state.maintenanceTruncated = false;
    state.maintenanceVersion = null;
  } else {
    if (state.nextStart === null && state.itemStatus === 'ready') return;
    state.itemStatus = 'loading-more';
  }
  renderList();

  try {
    let items;
    let nextStart;
    let total;
    if (isMaintenance) {
      const data = await api.maintenance({ view: state.nav.view || 'unfiled', offset: start, limit: PAGE_SIZE, version: start ? state.maintenanceVersion : undefined, signal: controller.signal });
      const rawItems = Array.isArray(data?.items) ? data.items : [];
      items = rawItems.map(normalizeItemSummary).filter((item) => item.key);
      total = Number.isFinite(Number(data?.total)) ? Number(data.total) : null;
      nextStart = total !== null && start + items.length < total ? start + items.length : null;
      if(controller.signal.aborted)return;
      state.maintenanceTruncated = Boolean(data?.truncated || data?.comparisonTruncated);
      state.maintenanceVersion = data?.version;
    } else {
      const data = await api.items({
        library: 'user',
        q: state.query,
        collection: state.nav.kind === 'collection' ? state.nav.key : '',
        sort: state.sort,
        start,
        limit: PAGE_SIZE,
        mode: state.fulltext ? 'everything' : 'all',
        signal: controller.signal,
      });
      const rawItems = Array.isArray(data?.items) ? data.items : [];
      items = rawItems.map(normalizeItemSummary).filter((item) => item.key);
      total = Number.isFinite(Number(data?.total)) ? Number(data.total) : null;
      const next = data?.nextStart;
      if (next === null || next === undefined) {
        nextStart = items.length >= PAGE_SIZE ? start + items.length : null;
      } else {
        nextStart = Number(next);
        if (!Number.isFinite(nextStart)) nextStart = null;
      }
    }
    if (controller.signal.aborted) return;
    state.items = reset ? items : state.items.concat(items);
    state.nextStart = nextStart;
    state.total = total;
    state.itemStatus = 'ready';
    state.itemError = '';
    renderList();
    renderNav();
    if (reset) {
      el.listScroll.scrollTop = 0;
      if (autoSelect && !state.currentKey && state.items.length) {
        await selectItem(state.items[0].key, { skipReload: false });
      } else if (state.currentKey && !state.items.some((item) => item.key === state.currentKey)) {
        // 当前条目不在新列表时保留详情，避免打断阅读。
      }
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return;
    state.itemStatus = 'error';
    state.itemError = error.message || '未知错误';
    renderList();
  }
}

function renderList() {
  if (!el.itemList) return;
  const status = state.itemStatus;
  if (status === 'loading' || status === 'idle') {
    el.itemList.innerHTML = skeletonRows(7);
    el.listFooter.innerHTML = '';
    updateResultCount();
    updateSelectionBar();
    return;
  }
  if (status === 'error') {
    el.itemList.innerHTML = '';
    el.listFooter.innerHTML = `
      <div class="items-message is-error">
        列表加载失败：${escapeHtml(state.itemError)}
        <div><button class="btn" type="button" data-ws-action="retry-items">重试</button></div>
      </div>`;
    updateResultCount();
    updateSelectionBar();
    return;
  }
  if (!state.items.length) {
    el.itemList.innerHTML = '';
    let hint;
    if (state.nav.kind === 'maintenance') {
      hint = state.nav.view==='duplicates' ? '本次扫描未发现符合规则的疑似重复文献' : `${MAINTENANCE_LABELS[state.nav.view] || '该视图'}没有条目`;
      if(state.maintenanceTruncated)hint += '（扫描达到上限，未覆盖全部文库）';
    } else if (state.query) {
      hint = `没有匹配「${escapeHtml(state.query)}」的文献`;
    } else {
      hint = '这里还没有文献';
    }
    el.listFooter.innerHTML = `<div class="items-message">${hint}<br /><span class="muted">试试切换导航、清空搜索或刷新</span></div>`;
    updateResultCount();
    updateSelectionBar();
    return;
  }

  el.itemList.innerHTML = state.items.map((item) => renderItemRow(item)).join('');
  if (status === 'loading-more') {
    el.listFooter.innerHTML = `<div class="items-message" aria-live="polite">正在加载更多…</div>`;
  } else if (state.nextStart !== null && state.nextStart !== undefined) {
    el.listFooter.innerHTML = `<button class="btn load-more" type="button" data-ws-action="load-more">加载更多</button>`;
  } else {
    const suffix = state.maintenanceTruncated ? '（服务端扫描已截断）' : '';
    el.listFooter.innerHTML = `<div class="items-message" style="padding:10px;font-size:11px">已加载 ${state.items.length} 条${suffix}${state.nav.view === 'duplicates' ? ' · 仅为待核对候选，不自动合并' : ''}</div>`;
  }
  updateResultCount();
  updateSelectionBar();
  updateSelectAll();
}

function renderItemRow(item) {
  const selected = state.currentKey === item.key;
  const checked = state.selection.has(item.key);
  const authors = item.authors.length ? item.authors.slice(0, 3).join('、') : '未知作者';
  const metaBits = [];
  metaBits.push(`<span class="item-type-chip">${escapeHtml(itemTypeLabel(item.itemType))}</span>`);
  metaBits.push(`<span class="ws-item-authors">${escapeHtml(authors)}</span>`);
  if (item.year) metaBits.push(`<span class="ws-item-year">${escapeHtml(item.year)}</span>`);
  if (item.publicationTitle) metaBits.push(`<span class="ws-item-venue">${escapeHtml(item.publicationTitle)}</span>`);
  const journalRanks = renderJournalRanks(item.journalLevels);
  const tags = item.tags.slice(0, 3);
  const chips = [];
  if (journalRanks) chips.push(journalRanks);
  if (item.hasPdf) chips.push(`<span class="ws-pdf-badge" title="有 PDF 附件">${icon('doc', 11)} PDF</span>`);
  if (tags.length) chips.push(...tags.map((tag) => `<span class="ws-tag">${escapeHtml(tag)}</span>`));
  return `
    <li class="ws-item ${selected ? 'is-current' : ''}" role="option" aria-selected="${selected}" data-ws-key="${escapeHtml(item.key)}">
      <label class="ws-item-check" title="选择用于对话/引用">
        <input type="checkbox" data-ws-check="${escapeHtml(item.key)}" ${checked ? 'checked' : ''} aria-label="选择 ${escapeHtml(item.title)}" />
      </label>
      <button class="ws-item-main" type="button" data-ws-item="${escapeHtml(item.key)}">
        <span class="ws-item-title">${escapeHtml(item.title)}</span>
        <span class="ws-item-meta">${metaBits.join('<span class="dot"></span>')}</span>
        ${chips.length ? `<span class="ws-item-chips">${chips.join('')}</span>` : ''}
      </button>
      ${renderDuplicateReview(item)}
    </li>`;
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

function updateSelectAll() {
  if (!el.selectAll) return;
  const keys = state.items.map((item) => item.key);
  const selectedCount = keys.filter((key) => state.selection.has(key)).length;
  el.selectAll.checked = keys.length > 0 && selectedCount === keys.length;
  el.selectAll.indeterminate = selectedCount > 0 && selectedCount < keys.length;
  el.selectAll.disabled = keys.length === 0;
}

/* ============================== 多选与对话 ============================== */

function syncSelectionDom() {
  for (const input of el.itemList.querySelectorAll('[data-ws-check]')) {
    input.checked = state.selection.has(input.dataset.wsCheck);
  }
  updateSelectionBar();
  updateSelectAll();
  renderTabBadge();
}

function recordSelectionSummary(item) {
  if (item) state.selectionCache.set(item.key, item);
}

function toggleSelection(key, force) {
  if (!key) return;
  const shouldCheck = force === undefined ? !state.selection.has(key) : Boolean(force);
  if (shouldCheck) {
    state.selection.add(key);
    recordSelectionSummary(state.items.find((item) => item.key === key));
  } else {
    state.selection.delete(key);
    state.selectionCache.delete(key);
  }
  // 只同步勾选状态，不整表重绘；同时失效引用 tab 的旧结果（P2.2）。
  invalidateCitations();
  syncSelectionDom();
}

function clearSelection() {
  state.selection.clear();
  state.selectionCache.clear();
  invalidateCitations();
  syncSelectionDom();
}

function selectionSummaries() {
  const byKey = new Map(state.items.map((item) => [item.key, item]));
  const summaries = [];
  for (const key of state.selection) {
    const summary = state.selectionCache.get(key) || byKey.get(key);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function updateSelectionBar() {
  if (!el.selectionBar) return;
  const count = state.selection.size;
  el.selectionBar.hidden = count === 0;
  if (el.selectionCount) el.selectionCount.textContent = `已选 ${count} 项`;
  for (const button of el.selectionBar.querySelectorAll('button')) button.disabled = count === 0;
}

function renderTabBadge() {
  if (!el.tabBadge) return;
  const count = state.selection.size;
  el.tabBadge.hidden = count === 0;
  el.tabBadge.textContent = String(count);
}

function itemCitationLine(item) {
  const authors = item.authors.length ? item.authors.join('、') : '未知作者';
  const year = item.year || 'n.d.';
  const venue = item.publicationTitle ? `《${item.publicationTitle}》` : '';
  return `${item.title}（${authors}·${year}）${venue} — ${zoteroItemUrl(item.key)}`;
}

function buildAddToChatText() {
  const summaries = selectionSummaries();
  if (!summaries.length) return '';
  return summaries.map((item) => itemCitationLine(item)).join('\n');
}

async function buildAskContext() {
  const summaries = selectionSummaries();
  const details = await Promise.all(
    summaries.slice(0, 20).map(async (item) => {
      if (state.detail && state.detail.key === item.key) return state.detail;
      try {
        const raw = await api.item({ library: 'user', key: item.key });
        return normalizeDetail(raw, state.collections);
      } catch {
        return null;
      }
    }),
  );
  const lines = [];
  summaries.forEach((item, index) => {
    const detail = details[index];
    lines.push(`[${index + 1}] ${item.title}`);
    const authors = item.authors.length ? item.authors.join('、') : '未知作者';
    lines.push(`作者：${authors}；年份：${item.year || 'n.d.'}${item.publicationTitle ? `；期刊：${item.publicationTitle}` : ''}`);
    if (item.DOI) lines.push(`DOI：${item.DOI}`);
    const abstract = detail?.abstractNote || '';
    if (abstract) lines.push(`摘要：${abstract.slice(0, 320)}${abstract.length > 320 ? '…' : ''}`);
    lines.push(`Zotero：${zoteroItemUrl(item.key)}`);
  });
  if (state.reader.open && state.detail && state.detail.annotations.length) {
    const pageIndex = state.reader.page - 1;
    const pageAnnotations = state.detail.annotations.filter((annotation) => annotation.pageIndex === pageIndex).slice(0, 5);
    if (pageAnnotations.length) {
      lines.push('');
      lines.push(`当前 PDF 第 ${state.reader.page} 页批注：`);
      for (const annotation of pageAnnotations) {
        lines.push(`- "${annotation.text}"${annotation.comment ? `（${annotation.comment}）` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

async function addToChat() {
  const text = buildAddToChatText();
  if (!text) {
    toast('请先勾选文献', { tone: 'error' });
    return;
  }
  await sendOrCopy('add-to-chat', { text }, text, '已加入对话输入框');
}

async function askWithSelection(question) {
  const context = await buildAskContext();
  if (!context) {
    toast('请先勾选文献', { tone: 'error' });
    return;
  }
  const payload = { question, context };
  const fallback = `${question}\n\n--- 上下文 ---\n${context}`;
  await sendOrCopy('ask', payload, fallback, '已发送提问');
}

async function sendOrCopy(type, payload, fallbackText, successMessage) {
  if (bridge && bridge.connected) {
    try {
      const ack = await bridge.request(type, payload, { timeout: 5000 });
      toast(ack.ok ? ack.message || successMessage : ack.message || '宿主处理失败', {
        tone: ack.ok ? 'info' : 'error',
      });
      return ack.ok;
    } catch (error) {
      if (error.code === 'host-unavailable' || error.code === 'host-timeout') {
        toast('对话桥未响应，已改为复制到剪贴板', { tone: 'error' });
      } else {
        toast(`操作失败：${error.message}`, { tone: 'error' });
        return false;
      }
    }
  }
  const copied = await copyText(fallbackText);
  toast(copied ? '已复制到剪贴板（独立模式，可粘贴到对话）' : '复制失败，请手动复制', {
    tone: copied ? 'info' : 'error',
  });
  return copied;
}

/* ============================== 条目详情 ============================== */

async function selectItem(key, { skipReload = false, preserveCitationReveal = false } = {}) {
  if (state.annotationCommentEdit?.status === 'saving' && key !== state.currentKey) {
    setAnnotationCommentStatus('Zotero 备注写入请求仍在处理；请先等待回执，当前草稿会保留。', 'info');
    return;
  }
  if (!key) return;
  if (
    !preserveCitationReveal &&
    citationReveal &&
    citationReveal.isVisible() &&
    citationReveal.currentRecord?.itemKey !== key
  ) {
    citationReveal.hide();
  }
  const changed = state.currentKey !== key;
  state.currentKey = key;
  renderList();
  renderTabBadge();
  if (!changed && state.detailStatus === 'ready' && !skipReload) {
    renderDetail();
    return;
  }
  if (state.center === 'reader') closeReader({ preserveCitationReveal });
  await loadDetail(key);
}

async function loadDetail(key, { silent = false } = {}) {
  if (detailAbort) detailAbort.abort();
  const controller = new AbortController();
  detailAbort = controller;
  state.detailStatus = silent ? state.detailStatus : 'loading';
  state.detailError = '';
  if (!silent) {
    state.detail = null;
    renderDetail();
  }
  try {
    const raw = await api.item({ library: 'user', key, signal: controller.signal });
    if (controller.signal.aborted) return;
    const detail = normalizeDetail(raw, state.collections);
    state.detail = detail;
    state.detailStatus = 'ready';
    state.reader.attachmentKey = (detail.attachments.find((attachment) => attachment.isPdf) || {}).key || '';
    renderDetail();
    renderReaderToolbar();
    if (state.center === 'reader' && !state.reader.open) renderReaderStage();
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return;
    state.detailStatus = 'error';
    state.detailError = error.message || '未知错误';
    renderDetail();
  }
}

function detailMetaRow(label, valueHtml) {
  if (!valueHtml) return '';
  return `<div class="ws-detail-row"><span class="ws-detail-label">${label}</span><span class="ws-detail-value">${valueHtml}</span></div>`;
}

function renderJournalRanks(levels) {
  if (!Array.isArray(levels) || !levels.length) return '';
  return levels
    .filter((level) => level && level.label)
    .map((level) => `<span class="ws-rank" title="Zotero 中已有的期刊等级信息">${escapeHtml(level.label)}</span>`)
    .join('');
}

function renderDetail() {
  if (!el.detailScroll) return;
  if (state.detailStatus === 'loading' || state.detailStatus === 'idle') {
    el.detailScroll.innerHTML = `
      <div class="ws-detail-body">
        <div class="skeleton-line" style="width:80%;height:14px"></div>
        <div class="skeleton-line" style="width:55%;margin-top:9px"></div>
        <div class="skeleton-line" style="width:70%;margin-top:9px"></div>
        ${skeletonRows(3)}
      </div>`;
    return;
  }
  if (!state.currentKey) {
    el.detailScroll.innerHTML = `<div class="ws-detail-empty">${icon('doc', 22)}<p>选择一篇文献，这里会显示元数据、摘要与批注。</p></div>`;
    return;
  }
  if (state.detailStatus === 'error') {
    el.detailScroll.innerHTML = `
      <div class="ws-detail-body">
        <div class="items-message is-error">详情加载失败：${escapeHtml(state.detailError)}
          <div><button class="btn" type="button" data-ws-action="retry-detail">重试</button></div>
        </div>
      </div>`;
    return;
  }
  const detail = state.detail;
  if (!detail) return;
  const doi = doiHref(detail.DOI);
  const pdfAttachments = detail.attachments.filter((attachment) => attachment.isPdf);
  const venue = venueLine(detail);
  const authorLine = detail.authors || '未知作者';
  const collectionsHtml = detail.collectionNames.length
    ? detail.collectionNames.map((name) => `<span class="ws-taxonomy-tag ws-taxonomy-tag-collection">${icon('collection', 12)}<span>${escapeHtml(name)}</span></span>`).join('')
    : '';
  const tagsHtml = detail.tags.length
    ? detail.tags.map((tag) => `<span class="ws-taxonomy-tag"><span class="ws-taxonomy-hash" aria-hidden="true">#</span><span>${escapeHtml(tag)}</span></span>`).join('')
    : '';
  const fieldLabels = {
    date: '出版日期', dateAdded: '加入日期', dateModified: '修改日期', ISSN: 'ISSN', ISBN: 'ISBN',
    publisher: '出版社', place: '出版地', edition: '版次', seriesTitle: '丛书', series: '系列',
    conferenceName: '会议名称', proceedingsTitle: '会议录', bookTitle: '书名', websiteTitle: '网站',
    accessDate: '访问日期', archive: '档案馆', archiveLocation: '档案位置', callNumber: '索书号',
    rights: '版权', libraryCatalog: '馆藏目录', institution: '机构', reportNumber: '报告编号',
    thesisType: '学位类型', university: '学校', number: '编号', patentNumber: '专利号',
  };
  const knownFields = new Set([
    'key', 'version', 'itemType', 'title', 'creators', 'date', 'dateAdded', 'dateModified', 'language',
    'DOI', 'ISSN', 'ISBN', 'publicationTitle', 'proceedingsTitle', 'bookTitle', 'websiteTitle',
    'publisher', 'place', 'volume', 'issue', 'pages', 'url', 'extra', 'abstractNote', 'tags', 'collections',
  ]);
  const fieldValue = (value) => Array.isArray(value) ? value.join('、') : value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  const additionalFields = Object.entries(detail.fields || {}).filter(([name, value]) =>
    !knownFields.has(name) && value !== null && value !== undefined && fieldValue(value).trim() !== '',
  );
  const additionalFieldsHtml = additionalFields.length
    ? `<details class="ws-detail-more"><summary>其他元数据（${additionalFields.length}）</summary><div class="ws-detail-more-fields">${additionalFields.map(([name, value]) => detailMetaRow(escapeHtml(fieldLabels[name] || name), escapeHtml(fieldValue(value)))).join('')}</div></details>`
    : '';
  const attachmentsHtml = detail.attachments.length
    ? `<div class="ws-attachment-list">${detail.attachments.map((attachment) => {
      const size = Number(attachment.size);
      const sizeText = Number.isFinite(size) && size > 0 ? (size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`) : '大小未知';
      const kind = attachment.isPdf ? 'PDF' : attachment.contentType || attachment.linkMode || '附件';
      return `<div class="ws-attachment-row"><div class="ws-attachment-info"><strong>${escapeHtml(attachment.title)}</strong><span>${escapeHtml([attachment.filename, kind, sizeText, attachment.linkMode].filter(Boolean).join(' · '))}</span><code>${escapeHtml(attachment.key)}</code></div><button class="btn btn-quiet" type="button" data-ws-detail-attachment="${escapeHtml(attachment.key)}">${attachment.isPdf ? '阅读 PDF' : '打开附件'}</button></div>`;
    }).join('')}</div>`
    : '<div class="ws-detail-muted">没有附件</div>';
  const rawFields = detail.fields || {};
  const itemUrl = /^https?:\/\//i.test(detail.url || '') ? detail.url : '';
  const extraHtml = detail.extra
    ? `<details class="ws-detail-more"><summary>Extra</summary><pre>${escapeHtml(detail.extra)}</pre></details>`
    : '';
  const annotations = detail.annotations;
  const annotationItems = annotations.length
    ? annotations
        .map(
          (annotation, index) => `
        <button class="ws-detail-ann ${index === selectedAnnotationIndex ? 'is-active' : ''}" type="button" data-ws-detail-ann="${index}" style="--ann-color:${annotation.color}">
          <span class="ws-detail-ann-quote">${escapeHtml(annotation.text || '（无原文）')}</span>
          ${annotation.comment ? `<span class="ws-detail-ann-comment">${escapeHtml(annotation.comment)}</span>` : ''}
          <span class="ws-detail-ann-meta">
            <span class="ws-ann-page-chip">第 ${escapeHtml(annotation.pageLabel || String((annotation.pageIndex ?? 0) + 1))} 页</span>
            ${annotation.tags.slice(0, 2).map((tag) => `<span class="ws-tag">${escapeHtml(tag)}</span>`).join('')}
          </span>
        </button>`,
        )
        .join('')
    : `<div class="ws-detail-muted">该 PDF 暂无批注</div>`;
  const notesHtml = detail.notes.length
    ? detail.notes
        .map(
          (note) => `<details class="ws-note" data-ws-note="${escapeHtml(note.key)}"><summary>${escapeHtml(note.title)}</summary><p>${escapeHtml(note.text)}</p></details>`,
        )
        .join('')
    : '';
  el.detailScroll.innerHTML = `
    <div class="ws-detail-body">
      <h2 class="ws-detail-title" title="${escapeHtml(detail.title)}">${escapeHtml(detail.title)}</h2>
      <div class="ws-detail-sub">${escapeHtml(authorLine)}${detail.year ? ` · ${escapeHtml(detail.year)}` : ''}</div>
      <div class="ws-detail-actions">
        <button class="btn btn-primary" type="button" data-ws-action="read-pdf" ${pdfAttachments.length ? '' : 'disabled title="该条目没有 PDF 附件"'}>${icon('doc', 13)}<span>阅读 PDF</span></button>
        <button class="btn" type="button" data-ws-action="view-annotations" ${annotations.length ? '' : 'disabled'}>${icon('quote', 13)}<span>查看批注${annotations.length ? `（${annotations.length}）` : ''}</span></button>
        <button class="btn" type="button" data-ws-action="cite-current">${icon('copy', 13)}<span>引用与导出</span></button>
        <button class="btn" type="button" data-ws-action="open-zotero-current">${icon('external', 13)}<span>在 Zotero 中显示</span></button>
      </div>
      <div class="ws-detail-section">
        ${detailMetaRow('类型', escapeHtml(itemTypeLabel(detail.itemType)))}
        ${detailMetaRow('作者', escapeHtml(authorLine))}
        ${detailMetaRow('期刊/来源', escapeHtml(venue || '—'))}
        ${detail.journalLevels.length ? detailMetaRow('期刊等级', `<span class="ws-ranks">${renderJournalRanks(detail.journalLevels)}</span>`) : ''}
        ${detailMetaRow('年份', escapeHtml(detail.year || '—'))}
        ${detailMetaRow('日期', escapeHtml(detail.date || '—'))}
        ${detailMetaRow('语言', escapeHtml(detail.language || '—'))}
        ${detailMetaRow('ISSN', escapeHtml(fieldValue(rawFields.ISSN) || '—'))}
        ${detailMetaRow('ISBN', escapeHtml(fieldValue(rawFields.ISBN) || '—'))}
        ${detailMetaRow('卷 / 期 / 页', escapeHtml([detail.volume, detail.issue && `第 ${detail.issue} 期`, detail.pages].filter(Boolean).join(' / ') || '—'))}
        ${detailMetaRow('出版社', escapeHtml(detail.publisher || '—'))}
        ${detailMetaRow('DOI', doi ? `<a href="${escapeHtml(doi)}" target="_blank" rel="noopener noreferrer">${escapeHtml(detail.DOI)}</a>` : '—')}
        ${detailMetaRow('URL', itemUrl ? `<a href="${escapeHtml(itemUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(detail.url)}</a>` : escapeHtml(detail.url || '—'))}
        ${detailMetaRow('集合', collectionsHtml || '—')}
        ${detailMetaRow('标签', tagsHtml || '—')}
        ${detailMetaRow('加入 / 修改', escapeHtml([detail.dateAdded, detail.dateModified].filter(Boolean).join(' · ') || '—'))}
        ${detailMetaRow('PDF', pdfAttachments.length ? `${pdfAttachments.length} 个 PDF 附件` : '无')}
        ${extraHtml}
        ${additionalFieldsHtml}
      </div>
      <div class="ws-detail-section" id="ws-detail-abstract">
        <h3 class="ws-detail-h3">摘要</h3>
        <p class="ws-detail-abstract ${detail.abstractNote ? '' : 'is-empty'}">${detail.abstractNote ? escapeHtml(detail.abstractNote) : '（该条目没有摘要）'}</p>
      </div>
      <div class="ws-detail-section" id="ws-detail-attachments">
        <h3 class="ws-detail-h3">附件 <span class="count-badge">${detail.attachments.length}</span></h3>
        ${attachmentsHtml}
      </div>
      <div class="ws-detail-section" id="ws-detail-annotations">
        <h3 class="ws-detail-h3">批注 <span class="count-badge">${annotations.length}</span></h3>
        <div class="ws-detail-ann-list">${annotationItems}</div>
      </div>
      ${notesHtml ? `<div class="ws-detail-section"><h3 class="ws-detail-h3">笔记</h3>${notesHtml}</div>` : ''}
    </div>`;
  // 保持选中批注可见
  const active = el.detailScroll.querySelector('.ws-detail-ann.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
  if (pendingResearchNoteKey && focusResearchNote(pendingResearchNoteKey)) pendingResearchNoteKey = '';
}

function scrollDetailToAnnotations() {
  el.detailScroll?.querySelector('#ws-detail-annotations')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============================== 桌面宽屏左右栏布局（折叠 / 拖拽 / 持久化） ============================== */

function isWideLayout() {
  try {
    return window.matchMedia('(min-width: 981px)').matches;
  } catch {
    return window.innerWidth > 980;
  }
}

function layoutResponsiveDefaults() {
  return window.innerWidth <= 1180
    ? { navWidth: 200, detailWidth: 280 }
    : { navWidth: LAYOUT_DEFAULTS.navWidth, detailWidth: LAYOUT_DEFAULTS.detailWidth };
}

function clampLayoutWidth(kind, value) {
  const limits = LAYOUT_LIMITS[kind];
  const fallback = kind === 'nav' ? layoutResponsiveDefaults().navWidth : layoutResponsiveDefaults().detailWidth;
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, numeric));
}

function clampLayoutToViewport(next) {
  if (!isWideLayout()) return next;
  const maxSum = Math.max(
    LAYOUT_LIMITS.nav.min + LAYOUT_LIMITS.detail.min,
    window.innerWidth - LAYOUT_HANDLES_TOTAL - LAYOUT_MIN_CENTER,
  );
  let navWidth = next.navWidth;
  let detailWidth = next.detailWidth;
  const overflow = navWidth + detailWidth - maxSum;
  if (overflow > 0) {
    const detailShrink = Math.min(overflow, detailWidth - LAYOUT_LIMITS.detail.min);
    detailWidth -= detailShrink;
    const remain = overflow - detailShrink;
    if (remain > 0) navWidth = Math.max(LAYOUT_LIMITS.nav.min, navWidth - remain);
  }
  return { ...next, navWidth, detailWidth };
}

function loadLayoutState() {
  const fallback = { ...LAYOUT_DEFAULTS, ...layoutResponsiveDefaults() };
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return clampLayoutToViewport({
          navWidth: clampLayoutWidth('nav', parsed.navWidth ?? fallback.navWidth),
          detailWidth: clampLayoutWidth('detail', parsed.detailWidth ?? fallback.detailWidth),
          navCollapsed: Boolean(parsed.navCollapsed),
          detailCollapsed: Boolean(parsed.detailCollapsed),
        });
      }
    }
  } catch (error) {
    console.warn('[zotero-workbench] 读取布局设置失败', error);
  }
  return clampLayoutToViewport({ ...fallback });
}

function saveLayoutState() {
  try {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        navWidth: layoutState.navWidth,
        detailWidth: layoutState.detailWidth,
        navCollapsed: layoutState.navCollapsed,
        detailCollapsed: layoutState.detailCollapsed,
      }),
    );
  } catch (error) {
    console.warn('[zotero-workbench] 保存布局设置失败', error);
  }
}

function applyLayout({ persist = false } = {}) {
  if (!el.body) return;
  const wide = isWideLayout();
  layoutState = clampLayoutToViewport(layoutState);
  el.body.style.setProperty('--ws-nav-width', `${layoutState.navWidth}px`);
  el.body.style.setProperty('--ws-detail-width', `${layoutState.detailWidth}px`);
  if (wide) {
    // 宽屏：折叠态生效；清掉窄屏抽屉残留 class，避免切回宽屏时状态错乱。
    el.body.classList.toggle('nav-collapsed', Boolean(layoutState.navCollapsed));
    el.body.classList.toggle('detail-collapsed', Boolean(layoutState.detailCollapsed));
    el.body.classList.remove('nav-open', 'detail-open');
  } else {
    // 窄屏：始终用 overlay 抽屉；折叠状态只保留在数据里，等回到宽屏再恢复。
    el.body.classList.remove('nav-collapsed', 'detail-collapsed');
  }
  syncLayoutControls();
  if (persist) saveLayoutState();
}

function syncLayoutControls() {
  const wide = isWideLayout();
  if (el.navToggleBtn) {
    const pressed = wide ? !layoutState.navCollapsed : el.body.classList.contains('nav-open');
    el.navToggleBtn.setAttribute('aria-pressed', String(pressed));
    el.navToggleBtn.setAttribute('aria-label', `${pressed ? '收起' : '展开'}左侧导航`);
    el.navToggleBtn.title = pressed ? '收起导航' : '展开导航';
  }
  if (el.detailToggleBtn) {
    const pressed = wide ? !layoutState.detailCollapsed : el.body.classList.contains('detail-open');
    el.detailToggleBtn.setAttribute('aria-pressed', String(pressed));
    el.detailToggleBtn.setAttribute('aria-label', `${pressed ? '收起' : '展开'}详情栏`);
    el.detailToggleBtn.title = pressed ? '收起详情' : '展开详情';
  }
  const bindSeparator = (handle, kind, current, collapsed) => {
    if (!handle) return;
    const limits = LAYOUT_LIMITS[kind];
    handle.setAttribute('aria-valuemin', String(limits.min));
    handle.setAttribute('aria-valuemax', String(limits.max));
    handle.setAttribute('aria-valuenow', String(current));
    handle.setAttribute('aria-disabled', String(Boolean(collapsed)));
  };
  bindSeparator(el.navHandle, 'nav', layoutState.navWidth, layoutState.navCollapsed);
  bindSeparator(el.detailHandle, 'detail', layoutState.detailWidth, layoutState.detailCollapsed);
}

function setLayoutWidth(kind, value, { persist = true } = {}) {
  const width = clampLayoutWidth(kind, value);
  if (kind === 'nav') layoutState.navWidth = width;
  else layoutState.detailWidth = width;
  applyLayout({ persist });
}

function toggleNavPanel() {
  if (isWideLayout()) {
    layoutState.navCollapsed = !layoutState.navCollapsed;
    applyLayout({ persist: true });
    return;
  }
  el.body.classList.toggle('nav-open');
  el.body.classList.remove('detail-open');
  syncLayoutControls();
}

function toggleDetailPanel() {
  if (state.view === 'citations') {
    setView('library');
    applyReaderLayout();
  }
  if (isWideLayout()) {
    layoutState.detailCollapsed = !layoutState.detailCollapsed;
    applyLayout({ persist: true });
    return;
  }
  el.body.classList.toggle('detail-open');
  el.body.classList.remove('nav-open');
  syncLayoutControls();
}

function resetLayout() {
  // 显式重置为规范默认值 224 / 304（双击单项也恢复到这两个默认值）。
  layoutState = { ...LAYOUT_DEFAULTS, navCollapsed: false, detailCollapsed: false };
  applyLayout({ persist: true });
  toast('已重置左右栏布局');
}

function beginLayoutDrag(kind, event) {
  if (!isWideLayout()) return;
  if (event.button !== undefined && event.button !== 0) return;
  if ((kind === 'nav' && layoutState.navCollapsed) || (kind === 'detail' && layoutState.detailCollapsed)) return;
  const handle = kind === 'nav' ? el.navHandle : el.detailHandle;
  if (!handle) return;
  event.preventDefault();
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
  layoutDrag = {
    kind,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: kind === 'nav' ? layoutState.navWidth : layoutState.detailWidth,
    handle,
  };
  handle.classList.add('is-active');
  document.body.classList.add('resizing');
  root.classList.add('resizing');
}

function moveLayoutDrag(event) {
  if (!layoutDrag) return;
  const dx = event.clientX - layoutDrag.startX;
  // 左栏拖拽条向右变宽；右栏拖拽条在详情栏左侧，向左拖动变宽。
  const nextWidth = layoutDrag.kind === 'nav' ? layoutDrag.startWidth + dx : layoutDrag.startWidth - dx;
  const width = clampLayoutWidth(layoutDrag.kind, nextWidth);
  if (layoutDrag.kind === 'nav') layoutState.navWidth = width;
  else layoutState.detailWidth = width;
  applyLayout({ persist: false });
}

function endLayoutDrag() {
  if (!layoutDrag) return;
  const { handle, pointerId } = layoutDrag;
  handle?.classList.remove('is-active');
  try {
    handle?.releasePointerCapture(pointerId);
  } catch {
    /* ignore */
  }
  document.body.classList.remove('resizing');
  root.classList.remove('resizing');
  layoutDrag = null;
  applyLayout({ persist: true });
}

function handleLayoutKeydown(kind, event) {
  const current = kind === 'nav' ? layoutState.navWidth : layoutState.detailWidth;
  const limits = LAYOUT_LIMITS[kind];
  const increaseKey = kind === 'nav' ? 'ArrowRight' : 'ArrowLeft';
  const decreaseKey = kind === 'nav' ? 'ArrowLeft' : 'ArrowRight';
  let next = null;
  if (event.key === increaseKey) next = current + 16;
  else if (event.key === decreaseKey) next = current - 16;
  else if (event.key === 'Home') next = limits.min;
  else if (event.key === 'End') next = limits.max;
  if (next === null) return;
  event.preventDefault();
  setLayoutWidth(kind, next);
}

function initWorkspaceLayout() {
  layoutState = loadLayoutState();
  applyLayout();
  const bindHandle = (handle, kind) => {
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => beginLayoutDrag(kind, event));
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      setLayoutWidth(kind, kind === 'nav' ? LAYOUT_DEFAULTS.navWidth : LAYOUT_DEFAULTS.detailWidth);
      toast(kind === 'nav' ? '左侧导航宽度已恢复默认' : '右侧详情栏宽度已恢复默认');
    });
    handle.addEventListener('keydown', (event) => handleLayoutKeydown(kind, event));
  };
  bindHandle(el.navHandle, 'nav');
  bindHandle(el.detailHandle, 'detail');
  document.addEventListener('pointermove', moveLayoutDrag);
  document.addEventListener('pointerup', endLayoutDrag);
  document.addEventListener('pointercancel', endLayoutDrag);
  window.addEventListener('resize', () => {
    if (layoutResizeTimer) clearTimeout(layoutResizeTimer);
    layoutResizeTimer = setTimeout(() => {
      layoutResizeTimer = null;
      applyLayout();
    }, 120);
  });
  try {
    const media = window.matchMedia('(min-width: 981px)');
    const onChange = () => applyLayout();
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  } catch {
    /* ignore */
  }
}

/* ============================== 紧凑模式（交给宿主开右栏 tab） ============================== */

async function openCompactReader() {
  if (bridge && bridge.connected) {
    try {
      const ack = await bridge.request('open-compact-reader', {}, { timeout: 5000 });
      toast(ack.ok ? ack.message || '已在右栏打开紧凑阅读器' : ack.message || '宿主打开紧凑阅读器失败', {
        tone: ack.ok ? 'info' : 'error',
      });
      return;
    } catch (error) {
      if (error.code !== 'host-unavailable' && error.code !== 'host-timeout') {
        toast(`打开紧凑阅读器失败：${error.message}`, { tone: 'error' });
        return;
      }
      toast('对话桥未响应，改为本地切换到紧凑模式', { tone: 'error' });
    }
  }
  // 非 DSH 独立打开：降级为同页跳转（这正是用户直接开 dev-server 时的期望）。
  const url = new URL(window.location.href);
  url.search = '?mode=sidebar';
  window.location.assign(url.toString());
}

/* ============================== 引用与导出 ============================== */

function setView(view) {
  if (!['library', 'citations', 'research', 'collaboration'].includes(view)) view = 'library';
  state.view = view;
  for (const tab of root.querySelectorAll('[data-ws-tab]')) {
    const active = tab.dataset.wsTab === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  const citations = view === 'citations';
  const research = view === 'research';
  const collaboration = view === 'collaboration';
  el.listView.hidden = citations || research || collaboration || state.center === 'reader';
  el.citationsView.hidden = !citations;
  el.researchView.hidden = !research;
  el.collaborationView.hidden = !collaboration;
  el.readerView.hidden = citations || research || collaboration || state.center !== 'reader';
  el.detail.hidden = citations || research || collaboration;
  el.body.classList.toggle('view-citations', citations);
  el.body.classList.toggle('view-research', research);
  el.body.classList.toggle('view-collaboration', collaboration);
  if (citations) {
    el.citationStyle.disabled = state.citations.format !== 'text';
    loadCitations();
  }
  if (research) showResearchWorkbench();
  if (collaboration) showCollaborationWorkbench();
  syncLayoutControls();
  renderTabBadge();
}

function researchScope() {
  const keys = selectionKeys();
  if (keys.length) return { library: 'user', keys };
  if (state.nav.kind === 'collection' && state.nav.key) {
    return { library: 'user', collection: state.nav.key, recursive: true };
  }
  if (state.currentKey) return { library: 'user', keys: [state.currentKey] };
  return null;
}

export function researchRequestEnvelope(name, args = {}) {
  const action = ({
    research_materials: 'materials',
    start_research_job: 'start',
    research_job: 'status',
    cancel_research_job: 'cancel',
  })[name];
  if (!action) throw new Error(`不支持的研究操作：${name}`);
  return action === 'status' || action === 'cancel' ? { action, id: args.id } : { action, args };
}

export async function callResearchToolWithApi(apiClient, name, args = {}) {
  if (name === 'list_collections') {
    const data = await apiClient.collections(args.library || 'user');
    return { collections: normalizeCollections(data?.collections) };
  }
  if (name === 'search_library') {
    const options = {
      library: args.library || 'user',
      q: args.query,
      mode: args.mode,
      limit: args.limit,
      start: args.start,
    };
    for (const key of ['collection', 'sort', 'direction', 'tag'])
      if (args[key] !== undefined) options[key] = args[key];
    const data = await apiClient.items(options);
    const items = Array.isArray(data?.items) ? data.items : [];
    return { items, total: Number.isFinite(data?.total) ? data.total : items.length };
  }
  const body = researchRequestEnvelope(name, args);
  return apiClient.requestJson('/research', { method: 'POST', body });
}

export async function callReaderAnnotationCommentToolWithApi(apiClient, name, args = {}, options = {}) {
  const fields = name === 'read_reader_annotation_comment'
    ? ['library', 'annotationKey', 'attachmentKey']
    : name === 'update_reader_annotation_comment'
      ? ['library', 'annotationKey', 'attachmentKey', 'expectedVersion', 'expectedComment', 'comment', 'editToken']
      : null;
  if (!fields) throw new Error(`不支持的批注备注操作：${name}`);
  const actual = Object.keys(args).sort();
  if (actual.join(',') !== [...fields].sort().join(','))
    throw new Error(`${name} 参数不符合批注身份与版本保护契约。`);
  if (Object.keys(options).length > 0 && (name !== 'read_reader_annotation_comment' || options.readOnly !== true || Object.keys(options).length !== 1))
    throw new Error('只读核对仅适用于读取当前批注备注。');
  return apiClient.requestJson('/annotation-comment', {
    method: 'POST',
    body: { tool: name, args, ...(options.readOnly === true ? { readOnly: true } : {}) },
  });
}

async function callResearchTool(name, args = {}) {
  return callResearchToolWithApi(api, name, args);
}

async function callCollaboration(action, args = {}) {
  return api.requestJson('/collaboration', {
    method: 'POST', body: collaborationRequestEnvelope(action, args),
  });
}

function focusResearchNote(noteKey) {
  const note = Array.from(el.detailScroll?.querySelectorAll('.ws-note') || [])
    .find((node) => node.dataset.wsNote === noteKey);
  if (!note) return false;
  note.open = true;
  note.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

async function openResearchMaterial(record) {
  const itemKey = String(record?.itemKey || record?.parentItemKey || '');
  const noteKey = record?.kind === 'note' ? String(record.key || record.noteKey || '') : '';
  const pageIndex = Number.isInteger(record?.pageIndex) && record.pageIndex >= 0 ? record.pageIndex : null;
  const attachmentKey = String(record?.attachmentKey || '');
  if (!itemKey) throw new Error('材料缺少 Zotero 条目 key，无法定位原文。');
  if (record.library && record.library !== 'user') throw new Error('DSH 工作区目前只支持个人文库材料。');

  setView('library');
  if (state.center === 'reader' && (!attachmentKey || pageIndex === null)) closeReader();
  pendingResearchNoteKey = noteKey;
  await selectItem(itemKey);

  if (noteKey && focusResearchNote(noteKey)) {
    pendingResearchNoteKey = '';
    return;
  }
  if (noteKey) pendingResearchNoteKey = '';
  if (attachmentKey && pageIndex !== null) {
    await openReader({ page: pageIndex + 1, attachmentKey });
    const index = state.detail?.annotations.findIndex((annotation) => annotation.key === record.key) ?? -1;
    if (index >= 0) {
      selectedAnnotationIndex = index;
      renderDetail();
      viewer?.scrollToAnnotation(record.key);
      showAnnotationPopover(state.detail.annotations[index]);
      return;
    }
    // If the local detail response omitted this annotation, preserve its Zotero deep link.
    await openInZotero({ kind: 'pdf', page: pageIndex + 1, attachmentKey, annotationKey: record.key });
    return;
  }
  if (noteKey) {
    await openInZotero({ kind: 'item', key: noteKey });
    return;
  }
  const index = state.detail?.annotations.findIndex((annotation) => annotation.key === record?.key) ?? -1;
  if (index >= 0) {
    selectedAnnotationIndex = index;
    renderDetail();
    scrollDetailToAnnotations();
    showAnnotationPopover(state.detail.annotations[index]);
  } else {
    scrollDetailToAnnotations();
  }
}

function showResearchWorkbench() {
  const scope = researchScope();
  const key = JSON.stringify(scope);
  if (researchDisposer && key === researchScopeKey) return;
  researchDisposer?.();
  researchDisposer = null;
  researchScopeKey = key;
  el.researchView.replaceChildren();
  const host = document.createElement('div');
  host.className = 'ws-research-host';
  el.researchView.append(host);
  researchDisposer = mountResearchWorkbench(host, {
    scope,
    call: callResearchTool,
    onRead: openResearchMaterial,
  });
}

function showCollaborationWorkbench() {
  if (collaborationDisposer) return;
  el.collaborationView.replaceChildren();
  const host = document.createElement('div');
  host.className = 'ws-collaboration-host';
  el.collaborationView.append(host);
  collaborationDisposer = mountCollaborationWorkbench(host, {
    call: callCollaboration,
    callResearchTool,
    getMaterialKeys: () => {
      const selected = selectionKeys();
      if (selected.length) return selected;
      return state.currentKey ? [state.currentKey] : [];
    },
    onRead: openResearchMaterial,
    bridge,
  });
}

function selectionKeys() {
  return Array.from(state.selection).sort();
}

function sameSelection(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** 选择变化后统一失效引用 tab：abort 在途请求、清空旧输出（P2.2）。 */
function invalidateCitations({ reload = false } = {}) {
  if (citationsAbort) {
    citationsAbort.abort();
    citationsAbort = null;
  }
  state.citations.status = 'idle';
  state.citations.text = '';
  state.citations.error = '';
  if (el.citationsOutput) el.citationsOutput.textContent = '';
  if (el.citationsHint) {
    el.citationsHint.innerHTML =
      state.selection.size > 0
        ? '<div class="items-message">选择已变化，正在更新引用…</div>'
        : '<div class="items-message">还没有选中文献。<br />回到「文库与阅读」勾选条目后，这里会生成引用/导出文本。</div>';
  }
  if (reload && state.view === 'citations') loadCitations();
}

async function loadCitations({ force = false } = {}) {
  if (citationsAbort) citationsAbort.abort();
  const keys = selectionKeys();
  if (!keys.length) {
    citationsAbort = null;
    state.citations.status = 'idle';
    state.citations.text = '';
    state.citations.error = '';
    if (el.citationsOutput) el.citationsOutput.textContent = '';
    if (el.citationsHint) {
      el.citationsHint.innerHTML = `<div class="items-message">${icon('quote', 18)}<p>还没有选中文献。<br />回到「文库与阅读」勾选条目后，这里会生成 ${CITATION_FORMATS.find((entry) => entry.value === state.citations.format)?.label || state.citations.format} 引用/导出文本。</p><button class="btn" type="button" data-ws-action="goto-library">去文库选择</button></div>`;
    }
    return;
  }
  const controller = new AbortController();
  citationsAbort = controller;
  state.citations.status = 'loading';
  state.citations.error = '';
  if (el.citationsHint) el.citationsHint.innerHTML = `<div class="items-message">正在生成 ${keys.length} 条文献的引用…</div>`;
  if (el.citationsOutput) el.citationsOutput.textContent = '';
  try {
    const data = await api.citations({
      keys,
      format: state.citations.format,
      style: state.citations.style,
      signal: controller.signal,
    });
    if (controller.signal.aborted || citationsAbort !== controller) return;
    // P2.2：请求返回时必须仍与当前选择一致，否则丢弃结果并置 idle。
    if (!sameSelection(keys, selectionKeys()) || !state.selection.size) {
      // 如果选择已变化且有新选择，交由新的 loadCitations 处理；这里只保证不写旧结果。
      if (citationsAbort === controller) {
        citationsAbort = null;
        state.citations.status = 'idle';
        state.citations.text = '';
        state.citations.error = '';
        if (el.citationsOutput) el.citationsOutput.textContent = '';
      }
      return;
    }
    state.citations.status = 'ready';
    state.citations.text = String(data?.text || '');
    if (el.citationsHint) {
      el.citationsHint.innerHTML = `<span class="ws-citations-meta">${keys.length} 条文献 · ${escapeHtml(state.citations.format)}${
        state.citations.format === 'text' ? ` · ${escapeHtml(state.citations.style)}` : ''
      }${data?.truncated ? ' · 已截断' : ''}</span>`;
    }
    if (el.citationsOutput) el.citationsOutput.textContent = state.citations.text || '（宿主返回空文本）';
  } catch (error) {
    if (controller.signal.aborted || citationsAbort !== controller) return;
    if (error?.name === 'AbortError') return;
    if (!sameSelection(keys, selectionKeys())) {
      citationsAbort = null;
      state.citations.status = 'idle';
      state.citations.text = '';
      state.citations.error = '';
      if (el.citationsOutput) el.citationsOutput.textContent = '';
      return;
    }
    state.citations.status = 'error';
    state.citations.error = error.message || '未知错误';
    if (el.citationsHint) {
      el.citationsHint.innerHTML = `<div class="items-message is-error">引用生成失败：${escapeHtml(state.citations.error)}<div><button class="btn" type="button" data-ws-action="citation-retry">重试</button></div></div>`;
    }
    if (el.citationsOutput) el.citationsOutput.textContent = '';
  } finally {
    if (citationsAbort === controller) citationsAbort = null;
  }
}

async function copyCitations() {
  if (!state.citations.text) {
    toast('还没有可复制的引用文本', { tone: 'error' });
    return;
  }
  const ok = await copyText(state.citations.text);
  toast(ok ? '已复制引用文本' : '复制失败', { tone: ok ? 'info' : 'error' });
}

/* ============================== PDF 阅读 ============================== */

function setupViewer() {
  viewer = new PdfViewer({
    scrollEl: el.pdfScroll,
    pageEl: el.pdfPage,
    onStatus(status) {
      if (status.status === 'loading') {
        state.reader.status = 'loading';
        state.reader.error = '';
      } else if (status.status === 'ready') {
        state.reader.status = 'ready';
        state.reader.numPages = status.numPages || 0;
        state.reader.page = viewer.pageNumber;
        state.reader.scale = viewer.scale;
      } else if (status.status === 'error') {
        state.reader.status = 'error';
        state.reader.error = status.message || 'PDF 加载失败';
      }
      renderReaderToolbar();
      renderReaderStage();
    },
    onProgress(progress) {
      state.reader.progress = progress;
      if (state.reader.status === 'loading') renderReaderStage();
    },
    onPageChange(info) {
      state.reader.page = info.page;
      state.reader.numPages = info.numPages;
      state.reader.scale = info.scale;
      state.reader.fitMode = info.fitMode;
      hideAnnotationPopover();
      renderReaderToolbar();
      if (state.center === 'reader' && state.reader.open) renderReaderAnnotationsForDetail();
    },
    onAnnotationClick(annotation, context) {
      showAnnotationPopover(annotation, context?.event);
    },
    onOverlayRendered(info) {
      state.reader.overlayCount = info.count;
      const chip = el.readerAnnCount;
      if (chip) chip.textContent = `本页批注 ${info.count}`;
    },
  });
}

function openReader({ page = 0, attachmentKey = '' } = {}) {
  if (state.annotationCommentEdit?.status === 'saving') {
    toast('Zotero 备注写入请求仍在处理，请等待回执后再切换 PDF。', { tone: 'info' });
    return Promise.resolve(null);
  }
  const detail = state.detail;
  if (!detail || state.detailStatus !== 'ready') {
    toast('条目详情尚未加载完成', { tone: 'error' });
    return Promise.reject(new Error('条目详情尚未加载完成'));
  }
  const pdfAttachments = detail.attachments.filter((attachment) => attachment.isPdf);
  if (!pdfAttachments.length) {
    toast('该条目没有 PDF 附件', { tone: 'error' });
    return Promise.reject(new Error('该条目没有 PDF 附件'));
  }
  // P3.4：requested attachment 不属于当前条目时回退第一个 PDF，并同步 state，
  // 避免“加载的是 A、工具栏下拉显示不匹配”。
  const wantedKey = attachmentKey || state.reader.attachmentKey;
  const attachment = pdfAttachments.find((entry) => entry.key === wantedKey) || pdfAttachments[0];
  state.reader.attachmentKey = attachment.key;

  state.center = 'reader';
  state.reader.open = true;
  setView('library');
  applyReaderLayout();
  renderReaderHead();
  renderReaderToolbar();
  const annotations = detail.annotations.filter(
    (annotation) => !annotation.parentAttachment || annotation.parentAttachment === attachment.key,
  );
  viewer.setAnnotations(annotations);
  const url = api.pdfUrl({ library: 'user', key: attachment.key });
  const requestedPage = Math.max(1, Math.trunc(Number(page)) || 1);

  // 复用已加载文档：不要先写 state.reader.page（P2.1 假成功根因），
  // 直接 await goToPage，让 onPageChange 更新真实页码。
  if (viewer.isOpen && viewer.currentUrl === url) {
    const run = (async () => {
      const numPages = viewer.numPages || 0;
      if (!numPages) throw new Error('PDF 页数未知，无法跳页');
      if (requestedPage > numPages) {
        throw new Error(`页码 ${requestedPage} 超出 PDF 共 ${numPages} 页`);
      }
      const target = Math.min(requestedPage, numPages);
      if (viewer.pageNumber !== target) await viewer.goToPage(target);
      state.reader.status = 'ready';
      renderReaderStage();
      renderReaderToolbar();
      return { page: viewer.pageNumber, numPages };
    })();
    run.catch(() => {});
    readerOpenPromise = run;
    return run;
  }

  state.reader.status = 'loading';
  state.reader.error = '';
  state.reader.progress = null;
  renderReaderStage();
  renderReaderToolbar();
  const run = (async () => {
    await viewer.open(url, { startPage: 1 });
    if (!viewer.isOpen) throw new Error(state.reader.error || 'PDF 加载失败');
    const numPages = viewer.numPages || 0;
    if (!numPages) throw new Error('PDF 页数未知，无法跳页');
    if (requestedPage > numPages) {
      throw new Error(`页码 ${requestedPage} 超出 PDF 共 ${numPages} 页`);
    }
    const target = Math.min(requestedPage, numPages);
    if (viewer.pageNumber !== target) await viewer.goToPage(target);
    if (viewer.pageNumber !== target) throw new Error(`无法跳转到第 ${target} 页`);
    return { page: viewer.pageNumber, numPages };
  })();
  readerOpenPromise = run;
  run.catch(() => {}); // UI 调用方可能不 await，避免 unhandled rejection；citation 调用方仍可 await 捕获
  run
    .catch((error) => {
      if (readerOpenPromise !== run) return;
      state.reader.status = 'error';
      state.reader.error = error?.message || String(error);
      renderReaderStage();
    })
    .finally(() => {
      if (readerOpenPromise === run) readerOpenPromise = null;
    });
  return run;
}

function closeReader({ preserveCitationReveal = false } = {}) {
  if (state.annotationCommentEdit?.status === 'saving') {
    setAnnotationCommentStatus('Zotero 备注写入请求仍在处理；当前编辑器会保持打开。', 'info');
    return;
  }
  state.center = 'list';
  state.reader.open = false;
  // P1.2：角标定位流程自己管理浮层生命周期；只有用户主动关闭阅读视图时才 hide。
  if (!preserveCitationReveal) citationReveal?.hide();
  viewer?.close();
  hideAnnotationPopover();
  applyReaderLayout();
  setView(state.view);
}

function applyReaderLayout() {
  const reader = state.center === 'reader' && state.reader.open;
  el.listView.hidden = reader || state.view === 'citations' || state.view === 'research';
  el.readerView.hidden = !reader || state.view === 'citations' || state.view === 'research';
  el.body.classList.toggle('reading', reader);
}

function renderReaderHead() {
  if (!el.readerTitle) return;
  const detail = state.detail;
  el.readerTitle.textContent = detail ? detail.title : '';
  const annotations = detail ? detail.annotations.length : 0;
  if (el.readerAnnCount) el.readerAnnCount.textContent = `批注 ${annotations}`;
}

function renderReaderToolbar() {
  if (!el.prevPage) return;
  const ready = state.reader.status === 'ready';
  const numPages = state.reader.numPages || 0;
  const page = clamp(state.reader.page || 1, 1, Math.max(1, numPages));
  el.prevPage.disabled = !ready || page <= 1;
  el.nextPage.disabled = !ready || page >= numPages;
  el.pageInput.value = ready ? String(page) : '—';
  el.pageInput.disabled = !ready;
  el.pageTotal.textContent = ready ? String(numPages) : '—';
  el.zoomLabel.textContent = ready ? `${Math.round((state.reader.scale || 1) * 100)}%` : '—';
  el.fitWidth.setAttribute('aria-pressed', String(state.reader.fitMode === 'width'));
  el.fitWidth.disabled = !ready;
  el.zoomIn.disabled = !ready;
  el.zoomOut.disabled = !ready;

  const detail = state.detail;
  const pdfAttachments = detail ? detail.attachments.filter((attachment) => attachment.isPdf) : [];
  if (pdfAttachments.length > 1) {
    el.attachmentSelect.hidden = false;
    el.attachmentSelect.innerHTML = pdfAttachments
      .map(
        (attachment) =>
          `<option value="${escapeHtml(attachment.key)}" ${attachment.key === state.reader.attachmentKey ? 'selected' : ''}>${escapeHtml(
            attachment.title || attachment.filename,
          )}</option>`,
      )
      .join('');
    el.attachmentSelect.value = state.reader.attachmentKey;
  } else {
    el.attachmentSelect.hidden = true;
    el.attachmentSelect.innerHTML = '';
  }
}

function renderReaderStage() {
  if (!el.stageOverlay || state.center !== 'reader') return;
  const status = state.reader.status;
  el.stageError.hidden = true;
  el.stageOverlay.hidden = true;
  el.stageEmpty.hidden = true;
  if (status === 'loading') {
    el.stageOverlay.hidden = false;
    const progress = state.reader.progress;
    let text = '正在加载 PDF…';
    if (progress && progress.percent !== null) text = `正在加载 PDF… ${progress.percent}%`;
    el.stageOverlayText.textContent = text;
    return;
  }
  if (status === 'error') {
    el.stageError.hidden = false;
    el.stageErrorMessage.textContent = state.reader.error;
    return;
  }
  if (status === 'nopdf') {
    el.stageEmpty.hidden = false;
    el.stageEmpty.innerHTML = `<div class="stage-empty-icon">${icon('doc', 22)}</div><h2>该条目没有 PDF 附件</h2><p>可以查看右侧批注与笔记，或返回文库选择其他条目。</p>`;
    return;
  }
  if (status === 'ready') {
    const count = state.reader.overlayCount;
    if (el.readerAnnCount) el.readerAnnCount.textContent = `本页批注 ${count}`;
  }
}

function renderReaderAnnotationsForDetail() {
  const active = el.detailScroll?.querySelectorAll('.ws-detail-ann');
  if (!active) return;
  // 滚动详情栏到当前页批注（不改变选中项）。
  void active;
}

async function jumpToAnnotation(annotation, index = -1) {
  if (!annotation) return;
  selectedAnnotationIndex = index;
  renderDetail();
  if (state.center !== 'reader') {
    openReader({ page: (annotation.pageIndex || 0) + 1 });
  } else if (state.reader.status === 'ready') {
    await viewer.goToPage((annotation.pageIndex || 0) + 1);
    setTimeout(() => viewer.scrollToAnnotation(annotation.key), 250);
  }
}

/* ============================== 批注浮层 ============================== */

function resetAnnotationCommentEditor() {
  state.annotationCommentRequest += 1;
  state.annotationCommentEdit = null;
  if (el.annCommentEditor) el.annCommentEditor.hidden = true;
  if (el.annCommentInput) el.annCommentInput.value = '';
  if (el.annCommentInput) el.annCommentInput.disabled = false;
  if (el.annCommentObserved) el.annCommentObserved.hidden = true;
  if (el.annCommentObservedText) el.annCommentObservedText.textContent = '';
  if (el.annCommentReconcile) {
    el.annCommentReconcile.hidden = true;
    el.annCommentReconcile.disabled = false;
  }
  if (el.annCommentStatus) {
    el.annCommentStatus.hidden = true;
    el.annCommentStatus.textContent = '';
    el.annCommentStatus.removeAttribute('data-tone');
  }
  if (el.annCommentSave) {
    el.annCommentSave.disabled = false;
    el.annCommentSave.hidden = false;
  }
  if (el.annCommentEditBtn) el.annCommentEditBtn.hidden = false;
}

function setAnnotationCommentStatus(message, tone = 'info') {
  if (!el.annCommentStatus) return;
  el.annCommentStatus.textContent = message;
  el.annCommentStatus.dataset.tone = tone;
  el.annCommentStatus.hidden = !message;
}

function showObservedAnnotationComment(comment) {
  if (!el.annCommentObserved || !el.annCommentObservedText) return;
  el.annCommentObservedText.textContent = comment || '（空备注）';
  el.annCommentObserved.hidden = false;
}

function positionAnnotationPopover() {
  if (!el.annPopover || el.annPopover.hidden) return;
  const rect = el.annPopover.getBoundingClientRect();
  const margin = 12;
  const left = Math.min(Math.max(margin, Number.parseFloat(el.annPopover.style.left) || margin), Math.max(margin, window.innerWidth - rect.width - margin));
  const top = Math.min(Math.max(margin, Number.parseFloat(el.annPopover.style.top) || margin), Math.max(margin, window.innerHeight - rect.height - margin));
  el.annPopover.style.left = `${left}px`;
  el.annPopover.style.top = `${top}px`;
}

function annotationCommentIdentity(annotation) {
  const attachmentKey = String(annotation?.parentAttachment || state.reader.attachmentKey || '');
  if (!annotation?.key || !attachmentKey || state.detailStatus !== 'ready' || !state.detail?.key)
    return null;
  return { library: 'user', annotationKey: String(annotation.key), attachmentKey };
}

function unwrapReaderCommentResult(result) {
  return result?.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : result;
}

async function beginAnnotationCommentEdit() {
  const annotation = currentPopoverAnnotation();
  const identity = annotationCommentIdentity(annotation);
  if (!identity) {
    setAnnotationCommentStatus('无法确认当前文献与 PDF 批注身份，请重新打开该批注。', 'error');
    return;
  }

  const requestId = ++state.annotationCommentRequest;
  state.annotationCommentEdit = { identity, status: 'loading', requestId, editToken: '' };
  el.annCommentEditor.hidden = false;
  el.annCommentEditBtn.hidden = true;
  el.annCommentSave.disabled = true;
  setAnnotationCommentStatus('正在读取当前备注与版本保护信息…');
  positionAnnotationPopover();

  try {
    const result = await callReaderAnnotationCommentToolWithApi(api, 'read_reader_annotation_comment', identity);
    const payload = unwrapReaderCommentResult(result);
    const edit = state.annotationCommentEdit;
    if (!edit || edit.requestId !== requestId || state.popoverAnnotationKey !== identity.annotationKey ||
        state.reader.attachmentKey !== identity.attachmentKey) return;
    if (!Number.isSafeInteger(payload?.annotationVersion) || payload.annotationVersion < 0 || typeof payload.comment !== 'string')
      throw new Error('读取结果缺少有效的版本保护信息。');

    edit.expectedVersion = payload.annotationVersion;
    edit.expectedComment = payload.comment;
    el.annCommentInput.value = payload.comment;
    if (payload.editable !== true || typeof payload.editToken !== 'string' || !/^[a-f0-9]{48}$/.test(payload.editToken)) {
      edit.status = 'blocked';
      edit.editToken = '';
      el.annCommentInput.disabled = true;
      el.annCommentSave.disabled = true;
      showObservedAnnotationComment(payload.comment);
      const operationMessage = typeof payload.lastOperation?.message === 'string' ? payload.lastOperation.message : '';
      const blockedMessage = typeof payload.editBlockedBy?.message === 'string' ? payload.editBlockedBy.message : '';
      setAnnotationCommentStatus(operationMessage || blockedMessage || '当前备注可读取，但 Zotero 暂未开放安全编辑。', 'error');
      if (['outcome-unknown', 'in-flight'].includes(payload.lastOperation?.status) || payload.editBlockedBy)
        el.annCommentReconcile.hidden = false;
      positionAnnotationPopover();
      return;
    }

    edit.status = 'ready';
    edit.editToken = payload.editToken;
    el.annCommentSave.disabled = false;
    setAnnotationCommentStatus('编辑当前 Zotero 批注的阅读者备注；保存后会回读核实。');
    el.annCommentInput.focus();
    positionAnnotationPopover();
  } catch (error) {
    const edit = state.annotationCommentEdit;
    if (!edit || edit.requestId !== requestId) return;
    edit.status = 'error';
    edit.editToken = '';
    el.annCommentSave.disabled = true;
    setAnnotationCommentStatus(`无法读取备注：${error?.message || '服务错误'}。没有执行写入。`, 'error');
    positionAnnotationPopover();
  }
}

async function reconcileAnnotationCommentReadOnly() {
  const edit = state.annotationCommentEdit;
  if (!edit || !['unknown', 'blocked', 'reconciled-readonly'].includes(edit.status)) return;
  if (state.popoverAnnotationKey !== edit.identity.annotationKey || state.reader.attachmentKey !== edit.identity.attachmentKey) return;
  const requestId = ++state.annotationCommentRequest;
  const draft = String(el.annCommentInput.value ?? '');
  edit.reconcileRequestId = requestId;
  el.annCommentInput.disabled = true;
  el.annCommentReconcile.disabled = true;
  setAnnotationCommentStatus('正在只读读取 Zotero 当前备注；草稿会保留，不会重发写入…');
  try {
    const result = await callReaderAnnotationCommentToolWithApi(api, 'read_reader_annotation_comment', edit.identity, { readOnly: true });
    const payload = unwrapReaderCommentResult(result);
    if (state.annotationCommentEdit !== edit || edit.reconcileRequestId !== requestId ||
        state.popoverAnnotationKey !== edit.identity.annotationKey || state.reader.attachmentKey !== edit.identity.attachmentKey) return;
    if (typeof payload?.comment !== 'string' || !Number.isSafeInteger(payload.annotationVersion))
      throw new Error('只读回执缺少当前备注或版本信息。');

    const annotation = currentPopoverAnnotation();
    if (annotation) annotation.comment = payload.comment;
    el.annComment.textContent = payload.comment;
    el.annComment.hidden = !payload.comment;
    el.annCommentEditBtn.textContent = payload.comment ? '编辑备注' : '添加备注';
    showObservedAnnotationComment(payload.comment);
    // 只读核对不接续写入授权。即使服务重新签发 editToken，也不会保存或使用。
    edit.editToken = '';
    edit.status = 'reconciled-readonly';
    el.annCommentInput.value = draft;
    el.annCommentInput.disabled = false;
    el.annCommentSave.disabled = true;
    const matchesSubmitted = typeof edit.submittedComment === 'string' && payload.comment === edit.submittedComment;
    const comparison = typeof edit.submittedComment === 'string'
      ? matchesSubmitted ? '当前备注与本次提交内容一致。' : '当前备注与本次提交内容不同。'
      : '当前备注已读取。';
    const operationMessage = typeof payload.lastOperation?.message === 'string' ? ` ${payload.lastOperation.message}` : '';
    setAnnotationCommentStatus(`只读核对完成：${comparison}编辑器草稿已保留，没有再次写入。${operationMessage}`);
    el.annCommentReconcile.disabled = false;
    positionAnnotationPopover();
  } catch (error) {
    if (state.annotationCommentEdit !== edit || edit.reconcileRequestId !== requestId) return;
    edit.status = 'unknown';
    edit.editToken = '';
    el.annCommentInput.value = draft;
    el.annCommentInput.disabled = false;
    el.annCommentSave.disabled = true;
    el.annCommentReconcile.disabled = false;
    setAnnotationCommentStatus(`只读核对失败，草稿仍保留：${error?.message || '读取服务错误'}。没有重发写入。`, 'error');
    positionAnnotationPopover();
  }
}

function cancelAnnotationCommentEdit() {
  if (state.annotationCommentEdit?.status === 'saving') {
    setAnnotationCommentStatus('备注保存请求仍在处理；请等待回执后再取消。当前草稿会保留。', 'info');
    return;
  }
  resetAnnotationCommentEditor();
  positionAnnotationPopover();
}

async function saveAnnotationComment() {
  const edit = state.annotationCommentEdit;
  if (!edit || edit.status !== 'ready' || !edit.editToken) return;
  if (state.popoverAnnotationKey !== edit.identity.annotationKey || state.reader.attachmentKey !== edit.identity.attachmentKey) {
    setAnnotationCommentStatus('当前批注已切换，已取消本次保存。请重新打开批注后编辑。', 'error');
    cancelAnnotationCommentEdit();
    return;
  }

  const requestId = edit.requestId;
  const newComment = String(el.annCommentInput.value ?? '');
  edit.status = 'saving';
  edit.saveAttempted = true;
  edit.submittedComment = newComment;
  el.annCommentInput.disabled = true;
  el.annCommentSave.disabled = true;
  setAnnotationCommentStatus('正在保存备注并回读验证…');

  try {
    const result = await callReaderAnnotationCommentToolWithApi(api, 'update_reader_annotation_comment', {
      ...edit.identity,
      expectedVersion: edit.expectedVersion,
      expectedComment: edit.expectedComment,
      comment: newComment,
      editToken: edit.editToken,
    });
    const payload = unwrapReaderCommentResult(result);
    if (state.annotationCommentEdit !== edit || state.popoverAnnotationKey !== edit.identity.annotationKey ||
        state.reader.attachmentKey !== edit.identity.attachmentKey) {
      toast('备注保存请求已发出，但批注浮层已切换；未自动重试，请重新打开批注只读核对。', { tone: 'error' });
      return;
    }
    edit.editToken = '';
    if (payload?.verified === true) {
      const annotation = currentPopoverAnnotation();
      const savedComment = typeof payload.comment === 'string' ? payload.comment : newComment;
      if (annotation) annotation.comment = savedComment;
      el.annComment.textContent = savedComment;
      el.annComment.hidden = !savedComment;
      el.annCommentEditBtn.textContent = savedComment ? '编辑备注' : '添加备注';
      edit.status = 'verified';
      resetAnnotationCommentEditor();
      renderDetail();
      toast('备注已保存并回读核实', { tone: 'info' });
      return;
    }
    edit.status = 'unknown';
    el.annCommentSave.disabled = true;
    el.annCommentInput.disabled = false;
    el.annCommentReconcile.hidden = false;
    setAnnotationCommentStatus(typeof payload?.message === 'string'
      ? `${payload.message} 草稿已保留，可在此只读核对；系统没有重试。`
      : '保存结果尚未核实；草稿已保留，可在此只读核对。系统没有重试。', 'error');
    positionAnnotationPopover();
  } catch (error) {
    if (state.annotationCommentEdit !== edit || requestId !== edit.requestId) return;
    edit.status = 'unknown';
    edit.editToken = '';
    el.annCommentSave.disabled = true;
    el.annCommentInput.disabled = false;
    el.annCommentReconcile.hidden = false;
    setAnnotationCommentStatus(`保存结果尚未核实：${error?.message || '服务错误'}。草稿已保留，可在此只读核对；系统没有重试。`, 'error');
    positionAnnotationPopover();
  }
}

function showAnnotationPopover(annotation, event) {
  if (!el.annPopover) return;
  if (state.annotationCommentEdit?.status === 'saving') {
    setAnnotationCommentStatus('备注保存请求仍在处理；当前批注浮层保持打开。', 'info');
    return;
  }
  resetAnnotationCommentEditor();
  state.popoverAnnotationKey = annotation.key;
  el.annColor.style.background = annotation.color;
  el.annPage.textContent = `第 ${annotation.pageLabel || String((annotation.pageIndex ?? 0) + 1)} 页`;
  el.annQuote.textContent = annotation.text || '（无原文）';
  el.annComment.textContent = annotation.comment || '';
  el.annComment.hidden = !annotation.comment;
  el.annCommentEditBtn.textContent = annotation.comment ? '编辑备注' : '添加备注';
  el.annTags.innerHTML = annotation.tags
    .map((tag) => `<span class="ws-tag">${escapeHtml(tag)}</span>`)
    .join('');
  el.annPopover.hidden = false;
  const rect = el.annPopover.getBoundingClientRect();
  const margin = 12;
  let left = (event?.clientX || window.innerWidth / 2) + 12;
  let top = (event?.clientY || window.innerHeight / 2) + 12;
  if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
  if (top + rect.height > window.innerHeight - margin) top = (event?.clientY || window.innerHeight / 2) - rect.height - 12;
  el.annPopover.style.left = `${Math.max(margin, left)}px`;
  el.annPopover.style.top = `${Math.max(margin, top)}px`;
  // 高亮对应详情列表项
  const annotations = state.detail?.annotations || [];
  const index = annotations.findIndex((entry) => entry.key === annotation.key);
  if (index >= 0 && index !== selectedAnnotationIndex) {
    selectedAnnotationIndex = index;
    for (const node of el.detailScroll?.querySelectorAll('.ws-detail-ann') || []) {
      node.classList.toggle('is-active', node.dataset.wsDetailAnn === String(index));
    }
  }
}

function hideAnnotationPopover() {
  if (state.annotationCommentEdit?.status === 'saving') {
    setAnnotationCommentStatus('备注保存请求仍在处理；当前编辑器会保持打开。', 'info');
    return;
  }
  resetAnnotationCommentEditor();
  if (el.annPopover) el.annPopover.hidden = true;
  state.popoverAnnotationKey = '';
}

function currentPopoverAnnotation() {
  const key = state.popoverAnnotationKey;
  if (!key) return null;
  return state.detail?.annotations.find((annotation) => annotation.key === key) || null;
}

async function openInZotero({ kind = 'item', key: requestedKey = '', page = 0, annotationKey = '', attachmentKey = '' } = {}) {
  const detail = state.detail;
  const key = requestedKey || detail?.key || state.currentKey;
  if (!key) {
    toast('没有可打开的条目', { tone: 'error' });
    return;
  }
  const targetAttachment = attachmentKey || state.reader.attachmentKey;
  let zoteroUrl;
  if (kind === 'pdf') {
    zoteroUrl = zoteroPdfUrl({ key, attachmentKey: targetAttachment || key, page, annotationKey });
  } else {
    zoteroUrl = zoteroItemUrl(key);
  }
  if (bridge && bridge.connected) {
    try {
      const ack = await bridge.request(
        'open-zotero',
        { kind, key, attachmentKey: targetAttachment || undefined, page: page || undefined, annotationKey: annotationKey || undefined },
        { timeout: 5000 },
      );
      toast(ack.ok ? ack.message || '已在 Zotero 中打开' : ack.message || '宿主打开失败', {
        tone: ack.ok ? 'info' : 'error',
      });
      return;
    } catch (error) {
      if (error.code !== 'host-unavailable' && error.code !== 'host-timeout') {
        toast(`打开失败：${error.message}`, { tone: 'error' });
        return;
      }
      toast('对话桥未响应，已改为复制 Zotero 深链', { tone: 'error' });
    }
  }
  const copied = await copyText(zoteroUrl);
  toast(copied ? `已复制 Zotero 深链：${zoteroUrl}` : `复制失败，链接：${zoteroUrl}`, {
    tone: copied ? 'info' : 'error',
    timeout: 3600,
  });
}

/* ============================== 提问弹窗 ============================== */

async function openAskModal() {
  if (!state.selection.size) {
    toast('请先勾选文献', { tone: 'error' });
    return;
  }
  el.askContext.textContent = '正在整理上下文…';
  el.contextCount.textContent = String(state.selection.size);
  el.askInput.value = '';
  el.askModal.hidden = false;
  setTimeout(() => el.askInput.focus(), 30);
  try {
    askContextText = await buildAskContext();
  } catch (error) {
    askContextText = selectionSummaries().map((item) => itemCitationLine(item)).join('\n');
    toast(`上下文整理失败，已退化为简版：${error.message}`, { tone: 'error' });
  }
  el.askContext.textContent = askContextText;
}

function closeAskModal() {
  el.askModal.hidden = true;
}

async function submitAsk() {
  const question = el.askInput.value.trim();
  if (!question) {
    toast('请先填写问题', { tone: 'error' });
    el.askInput.focus();
    return;
  }
  closeAskModal();
  await askWithSelection(question);
}

/* ============================== 事件绑定 ============================== */

function on(target, eventName, handler, options) {
  target?.addEventListener(eventName, handler, options);
}

function bindEvents() {
  // 顶栏 tabs
  for (const tab of root.querySelectorAll('[data-ws-tab]')) {
    tab.addEventListener('click', () => {
      if (tab.dataset.wsTab === 'citations') {
        setView('citations');
      } else if (tab.dataset.wsTab === 'research') {
        setView('research');
      } else if (tab.dataset.wsTab === 'collaboration') {
        setView('collaboration');
      } else {
        setView('library');
        applyReaderLayout();
      }
    });
  }
  on(el.refresh, 'click', () => refreshAll({ initial: false }));
  on(root.querySelector('[data-ws-action="to-sidebar"]'), 'click', () => openCompactReader());

  // 搜索 / 排序 / 全文
  const debouncedSearch = debounce(() => {
    state.query = el.search.value.trim();
    el.searchClear.hidden = !el.search.value;
    loadItems({ reset: true });
  }, 260);
  on(el.search, 'input', debouncedSearch);
  on(el.search, 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      state.query = el.search.value.trim();
      loadItems({ reset: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (el.search.value) {
        el.search.value = '';
        state.query = '';
        el.searchClear.hidden = true;
        loadItems({ reset: true });
      } else {
        el.search.blur();
      }
    }
  });
  on(el.searchClear, 'click', () => {
    el.search.value = '';
    state.query = '';
    el.searchClear.hidden = true;
    loadItems({ reset: true });
    el.search.focus();
  });
  on(el.fulltext, 'change', () => {
    state.fulltext = el.fulltext.checked;
    loadItems({ reset: true });
  });
  on(el.sort, 'change', () => {
    state.sort = el.sort.value;
    loadItems({ reset: true });
  });

  // 列表
  on(el.itemList, 'click', (event) => {
    const check = event.target.closest('[data-ws-check]');
    if (check) {
      event.stopPropagation();
      toggleSelection(check.dataset.wsCheck, check.checked);
      return;
    }
    const row = event.target.closest('[data-ws-item]');
    if (row) selectItem(row.dataset.wsItem);
  });
  on(el.selectAll, 'change', () => {
    if (el.selectAll.checked) {
      for (const item of state.items) {
        state.selection.add(item.key);
        recordSelectionSummary(item);
      }
    } else {
      state.selection.clear();
      state.selectionCache.clear();
    }
    invalidateCitations();
    syncSelectionDom();
  });
  on(el.listFooter, 'click', (event) => {
    if (event.target.closest('[data-ws-action="load-more"]')) loadItems({ reset: false });
    if (event.target.closest('[data-ws-action="retry-items"]')) loadItems({ reset: true });
  });

  // 导航
  on(el.nav, 'click', (event) => {
    const toggle = event.target.closest('[data-ws-toggle-collection]');
    if (toggle) {
      const key = toggle.dataset.wsToggleCollection;
      if (state.expandedCollections.has(key)) state.expandedCollections.delete(key);
      else state.expandedCollections.add(key);
      renderCollectionNav();
      return;
    }
    const collection = event.target.closest('[data-ws-collection]');
    if (collection) {
      setNav({ kind: 'collection', key: collection.dataset.wsCollection, view: '' });
      return;
    }
    const maintenance = event.target.closest('[data-ws-nav="maintenance"]');
    if (maintenance) {
      setNav({ kind: 'maintenance', key: '', view: maintenance.dataset.wsView });
      return;
    }
    const all = event.target.closest('[data-ws-nav="all"]');
    if (all) {
      setNav({ kind: 'all', key: '', view: '' });
      return;
    }
    const saved = event.target.closest('[data-ws-saved-search]');
    if (saved) {
      const name = saved.dataset.wsSavedSearch || '';
      el.search.value = name;
      el.searchClear.hidden = !name;
      state.query = name;
      setNav({ kind: 'all', key: '', view: '' });
    }
  });

  // 选择操作
  on(root, 'click', (event) => {
    const action = event.target.closest('[data-ws-action]');
    if (!action) return;
    switch (action.dataset.wsAction) {
      case 'add-to-chat':
        addToChat();
        break;
      case 'ask':
        openAskModal();
        break;
      case 'clear-selection':
        clearSelection();
        break;
      case 'nav-toggle':
        toggleNavPanel();
        break;
      case 'detail-toggle':
        toggleDetailPanel();
        break;
      case 'detail-close':
        if (isWideLayout()) {
          if (!layoutState.detailCollapsed) {
            layoutState.detailCollapsed = true;
            applyLayout({ persist: true });
          }
        } else {
          el.body.classList.remove('detail-open');
          syncLayoutControls();
        }
        break;
      case 'reset-layout':
        resetLayout();
        break;
      case 'reader-back':
        closeReader();
        break;
      case 'reader-retry':
        openReader({ page: state.reader.page });
        break;
      case 'reader-open-zotero':
        openInZotero({ kind: 'pdf', page: state.reader.page, attachmentKey: state.reader.attachmentKey });
        break;
      case 'open-zotero-current':
        openInZotero({ kind: 'item' });
        break;
      case 'read-pdf':
        openReader({ page: state.reader.page || 1 });
        break;
      case 'view-annotations':
        if (state.center !== 'reader') {
          openReader({ page: 1 });
          setTimeout(scrollDetailToAnnotations, 400);
        } else {
          scrollDetailToAnnotations();
        }
        break;
      case 'cite-current': {
        if (state.currentKey && !state.selection.has(state.currentKey)) {
          state.selection.add(state.currentKey);
          const summary =
            state.items.find((item) => item.key === state.currentKey) ||
            (state.detail
              ? {
                  key: state.detail.key,
                  title: state.detail.title,
                  itemType: state.detail.itemType,
                  authors: state.detail.authors ? state.detail.authors.split('、').filter(Boolean) : [],
                  year: state.detail.year,
                  date: state.detail.date,
                  publicationTitle: state.detail.publicationTitle,
                  DOI: state.detail.DOI,
                  tags: state.detail.tags,
                  collectionKeys: state.detail.collectionKeys,
                  hasPdf: state.detail.attachments.some((attachment) => attachment.isPdf),
                }
              : null);
          recordSelectionSummary(summary);
          invalidateCitations();
          syncSelectionDom();
        }
        setView('citations');
        break;
      }
      case 'retry-detail':
        if (state.currentKey) loadDetail(state.currentKey);
        break;
      case 'retry-items':
        loadItems({ reset: true });
        break;
      case 'load-more':
        loadItems({ reset: false });
        break;
      case 'citation-refresh':
      case 'citation-retry':
        loadCitations({ force: true });
        break;
      case 'citation-copy':
        copyCitations();
        break;
      case 'citation-clear':
        clearSelection();
        break;
      case 'goto-library':
        setView('library');
        applyReaderLayout();
        break;
      case 'ask-send':
        submitAsk();
        break;
      case 'ask-cancel':
        closeAskModal();
        break;
      case 'ann-close':
        hideAnnotationPopover();
        break;
      case 'ann-comment-edit':
        void beginAnnotationCommentEdit();
        break;
      case 'ann-comment-cancel':
        cancelAnnotationCommentEdit();
        break;
      case 'ann-comment-save':
        void saveAnnotationComment();
        break;
      case 'ann-comment-reconcile':
        void reconcileAnnotationCommentReadOnly();
        break;
      case 'ann-open-zotero': {
        const annotation = currentPopoverAnnotation();
        openInZotero({
          kind: 'pdf',
          page: (annotation?.pageIndex ?? state.reader.page - 1) + 1,
          annotationKey: annotation?.key || '',
          attachmentKey: state.reader.attachmentKey,
        });
        break;
      }
      case 'ann-copy': {
        const annotation = currentPopoverAnnotation();
        if (annotation?.text) {
          copyText(annotation.text).then((ok) => toast(ok ? '已复制批注原文' : '复制失败', { tone: ok ? 'info' : 'error' }));
        }
        break;
      }
      default:
        break;
    }
  });

  // 详情批注列表
  on(el.detailScroll, 'click', (event) => {
    const attachmentButton = event.target.closest('[data-ws-detail-attachment]');
    if (attachmentButton) {
      const key = attachmentButton.dataset.wsDetailAttachment;
      const attachment = state.detail?.attachments.find((entry) => entry.key === key);
      if (!attachment) return;
      if (attachment.isPdf) openReader({ page: 1, attachmentKey: key });
      else openInZotero({ kind: 'item', key });
      return;
    }
    const annotationButton = event.target.closest('[data-ws-detail-ann]');
    if (annotationButton) {
      const index = Number(annotationButton.dataset.wsDetailAnn);
      const annotation = state.detail?.annotations[index];
      jumpToAnnotation(annotation, index);
    }
  });

  // 引用格式
  on(el.citationFormat, 'change', () => {
    state.citations.format = el.citationFormat.value;
    el.citationStyle.disabled = state.citations.format !== 'text';
    state.citations.status = 'idle';
    loadCitations({ force: true });
  });
  on(el.citationStyle, 'change', () => {
    state.citations.style = el.citationStyle.value;
    loadCitations({ force: true });
  });

  // 阅读器工具栏
  on(el.prevPage, 'click', () => viewer?.prevPage());
  on(el.nextPage, 'click', () => viewer?.nextPage());
  on(el.pageInput, 'keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = Number.parseInt(el.pageInput.value, 10);
    if (Number.isFinite(value)) viewer?.goToPage(clamp(value, 1, state.reader.numPages));
    el.pageInput.blur();
  });
  on(el.pageInput, 'blur', () => {
    if (state.reader.status === 'ready') el.pageInput.value = String(state.reader.page);
  });
  on(el.zoomIn, 'click', () => viewer?.zoomIn());
  on(el.zoomOut, 'click', () => viewer?.zoomOut());
  on(el.fitWidth, 'click', () => viewer?.setFitWidth());
  on(el.attachmentSelect, 'change', async () => {
    state.reader.attachmentKey = el.attachmentSelect.value;
    openReader({ page: 1 });
  });

  // 批注浮层：点外部关闭
  document.addEventListener('mousedown', (event) => {
    if (!el.annPopover || el.annPopover.hidden) return;
    if (!el.annPopover.contains(event.target)) hideAnnotationPopover();
  });
  on(el.pdfScroll, 'scroll', hideAnnotationPopover, { passive: true });

  // 提问弹窗遮罩
  on(el.askModal, 'mousedown', (event) => {
    if (event.target === el.askModal) closeAskModal();
  });

  // 键盘
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const inField =
      target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    if (event.key === 'Escape') {
      if (!el.askModal.hidden) {
        closeAskModal();
        return;
      }
      if (!el.annPopover.hidden) {
        hideAnnotationPopover();
        return;
      }
      if (inField) {
        target.blur();
        return;
      }
      if (state.center === 'reader') {
        closeReader();
        return;
      }
      if (el.body.classList.contains('nav-open')) {
        el.body.classList.remove('nav-open');
        return;
      }
      if (el.body.classList.contains('detail-open')) {
        el.body.classList.remove('detail-open');
        return;
      }
      return;
    }
    if (inField) return;
    if (event.key === '/') {
      event.preventDefault();
      setView('library');
      applyReaderLayout();
      el.search.focus();
      el.search.select();
      return;
    }
    if (state.center === 'reader' && state.reader.status === 'ready') {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        viewer?.prevPage();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        viewer?.nextPage();
      }
    }
  });
}

/* ============================== 导出给自测 ============================== */

window.__ZOTERO_WORKSPACE__ = {
  state,
  get viewer() {
    return viewer;
  },
  get bridge() {
    return bridge;
  },
  get citationReveal() {
    return citationReveal;
  },
  get layout() {
    return { ...layoutState, wide: isWideLayout() };
  },
  setLayoutWidth,
  resetLayout,
  toggleNavPanel,
  toggleDetailPanel,
  openCompactReader,
  queueOrRevealCitation,
  get revealFlushCount() {
    return revealFlushCount;
  },
  waitForReaderPage,
  refreshAll,
  openReader,
  closeReader,
  selectItem,
  setView,
  loadCitations,
  version: '0.10.0-web.2-workspace',
};

function renderDuplicateReview(item) {
  if(!item.duplicateMatches?.length)return '';
  const labels={title:'标题',date:'日期',DOI:'DOI',itemType:'类型',edition:'版次',volume:'卷',issue:'期',pages:'页码',publicationTitle:'期刊',bookTitle:'书名',creators:'作者'};
  return `<details class="ws-duplicate-review"><summary>与 ${escapeHtml(String(item.duplicateCount))} 条文献可能重复 · 核对差异</summary>${item.duplicateMatches.map(peer=>`<section><p>${escapeHtml(peer.reason)}</p><button class="btn" data-ws-item="${escapeHtml(peer.key)}">${escapeHtml(peer.title)} · ${escapeHtml(peer.key)}</button>${peer.differences.length?`<div class="ws-diff-scroll"><table><thead><tr><th>字段</th><th>当前条目</th><th>对方条目</th></tr></thead><tbody>${peer.differences.map(d=>`<tr><th>${escapeHtml(labels[d.field]||d.field)}</th><td>${escapeHtml(d.left||'未填写')}</td><td>${escapeHtml(d.right||'未填写')}</td></tr>`).join('')}</tbody></table></div>`:'<p>比较字段一致，仍需核对附件和笔记。</p>'}</section>`).join('')}${item.peersTruncated?'<p>这里只展示前 8 条匹配；其余条目可在候选列表中查看。</p>':''}</details>`;
}
