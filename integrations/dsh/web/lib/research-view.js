export const mountResearchWorkbench = (() => {
const LEVELS = [
  ['topic', '主题'],
  ['takeaway', '结论'],
  ['key', '要点'],
  ['brief', '关键原句'],
  ['full', '全文'],
];

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const ANNOTATION_KIND_LABELS = new Map([
  ['highlight', '高亮'],
  ['underline', '下划线'],
  ['image', '区域批注'],
  ['ink', '手写批注'],
  ['text', '文本批注'],
]);
const UNIT_KIND_LABELS = new Map([
  ['paragraph', '段落'],
  ['list item', '列表项'],
  ['caption', '图注'],
  ['abstract', '摘要'],
]);

function el(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function unique(values) {
  return [...new Set(values)];
}

function markdownEscape(value) {
  return text(value).replace(/[\\`*_{}\[\]<>]/g, '\\$&');
}

function markdownUrl(value) {
  return text(value).replace(/[()\s]/g, character => encodeURIComponent(character));
}

function stableHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const character of String(value)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function mountResearchWorkbench(host, { scope, call, onRead } = {}) {
  if (!host || !host.ownerDocument) throw new TypeError('mountResearchWorkbench requires a DOM root.');
  if (typeof call !== 'function') throw new TypeError('mountResearchWorkbench requires a call function.');

  const document = host.ownerDocument;
  const library = scope?.library || 'user';
  let activeScope = scope && typeof scope === 'object' ? {
    library,
    ...(Array.isArray(scope.keys) ? { keys: unique(scope.keys) } : {}),
    ...(scope.collection ? { collection: scope.collection, recursive: scope.recursive !== false } : {}),
  } : null;
  const app = el(document, 'section', 'rw');
  app.setAttribute('aria-label', '研究工作台');
  host.replaceChildren(app);

  const state = {
    papers: [],
    errors: [],
    incomplete: false,
    loading: false,
    loaded: 0,
    total: null,
    selected: new Map(),
    view: 'annotations',
    purpose: 'paragraph',
    framework: '',
    job: null,
    result: null,
    level: 'topic',
    openSources: new Set(),
    readError: '',
    copyMessage: '',
    showAllSelected: false,
    scopePickerOpen: false,
    scopeMode: activeScope?.collection ? 'collection' : 'paper',
    scopeCollections: [],
    scopeResults: [],
    scopeTotal: 0,
    scopeQuery: '',
    scopeLoading: false,
    scopeError: '',
  };

  let disposed = false;
  let loadEpoch = 0;
  let jobEpoch = 0;
  let pollTimer = null;
  let recoveryStarted = false;
  let scopeLookupEpoch = 0;
  let draftComposer = null;
  function jobStorageKeyFor(scopeValue = activeScope) {
    const normalizedKeys = Array.isArray(scopeValue?.keys) ? unique(scopeValue.keys).sort() : null;
    const scopeSignature = stableHash(JSON.stringify({
      library,
      keys: normalizedKeys,
      collection: scopeValue?.collection || null,
      recursive: scopeValue?.collection ? scopeValue.recursive !== false : null,
    }));
    return `zotero-workbench-research-jobs:${library}:${scopeSignature}`;
  }
  const ZOTERO_COLOR_CLASSES = new Map([
    ['#ffd400', 'rw-zotero-yellow'],
    ['#ffff00', 'rw-zotero-yellow-legacy'],
    ['#ff6666', 'rw-zotero-red'],
    ['#5fb236', 'rw-zotero-green'],
    ['#2ea8e5', 'rw-zotero-blue'],
    ['#a28ae5', 'rw-zotero-purple'],
    ['#e56eee', 'rw-zotero-magenta'],
    ['#f19837', 'rw-zotero-orange'],
    ['#aaaaaa', 'rw-zotero-gray'],
  ]);

  function current(epoch) {
    return !disposed && epoch === loadEpoch;
  }

  function badge(label, value, variant = 'neutral') {
    const tone = ['success', 'error', 'active'].includes(variant) ? variant : 'neutral';
    return el(document, 'span', `rw-badge rw-badge-${tone}`, `${label} ${value}`);
  }

  function tag(icon, label, className = '') {
    return el(document, 'span', `rw-tag${className ? ` ${className}` : ''}`, `${icon} ${label}`);
  }

  function button(label, className, handler, options = {}) {
    const result = el(document, 'button', className || 'rw-button', label);
    result.type = 'button';
    if (options.disabled) result.disabled = true;
    if (options.title) result.title = options.title;
    if (options.pressed !== undefined) result.setAttribute('aria-pressed', String(options.pressed));
    if (options.label) result.setAttribute('aria-label', options.label);
    result.addEventListener('click', handler);
    return result;
  }

  function showError(message, target = state) {
    target.readError = text(message);
    render();
  }

  function selectedRecords() {
    return [...state.selected.values()];
  }

  function materialKindLabel(record) {
    if (record.kind === 'note') return '独立笔记';
    return ANNOTATION_KIND_LABELS.get(record.kind) || '批注';
  }

  function zoteroColorClass(value) {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) return '';
    return ZOTERO_COLOR_CLASSES.get(value.toLowerCase()) || '';
  }

  function saveJobReference(job, kind, scopeValue = activeScope) {
    try {
      const storage = document.defaultView.localStorage;
      const storageKey = jobStorageKeyFor(scopeValue);
      const refs = JSON.parse(storage.getItem(storageKey) || '[]');
      const reference = { id: job.id, kind, library, updatedAt: Date.now() };
      const next = Array.isArray(refs) ? refs.filter(ref => ref.id !== job.id) : [];
      next.push(reference);
      storage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The panel can still run; persistence is an optional reload convenience.
    }
  }

  function removeJobReference(id, scopeValue = activeScope) {
    try {
      const storage = document.defaultView.localStorage;
      const storageKey = jobStorageKeyFor(scopeValue);
      const refs = JSON.parse(storage.getItem(storageKey) || '[]');
      if (!Array.isArray(refs)) return;
      const next = refs.filter(reference => reference.id !== id);
      if (next.length) storage.setItem(storageKey, JSON.stringify(next));
      else storage.removeItem(storageKey);
    } catch {
      // Ignore storage being unavailable.
    }
  }

  async function readMaterials() {
    const epoch = ++loadEpoch;
    const requestScope = activeScope ? {
      ...activeScope,
      ...(Array.isArray(activeScope.keys) ? { keys: [...activeScope.keys] } : {}),
    } : null;
    const requestLibrary = requestScope?.library || library;
    state.loading = true;
    state.papers = [];
    state.errors = [];
    state.selected.clear();
    state.loaded = 0;
    state.total = null;
    state.incomplete = false;
    state.readError = '';
    render();

    if (!requestScope || (!Array.isArray(requestScope.keys) && !requestScope.collection)) {
      state.loading = false;
      render();
      return;
    }

    let offset = 0;
    let scopeId;
    const seenOffsets = new Set();
    try {
      while (current(epoch)) {
        if (seenOffsets.has(offset)) throw new Error('分页位置重复，已停止读取以避免遗漏。');
        seenOffsets.add(offset);
        const args = { library: requestLibrary, limit: 10, offset };
        if (scopeId) args.scopeId = scopeId;
        else if (Array.isArray(requestScope.keys) && requestScope.keys.length) args.keys = requestScope.keys;
        else {
          args.collection = requestScope.collection;
          args.recursive = requestScope.recursive !== false;
        }

        const packet = await call('research_materials', args);
        if (!current(epoch)) return;
        if (!packet || !Array.isArray(packet.papers)) throw new Error('研究服务返回了不完整的分页结果。');
        if (!scopeId && packet.scopeId) scopeId = packet.scopeId;
        if (state.total === null && Number.isFinite(packet.total)) state.total = packet.total;

        for (const paper of packet.papers) {
          if (!state.papers.some(existing => existing.itemKey === paper.itemKey)) state.papers.push(paper);
        }
        if (Array.isArray(packet.errors)) state.errors.push(...packet.errors);
        state.incomplete ||= Boolean(packet.incomplete);
        state.loaded = Number.isFinite(packet.processed) ? packet.processed : state.loaded + packet.papers.length + (packet.errors?.length || 0);
        render();

        if (packet.nextOffset === null || packet.nextOffset === undefined) break;
        if (!Number.isInteger(packet.nextOffset) || packet.nextOffset <= offset) throw new Error('分页没有向前推进，已停止读取。');
        offset = packet.nextOffset;
      }
    } catch (error) {
      if (current(epoch)) state.readError = error?.message || String(error);
    } finally {
      if (current(epoch)) {
        state.loading = false;
        render();
      }
    }
  }

  function updateRecordSelection(record, checked) {
    if (checked) state.selected.set(record.id, record);
    else state.selected.delete(record.id);
    render();
  }

  function togglePaper(paper, checked) {
    for (const record of paper.records || []) {
      if (checked) state.selected.set(record.id, record);
      else state.selected.delete(record.id);
    }
    render();
  }

  function beginPolling(id, kind, epoch) {
    const poll = async () => {
      if (disposed || epoch !== jobEpoch) return;
      try {
        const snapshot = await call('research_job', { id });
        if (disposed || epoch !== jobEpoch) return;
        state.job = { ...snapshot, id: snapshot.id || id, kind };
        if (snapshot.status === 'completed') {
          state.result = snapshot.result || null;
          state.level = 'topic';
          state.view = kind === 'fold' ? 'fold' : 'annotations';
          if (kind === 'draft') state.openSources.clear();
        }
        if (TERMINAL.has(snapshot.status)) {
          if (snapshot.status !== 'completed' || !snapshot.result) removeJobReference(id);
          render();
          return;
        }
        render();
      } catch (error) {
        if (disposed || epoch !== jobEpoch) return;
        state.job = { ...(state.job || {}), id, kind, status: 'running', pollingError: error?.message || String(error) };
        render();
      }
      if (!disposed && epoch === jobEpoch) {
        pollTimer = setTimeout(poll, 1100);
      }
    };
    void poll();
  }

  async function recoverJob() {
    if (recoveryStarted) return;
    recoveryStarted = true;
    let refs;
    try {
      refs = JSON.parse(document.defaultView.localStorage.getItem(jobStorageKeyFor()) || '[]');
    } catch {
      return;
    }
    if (!Array.isArray(refs) || disposed || state.job) return;
    for (const saved of refs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      if (!saved?.id || saved.library !== library || !['fold', 'draft'].includes(saved.kind)) continue;
      const epoch = ++jobEpoch;
      try {
        const snapshot = await call('research_job', { id: saved.id });
        if (disposed || epoch !== jobEpoch || state.job) return;
        if (TERMINAL.has(snapshot.status) && (snapshot.status !== 'completed' || !snapshot.result)) {
          removeJobReference(saved.id);
          continue;
        }
        state.job = { ...snapshot, id: snapshot.id || saved.id, kind: saved.kind };
        if (snapshot.status === 'completed') {
          state.result = snapshot.result || null;
          state.view = saved.kind === 'fold' ? 'fold' : 'annotations';
        }
        render();
        if (!TERMINAL.has(snapshot.status)) beginPolling(saved.id, saved.kind, epoch);
        return;
      } catch (error) {
        if (disposed || epoch !== jobEpoch || state.job) return;
        state.job = { id: saved.id, kind: saved.kind, status: 'interrupted', error: error?.message || '无法恢复上次研究任务。' };
        render();
        return;
      }
    }
  }

  async function startJob(kind, args) {
    if (state.job && !TERMINAL.has(state.job.status)) return;
    const jobScope = activeScope;
    const epoch = ++jobEpoch;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    state.readError = '';
    state.result = null;
    state.job = { kind, status: 'starting', stage: '准备任务', progress: 0 };
    if (kind === 'fold') state.view = 'fold';
    render();
    try {
      const started = await call('start_research_job', args);
      if (!disposed && epoch !== jobEpoch && started?.id) saveJobReference(started, kind, jobScope);
      if (disposed || epoch !== jobEpoch) return;
      if (!started?.id) throw new Error('研究服务未返回任务编号。');
      state.job = { ...started, kind };
      saveJobReference(started, kind, jobScope);
      render();
      beginPolling(started.id, kind, epoch);
    } catch (error) {
      if (disposed || epoch !== jobEpoch) return;
      state.job = { kind, status: 'failed', error: error?.message || String(error) };
      render();
    }
  }

  async function cancelJob() {
    const job = state.job;
    if (!job?.id || TERMINAL.has(job.status)) return;
    const epoch = ++jobEpoch;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    state.job = { ...job, cancelling: true };
    render();
    try {
      const snapshot = await call('cancel_research_job', { id: job.id });
      if (disposed || epoch !== jobEpoch) return;
      state.job = { ...snapshot, kind: job.kind };
      if (TERMINAL.has(snapshot.status)) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        removeJobReference(job.id);
      } else {
        beginPolling(job.id, job.kind, epoch);
      }
      render();
    } catch (error) {
      if (disposed || epoch !== jobEpoch) return;
      state.job = { ...job, cancelling: false, cancelError: error?.message || String(error) };
      render();
      beginPolling(job.id, job.kind, epoch);
    }
  }

  function requestRead(record) {
    state.readError = '';
    render();
    Promise.resolve().then(() => onRead?.(record)).catch(error => {
      if (!disposed) showError(error?.message || String(error));
    });
  }

  function sourceLabel(record) {
    const kind = materialKindLabel(record);
    const page = Number.isInteger(record.pageIndex) ? ` · PDF 第 ${record.pageIndex + 1} 页` : '';
    return `${kind} · ${record.title || record.itemKey}${page}`;
  }

  function renderJobStatus() {
    if (!state.job) return null;
    const job = state.job;
    const box = el(document, 'section', 'rw-job');
    const heading = el(document, 'div', 'rw-job-heading');
    heading.append(el(document, 'strong', '', job.kind === 'fold' ? 'TextFold 全文阅读' : '标注写作'));
    const statusTone = job.status === 'completed' ? 'success'
      : ['failed', 'interrupted'].includes(job.status) ? 'error'
        : ['starting', 'running'].includes(job.status) ? 'active' : 'neutral';
    heading.append(badge('状态', ({ starting: '准备中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '中断' })[job.status] || job.status || '读取中', statusTone));
    box.append(heading);
    if (job.stage) box.append(el(document, 'p', 'rw-job-stage', job.stage));
    if (job.status === 'running' || job.status === 'starting') {
      const progress = el(document, 'progress', 'rw-progress');
      progress.max = 100;
      progress.value = Number.isFinite(job.progress) ? job.progress : 0;
      progress.setAttribute('aria-label', '研究任务进度');
      box.append(progress);
      if (job.id) box.append(button(job.cancelling ? '正在取消…' : '取消任务', 'rw-button rw-button-muted', cancelJob, { disabled: Boolean(job.cancelling) }));
    }
    if (job.error) box.append(el(document, 'p', 'rw-alert', job.error));
    if (job.pollingError) box.append(el(document, 'p', 'rw-alert', `任务状态读取失败：${job.pollingError}`));
    if (job.cancelError) box.append(el(document, 'p', 'rw-alert', `取消失败：${job.cancelError}`));
    return box;
  }

  function scopeItemLabel() {
    if (!Array.isArray(activeScope?.keys) || activeScope.keys.length !== 1) return '';
    const key = activeScope.keys[0];
    return state.papers.find(paper => paper.itemKey === key)?.title || key;
  }

  function scopeTitle() {
    const libraryName = library === 'user' ? '个人文库' : `群组 ${library}`;
    if (activeScope?.collection) {
      const name = state.scopeCollections.find(collection => collection.key === activeScope.collection)?.name || activeScope.collection;
      return `${libraryName} · 分类 ${name}`;
    }
    if (Array.isArray(activeScope?.keys) && activeScope.keys.length === 1)
      return `${libraryName} · 文献 ${state.scopeItemLabel || scopeItemLabel()}`;
    if (Array.isArray(activeScope?.keys) && activeScope.keys.length > 1)
      return `${libraryName} · 指定 ${activeScope.keys.length} 篇文献`;
    return `${libraryName} · 选择材料范围`;
  }

  function selectedItemUrl(itemKey) {
    const prefix = library === 'user' ? 'library' : `groups/${library.slice(1)}`;
    return `zotero://select/${prefix}/items/${itemKey}`;
  }

  function responseData(value) {
    return value?.structuredContent || value?.structured || value;
  }

  function closeScopePicker() {
    scopeLookupEpoch += 1;
    state.scopePickerOpen = false;
    state.scopeLoading = false;
    state.scopeError = '';
    render();
  }

  async function loadScopeCollections() {
    const epoch = ++scopeLookupEpoch;
    state.scopeLoading = true;
    state.scopeError = '';
    render();
    try {
      const packet = responseData(await call('list_collections', { library }));
      if (disposed || epoch !== scopeLookupEpoch || !state.scopePickerOpen || state.scopeMode !== 'collection') return;
      if (!Array.isArray(packet?.collections)) throw new Error('分类列表格式不完整。');
      state.scopeCollections = packet.collections;
    } catch (error) {
      if (disposed || epoch !== scopeLookupEpoch) return;
      state.scopeError = error?.message || String(error);
    } finally {
      if (!disposed && epoch === scopeLookupEpoch) {
        state.scopeLoading = false;
        render();
      }
    }
  }

  async function searchScopeItems() {
    const epoch = ++scopeLookupEpoch;
    state.scopeLoading = true;
    state.scopeError = '';
    render();
    try {
      const args = { library, mode: 'titleCreatorYear', limit: 20, start: 0 };
      if (state.scopeQuery.trim()) args.query = state.scopeQuery.trim();
      const packet = responseData(await call('search_library', args));
      if (disposed || epoch !== scopeLookupEpoch || !state.scopePickerOpen || state.scopeMode !== 'paper') return;
      if (!Array.isArray(packet?.items)) throw new Error('文献搜索结果格式不完整。');
      state.scopeResults = packet.items;
      state.scopeTotal = Number.isFinite(packet.total) ? packet.total : packet.items.length;
    } catch (error) {
      if (disposed || epoch !== scopeLookupEpoch) return;
      state.scopeError = error?.message || String(error);
    } finally {
      if (!disposed && epoch === scopeLookupEpoch) {
        state.scopeLoading = false;
        render();
      }
    }
  }

  function setScopeMode(mode) {
    state.scopeMode = mode;
    state.scopeError = '';
    if (mode === 'collection') void loadScopeCollections();
    else void searchScopeItems();
  }

  function openScopePicker() {
    state.scopePickerOpen = true;
    state.scopeMode = activeScope?.collection ? 'collection' : 'paper';
    state.scopeQuery = '';
    state.scopeResults = [];
    state.scopeError = '';
    render();
    if (state.scopeMode === 'collection') void loadScopeCollections();
    else void searchScopeItems();
  }

  function chooseMaterialScope(nextScope, label = '') {
    scopeLookupEpoch += 1;
    activeScope = { library, ...nextScope };
    state.scopeItemLabel = nextScope.keys?.length === 1 ? label : '';
    state.scopePickerOpen = false;
    state.scopeLoading = false;
    state.scopeError = '';
    state.scopeResults = [];
    state.result = null;
    state.job = null;
    state.openSources.clear();
    state.showAllSelected = false;
    state.view = 'annotations';
    recoveryStarted = false;
    jobEpoch += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    void readMaterials();
    void recoverJob();
  }

  function collectionOptions() {
    const children = new Map();
    for (const collection of state.scopeCollections) {
      const parent = collection.parent || null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(collection);
    }
    for (const values of children.values()) values.sort((a, b) => text(a.name).localeCompare(text(b.name)));
    const rows = [];
    const visit = (parent, depth, visited) => {
      for (const collection of children.get(parent) || []) {
        if (visited.has(collection.key)) continue;
        rows.push({ collection, depth });
        const next = new Set(visited);
        next.add(collection.key);
        visit(collection.key, depth + 1, next);
      }
    };
    visit(null, 0, new Set());
    return rows;
  }

  function renderScopePicker() {
    const picker = el(document, 'section', 'rw-scope-picker');
    picker.setAttribute('aria-label', '选择研究材料范围');
    const heading = el(document, 'div', 'rw-scope-picker-heading');
    heading.append(el(document, 'strong', '', '研究范围'));
    heading.append(button('取消', 'rw-link-button', closeScopePicker));
    picker.append(heading);

    const modes = el(document, 'div', 'rw-scope-modes');
    for (const [id, label] of [['collection', '分类'], ['paper', '文献']]) {
      modes.append(button(label, `rw-pill${state.scopeMode === id ? ' is-active' : ''}`, () => setScopeMode(id), {
        pressed: state.scopeMode === id,
      }));
    }
    picker.append(modes);

    if (state.scopeMode === 'collection') {
      picker.append(el(document, 'p', 'rw-muted', '选择一个分类，读取该分类及子分类中的文献标注。'));
      const options = el(document, 'div', 'rw-scope-options');
      for (const { collection, depth } of collectionOptions()) {
        const option = button(`${'　'.repeat(Math.min(depth, 6))}${collection.name || collection.key} · ${collection.numItems ?? 0}`, 'rw-scope-option', () => {
          chooseMaterialScope({ collection: collection.key, recursive: true });
        });
        option.dataset.key = collection.key;
        option.setAttribute('aria-current', String(activeScope?.collection === collection.key));
        options.append(option);
      }
      if (!state.scopeLoading && !state.scopeError && !state.scopeCollections.length)
        options.append(el(document, 'p', 'rw-muted', '文库中没有可选分类。'));
      picker.append(options);
    } else {
      const searchRow = el(document, 'div', 'rw-scope-search');
      const input = el(document, 'input', 'rw-scope-search-input');
      input.type = 'search';
      input.maxLength = 300;
      input.placeholder = '搜索题名、作者；留空显示最近文献';
      input.value = state.scopeQuery;
      input.setAttribute('aria-label', '搜索文献');
      input.addEventListener('input', () => { state.scopeQuery = input.value; });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') void searchScopeItems(); });
      searchRow.append(input);
      searchRow.append(button('搜索', 'rw-button rw-button-muted', () => void searchScopeItems(), { disabled: state.scopeLoading }));
      picker.append(searchRow);
      if (!state.scopeQuery.trim()) picker.append(el(document, 'p', 'rw-muted', '显示最近文献；输入关键词后可搜索题名和作者。'));
      if (state.scopeTotal > state.scopeResults.length)
        picker.append(el(document, 'p', 'rw-muted', `显示 ${state.scopeResults.length} 篇，共 ${state.scopeTotal} 篇匹配结果。`));
      const options = el(document, 'div', 'rw-scope-options');
      for (const item of state.scopeResults) {
        const option = button(item.title || item.key, 'rw-scope-option', () => {
          chooseMaterialScope({ keys: [item.key] }, item.title || item.key);
        });
        option.dataset.key = item.key;
        option.append(el(document, 'span', 'rw-scope-option-key', item.key));
        options.append(option);
      }
      if (!state.scopeLoading && !state.scopeError && !state.scopeResults.length)
        options.append(el(document, 'p', 'rw-muted', '没有找到文献。'));
      picker.append(options);
    }

    if (state.scopeLoading) picker.append(el(document, 'p', 'rw-muted', '正在读取文库…'));
    if (state.scopeError) picker.append(el(document, 'p', 'rw-alert', state.scopeError));
    return picker;
  }

  function renderTop() {
    const header = el(document, 'header', 'rw-header');
    const titleLine = el(document, 'div', 'rw-title-line');
    titleLine.append(el(document, 'span', 'rw-title', '研究工作台'));
    titleLine.append(badge('文献', state.total ?? state.papers.length));
    titleLine.append(badge('材料', state.papers.reduce((sum, paper) => sum + (paper.records?.length || 0), 0)));
    titleLine.append(badge('已选', state.selected.size));
    if (state.loading) titleLine.append(badge('读取', `${state.loaded}${state.total === null ? '' : ` / ${state.total}`}`));
    header.append(titleLine);

    const nav = el(document, 'nav', 'rw-tabs');
    nav.setAttribute('aria-label', '研究视图');
    for (const [id, label] of [['annotations', '我的标注'], ['fold', 'TextFold']]) {
      nav.append(button(label, `rw-pill${state.view === id ? ' is-active' : ''}`, () => {
        state.view = id;
        render();
      }, { pressed: state.view === id }));
    }
    header.append(nav);

    const scopeLine = el(document, 'div', 'rw-scope-line');
    const scopeControl = el(document, 'div', 'rw-scope-control');
    scopeControl.append(button(scopeTitle(), 'rw-scope-trigger', openScopePicker, {
      pressed: state.scopePickerOpen,
      label: '更改研究范围；可选择文库分类或指定文献',
    }));
    if (Array.isArray(activeScope?.keys) && activeScope.keys.length === 1) {
      const key = activeScope.keys[0];
      scopeControl.append(button('打开文献', 'rw-link-button', () => requestRead({ library, itemKey: key, url: selectedItemUrl(key) })));
    }
    if (state.scopePickerOpen) scopeControl.append(renderScopePicker());
    scopeLine.append(scopeControl);
    if (state.readError) scopeLine.append(el(document, 'span', 'rw-alert rw-alert-inline', state.readError));
    header.append(scopeLine);
    const job = renderJobStatus();
    if (job) header.append(job);
    return header;
  }

  function renderSelectedChips() {
    const selected = selectedRecords();
    if (!selected.length) return null;
    const tray = el(document, 'section', 'rw-selected');
    const line = el(document, 'div', 'rw-section-heading');
    line.append(el(document, 'strong', '', '已选材料'));
    line.append(badge('条', selected.length));
    if (selected.length > 5) {
      line.append(button(state.showAllSelected ? '收起' : `展开另外 ${selected.length - 5} 条`, 'rw-link-button', () => {
        state.showAllSelected = !state.showAllSelected;
        render();
      }, { pressed: state.showAllSelected }));
    }
    line.append(button('清除', 'rw-link-button', () => {
      state.selected.clear();
      state.showAllSelected = false;
      render();
    }));
    tray.append(line);
    const chips = el(document, 'div', 'rw-chips');
    const visible = selected.length > 5 && !state.showAllSelected ? selected.slice(0, 5) : selected;
    for (const record of visible) {
      const chip = button(`× ${sourceLabel(record)}`, 'rw-chip', () => {
        state.selected.delete(record.id);
        render();
      }, { label: `移除已选材料：${sourceLabel(record)}` });
      chips.append(chip);
    }
    tray.append(chips);
    return tray;
  }

  function renderRecord(record) {
    const item = el(document, 'article', 'rw-record');
    const top = el(document, 'div', 'rw-record-top');
    const checkbox = el(document, 'input', 'rw-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(record.id);
    checkbox.setAttribute('aria-label', `选择${sourceLabel(record)}`);
    checkbox.addEventListener('change', () => updateRecordSelection(record, checkbox.checked));
    top.append(checkbox);
    const colorClass = record.kind === 'note' ? '' : zoteroColorClass(record.color);
    const kindTag = tag(record.kind === 'note' ? '▤' : '▧', materialKindLabel(record), colorClass ? `rw-annotation-tag ${colorClass}` : 'rw-annotation-tag');
    if (colorClass) kindTag.append(el(document, 'span', 'rw-color-dot'));
    top.append(kindTag);
    if (record.pageLabel || Number.isInteger(record.pageIndex)) {
      const pageText = record.pageLabel ? `页标 ${record.pageLabel}` : `PDF 第 ${record.pageIndex + 1} 页`;
      top.append(tag('↗', pageText));
    }
    item.append(top);
    if (record.text) {
      const quote = el(document, 'div', record.kind === 'note' ? 'rw-note-text' : `rw-quote${colorClass ? ` ${colorClass}` : ''}`);
      quote.append(el(document, 'span', 'rw-origin-label', record.kind === 'note' ? '独立笔记' : '原文摘录'));
      quote.append(el(document, 'p', '', record.text));
      item.append(quote);
    }
    if (record.comment) {
      const comment = el(document, 'div', 'rw-comment');
      comment.append(el(document, 'span', 'rw-origin-label', '阅读者备注'));
      comment.append(el(document, 'p', '', record.comment));
      item.append(comment);
    }
    if (record.url) item.append(button(record.kind === 'note' ? '回到笔记' : '回到原文', 'rw-link-button', () => requestRead(record)));
    return item;
  }

  function paperIsSelected(paper) {
    const records = paper.records || [];
    return records.length > 0 && records.every(record => state.selected.has(record.id));
  }

  function renderPaper(paper) {
    const section = el(document, 'section', 'rw-paper');
    const heading = el(document, 'div', 'rw-paper-heading');
    const select = el(document, 'input', 'rw-checkbox');
    select.type = 'checkbox';
    select.checked = paperIsSelected(paper);
    select.disabled = !(paper.records || []).length;
    select.setAttribute('aria-label', `全选文献材料：${paper.title || paper.itemKey}`);
    select.addEventListener('change', () => togglePaper(paper, select.checked));
    heading.append(select);
    heading.append(el(document, 'h3', '', paper.title || paper.itemKey));
    heading.append(badge('材料', paper.records?.length || 0));
    heading.append(button('打开文献', 'rw-link-button', () => requestRead({
      library, itemKey: paper.itemKey, url: selectedItemUrl(paper.itemKey),
    })));
    heading.append(button('AI 全文阅读并生成', 'rw-button rw-fold-button', () => startJob('fold', { kind: 'fold', library, key: paper.itemKey }), {
      disabled: Boolean(state.job && !TERMINAL.has(state.job.status)),
      title: '需要可读取文本的 PDF；无 PDF 或扫描页会明确报错，不会生成降级摘要。',
    }));
    section.append(heading);
    if (paper.errors?.length) {
      for (const error of paper.errors) section.append(el(document, 'p', 'rw-alert', error.message || '部分批注读取失败。'));
    }
    const records = el(document, 'div', 'rw-records');
    for (const record of paper.records || []) records.append(renderRecord(record));
    if (!paper.records?.length && !paper.errors?.length) records.append(el(document, 'p', 'rw-muted', '这篇文献没有可整理的高亮、批注或子笔记。'));
    section.append(records);
    return section;
  }

  function draftMarkdown(result) {
    const sources = new Map((result.sources || []).map(record => [record.id, record]));
    const lines = [`# ${text(result.title, '标注整理初稿')}`, ''];
    for (const paragraph of result.paragraphs || []) {
      lines.push(text(paragraph.text), '');
      const refs = (paragraph.sourceIds || []).map(id => {
        const record = sources.get(id);
        if (!record) return `- 来源 ID：${markdownEscape(id)}`;
        const label = `${record.title || record.itemKey}${Number.isInteger(record.pageIndex) ? `，PDF 第 ${record.pageIndex + 1} 页` : ''}，${record.kind === 'note' ? '独立笔记' : materialKindLabel(record)}`;
        return record.url ? `- [${markdownEscape(label)}](${markdownUrl(record.url)})` : `- ${markdownEscape(label)}（Zotero ${record.library}/${record.key}）`;
      });
      lines.push(...refs, '');
    }
    if (result.gaps?.length) lines.push('## 需要补充的证据', '', ...result.gaps.map(gap => `- ${text(gap)}`), '');
    lines.push('> 初稿仅根据研究者勾选的材料生成，论断与引文仍需人工核对。');
    return lines.join('\n');
  }

  function copyDraft(result) {
    state.copyMessage = '';
    const clipboard = document.defaultView.navigator?.clipboard;
    if (!clipboard?.writeText) {
      state.copyMessage = '当前环境无法访问剪贴板。';
      render();
      return;
    }
    clipboard.writeText(draftMarkdown(result)).then(() => {
      if (disposed) return;
      state.copyMessage = '已复制 Markdown 与来源回链。';
      render();
    }).catch(error => {
      if (disposed) return;
      state.copyMessage = `复制失败：${error?.message || String(error)}`;
      render();
    });
  }

  function renderDraftSource(record, open) {
    const source = el(document, 'div', 'rw-source-detail');
    const colorClass = record.kind === 'note' ? '' : zoteroColorClass(record.color);
    const sourceTag = tag(record.kind === 'note' ? '▤' : '▧', sourceLabel(record), colorClass ? `rw-annotation-tag ${colorClass}` : 'rw-annotation-tag');
    if (colorClass) sourceTag.append(el(document, 'span', 'rw-color-dot'));
    source.append(sourceTag);
    if (record.text) {
      source.append(el(document, 'span', 'rw-origin-label', record.kind === 'note' ? '独立笔记' : '原文摘录'));
      const excerpt = el(document, 'p', `rw-source-excerpt${record.kind === 'note' ? ' rw-source-note' : ` rw-source-quote${colorClass ? ` ${colorClass}` : ''}`}`, record.text);
      source.append(excerpt);
    }
    if (record.comment) {
      source.append(el(document, 'span', 'rw-origin-label rw-comment-label', '阅读者备注'));
      source.append(el(document, 'p', 'rw-source-comment', record.comment));
    }
    if (record.url) source.append(button(record.kind === 'note' ? '回到笔记' : '回到原文', 'rw-button rw-button-muted', () => requestRead(record)));
    if (!open) source.hidden = true;
    return source;
  }

  function renderDraftResult(result) {
    const panel = el(document, 'section', 'rw-result');
    const heading = el(document, 'div', 'rw-section-heading');
    heading.append(el(document, 'h2', '', result.title || '标注整理初稿'));
    heading.append(button('复制 Markdown', 'rw-button rw-button-muted', () => copyDraft(result)));
    panel.append(heading);
    panel.append(el(document, 'p', 'rw-muted', '依据本次勾选的材料生成；初稿中的每段均有来源，仍需人工核对论断与引文。'));
    if (state.copyMessage) panel.append(el(document, 'p', 'rw-copy-message', state.copyMessage));
    const sourceMap = new Map((result.sources || []).map(record => [record.id, record]));
    for (const [index, paragraph] of (result.paragraphs || []).entries()) {
      const card = el(document, 'article', 'rw-draft-paragraph');
      card.append(el(document, 'p', 'rw-draft-text', paragraph.text));
      const sourceButtons = el(document, 'div', 'rw-source-buttons');
      for (const id of paragraph.sourceIds || []) {
        const record = sourceMap.get(id);
        if (!record) continue;
        const open = state.openSources.has(id);
        sourceButtons.append(button(`${open ? '收起' : '查看'}来源 · ${sourceLabel(record)}`, 'rw-source-button', () => {
          if (state.openSources.has(id)) state.openSources.delete(id);
          else state.openSources.add(id);
          render();
        }, { pressed: open }));
        if (open) card.append(renderDraftSource(record, true));
      }
      if (!paragraph.sourceIds?.length) card.append(el(document, 'p', 'rw-alert', '该段没有可用来源回链。'));
      card.append(sourceButtons);
      card.dataset.paragraph = String(index + 1);
      panel.append(card);
    }
    if (result.gaps?.length) {
      const gaps = el(document, 'section', 'rw-gaps');
      gaps.append(el(document, 'h3', '', '需要补充的证据'));
      const list = el(document, 'ul', '');
      for (const gap of result.gaps) list.append(el(document, 'li', '', gap));
      gaps.append(list);
      panel.append(gaps);
    }
    return panel;
  }

  function startDraft() {
    const selected = selectedRecords();
    if (!selected.length) return;
    const sourceIds = selected.map(record => record.id);
    const sourceVersions = Object.fromEntries(selected.map(record => [record.id, record.fingerprint]));
    const keys = unique(selected.map(record => record.itemKey));
    void startJob('draft', {
      kind: 'draft',
      library,
      keys,
      sourceIds,
      sourceVersions,
      purpose: state.purpose,
      framework: state.framework,
    });
  }

  function renderDraftComposer() {
    const composer = el(document, 'section', 'rw-composer');
    composer.tabIndex = -1;
    draftComposer = composer;
    const heading = el(document, 'div', 'rw-section-heading');
    heading.append(el(document, 'h2', '', '按已选标注生成初稿'));
    heading.append(badge('已选', state.selected.size));
    composer.append(heading);
    composer.append(el(document, 'p', 'rw-muted', '只发送勾选来源的原文、阅读者备注、独立笔记与指纹。'));
    const purposes = el(document, 'div', 'rw-tabs rw-purpose-tabs');
    for (const [value, label] of [['paragraph', '论文段落'], ['review', '文献综述']]) {
      purposes.append(button(label, `rw-pill${state.purpose === value ? ' is-active' : ''}`, () => {
        state.purpose = value;
        render();
      }, { pressed: state.purpose === value }));
    }
    composer.append(purposes);
    const frameworkLabel = el(document, 'label', 'rw-label', '写作框架（可选）');
    const framework = el(document, 'textarea', 'rw-textarea');
    framework.rows = 3;
    framework.maxLength = 12000;
    framework.placeholder = '补充本段要回答的问题、概念或结构要求';
    framework.value = state.framework;
    framework.addEventListener('input', () => { state.framework = framework.value; });
    frameworkLabel.append(framework);
    composer.append(frameworkLabel);
    composer.append(button(state.job?.kind === 'draft' && !TERMINAL.has(state.job.status) ? '写作任务进行中…' : '根据所选材料生成', 'rw-button rw-button-primary', startDraft, {
      disabled: !state.selected.size || Boolean(state.job && !TERMINAL.has(state.job.status)),
    }));
    return composer;
  }

  function focusComposer() {
    if (!draftComposer) return;
    draftComposer.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    draftComposer.focus?.({ preventScroll: true });
  }

  function renderAnnotations() {
    const body = el(document, 'main', 'rw-body');
    const controls = el(document, 'div', 'rw-controls');
    const status = el(document, 'p', 'rw-muted', state.loading
      ? `正在顺序读取材料 ${state.loaded}${state.total === null ? '' : ` / ${state.total}`} …`
      : state.incomplete ? '部分批注读取未完成；请按下方错误核对。' : '高亮、原文批注、阅读者备注与独立笔记分开呈现。');
    controls.append(status);
    if (state.errors.length) {
      const errors = el(document, 'details', 'rw-errors');
      errors.append(el(document, 'summary', '', `读取错误 ${state.errors.length} 条`));
      const list = el(document, 'ul', '');
      for (const error of state.errors) list.append(el(document, 'li', '', `${error.itemKey || ''} ${error.message || ''}`.trim()));
      errors.append(list);
      controls.append(errors);
    }
    body.append(controls);
    if (state.selected.size) {
      const actionbar = el(document, 'div', 'rw-selection-bar');
      actionbar.append(el(document, 'span', '', `已选 ${state.selected.size} 条材料`));
      actionbar.append(button('整理所选材料', 'rw-button rw-button-primary', focusComposer));
      body.append(actionbar);
    }
    const chips = renderSelectedChips();
    if (chips) body.append(chips);

    if (!activeScope || (!Array.isArray(activeScope.keys) && !activeScope.collection)) {
      body.append(el(document, 'p', 'rw-empty', '先选择一个文库分类或一篇文献，再查看标注。'));
    } else if (!state.loading && !state.papers.length && !state.readError) {
      body.append(el(document, 'p', 'rw-empty', '当前范围内没有可读取的标注文献。'));
    }

    const papers = el(document, 'div', 'rw-papers');
    for (const paper of state.papers) papers.append(renderPaper(paper));
    body.append(papers);
    body.append(renderDraftComposer());
    if (state.result && state.job?.kind === 'draft') body.append(renderDraftResult(state.result));
    if (state.readError) body.append(el(document, 'p', 'rw-alert', state.readError));
    return body;
  }

  function pageButton(libraryId, itemKey, attachmentKey, pageIndex) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
    return button(`PDF 第 ${pageIndex + 1} 页`, 'rw-page-button', () => requestRead({
      library: libraryId,
      itemKey,
      attachmentKey,
      pageIndex,
    }));
  }

  function levelText(unit, level) {
    if (level === 'topic') return unit.topic || '';
    if (level === 'takeaway') return unit.takeaway || '';
    if (level === 'key') return unit.key || '';
    if (level === 'brief') return Array.isArray(unit.brief) ? unit.brief.join('\n\n') : text(unit.brief);
    return unit.full || '';
  }

  function renderFoldResult(result) {
    const panel = el(document, 'section', 'rw-fold-result');
    const titleLine = el(document, 'div', 'rw-section-heading');
    titleLine.append(el(document, 'h2', '', result.title || 'TextFold 阅读结果'));
    titleLine.append(badge('页数', result.coverage?.pages ?? '—'));
    if (result.provenance?.ai_generated) titleLine.append(tag('✦', 'AI 全文生成', 'rw-ai-tag'));
    panel.append(titleLine);

    if (result.overview) {
      const overview = el(document, 'section', 'rw-overview');
      overview.append(el(document, 'h3', '', '全文理解'));
      for (const [label, value] of [['研究问题与概览', result.overview.overview], ['论证主线', result.overview.argument], ['适用范围与限制', result.overview.limitations]]) {
        if (!value) continue;
        const block = el(document, 'div', 'rw-overview-block');
        block.append(el(document, 'span', 'rw-origin-label rw-ai-label', 'AI 概括'));
        block.append(el(document, 'strong', '', label));
        block.append(el(document, 'p', '', value));
        overview.append(block);
      }
      panel.append(overview);
    }

    const levels = el(document, 'nav', 'rw-levels');
    levels.setAttribute('aria-label', 'TextFold 阅读层级');
    for (const [id, label] of LEVELS) {
      levels.append(button(label, `rw-pill${state.level === id ? ' is-active' : ''}`, () => {
        state.level = id;
        render();
      }, { pressed: state.level === id }));
    }
    panel.append(levels);
    const isAi = state.level !== 'brief' && state.level !== 'full';
    panel.append(el(document, 'p', 'rw-muted rw-level-note', isAi
      ? '当前层展示 AI 生成的主题、结论或要点；关键原句与全文为 PDF 原文。'
      : '当前层展示 PDF 原文句子；每段保留 PDF 页码回跳。'));

    const sections = el(document, 'div', 'rw-fold-sections');
    for (const section of result.sections || []) {
      const sectionBox = el(document, 'section', 'rw-fold-section');
      const heading = el(document, 'div', 'rw-fold-section-heading');
      const sectionName = [section.num, section.title].filter(Boolean).join(' ');
      heading.append(el(document, 'h3', '', sectionName || section.id || '章节'));
      if (section.topic && state.level === 'topic') heading.append(tag('◌', section.topic, 'rw-topic-tag'));
      if (section.takeaway && (state.level === 'topic' || state.level === 'takeaway')) {
        const take = el(document, 'p', 'rw-fold-section-takeaway');
        take.append(el(document, 'span', 'rw-origin-label rw-ai-label', 'AI 概括'));
        take.append(document.createTextNode(section.takeaway));
        heading.append(take);
      }
      sectionBox.append(heading);
      for (const unit of section.units || []) {
        const value = levelText(unit, state.level);
        if (!value) continue;
        const article = el(document, 'article', 'rw-fold-unit');
        const meta = el(document, 'div', 'rw-fold-unit-meta');
        meta.append(el(document, 'span', 'rw-origin-label', isAi ? 'AI 概括' : '原文句子'));
        if (unit.kind) meta.append(tag('·', UNIT_KIND_LABELS.get(unit.kind) || '正文'));
        if (state.level === 'topic' && unit.topic) meta.append(tag('◌', unit.topic, 'rw-topic-tag'));
        const jump = pageButton(result.library, result.itemKey, result.attachmentKey, unit.pageIndex);
        if (jump) meta.append(jump);
        article.append(meta);
        article.append(el(document, 'p', 'rw-fold-text', value));
        article.dataset.unit = text(unit.id);
        sectionBox.append(article);
      }
      if (!section.units?.length && (state.level === 'topic' || state.level === 'takeaway') && section.takeaway) {
        const fallback = el(document, 'p', 'rw-fold-text');
        fallback.append(el(document, 'span', 'rw-origin-label rw-ai-label', 'AI 概括'));
        fallback.append(document.createTextNode(section.takeaway));
        sectionBox.append(fallback);
      }
      sections.append(sectionBox);
    }
    panel.append(sections);
    if (result.source?.sha256 || result.provenance?.made_with) {
      const provenance = el(document, 'details', 'rw-provenance');
      provenance.append(el(document, 'summary', '', '来源与任务信息'));
      if (result.source?.sha256) provenance.append(el(document, 'p', 'rw-muted rw-fingerprint', `PDF 指纹 ${result.source.sha256}`));
      if (result.provenance?.made_with) provenance.append(el(document, 'p', 'rw-muted', result.provenance.made_with));
      panel.append(provenance);
    }
    return panel;
  }

  function renderFoldView() {
    const body = el(document, 'main', 'rw-body');
    body.append(el(document, 'p', 'rw-muted', '选择单篇文献，读取 PDF 的完整可提取文字并生成五层阅读结果。图表及复杂版式请结合原 PDF 核对。'));
    if (state.result && state.job?.kind === 'fold') body.append(renderFoldResult(state.result));
    else if (!state.loading && !state.papers.length) body.append(el(document, 'p', 'rw-empty', '先从文库选择一篇文献或一个分类。'));

    if (state.papers.length) {
      const papers = el(document, 'div', 'rw-fold-paper-list');
      for (const paper of state.papers) {
        const row = el(document, 'div', 'rw-fold-paper-row');
        row.append(el(document, 'div', 'rw-fold-paper-title', paper.title || paper.itemKey));
        row.append(tag('▧', paper.itemKey));
        row.append(button('AI 全文阅读并生成', 'rw-button rw-button-primary', () => startJob('fold', { kind: 'fold', library, key: paper.itemKey }), {
          disabled: Boolean(state.job && !TERMINAL.has(state.job.status)),
          title: '需要可读取文本的 PDF；无 PDF 或扫描页会明确报错，不会生成降级摘要。',
        }));
        papers.append(row);
      }
      body.append(papers);
    }
    if (state.readError) body.append(el(document, 'p', 'rw-alert', state.readError));
    return body;
  }

  function render() {
    if (disposed) return;
    app.replaceChildren(renderTop(), state.view === 'fold' ? renderFoldView() : renderAnnotations());
  }

  render();
  void readMaterials();
  void recoverJob();

  return () => {
    if (disposed) return;
    disposed = true;
    loadEpoch += 1;
    jobEpoch += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    app.replaceChildren();
  };
}
return mountResearchWorkbench;
})();
