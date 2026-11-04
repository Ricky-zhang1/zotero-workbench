import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountResearchWorkbench } from '../src/ui/research-view.js';
import { annotationHighlightType } from '../src/ui/highlight-presets.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

class FakeNode {
  constructor(ownerDocument, tagName = '#text', value = '') {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toLowerCase();
    this.className = '';
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this._text = value;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...items) {
    for (const item of items) {
      if (item === null || item === undefined) continue;
      const child = typeof item === 'string' ? this.ownerDocument.createTextNode(item) : item;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name) {
    for (const listener of this.listeners.get(name) || []) listener({ target: this, currentTarget: this });
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  scrollIntoView(options) { this.scrollOptions = options; }
  focus(options) { this.focusOptions = options; }
}

class FakeDocument {
  constructor(storage = new MemoryStorage()) {
    this.clipboardWrites = [];
    this.defaultView = {
      localStorage: storage,
      navigator: { clipboard: { writeText: async value => { this.clipboardWrites.push(value); } } },
    };
  }
  createElement(tagName) { return new FakeNode(this, tagName); }
  createTextNode(value) { return new FakeNode(this, '#text', String(value)); }
}

function harness(storage, { autoTranslate = false } = {}) {
  const actualStorage = storage || new MemoryStorage();
  if (autoTranslate !== null && actualStorage.getItem('zoteroWorkbenchAutoTranslateAnnotations') === null) {
    actualStorage.setItem('zoteroWorkbenchAutoTranslateAnnotations', String(autoTranslate));
  }
  const document = new FakeDocument(actualStorage);
  return { document, host: document.createElement('div'), storage: actualStorage };
}

function all(root, predicate) {
  const found = [];
  const visit = node => {
    if (predicate(node)) found.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return found;
}

function button(root, label) {
  const found = all(root, node => node.tagName === 'button' && node.textContent === label)[0];
  assert.ok(found, `expected button: ${label}`);
  return found;
}

function byClass(root, className) {
  return all(root, node => node.className === className);
}

async function until(predicate, message = 'condition did not become true') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function record({ id, itemKey, title, text, comment, pageIndex = 0, pageLabel, kind = 'highlight', color = '', tags = [] }) {
  return {
    id, library: 'user', itemKey, title, key: `ANN${id.padEnd(5, '0')}`.slice(0, 8),
    attachmentKey: 'PDF00001', kind, text, comment, pageIndex, pageLabel: pageLabel ?? String(pageIndex + 1), color, tags,
    url: `zotero://open-pdf/library/items/PDF00001?page=${pageIndex + 1}`,
    fingerprint: `fingerprint-${id}`,
  };
}

function paper(itemKey, title, records = []) { return { itemKey, title, records, errors: [] }; }

function foldResult(itemKey = 'PAPER001') {
  return {
    title: 'A paper', library: 'user', itemKey, attachmentKey: 'PDF00001',
    overview: { overview: 'Overview.', argument: 'Argument.', limitations: 'Limits.' },
    sections: [{ id: 'S1', num: '1', title: 'Section', topic: 'AI topic', takeaway: 'AI conclusion', units: [{
      id: 'U1', kind: 'paragraph', pageIndex: 0, topic: 'AI topic', takeaway: 'AI takeaway', key: 'AI key point',
      brief: ['Exact original sentence.'], full: 'Exact original sentence.',
    }] }],
    coverage: { pages: 1 }, provenance: { ai_generated: true, made_with: 'TextFold' }, source: { sha256: 'abc' },
  };
}

function translationResult(itemKey = 'PAPER001', { complete = true } = {}) {
  const block = {
    blockId: 'p1-b1', originalFingerprint: 'b'.repeat(64),
    original: 'Original page text.', translation: '整页中文译文。', unchanged: false,
  };
  return {
    format: 'zotero-workbench/translation', version: 1, targetLanguage: 'zh-CN',
    title: 'Translated paper', library: 'user', itemKey, attachmentKey: 'PDF00001',
    sha256: 'a'.repeat(64), textSource: 'pdfjs',
    pages: [{
      page: 1, pageIndex: 0,
      url: 'zotero://open-pdf/library/items/PDF00001?page=1',
      original: block.original, translation: block.translation, blocks: [block],
    }],
    coverage: { complete, pages: 1, blocks: 1 },
    provenance: { translationVersion: 'zotero-workbench-zh-v1', textSource: 'pdfjs' },
  };
}

test('reads material pages sequentially and drafts with only selected source IDs and fingerprints', async () => {
  const first = record({ id: 'SRC00001', itemKey: 'PAPER001', title: 'Paper One', text: 'Selected excerpt.', comment: 'Reader note.' });
  const other = record({ id: 'SRC00002', itemKey: 'PAPER002', title: 'Paper Two', text: 'Unselected excerpt.', comment: '' });
  const requests = [];
  const reads = [];
  const { host } = harness();
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001', 'PAPER002'] },
    onRead: source => reads.push(source),
    call: async (name, args) => {
      requests.push({ name, args });
      if (name === 'research_materials' && args.offset === 0) return {
        scopeId: 'scope-page-token', total: 2, processed: 1, nextOffset: 1,
        papers: [paper('PAPER001', 'Paper One', [first])], errors: [],
      };
      if (name === 'research_materials' && args.offset === 1) return {
        scopeId: args.scopeId, total: 2, processed: 2, nextOffset: null,
        papers: [paper('PAPER002', 'Paper Two', [other])], errors: [],
      };
      if (name === 'start_research_job') return { id: 'a'.repeat(24), status: 'running' };
      if (name === 'research_job') return {
        id: args.id, status: 'completed', result: {
          title: 'Draft', sources: [first], paragraphs: [{ text: 'A supported paragraph.', sourceIds: [first.id] }], gaps: [],
        },
      };
      throw new Error(`unexpected tool: ${name}`);
    },
  });

  await until(() => all(host, node => node.className === 'rw-paper').length === 2, 'both material pages were not loaded');
  const pages = requests.filter(request => request.name === 'research_materials');
  assert.deepEqual(pages.map(({ args }) => [args.offset, args.scopeId || null]), [[0, null], [1, 'scope-page-token']]);
  assert.equal(requests.some(request => request.name === 'start_research_job'), false, 'mount must not start AI');

  const selectedCard = all(host, node => node.className === 'rw-record' && node.textContent.includes('Selected excerpt.'))[0];
  assert.ok(selectedCard);
  const checkbox = all(selectedCard, node => node.tagName === 'input')[0];
  checkbox.checked = true;
  checkbox.dispatch('change');
  button(host, '根据所选材料生成').click();
  await until(() => all(host, node => node.className === 'rw-draft-paragraph').length === 1, 'draft was not rendered');

  const start = requests.find(request => request.name === 'start_research_job');
  assert.deepEqual(start.args.keys, ['PAPER001']);
  assert.deepEqual(start.args.sourceIds, [first.id]);
  assert.deepEqual(start.args.sourceVersions, { [first.id]: first.fingerprint });
  assert.equal(start.args.framework, '');
  assert.equal(start.args.purpose, 'paragraph');
  assert.equal(JSON.stringify(start.args).includes(other.id), false);

  const sourceButton = all(host, node => node.tagName === 'button' && node.textContent.startsWith('查看来源 ·'))[0];
  assert.ok(sourceButton);
  sourceButton.click();
  assert.ok(host.textContent.includes('Selected excerpt.'));
  button(host, '回到原文').click();
  await until(() => reads.length === 1);
  assert.equal(reads[0].id, first.id);
  dispose();
});

test('localizes annotation kinds and keeps large selections compact with a non-generating composer shortcut', async () => {
  const kinds = [
    ['SRC00011', 'highlight', '高亮'],
    ['SRC00012', 'underline', '下划线'],
    ['SRC00013', 'image', '区域批注'],
    ['SRC00014', 'ink', '手写批注'],
    ['SRC00015', 'text', '文本批注'],
    ['SRC00016', 'note', '独立笔记'],
  ];
  const entries = kinds.map(([id, kind], index) => record({
    id, itemKey: 'PAPER001', title: 'Paper One', kind, text: `Excerpt ${index + 1}.`, comment: '',
  }));
  const calls = [];
  const { host } = harness();
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials') return {
        scopeId: 'kinds', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Paper One', entries)], errors: [],
      };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  for (const [, , label] of kinds) assert.ok(host.textContent.includes(label), `missing localized type ${label}`);
  for (const raw of ['highlight', 'underline', 'image', 'ink', 'text']) assert.equal(host.textContent.includes(raw), false, `raw type leaked: ${raw}`);

  const paperHeading = all(host, node => node.className === 'rw-paper-heading')[0];
  const selectPaper = all(paperHeading, node => node.tagName === 'input')[0];
  selectPaper.checked = true;
  selectPaper.dispatch('change');
  assert.equal(all(host, node => node.className === 'rw-chip').length, 5);
  button(host, '展开另外 1 条').click();
  assert.equal(all(host, node => node.className === 'rw-chip').length, 6);
  button(host, '收起').click();
  assert.equal(all(host, node => node.className === 'rw-chip').length, 5);

  button(host, '整理所选材料').click();
  const composer = all(host, node => node.className === 'rw-composer')[0];
  assert.deepEqual(composer.scrollOptions, { behavior: 'smooth', block: 'start' });
  assert.deepEqual(composer.focusOptions, { preventScroll: true });
  assert.equal(calls.some(call => call.name === 'start_research_job'), false, 'shortcut must focus the composer without generating');
  dispose();
});

test('material cards keep comment attached to one source and grouping preserves selection, title, page, and tagged type', async () => {
  const highlighted = record({
    id: 'SRC00101', itemKey: 'PAPER001', title: 'First paper', text: 'A long source quote '.repeat(15),
    comment: 'Reader context.', color: '#ffd400', tags: [{ tag: '类型:研究方法' }], pageIndex: 2,
  });
  const unclassified = record({
    id: 'SRC00102', itemKey: 'PAPER002', title: 'Second paper', text: 'Figure annotation.',
    comment: '', kind: 'text', color: '#2ea8e5', pageIndex: 4,
  });
  const { document, host } = harness();
  document.defaultView.wbHighlightPresets = { annotationHighlightType };
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001', 'PAPER002'] },
    call: async name => {
      if (name === 'research_materials') return {
        scopeId: 'groups', total: 2, processed: 2, nextOffset: null,
        papers: [paper('PAPER001', 'First paper', [highlighted]), paper('PAPER002', 'Second paper', [unclassified])], errors: [],
      };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-record').length === 2);
  assert.equal(all(host, node => node.className === 'rw-record').length, 2, 'reader comments remain within the original annotation source');
  assert.ok(host.textContent.includes('高亮原文'));
  assert.ok(host.textContent.includes('原文批注'));
  assert.ok(host.textContent.includes('阅读者备注'));
  assert.equal(all(host, node => node.className === 'rw-long-text-preview').length, 2);
  const firstCard = all(host, node => node.className === 'rw-record' && node.textContent.includes('A long source quote'))[0];
  const firstCheckbox = all(firstCard, node => node.tagName === 'input')[0];
  firstCheckbox.checked = true;
  firstCheckbox.dispatch('change');
  button(host, '颜色').click();
  assert.ok(host.textContent.includes('黄色'));
  assert.ok(host.textContent.includes('蓝色'));
  button(host, '研究类型').click();
  assert.ok(host.textContent.includes('研究方法'));
  assert.ok(host.textContent.includes('未分类'));
  assert.equal(all(host, node => node.className === 'rw-chip').length, 1, 'switching grouping does not clear the selected source');
  const groupedFirstCard = all(host, node => node.className === 'rw-record' && node.textContent.includes('A long source quote'))[0];
  assert.equal(all(groupedFirstCard, node => node.tagName === 'input')[0].checked, true);
  assert.ok(groupedFirstCard.textContent.includes('First paper'));
  assert.ok(groupedFirstCard.textContent.includes('页标 3'));
  assert.ok(all(groupedFirstCard, node => node.tagName === 'button').some(node => node.textContent === '回到原文'));
  dispose();
});

test('reader selection, grouping, and view restore by scoped source fingerprint after remount', async () => {
  const storage = new MemoryStorage();
  const selectedSource = record({
    id: 'SRC00901', itemKey: 'PAPER001', title: 'First paper', text: 'A selected source excerpt.',
    comment: '', tags: [{ tag: '类型:研究方法' }],
  });
  const mountScope = (itemKey, source) => {
    const { host, document } = harness(storage);
    document.defaultView.wbHighlightPresets = { annotationHighlightType };
    const reads = [];
    const dispose = mountResearchWorkbench(host, {
      scope: { library: 'user', keys: [itemKey] },
      onRead: value => reads.push(value),
      call: async name => {
        if (name === 'research_materials') return {
          scopeId: `selection-${itemKey}`, total: 1, processed: 1, nextOffset: null,
          papers: [paper(itemKey, itemKey === 'PAPER001' ? 'First paper' : 'Second paper', [source])], errors: [],
        };
        throw new Error(`unexpected tool: ${name}`);
      },
    });
    return { host, reads, dispose };
  };

  const first = mountScope('PAPER001', selectedSource);
  await until(() => all(first.host, node => node.className === 'rw-record').length === 1);
  const firstCheckbox = all(all(first.host, node => node.className === 'rw-record')[0], node => node.tagName === 'input')[0];
  firstCheckbox.checked = true;
  firstCheckbox.dispatch('change');
  button(first.host, '研究类型').click();
  button(first.host, '回到原文').click();
  await until(() => first.reads.length === 1);
  button(first.host, '全文翻译').click();

  const persisted = [...storage.values.entries()].find(([key]) => key.endsWith(':reader-state'));
  assert.ok(persisted);
  const savedState = JSON.parse(persisted[1]);
  assert.deepEqual(savedState.selection, [{ id: selectedSource.id, fingerprint: selectedSource.fingerprint }]);
  assert.equal(persisted[1].includes(selectedSource.text), false, 'reader state stores identifiers and fingerprints, not source text');
  first.dispose();

  const restored = mountScope('PAPER001', selectedSource);
  await until(() => all(restored.host, node => node.className === 'rw-fold-paper-row').length === 1);
  assert.ok(button(restored.host, '全文翻译').className.includes('is-active'), 'the selected reader view is restored');
  button(restored.host, '我的标注').click();
  assert.equal(all(restored.host, node => node.className === 'rw-chip').length, 1);
  const restoredCheckbox = all(all(restored.host, node => node.className === 'rw-record')[0], node => node.tagName === 'input')[0];
  assert.equal(restoredCheckbox.checked, true);
  assert.ok(button(restored.host, '研究类型').className.includes('is-active'));
  restored.dispose();

  const changedSource = { ...selectedSource, fingerprint: 'changed-fingerprint' };
  const changed = mountScope('PAPER001', changedSource);
  await until(() => all(changed.host, node => node.className === 'rw-record').length === 1);
  assert.equal(all(changed.host, node => node.className === 'rw-chip').length, 0);
  assert.ok(changed.host.textContent.includes('来源已变化或不在当前范围，已取消这些选择。'));
  changed.dispose();

  const otherScope = mountScope('PAPER002', { ...selectedSource, itemKey: 'PAPER002', title: 'Second paper' });
  await until(() => all(otherScope.host, node => node.className === 'rw-record').length === 1);
  assert.equal(all(otherScope.host, node => node.className === 'rw-chip').length, 0, 'selection state is isolated by scope');
  assert.ok(button(otherScope.host, '文献').className.includes('is-active'));
  otherScope.dispose();
});

test('annotation auto-translation defaults on, batches at twenty, skips Chinese and does not auto-retry failed work', async () => {
  const batchRecords = Array.from({ length: 25 }, (_, index) => record({
    id: `SRC${String(index + 200).padStart(5, '0')}`, itemKey: 'PAPER001', title: 'Paper One',
    text: `An English excerpt number ${index + 1}.`, comment: index === 0 ? 'Private reader note.' : '',
  }));
  const japanese = record({ id: 'SRC00230', itemKey: 'PAPER001', title: 'Paper One', text: '研究方法の設計。', comment: '' });
  const korean = record({ id: 'SRC00231', itemKey: 'PAPER001', title: 'Paper One', text: '연구 방법 설계.', comment: '' });
  const chinese = record({ id: 'SRC00232', itemKey: 'PAPER001', title: 'Paper One', text: '教师评价的制度基础。', comment: '' });
  const mixed = record({ id: 'SRC00233', itemKey: 'PAPER001', title: 'Paper One', text: '教师 governance', comment: '' });
  const started = [];
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return {
        scopeId: 'translation-batch', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Paper One', [...batchRecords, japanese, korean, chinese, mixed])], errors: [],
      };
      if (name === 'start_research_job') {
        started.push(args);
        throw new Error('fixture start is intentionally unavailable');
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => started.length === 1, 'automatic annotation translation did not start');
  assert.equal(host.textContent.includes('停止自动对照'), true, 'automatic translation is enabled by default');
  assert.equal(host.textContent.includes('使用已配置的 Codex 模型'), true);
  assert.equal(started[0].kind, 'translate_annotations');
  assert.equal(started[0].sourceIds.length, 20, 'one model job only receives up to twenty excerpts');
  assert.equal(started[0].sourceVersions && Object.keys(started[0].sourceVersions).length, 20);
  assert.ok(started[0].keys.every(key => key === 'PAPER001'));
  assert.equal(JSON.stringify(started[0]).includes('Private reader note.'), false, 'comments are not passed to translation');
  assert.equal(started[0].sourceIds.includes(chinese.id), false, 'Chinese text is not sent for automatic translation');
  assert.equal(started[0].sourceIds.includes(mixed.id), false, 'Chinese mixed with terminology waits for manual review');
  button(host, '颜色').click();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started.length, 1, 'a failed batch is not retried by rerendering or changing groups');
  const remaining = Number(host.textContent.match(/待处理 (\d+) 条/)?.[1] || 0);
  assert.equal(remaining, 7);
  button(host, '继续翻译下一批（7 条）').click();
  await until(() => started.length === 2);
  assert.equal(started[1].sourceIds.length, 7);
  dispose();
});

test('automatic annotation translation serially continues from twenty to the final loaded record', async () => {
  const sources = Array.from({ length: 21 }, (_, index) => record({
    id: `SRC${String(index + 500).padStart(5, '0')}`, itemKey: 'PAPER001', title: 'Paper One',
    text: `An English passage ${index + 1}.`, comment: '',
  }));
  const starts = [];
  const jobs = new Map();
  let active = 0;
  let maxActive = 0;
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return {
        scopeId: 'translation-auto-21', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Paper One', sources)], errors: [],
      };
      if (name === 'start_research_job') {
        assert.equal(active, 0, 'the next batch must wait until the previous one is terminal');
        const id = `${starts.length + 1}`.repeat(24);
        starts.push(args);
        jobs.set(id, sources.filter(source => args.sourceIds.includes(source.id)));
        active += 1;
        maxActive = Math.max(maxActive, active);
        return { id, status: 'running' };
      }
      if (name === 'research_job') {
        const batch = jobs.get(args.id) || [];
        active -= 1;
        return { id: args.id, status: 'completed', result: {
          format: 'zotero-workbench/annotation-translations', version: 1, targetLanguage: 'zh-CN',
          translations: batch.map(source => ({
            sourceId: source.id, fingerprint: source.fingerprint, originalFingerprint: 'a'.repeat(64),
            original: source.text, translation: `中文对照 ${source.id}`, kind: source.kind, pageIndex: source.pageIndex,
          })),
          coverage: { complete: true, total: batch.length }, provenance: { translationVersion: 'zotero-workbench-zh-v1' },
        } };
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => host.textContent.includes('已译 21 条'), 'the automatic queue did not translate the full loaded scope');
  assert.deepEqual(starts.map(args => args.sourceIds.length), [20, 1]);
  assert.equal(maxActive, 1);
  assert.equal(host.textContent.includes('继续翻译下一批'), false, 'no manual continuation is needed after successful completion');
  dispose();
});

test('verification-required batches stop automatic continuation and keep explicit controls', async () => {
  const sources = Array.from({ length: 21 }, (_, index) => record({
    id: `SRC${String(index + 600).padStart(5, '0')}`, itemKey: 'PAPER001', title: 'Paper One',
    text: `An English passage ${index + 1}.`, comment: '',
  }));
  let starts = 0;
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return {
        scopeId: 'translation-verification-stop', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Paper One', sources)], errors: [],
      };
      if (name === 'start_research_job') { starts += 1; return { id: 'c'.repeat(24), status: 'running' }; }
      if (name === 'research_job') return { id: args.id, status: 'verification_required', stage: '来源待核验' };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => host.textContent.includes('待核验 20 条') && host.textContent.includes('重新核验'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(starts, 1, 'a source verification failure must not auto-continue or resubmit the batch');
  assert.ok(host.textContent.includes('继续翻译下一批（1 条）'), 'the remaining loaded source stays available for explicit continuation');
  dispose();
});

test('annotation translation ignores a late start response after the scope changes and cancels that job', async () => {
  let resolveStart;
  const calls = [];
  const oldRecord = record({ id: 'SRC00301', itemKey: 'PAPER001', title: 'Old paper', text: 'A foreign language excerpt.', comment: '' });
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials' && args.keys?.[0] === 'PAPER001') return {
        scopeId: 'old-translation-scope', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Old paper', [oldRecord])], errors: [],
      };
      if (name === 'research_materials' && args.keys?.[0] === 'PAPER002') return {
        scopeId: 'new-translation-scope', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER002', 'New paper', [record({ id: 'SRC00302', itemKey: 'PAPER002', title: 'New paper', text: '教师评价。', comment: '' })])], errors: [],
      };
      if (name === 'start_research_job') return new Promise(resolve => { resolveStart = resolve; });
      if (name === 'search_library') return { total: 1, items: [{ key: 'PAPER002', title: 'New paper' }] };
      if (name === 'cancel_research_job') return { id: args.id, status: 'cancelled' };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => typeof resolveStart === 'function');
  byClass(host, 'rw-scope-trigger')[0].click();
  await until(() => byClass(host, 'rw-scope-option').some(node => node.dataset.key === 'PAPER002'));
  byClass(host, 'rw-scope-option').find(node => node.dataset.key === 'PAPER002').click();
  await until(() => host.textContent.includes('教师评价。'));
  resolveStart({ id: 'f'.repeat(24), status: 'running' });
  await until(() => calls.some(call => call.name === 'cancel_research_job' && call.args.id === 'f'.repeat(24)));
  assert.equal(host.textContent.includes('Old paper'), false);
  assert.equal(host.textContent.includes('A foreign language excerpt.'), false);
  assert.equal(calls.filter(call => call.name === 'start_research_job').length, 1);
  dispose();
});

test('disposing the reader stops annotation polling without cancelling the active backend batch', async () => {
  const calls = [];
  const source = record({ id: 'SRC00311', itemKey: 'PAPER001', title: 'Paper One', text: 'A foreign language excerpt.', comment: '' });
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials') return {
        scopeId: 'dispose-translation', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Paper One', [source])], errors: [],
      };
      if (name === 'start_research_job') return { id: 'e'.repeat(24), status: 'running' };
      if (name === 'research_job') return { id: args.id, status: 'running' };
      if (name === 'cancel_research_job') return { id: args.id, status: 'cancelled' };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => calls.some(call => call.name === 'research_job' && call.args.id === 'e'.repeat(24)));
  dispose();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.some(call => call.name === 'cancel_research_job'), false, 'unmounting the UI must not cancel an already started batch');
  assert.equal(calls.filter(call => call.name === 'research_job').length, 1, 'unmounting stops further status polling');
});

test('annotation machine translation requires the exact version, source ID, fingerprint, and translation field', async () => {
  const source = record({ id: 'SRC00401', itemKey: 'PAPER001', title: 'Paper One', text: 'A checked English passage.', comment: 'Keep this reader note private.' });
  source.fingerprint = 'a'.repeat(64);
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return { scopeId: 'annotation-translation', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One', [source])], errors: [] };
      if (name === 'start_research_job') return { id: '7'.repeat(24), status: 'running' };
      if (name === 'research_job') return { id: args.id, status: 'completed', result: {
        format: 'zotero-workbench/annotation-translations', version: 1, targetLanguage: 'zh-CN',
        translations: [{
          sourceId: source.id, fingerprint: source.fingerprint, originalFingerprint: 'b'.repeat(64),
          original: source.text, translation: '这是一段已核验的中文对照。', kind: source.kind,
          pageIndex: source.pageIndex, page: source.pageIndex + 1,
        }],
        coverage: { complete: true, total: 1 }, provenance: { translationVersion: 'zotero-workbench-zh-v1' },
      } };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => host.textContent.includes('这是一段已核验的中文对照。'));
  assert.ok(host.textContent.includes('机器译文'));
  assert.ok(host.textContent.includes('A checked English passage.'));
  dispose();

  const staleSource = { ...source };
  const stale = harness(undefined, { autoTranslate: null });
  let starts = 0;
  const disposeStale = mountResearchWorkbench(stale.host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return { scopeId: 'stale-annotation-translation', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One', [staleSource])], errors: [] };
      if (name === 'start_research_job') { starts += 1; return { id: '6'.repeat(24), status: 'running' }; }
      if (name === 'research_job') return { id: args.id, status: 'completed', result: {
        format: 'zotero-workbench/annotation-translations', version: 1, targetLanguage: 'zh-CN',
        translations: [{ sourceId: staleSource.id, fingerprint: 'f'.repeat(64), originalFingerprint: 'b'.repeat(64), original: staleSource.text, translation: '不能展示的旧译文。', kind: staleSource.kind, pageIndex: staleSource.pageIndex }],
        coverage: { complete: true, total: 1 }, provenance: { translationVersion: 'zotero-workbench-zh-v1' },
      } };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => stale.host.textContent.includes('重试翻译'));
  assert.equal(stale.host.textContent.includes('不能展示的旧译文。'), false);
  button(stale.host, '颜色').click();
  assert.equal(starts, 1, 'stale cached results are not retried automatically');
  disposeStale();
});

test('annotation translations can reverify a saved job ID without starting another model task', async () => {
  const source = record({ id: 'SRC00402', itemKey: 'PAPER001', title: 'Paper One', text: 'A checked English passage.', comment: '' });
  source.fingerprint = 'c'.repeat(64);
  const calls = [];
  let starts = 0;
  const { host } = harness(undefined, { autoTranslate: null });
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials') return { scopeId: 'annotation-reverify', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One', [source])], errors: [] };
      if (name === 'start_research_job') { starts += 1; return { id: '5'.repeat(24), status: 'running' }; }
      if (name === 'research_job' && calls.filter(call => call.name === name).length === 1) {
        return { id: args.id, status: 'verification_required', stage: '来源待核验' };
      }
      if (name === 'research_job') return { id: args.id, status: 'completed', result: {
        format: 'zotero-workbench/annotation-translations', version: 1, targetLanguage: 'zh-CN',
        translations: [{
          sourceId: source.id, fingerprint: source.fingerprint, originalFingerprint: 'b'.repeat(64),
          original: source.text, translation: '重新核验后的中文对照。', kind: source.kind, pageIndex: source.pageIndex,
        }],
        coverage: { complete: true, total: 1 }, provenance: { translationVersion: 'zotero-workbench-zh-v1' },
      } };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.tagName === 'button' && node.textContent === '重新核验').length === 1);
  assert.ok(host.textContent.includes('来源待核验，暂不显示旧译文。'));
  assert.equal(starts, 1);
  button(host, '重新核验').click();
  await until(() => host.textContent.includes('重新核验后的中文对照。'));
  assert.equal(starts, 1, 'reverification must read the existing job, not start a new model task');
  const jobReads = calls.filter(call => call.name === 'research_job');
  assert.deepEqual(jobReads.map(call => call.args.id), ['5'.repeat(24), '5'.repeat(24)]);
  dispose();
});

test('TextFold labels all three AI-written levels and marks brief/full as source text', async () => {
  const { host } = harness();
  const item = paper('PAPER001', 'Paper One');
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return { scopeId: 'one', total: 1, processed: 1, nextOffset: null, papers: [item], errors: [] };
      if (name === 'start_research_job') return { id: 'b'.repeat(24), status: 'running' };
      if (name === 'research_job') return { id: args.id, status: 'completed', result: foldResult() };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  button(host, 'TextFold').click();
  button(host, 'AI 全文阅读并生成').click();
  await until(() => host.textContent.includes('AI topic'));
  assert.ok(host.textContent.includes('来源与任务信息'));
  assert.ok(host.textContent.includes('段落'));
  assert.equal(host.textContent.includes('paragraph'), false, 'unit kinds are localized too');
  assert.equal(all(host, node => node.className === 'rw-provenance')[0].open, false, 'technical provenance stays collapsed');

  button(host, '要点').click();
  assert.ok(all(host, node => node.className === 'rw-origin-label').some(node => node.textContent === 'AI 概括'));
  assert.equal(all(host, node => node.className === 'rw-origin-label').some(node => node.textContent === '原文句子'), false);

  button(host, '关键原句').click();
  assert.ok(all(host, node => node.className === 'rw-origin-label').some(node => node.textContent === '原文句子'));
  button(host, '全文').click();
  assert.ok(host.textContent.includes('Exact original sentence.'));
  dispose();
});

test('TextFold research guide separates AI summaries from quoted evidence and links evidence to its PDF page', async () => {
  const reads = [];
  const { host } = harness();
  const result = {
    ...foldResult(),
    researchGuide: {
      profileId: 'social-science-general', profileVersion: '1',
      researchQuestion: { items: [{ kind: 'author-claim', text: 'AI question summary.', evidence: [{ page: 2, quote: 'Exact question from the article.' }] }], gaps: [] },
      argument: { items: [{ kind: 'researcher-prompt', text: 'AI argument prompt.', basedOn: [{ page: 1, quote: 'Exact argument sentence from the paper.' }] }], gaps: [] },
      concepts: { items: [{ kind: 'researcher-prompt', text: 'AI concept note.', basedOn: [{ page: 1, quote: 'Concept evidence from the paper.' }] }], gaps: [] },
      methods: { items: [{ kind: 'researcher-prompt', text: 'AI method note.', basedOn: [{ page: 1, quote: 'Methods evidence from the paper.' }] }], gaps: [] },
      findings: { items: [{ kind: 'researcher-prompt', text: 'AI finding note.', basedOn: [{ page: 1, quote: 'Findings evidence from the paper.' }] }], gaps: [] },
      limitations: { items: [{ kind: 'researcher-prompt', text: 'AI boundary note.', basedOn: [{ page: 1, quote: 'Boundary evidence from the paper.' }] }], gaps: [] },
    },
  };
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    onRead: source => reads.push(source),
    call: async (name, args) => {
      if (name === 'research_materials') return { scopeId: 'guide', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One')], errors: [] };
      if (name === 'start_research_job') return { id: 'e'.repeat(24), status: 'running' };
      if (name === 'research_job') return { id: args.id, status: 'completed', result };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  button(host, 'TextFold').click();
  button(host, 'AI 全文阅读并生成').click();
  await until(() => host.textContent.includes('AI topic'));
  button(host, '研究导读').click();
  assert.ok(host.textContent.includes('AI question summary.'));
  assert.ok(host.textContent.includes('Exact question from the article.'));
  assert.ok(host.textContent.includes('AI 概括'));
  assert.ok(host.textContent.includes('原文证据'));
  assert.ok(host.textContent.includes('作者主张 · AI 整理'));
  assert.ok(host.textContent.includes('研究者提示 · AI 概括'));
  assert.ok(host.textContent.includes('方法'));
  const pageTwo = all(host, node => node.tagName === 'button' && node.textContent === 'PDF 第 2 页')[0];
  assert.ok(pageTwo);
  pageTwo.click();
  await until(() => reads.length === 1);
  assert.equal(reads[0].pageIndex, 1);
  assert.equal(reads[0].attachmentKey, 'PDF00001');
  dispose();
});

test('full translation keeps every source page, links back, copies only Chinese Markdown, and rejects incomplete coverage', async () => {
  const reads = [];
  const { document, host } = harness();
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    onRead: source => reads.push(source),
    call: async (name, args) => {
      if (name === 'research_materials') return { scopeId: 'translation-result', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One')], errors: [] };
      if (name === 'start_research_job') return { id: '9'.repeat(24), status: 'running' };
      if (name === 'research_job') return { id: args.id, status: 'completed', result: translationResult() };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  button(host, '全文翻译').click();
  button(all(host, node => node.className === 'rw-fold-paper-row')[0], '全文翻译').click();
  await until(() => host.textContent.includes('整页中文译文。'));
  assert.ok(host.textContent.includes('全文已译'));
  assert.ok(host.textContent.includes('Original page text.'));
  assert.ok(host.textContent.includes('PDF 来源指纹'));
  assert.ok(host.textContent.includes('a'.repeat(64)));
  button(host, '中文').click();
  assert.equal(host.textContent.includes('Original page text.'), false);
  assert.ok(host.textContent.includes('整页中文译文。'));
  button(host, '原文').click();
  assert.ok(host.textContent.includes('Original page text.'));
  assert.equal(host.textContent.includes('整页中文译文。'), false);
  button(host, '对照').click();
  button(host, '复制译文 Markdown').click();
  await until(() => document.clipboardWrites.length === 1);
  assert.ok(document.clipboardWrites[0].includes('整页中文译文。'));
  assert.equal(document.clipboardWrites[0].includes('Original page text.'), false, 'copy exports translation only');
  assert.ok(document.clipboardWrites[0].includes('[回到原文第 1 页]'));
  button(host, 'PDF 第 1 页').click();
  await until(() => reads.length === 1);
  assert.equal(reads[0].pageIndex, 0);
  assert.equal(reads[0].url, 'zotero://open-pdf/library/items/PDF00001?page=1');
  dispose();

  const incomplete = harness();
  const disposeIncomplete = mountResearchWorkbench(incomplete.host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      if (name === 'research_materials') return { scopeId: 'translation-incomplete', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One')], errors: [] };
      if (name === 'start_research_job') return { id: '8'.repeat(24), status: 'running' };
      if (name === 'research_job') return { id: args.id, status: 'completed', result: translationResult('PAPER001', { complete: false }) };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(incomplete.host, node => node.className === 'rw-paper').length === 1);
  button(incomplete.host, '全文翻译').click();
  button(all(incomplete.host, node => node.className === 'rw-fold-paper-row')[0], '全文翻译').click();
  await until(() => incomplete.host.textContent.includes('整篇已译'));
  assert.equal(incomplete.host.textContent.includes('全文已译'), false);
  assert.ok(incomplete.host.textContent.includes('结果未完整'));
  disposeIncomplete();
});

test('verification-required full translations clear stale results and stop polling until the same job is rechecked', async () => {
  const calls = [];
  let starts = 0;
  const { host } = harness();
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials') return { scopeId: 'translation-reverify', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One')], errors: [] };
      if (name === 'start_research_job') { starts += 1; return { id: '4'.repeat(24), status: 'running' }; }
      if (name === 'research_job') {
        const count = calls.filter(call => call.name === name).length;
        if (count === 1 || count === 3) return { id: args.id, status: 'completed', result: translationResult() };
        return { id: args.id, status: 'verification_required', stage: '来源待核验', error: '来源暂不可核验。' };
      }
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  button(host, '全文翻译').click();
  button(all(host, node => node.className === 'rw-fold-paper-row')[0], '全文翻译').click();
  await until(() => host.textContent.includes('整页中文译文。'));
  const saved = all(host, node => node.tagName === 'button' && node.className.split(' ').includes('rw-saved-job'))[0];
  assert.ok(saved);
  saved.click();
  await until(() => host.textContent.includes('来源待核验') && host.textContent.includes('重新核验'));
  assert.equal(host.textContent.includes('整页中文译文。'), false, 'a missing verified result must clear the prior in-memory translation');
  assert.equal(calls.filter(call => call.name === 'research_job').length, 2);
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(calls.filter(call => call.name === 'research_job').length, 2, 'verification_required is terminal for polling');
  button(host, '重新核验').click();
  await until(() => host.textContent.includes('整页中文译文。'));
  assert.equal(starts, 1, 'reverification must not rerun the model');
  assert.deepEqual(calls.filter(call => call.name === 'research_job').map(call => call.args.id), ['4'.repeat(24), '4'.repeat(24), '4'.repeat(24)]);
  dispose();
});

test('scope picker loads categories and searched literature as real material scopes', async () => {
  const requests = [];
  const opens = [];
  const { host } = harness();
  const dispose = mountResearchWorkbench(host, {
    onRead: source => opens.push(source),
    call: async (name, args) => {
      requests.push({ name, args });
      if (name === 'search_library') return {
        total: 1, items: [{ key: 'PAPER001', title: 'Selected Paper' }],
      };
      if (name === 'list_collections') return {
        library: 'user', collections: [{ key: 'COLL0001', name: '教育评价', parent: null, numItems: 3, numCollections: 0 }],
      };
      if (name === 'research_materials' && args.collection === 'COLL0001') return {
        scopeId: 'collection-scope', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Selected Paper', [record({ id: 'SRC00011', itemKey: 'PAPER001', title: 'Selected Paper', text: 'Collection material.', comment: '' })])], errors: [],
      };
      if (name === 'research_materials' && args.keys?.[0] === 'PAPER001') return {
        scopeId: 'paper-scope', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER001', 'Selected Paper', [record({ id: 'SRC00012', itemKey: 'PAPER001', title: 'Selected Paper', text: 'Paper material.', comment: '' })])], errors: [],
      };
      throw new Error(`unexpected tool: ${name}`);
    },
  });

  button(host, '个人文库 · 选择材料范围').click();
  await until(() => byClass(host, 'rw-scope-option').length > 0);
  button(host, '分类').click();
  await until(() => requests.some(request => request.name === 'list_collections'));
  await until(() => byClass(host, 'rw-scope-option').some(node => node.dataset.key === 'COLL0001'));
  byClass(host, 'rw-scope-option').find(node => node.dataset.key === 'COLL0001').click();
  await until(() => host.textContent.includes('Collection material.'));
  assert.deepEqual(requests.filter(request => request.name === 'research_materials').at(-1).args.collection, 'COLL0001');
  const selected = all(host, node => node.className === 'rw-record')[0];
  const checkbox = all(selected, node => node.tagName === 'input')[0];
  checkbox.checked = true;
  checkbox.dispatch('change');
  assert.equal(byClass(host, 'rw-chip').length, 1);

  const loadedRequestsBeforeCancel = requests.filter(request => request.name === 'research_materials').length;
  button(host, '个人文库 · 分类 教育评价').click();
  button(host, '文献').click();
  button(host, '取消').click();
  assert.ok(host.textContent.includes('Collection material.'), 'cancelling the picker keeps the current scope rendered');
  assert.equal(byClass(host, 'rw-chip').length, 1, 'cancelling the picker preserves the existing material selection');
  assert.equal(requests.filter(request => request.name === 'research_materials').length, loadedRequestsBeforeCancel);

  button(host, '个人文库 · 分类 教育评价').click();
  button(host, '文献').click();
  await until(() => requests.some(request => request.name === 'search_library'));
  const search = byClass(host, 'rw-scope-search-input')[0];
  assert.ok(search);
  search.value = 'Selected';
  search.dispatch('input');
  button(host, '搜索').click();
  await until(() => byClass(host, 'rw-scope-option').some(node => node.dataset.key === 'PAPER001'));
  byClass(host, 'rw-scope-option').find(node => node.dataset.key === 'PAPER001').click();
  await until(() => host.textContent.includes('Paper material.'));
  const paperRequest = requests.filter(request => request.name === 'research_materials').at(-1);
  assert.deepEqual(paperRequest.args.keys, ['PAPER001']);
  assert.equal(paperRequest.args.collection, undefined);
  assert.equal(byClass(host, 'rw-chip').length, 0, 'changing scope clears the previous material selection');
  assert.ok(requests.some(request => request.name === 'search_library' && request.args.query === 'Selected'));
  button(host, '打开文献').click();
  await until(() => opens.length === 1);
  assert.deepEqual(opens[0], {
    library: 'user', itemKey: 'PAPER001', url: 'zotero://select/library/items/PAPER001',
  });
  dispose();
});

test('changing material scope ignores a delayed page from the previous scope', async () => {
  let resolveOld;
  const requests = [];
  const { host } = harness();
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      requests.push({ name, args });
      if (name === 'research_materials' && args.keys?.[0] === 'PAPER001') {
        return new Promise(resolve => { resolveOld = resolve; });
      }
      if (name === 'search_library') return { total: 1, items: [{ key: 'PAPER002', title: 'New Paper' }] };
      if (name === 'research_materials' && args.keys?.[0] === 'PAPER002') return {
        scopeId: 'new-scope', total: 1, processed: 1, nextOffset: null,
        papers: [paper('PAPER002', 'New Paper', [record({ id: 'SRC00022', itemKey: 'PAPER002', title: 'New Paper', text: 'New scope result.', comment: '' })])], errors: [],
      };
      throw new Error(`unexpected tool: ${name}`);
    },
  });

  await until(() => typeof resolveOld === 'function');
  byClass(host, 'rw-scope-trigger')[0].click();
  await until(() => byClass(host, 'rw-scope-option').some(node => node.dataset.key === 'PAPER002'));
  byClass(host, 'rw-scope-option').find(node => node.dataset.key === 'PAPER002').click();
  await until(() => host.textContent.includes('New scope result.'));
  resolveOld({
    scopeId: 'old-scope', total: 1, processed: 1, nextOffset: null,
    papers: [paper('PAPER001', 'Old Paper', [record({ id: 'SRC00021', itemKey: 'PAPER001', title: 'Old Paper', text: 'Stale result.', comment: '' })])], errors: [],
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(host.textContent.includes('New scope result.'));
  assert.equal(host.textContent.includes('Stale result.'), false);
  assert.deepEqual(requests.filter(request => request.name === 'research_materials').map(request => request.args.keys), [['PAPER001'], ['PAPER002']]);
  dispose();
});

test('job recovery is bound to a scope with sorted keys, keeps job references, and ignores late page replies after dispose', async () => {
  const storage = new MemoryStorage();
  const shared = record({ id: 'SRC00003', itemKey: 'PAPER001', title: 'Paper One', text: 'Text.', comment: '' });
  const calls = [];
  const scopeCall = async (name, args) => {
    calls.push({ name, args });
    if (name === 'research_materials' && args.offset === 0) return { scopeId: 'scope', total: 2, processed: 1, nextOffset: 1, papers: [paper('PAPER001', 'Paper One', [shared])], errors: [] };
    if (name === 'research_materials' && args.offset === 1) return { scopeId: args.scopeId, total: 2, processed: 2, nextOffset: null, papers: [paper('PAPER002', 'Paper Two')], errors: [] };
    if (name === 'start_research_job') return { id: (args.kind === 'fold' ? 'c' : 'd').repeat(24), status: 'running' };
    if (name === 'research_job') return { id: args.id, status: 'running', stage: 'Working' };
    throw new Error(`unexpected tool: ${name}`);
  };

  let { host } = harness(storage);
  let dispose = mountResearchWorkbench(host, { scope: { library: 'user', keys: ['PAPER002', 'PAPER001'] }, call: scopeCall });
  await until(() => all(host, node => node.className === 'rw-paper').length >= 1);
  button(host, 'TextFold').click();
  button(host, 'AI 全文阅读并生成').click();
  await until(() => calls.some(call => call.name === 'research_job'));
  dispose();

  calls.length = 0;
  ({ host } = harness(storage));
  dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001', 'PAPER002'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials' && args.offset === 0) return { scopeId: 'scope', total: 2, processed: 1, nextOffset: 1, papers: [paper('PAPER001', 'Paper One', [shared])], errors: [] };
      if (name === 'research_materials' && args.offset === 1) return { scopeId: args.scopeId, total: 2, processed: 2, nextOffset: null, papers: [paper('PAPER002', 'Paper Two')], errors: [] };
      if (name === 'start_research_job') return { id: 'd'.repeat(24), status: 'running' };
      if (name === 'research_job' && args.id === 'c'.repeat(24)) return { id: args.id, status: 'completed', result: foldResult() };
      if (name === 'research_job' && args.id === 'd'.repeat(24)) return { id: args.id, status: 'completed', result: { title: 'Draft', sources: [shared], paragraphs: [{ text: 'Draft.', sourceIds: [shared.id] }], gaps: [] } };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => calls.some(call => call.name === 'research_job' && call.args.id === 'c'.repeat(24)));
  assert.equal(calls.some(call => call.name === 'start_research_job'), false);
  button(host, '我的标注').click();
  const sourceCard = all(host, node => node.className === 'rw-record' && node.textContent.includes('Text.'))[0];
  all(sourceCard, node => node.tagName === 'input')[0].checked = true;
  all(sourceCard, node => node.tagName === 'input')[0].dispatch('change');
  button(host, '根据所选材料生成').click();
  await until(() => all(host, node => node.className === 'rw-draft-paragraph').length === 1);
  const refs = [...storage.values.values()].map(value => JSON.parse(value)).filter(Array.isArray).flat();
  assert.deepEqual(refs.map(ref => [ref.id, ref.kind]).sort(), [
    ['c'.repeat(24), 'fold'], ['d'.repeat(24), 'draft'],
  ].sort());
  dispose();

  calls.length = 0;
  ({ host } = harness(storage));
  dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER003'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials') return { scopeId: 'other', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER003', 'Paper Three')], errors: [] };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  assert.equal(calls.some(call => call.name === 'research_job'), false, 'another document scope must not recover this result');
  dispose();

  let resolvePage;
  const pending = new Promise(resolve => { resolvePage = resolve; });
  let pageCalls = 0;
  ({ host } = harness(storage));
  dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER004'] },
    call: async name => { if (name === 'research_materials') { pageCalls += 1; return pending; } throw new Error('unexpected'); },
  });
  dispose();
  resolvePage({ scopeId: 'late', total: 2, processed: 1, nextOffset: 1, papers: [paper('PAPER004', 'Late paper')], errors: [] });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pageCalls, 1, 'a disposed view must not request the next page');
  assert.equal(host.textContent, '', 'a disposed view must not render a stale page');
});

test('switching saved TextFold and translation results does not rerun models or cancel another live job', async () => {
  const storage = new MemoryStorage();
  const calls = [];
  let starts = 0;
  const { host } = harness(storage);
  const dispose = mountResearchWorkbench(host, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'research_materials') return { scopeId: 'saved-results', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One')], errors: [] };
      if (name === 'start_research_job') {
        starts += 1;
        return { id: starts === 1 ? '1'.repeat(24) : starts === 2 ? '2'.repeat(24) : '3'.repeat(24), status: 'running' };
      }
      if (name === 'research_job' && args.id === '1'.repeat(24)) return { id: args.id, status: 'completed', result: foldResult() };
      if (name === 'research_job' && args.id === '2'.repeat(24)) return { id: args.id, status: 'completed', result: translationResult() };
      if (name === 'research_job' && args.id === '3'.repeat(24)) return { id: args.id, status: 'running', stage: '翻译中' };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(host, node => node.className === 'rw-paper').length === 1);
  const runFullTranslation = () => {
    button(host, '全文翻译').click();
    button(all(host, node => node.className === 'rw-fold-paper-row')[0], '全文翻译').click();
  };
  button(host, 'TextFold').click();
  button(host, 'AI 全文阅读并生成').click();
  await until(() => host.textContent.includes('AI topic'));
  runFullTranslation();
  await until(() => host.textContent.includes('整页中文译文。'));
  assert.ok(host.textContent.includes('全文已译'));
  assert.equal(all(host, node => node.className.split(' ').includes('rw-saved-job')).length, 2);
  all(host, node => node.dataset.jobId === '1'.repeat(24))[0].click();
  await until(() => host.textContent.includes('AI topic'));
  assert.equal(starts, 2, 'opening a saved result reads research_job and does not start another model job');
  assert.ok(all(host, node => node.className.split(' ').includes('rw-saved-job')).some(node => node.textContent.startsWith('全文翻译 · Paper One')));

  runFullTranslation();
  await until(() => calls.some(call => call.name === 'research_job' && call.args.id === '3'.repeat(24)));
  all(host, node => node.dataset.jobId === '1'.repeat(24))[0].click();
  await until(() => calls.filter(call => call.name === 'research_job' && call.args.id === '1'.repeat(24)).length >= 2);
  assert.equal(calls.some(call => call.name === 'cancel_research_job'), false, 'switching the visible result does not cancel an active task');
  assert.equal(host.textContent.includes('AI topic'), true);
  dispose();

  const restoredCalls = [];
  const { host: restoredHost } = harness(storage);
  const disposeRestored = mountResearchWorkbench(restoredHost, {
    scope: { library: 'user', keys: ['PAPER001'] },
    call: async (name, args) => {
      restoredCalls.push({ name, args });
      if (name === 'research_materials') return { scopeId: 'saved-results', total: 1, processed: 1, nextOffset: null, papers: [paper('PAPER001', 'Paper One')], errors: [] };
      if (name === 'research_job' && args.id === '1'.repeat(24)) return { id: args.id, status: 'completed', result: foldResult() };
      if (name === 'research_job' && args.id === '2'.repeat(24)) return { id: args.id, status: 'completed', result: translationResult() };
      if (name === 'research_job' && args.id === '3'.repeat(24)) return { id: args.id, status: 'running', stage: '翻译中' };
      throw new Error(`unexpected tool: ${name}`);
    },
  });
  await until(() => all(restoredHost, node => node.className.split(' ').includes('rw-saved-job')).length === 3);
  all(restoredHost, node => node.dataset.jobId === '1'.repeat(24))[0].click();
  await until(() => restoredHost.textContent.includes('AI topic'));
  assert.equal(restoredCalls.some(call => call.name === 'start_research_job'), false, 'refresh recovery reads the saved job without rerunning it');
  const savedTranslation = all(restoredHost, node => node.tagName === 'button' && node.className.split(' ').includes('rw-saved-job')
    && node.dataset.jobId === '2'.repeat(24))[0];
  assert.ok(savedTranslation, JSON.stringify(all(restoredHost, node => node.className.split(' ').includes('rw-saved-job')).map(node => node.textContent)));
  savedTranslation.click();
  assert.ok(restoredHost.textContent.includes('读取已保存结果'), 'saved result click should render its loading state');
  try {
    await until(() => restoredCalls.some(call => call.name === 'research_job' && call.args.id === '2'.repeat(24)), JSON.stringify(restoredCalls));
  } catch (error) {
    disposeRestored();
    throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!restoredHost.textContent.includes('整页中文译文。')) {
    const failure = JSON.stringify({ text: restoredHost.textContent, calls: restoredCalls });
    disposeRestored();
    assert.fail(failure);
  }
  assert.equal(restoredCalls.some(call => call.name === 'research_job' && call.args.id === '2'.repeat(24)), true, 'translation remains separately selectable after refresh');
  disposeRestored();
});
