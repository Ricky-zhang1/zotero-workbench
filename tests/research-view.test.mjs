import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountResearchWorkbench } from '../src/ui/research-view.js';

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
    this.defaultView = {
      localStorage: storage,
      navigator: { clipboard: { writeText: async () => {} } },
    };
  }
  createElement(tagName) { return new FakeNode(this, tagName); }
  createTextNode(value) { return new FakeNode(this, '#text', String(value)); }
}

function harness(storage) {
  const document = new FakeDocument(storage);
  return { document, host: document.createElement('div') };
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

async function until(predicate, message = 'condition did not become true') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function record({ id, itemKey, title, text, comment, pageIndex = 0, kind = 'highlight' }) {
  return {
    id, library: 'user', itemKey, title, key: `ANN${id.padEnd(5, '0')}`.slice(0, 8),
    attachmentKey: 'PDF00001', kind, text, comment, pageIndex, pageLabel: String(pageIndex + 1),
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
  const refs = [...storage.values.values()].map(value => JSON.parse(value)).flat();
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
