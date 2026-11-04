import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as wbHighlightPresets from '../src/ui/highlight-presets.js';

const root = new URL('../', import.meta.url);
const [workspaceSource, extensionSource, extensionCss, buildSource, pinnedPanel] = await Promise.all([
  readFile(new URL('src/ui/panel-workspace.js', root), 'utf8'),
  readFile(new URL('src/ui/panel-extension.js', root), 'utf8'),
  readFile(new URL('src/ui/panel-extension.css', root), 'utf8'),
  readFile(new URL('scripts/build.mjs', root), 'utf8'),
  readFile(new URL('vendor/zcode-zotero-0.2.1/dist/ui/panel.html', root), 'utf8'),
]);

const bridgeCalls = [];
const messageCalls = [];
let restoreCallError = null;
let contextUpdateError = null;
let prepareTrashHandler = null;
let trashHandler = null;
let prepareRestoreHandler = null;
let restoreHandler = null;
let openZoteroResult = { accepted: true, transport: 'operating-system' };
let openZoteroError = null;
let readerOperationsHandler = null;
let workbenchStateError = null;
let workbenchStatusHandler = null;
let researchMaterialsResponse = null;
let collaborationSessionResponse = null;
let collaborationFeedbackResponse = null;
let readAnnotationCommentHandler = null;
let updateAnnotationCommentHandler = null;
let readerAnnotationDocument = { annotations: [] };
const annotationResourceCache = new Map();
const readerAnnotationRefreshes = [];
const fakeTimers = new Map();
let fakeNow = 0;
let nextTimerId = 1;
function fakeSetTimeout(callback, delay) {
  const id = nextTimerId++;
  fakeTimers.set(id, { callback, dueAt: fakeNow + delay });
  return id;
}
function fakeClearTimeout(id) { fakeTimers.delete(id); }
function advanceTimers(milliseconds) {
  fakeNow += milliseconds;
  for (const [id, timer] of fakeTimers) {
    if (timer.dueAt <= fakeNow) {
      fakeTimers.delete(id);
      timer.callback();
    }
  }
}
const en = {
  canMessage: true,
  ready: async () => {},
  call: async (name, args) => {
    bridgeCalls.push({ name, args });
    if (name === 'prepare_reader_annotation_trash' && prepareTrashHandler) return prepareTrashHandler(args);
    if (name === 'trash_reader_annotation' && trashHandler) return trashHandler(args);
    if (name === 'prepare_reader_annotation_restore' && prepareRestoreHandler) return prepareRestoreHandler(args);
    if (name === 'open_in_zotero') {
      if (openZoteroError) throw openZoteroError;
      return openZoteroResult;
    }
    if (name === 'reader_annotation_operations')
      return readerOperationsHandler ? readerOperationsHandler(args) : { operations: [], total: 0, nextOffset: null, currentServerId: 'test-server' };
    if (name === 'workbench_state' && workbenchStateError) throw workbenchStateError;
    if (name === 'workbench_status' && workbenchStatusHandler) return workbenchStatusHandler();
    if (name === 'read_reader_annotation_comment')
      return readAnnotationCommentHandler ? readAnnotationCommentHandler(args) : { status: 'ready', ...args, comment: '', annotationVersion: 1, editable: true, editToken: 'e'.repeat(48), lastOperation: null };
    if (name === 'update_reader_annotation_comment')
      return updateAnnotationCommentHandler ? updateAnnotationCommentHandler(args) : { status: 'verified', verified: true, changed: true, ...args, comment: args.comment, annotationVersion: args.expectedVersion + 1, operationId: 'd'.repeat(64) };
    if (name === 'research_materials') return researchMaterialsResponse;
    if (name === 'collaboration_session') {
      if (args.action === 'list') return { sessions: [] };
      return collaborationSessionResponse;
    }
    if (name === 'collaboration_feedback') return collaborationFeedbackResponse;
    if (name === 'collaboration_read') return { readings: [] };
    if (name === 'trash_reader_annotation') return { status: 'verified', action: 'moved_to_trash', operationId: 'a'.repeat(64), annotationKey: 'ANN12345', restoreEntryAvailable: true };
    if (name === 'restore_reader_annotation') {
      if (restoreCallError) throw restoreCallError;
      if (restoreHandler) return restoreHandler(args);
      return { status: 'verified', action: 'restored_to_library', operationId: 'c'.repeat(64), annotationKey: 'ANN12345' };
    }
    if (name === 'reconcile_reader_annotation_operation') return { status: 'outcome-unknown', action: 'unresolved', operationId: args.operationId };
    return {};
  },
  openLink: async url => { bridgeCalls.push({ name: 'openLink', args: { url } }); return { accepted: true }; },
  readJson: async uri => { readerAnnotationRefreshes.push(uri); return structuredClone(readerAnnotationDocument); },
  updateModelContext: async (...args) => { if (contextUpdateError) throw contextUpdateError; messageCalls.push({ kind: 'context', args }); },
  sendMessage: async (...args) => { messageCalls.push({ kind: 'message', args }); },
};
const context = {
  ar: {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  },
  en,
  rr: { annotations: (library, attachmentKey) => `reader-annotations://${library}/${attachmentKey}` },
  wf: { get: uri => annotationResourceCache.get(uri) },
  Co: { tick: 4 },
  rl: value => { readerAnnotationRefreshes.push(value); },
  wbHighlightPresets,
  uiEvents: [],
  window: { matchMedia: () => ({ matches: true }), dispatchEvent: event => { context.uiEvents.push(event); return true; }, addEventListener: () => {}, removeEventListener: () => {} },
  Event: class { constructor(type) { this.type = type; } },
  CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  URL,
  navigator: { clipboard: { writeText: async text => { context.clipboardText = text; } } },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  console,
};
const plain = (value) => JSON.parse(JSON.stringify(value));
async function resetTrashState() {
  context.uiTest.wbReaderTrashInFlight.clear();
  context.uiTest.wbResetReaderTrashLedger();
  readerOperationsHandler = null;
  workbenchStateError = null;
  await en.setWidgetState({
    lastAnnotationTrashOperationIds: [], lastAnnotationTrashOperationId: null,
    lastAnnotationRestoreOperationId: null, annotationRestoreOperationIds: {},
    readerAnnotationTrashAttempts: {},
  });
}
vm.createContext(context);
vm.runInContext(`${workspaceSource}\n${extensionSource}\nglobalThis.uiTest = { wbConnectionSummary, wbStartConnectionStatusRequest, wbRankLabels, wbRankLevels, wbRankTone, wbRankBlock, wbInspectorItem, wbAnnotationSource, wbAnnotationPrompt, wbAddAnnotationContext, wbRefreshAnnotationContextComment, wbAddAnnotationContexts, wbAskAnnotation, wbRemoveAnnotationContext, wbClearAnnotationContext, wbContextSnapshot, wbContextKey, wbContextPayload, wbContextMetadata, wbSendAnnotationContextMessage, wbReadCollaborationMaterialRecords, wbCollaborationSourceSelectors, wbListCollaborationSessions, wbListCollaborationFeedback, wbLoadCollaborationSession, wbLoadCollaborationDraft, wbCollaborationDecisionLabel, wbCollaborationRangeLabel, wbCollaborationContextSources, wbCollaborationSourceStatus, wbCollaborationSourceReference, wbReplaceContextWithCollaborationSession, wbSetCollaborationContextSession, wbCollaborationFeedbackMessage, wbSendCollaborationFeedbackMessage, WorkbenchCollaboration, wbPrepareAnnotationTrash, wbConfirmAnnotationTrash, wbRememberTrashedAnnotation, wbTrackReaderTrashOperation, wbPrepareAnnotationRestore, wbConfirmAnnotationRestore, wbReconcileAnnotationOperation, wbTrashReaderAnnotationsBatch, wbRemoveReaderAnnotationOnce, wbUndoReaderAnnotationRemoval, wbReaderTrashOperationIds, wbReaderTrashAttempt, wbReaderTrashInFlight, wbSetReaderTrashLedgerOperations, wbReadReaderTrashOperations, wbResetReaderTrashLedger, wbReaderTrashLedgerOperation, wbSelectableReaderAnnotations, wbSelectedReaderAnnotations, wbSelectedReaderHighlights, wbReaderAnnotationSelectionToggle, wbReaderAnnotationSelectionForRoute, wbReaderAnnotationCopyText, wbCopyReaderAnnotations, wbReaderTrashErrorResult, wbReaderAnnotationCommentInFlight, wbReaderAnnotationCommentAttempts, wbReadReaderAnnotationComment, wbSaveReaderAnnotationComment, WorkbenchReaderAnnotationComment, wbOpenTarget, wbOpenTargetWithFeedback, WorkbenchAnnotationRestore, wbQueueItemOpen, wbCancelItemOpen };`, context);

function createHookHarness(component, initialProps) {
  const originalAr = context.ar;
  const slots = [];
  let cursor = 0;
  let props = initialProps;
  context.ar = {
    ...originalAr,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {},
  };
  return {
    render(nextProps = props) { props = nextProps; cursor = 0; return component(props); },
    restore() { context.ar = originalAr; },
  };
}
function treeText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(treeText).join('');
  return treeText(node.props?.children);
}
function findTreeNode(rootNode, predicate) {
  if (!rootNode) return null;
  if (Array.isArray(rootNode)) {
    for (const child of rootNode) { const found = findTreeNode(child, predicate); if (found) return found; }
    return null;
  }
  if (typeof rootNode !== 'object') return null;
  if (predicate(rootNode)) return rootNode;
  return findTreeNode(rootNode.props?.children, predicate);
}
async function resetAnnotationCommentHarness() {
  readAnnotationCommentHandler = null;
  updateAnnotationCommentHandler = null;
  readerAnnotationDocument = { annotations: [] };
  annotationResourceCache.clear();
  readerAnnotationRefreshes.length = 0;
  context.uiTest.wbReaderAnnotationCommentInFlight.clear();
  context.uiTest.wbReaderAnnotationCommentAttempts.clear();
  await context.uiTest.wbClearAnnotationContext();
}

test('connection indicator follows local Zotero API and treats external Zotero MCP as optional', () => {
  const disconnectedMcp = context.uiTest.wbConnectionSummary({
    zotero: { state: 'ready', writes: 'available' },
    mcp: { connected: false, error: 'fetch failed' },
    capabilities: {
      notesMetadataImport: 'local-api', evidenceHighlights: 'unavailable', semanticSearch: 'unavailable',
    },
  });
  assert.equal(disconnectedMcp.button, 'Zotero 已连接');
  assert.equal(disconnectedMcp.ready, true);
  assert.match(disconnectedMcp.optional, /可选 Zotero MCP 未连接/);
  assert.match(disconnectedMcp.optional, /AI 审计高亮、语义检索暂不可用/);
  assert.doesNotMatch(disconnectedMcp.optional, /标准笔记、元数据与单条导入暂不可用/);
  assert.match(disconnectedMcp.optional, /文库浏览、PDF 阅读、批注读取与引用导出仍可使用/);
  assert.equal(disconnectedMcp.highlights, '个人高亮：可直接保存（需要 Zotero 10 或更新版本）。');

  const mcpBackedWrites = context.uiTest.wbConnectionSummary({
    zotero: { state: 'ready', writes: 'unsupported' },
    mcp: { connected: false },
    capabilities: { notesMetadataImport: 'unavailable', evidenceHighlights: 'unavailable', semanticSearch: 'unavailable' },
  });
  assert.match(mcpBackedWrites.optional, /可选 Zotero MCP 未连接：AI 审计高亮、语义检索暂不可用/);
  assert.match(mcpBackedWrites.optional, /当前 Zotero 本地 API 只读，且没有完整旧版 MCP 写入通道：标准笔记、元数据与单条导入暂不可用/);

  const legacyWrites = context.uiTest.wbConnectionSummary({
    zotero: { state: 'ready', writes: 'unsupported' },
    mcp: { connected: true },
    capabilities: { notesMetadataImport: 'legacy-zotero-mcp', evidenceHighlights: 'audited-via-zotero-lattics', semanticSearch: 'upstream-quota' },
  });
  assert.match(legacyWrites.optional, /标准笔记、元数据与单条导入使用旧版 Zotero MCP/);
  assert.doesNotMatch(legacyWrites.optional, /标准笔记、元数据与单条导入暂不可用/);

  const localApiReadOnly = context.uiTest.wbConnectionSummary({
    zotero: { state: 'ready', writes: 'unsupported' },
    mcp: { connected: false },
    capabilities: { notesMetadataImport: 'read-only', evidenceHighlights: 'unavailable', semanticSearch: 'unavailable' },
  });
  assert.match(localApiReadOnly.optional, /当前 Zotero 本地 API 只读，且没有完整旧版 MCP 写入通道：标准笔记、元数据与单条导入暂不可用/);
  assert.match(localApiReadOnly.optional, /可选 Zotero MCP 未连接：AI 审计高亮、语义检索暂不可用/);

  const apiOff = context.uiTest.wbConnectionSummary({ zotero: { state: 'api_disabled' }, mcp: { connected: true } });
  assert.equal(apiOff.button, 'Zotero 未连接');
  assert.equal(apiOff.ready, false);
  assert.match(apiOff.local, /本地 API：未启用/);
  assert.equal(apiOff.highlights, '个人高亮：连接 Zotero 后检查可用性。');
  const readOnly = context.uiTest.wbConnectionSummary({ zotero: { state: 'ready', writes: 'unsupported' } });
  assert.equal(readOnly.highlights, '个人高亮：当前 Zotero 本地 API 只读。');
});

test('connection indicator remains pending when workbench status is missing or unknown', () => {
  for (const connection of [null, { zotero: { state: 'unknown' } }, { error: 'status unavailable' }]) {
    const summary = context.uiTest.wbConnectionSummary(connection);
    assert.equal(summary.ready, false);
    assert.equal(summary.button, '正在检测 Zotero');
    assert.match(summary.local, /正在检测/);
  }
});

test('authoritative Zotero status overrides stale workbench unknown while MCP state stays optional', () => {
  const summary=context.uiTest.wbConnectionSummary(
    {zotero:{state:'unknown',writes:'unknown'},mcp:{connected:false},capabilities:{semanticSearch:'unavailable'}},
    {state:'ready',writes:'available'},
  );
  assert.equal(summary.ready,true);
  assert.equal(summary.button,'Zotero 已连接');
  assert.equal(summary.highlights,'个人高亮：可直接保存（需要 Zotero 10 或更新版本）。');
  assert.match(summary.optional,/可选 Zotero MCP 未连接/);
  assert.match(summary.optional,/文库浏览、PDF 阅读、批注读取与引用导出仍可使用/);
  const stopped=context.uiTest.wbConnectionSummary(
    {zotero:{state:'ready',writes:'available'}},
    {state:'not_running',writes:'unknown'},
  );
  assert.equal(stopped.ready,false,'a definitive store disconnection overrides an old ready response');
  assert.equal(stopped.button,'Zotero 未连接');
});

test('connection status refresh discards an older response after a newer request starts', async () => {
  workbenchStatusHandler=()=>new Promise(resolve=>statusResolvers.push(resolve));
  const statusResolvers=[],generation={current:0},results=[],checking=[];
  const cancelOld=context.uiTest.wbStartConnectionStatusRequest(generation,value=>results.push(value),value=>checking.push(value));
  await new Promise(resolve=>setImmediate(resolve));
  const cancelNew=context.uiTest.wbStartConnectionStatusRequest(generation,value=>results.push(value),value=>checking.push(value));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(statusResolvers.length,2);
  statusResolvers[0]({zotero:{state:'unknown'}});
  statusResolvers[1]({zotero:{state:'ready',writes:'available'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(plain(results),[{zotero:{state:'ready',writes:'available'}}]);
  assert.equal(checking.at(-1),false);
  cancelOld();cancelNew();workbenchStatusHandler=null;
  assert.match(extensionSource,/\[store\.connected,store\.state\?\.status\?\.state,store\.state\?\.status\?\.writes\]/);
});

test('Zotero links use the app-only opener and opening feedback never claims the target was displayed', async () => {
  bridgeCalls.length = 0;
  context.uiEvents.length = 0;
  openZoteroResult = { accepted: true, transport: 'operating-system' };
  const zotero = await context.uiTest.wbOpenTargetWithFeedback('zotero://open-pdf/library/items/PDF00001');
  assert.equal(zotero.kind, 'zotero');
  assert.ok(bridgeCalls.some(call => call.name === 'open_in_zotero' && call.args.url === 'zotero://open-pdf/library/items/PDF00001'));
  assert.ok(!bridgeCalls.some(call => call.name === 'openLink'));
  assert.equal(context.uiEvents.at(-1).detail.message, '已请求 Zotero 打开原文。');

  const external = await context.uiTest.wbOpenTargetWithFeedback('https://example.org/source');
  assert.equal(external.kind, 'external');
  assert.ok(bridgeCalls.some(call => call.name === 'openLink' && call.args.url === 'https://example.org/source'));
  assert.equal((await context.uiTest.wbOpenTarget('http://example.org/source')).kind, 'external');
  await assert.rejects(context.uiTest.wbOpenTargetWithFeedback('file:///etc/passwd'), /仅支持 Zotero 回链或 HTTP\/HTTPS/);
  assert.equal(context.uiEvents.at(-1).detail.status, 'error');
});

test('rank badges preserve all server levels and combine tag-only fallback without dropping dual grades', () => {
  const levels = context.uiTest.wbRankLevels({
    journalLevels: [
      { id: 'cssci-ext', label: 'CSSCI 扩展版' },
      { id: 'jcr2', label: 'JCR Q2' },
    ],
    tags: ['北大核心；CSSCI扩展版；JCR Q2'],
  });
  assert.deepEqual(plain(levels.map((level) => level.label)), ['CSSCI 扩展版', 'JCR Q2', '北大核心']);
  assert.equal(context.uiTest.wbRankTone(levels[0]), 'cssci');
  assert.equal(context.uiTest.wbRankTone(levels[1]), 'jcr');
});

test('full item detail renders color-coded rank pills from Extra and Zotero tags', () => {
  const block = context.uiTest.wbRankBlock({
    fields: { extra: 'CSSCI扩展版\n北大核心' },
    tags: ['JCR Q2'],
  }, 'wb-detail-ranks');
  assert.equal(block.type, 'div');
  assert.equal(block.props.className, 'wb-ranks wb-detail-ranks');
  const pills = Array.isArray(block.props.children) ? block.props.children : [block.props.children];
  assert.deepEqual(pills.map(pill => pill.props.children), ['CSSCI 扩展版', '北大核心', 'JCR Q2']);
  assert.deepEqual(pills.map(pill => pill.props.className), [
    'wb-rank wb-rank--cssci', 'wb-rank wb-rank--core', 'wb-rank wb-rank--jcr',
  ]);
});

test('Extra rank parser rejects per-rank negative values without contaminating neighboring grades', () => {
  assert.deepEqual(plain(context.uiTest.wbRankLabels([
    'CSSCI/南大核心: 否', 'SSCI: 未收录', 'AMI: no', 'SCI: false', 'ESCI: 0',
    '中文核心期刊/北大核心: 否', 'CSSCI否；北大核心是', '中文核心期刊/北大核心: 是', 'CSSCI扩展版/北大核心:是',
  ].join('\n'))), ['CSSCI 扩展版', '北大核心']);
  assert.deepEqual(plain(context.uiTest.wbRankLabels('CSSCI: false; SSCI: no; JCR Q2; IF: 10')), ['JCR Q2', 'IF 10']);
  assert.deepEqual(plain(context.uiTest.wbRankLabels('中文标题: CSSCI期刊研究')), []);
});

test('inspector joins the outer inspect_item journalLevels field to the item', () => {
  const levels = [{ id: 'pku', label: '北大核心' }];
  const item = context.uiTest.wbInspectorItem({ item: { key: 'AB12CD34', fields: {} }, journalLevels: levels });
  assert.deepEqual(item.journalLevels, levels);
});

test('annotation context record retains library, item, attachment, annotation, page, quote, and comment', async () => {
  const source = context.uiTest.wbAnnotationSource(
    { key: 'ANN12345', type: 'highlight', color: '#5fb236', tags: [{ tag: '类型:研究方法' }], pageIndex: 4, text: '原文摘录', comment: '阅读者备注' },
    { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' },
  );
  assert.deepEqual(plain(source), {
    library: 'g12', itemKey: 'ITEM1234', title: 'ITEM1234', attachmentKey: 'PDF12345', annotationKey: 'ANN12345',
    annotationTypeId: 'research-method', annotationTypeLabel: '研究方法',
    pageIndex: 4, page: 5, url: 'zotero://open-pdf/groups/12/items/PDF12345?page=5&annotation=ANN12345', text: '原文摘录', comment: '阅读者备注',
  });
  assert.match(context.uiTest.wbAnnotationPrompt(source), /PDF 附件：PDF12345[\s\S]*研究类型：研究方法[\s\S]*物理页：5[\s\S]*Zotero 回链：zotero:\/\/open-pdf\/groups\/12[\s\S]*原文摘录：[\s\S]*阅读者备注：[\s\S]*阅读者备注/);
  await context.uiTest.wbAddAnnotationContext({ key: 'ANN12345', type:'highlight', tags:[{tag:'类型:研究方法'}], pageIndex: 4, text: '原文摘录', comment: '阅读者备注' }, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  assert.match(messageCalls.at(-1).args[0], /批注：ANN12345[\s\S]*物理页：5[\s\S]*原文摘录：[\s\S]*阅读者备注/);
  assert.equal(messageCalls.findLast(call => call.kind === 'context').args[1].zotero[0].url, source.url);
  assert.equal(messageCalls.findLast(call => call.kind === 'context').args[1].zotero[0].text, undefined);
  assert.equal(messageCalls.findLast(call => call.kind === 'context').args[1].zotero[0].comment, undefined);
  const unclassified=context.uiTest.wbAnnotationSource({key:'ANN12346',type:'highlight',color:'#5fb236',tags:[],pageIndex:0,text:'无标签高亮'},{library:'user',itemKey:'ITEM1234',attachmentKey:'PDF12345'});
  assert.equal(unclassified.annotationTypeLabel,'未分类','historical highlight color does not imply a research type');
  assert.match(context.uiTest.wbReaderAnnotationCopyText([{key:'ANN12346',type:'highlight',color:'#5fb236',tags:[],pageIndex:0,text:'无标签高亮'}],{library:'user',itemKey:'ITEM1234',attachmentKey:'PDF12345'}),/研究类型：未分类/);
  assert.match(messageCalls.findLast(call=>call.kind==='context').args[0],/研究类型：研究方法/);
  await context.uiTest.wbAskAnnotation('解释这条批注', { key: 'ANN12345', pageIndex: 4, text: '原文摘录', comment: '阅读者备注' }, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  assert.match(messageCalls.at(-1).args[0], /解释这条批注[\s\S]*批注：ANN12345[\s\S]*物理页：5[\s\S]*Zotero 回链：zotero:\/\/open-pdf\/groups\/12[\s\S]*原文摘录：[\s\S]*阅读者备注/);
  assert.throws(
    () => context.uiTest.wbAnnotationSource({ key: 'ANN12345', pageIndex: null }, { itemKey: 'ITEM1234', attachmentKey: 'PDF12345' }),
    /缺少条目、附件或物理页定位/,
  );
});

test('sidebar batch selection stays on the current PDF and copies full provenance without treating agent marks as Zotero annotations', async () => {
  const rows = [
    { kind: 'annotation', annotation: { key: 'ANN00001', type: 'highlight', pageIndex: 2, text: '摘录甲', comment: '备注甲' } },
    { kind: 'annotation', annotation: { key: 'ANN00002', type: 'note', pageIndex: 4, text: '摘录乙', comment: '' } },
    { kind: 'highlight', highlight: { id: 'AGENT001', pageIndex: 1, quote: '会话候选' } },
  ];
  const selected = context.uiTest.wbReaderAnnotationSelectionToggle(new Set(), 'ANN00001', true);
  assert.deepEqual(plain(context.uiTest.wbSelectableReaderAnnotations(rows).map(row => row.annotation.key)), ['ANN00001', 'ANN00002']);
  assert.deepEqual(plain(context.uiTest.wbReaderAnnotationSelectionForRoute(rows, selected, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' })), ['ANN00001']);
  assert.deepEqual(plain(context.uiTest.wbSelectedReaderHighlights(rows, selected).map(annotation => annotation.key)), ['ANN00001']);
  assert.deepEqual([...context.uiTest.wbReaderAnnotationSelectionToggle(selected, 'ANN00001', false)], []);

  const text = context.uiTest.wbReaderAnnotationCopyText([rows[0].annotation], {
    library: 'g12', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345',
  });
  assert.match(text, /当前文献[\s\S]*g12\/ITEM1234[\s\S]*PDF12345[\s\S]*物理页：3[\s\S]*zotero:\/\/open-pdf\/groups\/12[\s\S]*摘录甲[\s\S]*备注甲/);
  const copied = await context.uiTest.wbCopyReaderAnnotations([rows[0].annotation], { library: 'g12', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345' });
  assert.equal(copied.count, 1);
  assert.match(context.clipboardText, /物理页：3[\s\S]*摘录甲[\s\S]*备注甲/);
  const clipboard = context.navigator.clipboard;
  context.navigator.clipboard = null;
  await assert.rejects(context.uiTest.wbCopyReaderAnnotations([rows[0].annotation], { library: 'g12', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345' }), /无法访问剪贴板/);
  context.navigator.clipboard = clipboard;
  assert.match(buildSource, /setReaderSelection\(new Set\(\)\).*\[t\.library,t\.itemKey,t\.attachmentKey\]/);
  assert.match(buildSource, /type:"checkbox"[\s\S]*onClick:event=>event\.stopPropagation\(\)[\s\S]*onChange:event=>setReaderSelection/);
  assert.match(buildSource, /移除选中高亮 \(\$\{readerSelectedHighlights\.length\}\)/);
});

test('batch context update merges selected annotations in one full replacement', async () => {
  await context.uiTest.wbClearAnnotationContext();
  const route = { library: 'g12', itemKey: 'ITEM1234', title: '同一篇文献', attachmentKey: 'PDF12345' };
  await context.uiTest.wbAddAnnotationContext({ key: 'ANN00010', type: 'highlight', pageIndex: 0, text: '既有材料' }, route);
  const before = messageCalls.filter(call => call.kind === 'context').length;
  const result = await context.uiTest.wbAddAnnotationContexts([
    { key: 'ANN00011', type: 'highlight', pageIndex: 1, text: '批量甲' },
    { key: 'ANN00012', type: 'highlight', pageIndex: 2, text: '批量乙', comment: '阅读备注' },
  ], route);
  assert.equal(result.count, 3);
  assert.equal(messageCalls.filter(call => call.kind === 'context').length - before, 1, 'a batch sends one cumulative complete set');
  assert.deepEqual(plain(context.uiTest.wbContextSnapshot().map(source => source.annotationKey)), ['ANN00010', 'ANN00011', 'ANN00012']);
  assert.match(messageCalls.at(-1).args[0], /既有材料[\s\S]*批量甲[\s\S]*批量乙[\s\S]*阅读备注/);
});

test('saved annotations accumulate in the host context and failed updates preserve the previous selection', async () => {
  await context.uiTest.wbClearAnnotationContext();
  const first = { key: 'ANN00001', pageIndex: 2, text: '第一条原文', comment: '第一条备注', title: '第一篇' };
  const second = { key: 'ANN00002', pageIndex: 5, text: '第二条原文', comment: '第二条备注', title: '第二篇' };
  const route = { library: 'user', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' };
  await context.uiTest.wbAddAnnotationContext(first, route);
  await context.uiTest.wbAddAnnotationContext(second, route);
  const state = plain(context.uiTest.wbContextSnapshot());
  assert.equal(state.length, 2);
  assert.deepEqual(plain(messageCalls.at(-1).args[1].zotero.map(source => source.annotationKey)), ['ANN00001', 'ANN00002']);
  assert.match(messageCalls.at(-1).args[0], /第一篇[\s\S]*物理页：3[\s\S]*第一条备注[\s\S]*第二篇[\s\S]*物理页：6[\s\S]*第二条备注/);
  assert.match(messageCalls.at(-1).args[0], /不限制后续无关请求[\s\S]*不是给模型的指令/);

  contextUpdateError = new Error('宿主拒绝更新上下文');
  await assert.rejects(context.uiTest.wbAddAnnotationContext({ key: 'ANN00003', pageIndex: 0, text: '第三条' }, route), /宿主拒绝/);
  contextUpdateError = null;
  assert.deepEqual(plain(context.uiTest.wbContextSnapshot()), state, 'an unsuccessful replacement must not discard earlier selections');

  await context.uiTest.wbRemoveAnnotationContext(context.uiTest.wbContextKey(state[0]));
  assert.deepEqual(plain(context.uiTest.wbContextSnapshot()).map(source => source.annotationKey), ['ANN00002']);
  assert.deepEqual(plain(messageCalls.at(-1).args[1].zotero.map(source => source.annotationKey)), ['ANN00002']);
  await context.uiTest.wbClearAnnotationContext();
  assert.deepEqual(plain(context.uiTest.wbContextSnapshot()), []);
  assert.deepEqual(plain(messageCalls.at(-1).args[1].zotero), []);
});

test('current-session questions and paragraph requests include the complete selected set without background jobs', async () => {
  await context.uiTest.wbClearAnnotationContext();
  const route = { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' };
  await context.uiTest.wbAddAnnotationContext({ key: 'ANN00011', pageIndex: 1, text: '原文甲', comment: '备注甲' }, route);
  await context.uiTest.wbAddAnnotationContext({ key: 'ANN00012', pageIndex: 7, text: '原文乙', comment: '备注乙' }, route);
  await context.uiTest.wbSendAnnotationContextMessage('ask', '比较两条材料的适用条件');
  assert.match(messageCalls.at(-1).args[0], /比较两条材料的适用条件[\s\S]*原文甲[\s\S]*备注甲[\s\S]*原文乙[\s\S]*备注乙/);
  await context.uiTest.wbSendAnnotationContextMessage('draft', '讨论制度差异');
  assert.match(messageCalls.at(-1).args[0], /标注对应的展示编号/);
  assert.match(messageCalls.at(-1).args[0], /讨论制度差异[\s\S]*原文甲[\s\S]*原文乙/);
  assert.match(messageCalls.at(-1).args[0], /不写入 Zotero/);
  assert.equal(bridgeCalls.some(call => call.name === 'research_job'), false);
  await context.uiTest.wbClearAnnotationContext();
});

test('oversized context is rejected without truncation or loss of the prior selected set', async () => {
  await context.uiTest.wbClearAnnotationContext();
  const route = { library: 'user', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' };
  await context.uiTest.wbAddAnnotationContext({ key: 'ANN00021', pageIndex: 1, text: 'a'.repeat(21000), comment: '' }, route);
  const before = plain(context.uiTest.wbContextSnapshot());
  const callCount = messageCalls.filter(call => call.kind === 'context').length;
  await assert.rejects(context.uiTest.wbAddAnnotationContext({ key: 'ANN00022', pageIndex: 2, text: 'b'.repeat(21000), comment: '' }, route), /超过 40,000 字符/);
  assert.deepEqual(plain(context.uiTest.wbContextSnapshot()), before);
  assert.equal(messageCalls.filter(call => call.kind === 'context').length, callCount, 'oversized replacement must not reach the host');
  await context.uiTest.wbClearAnnotationContext();
});

test('persistent collaboration source selection uses the live Zotero fingerprint and rejects changed visible text', async () => {
  const visible = {
    library: 'g12', itemKey: 'ITEM1234', title: '来源文献', attachmentKey: 'PDF12345', annotationKey: 'ANN12345',
    pageIndex: 4, page: 5, url: 'zotero://open-pdf/groups/12/items/PDF12345?page=5', text: '可回看的原文', comment: '研究者备注',
  };
  researchMaterialsResponse = {
    scopeId: 'd'.repeat(24), library: 'g12', total: 1, processed: 1, nextOffset: null, errors: [], incomplete: false,
    papers: [{ itemKey: 'ITEM1234', title: '来源文献', errors: [], records: [{
      id: 'a'.repeat(16), library: 'g12', itemKey: 'ITEM1234', title: '来源文献', key: 'ANN12345', attachmentKey: 'PDF12345',
      kind: 'highlight', pageIndex: 4, text: '可回看的原文', comment: '研究者备注', fingerprint: 'b'.repeat(64),
    }] }],
  };
  const selectors = await context.uiTest.wbCollaborationSourceSelectors([visible]);
  assert.deepEqual(plain(selectors), [{
    library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345', annotationKey: 'ANN12345', fingerprint: 'b'.repeat(64),
  }]);
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'research_materials', args: { library: 'g12', keys: ['ITEM1234'], limit: 10, offset: 0 },
  });

  researchMaterialsResponse.papers[0].records[0].text = 'Zotero 中已变化的原文';
  await assert.rejects(context.uiTest.wbCollaborationSourceSelectors([visible]), /原文、备注或页码与当前显示内容不一致/);
});

test('session restore reads feedback at the matching revision and loads a selected full draft snapshot explicitly', async () => {
  const sessionId = 'c'.repeat(24);
  const draftId = 'd'.repeat(24);
  collaborationSessionResponse = { session: {
    id: sessionId, revision: 7, title: '教师职业吸引力', projectPath: null, sources: [],
    drafts: [{ id: draftId, revision: 6, title: '摘要，不含正文', contentIncluded: false }],
    draftSummaries: [{ id: draftId, revision: 6, title: '第一稿', paragraphCount: 1, claimCount: 1 }],
    readings: [],
  } };
  collaborationFeedbackResponse = { id: sessionId, revision: 7, total: 0, nextOffset: null, feedback: [] };
  const restored = await context.uiTest.wbLoadCollaborationSession(sessionId);
  assert.equal(restored.session.revision, 7);
  assert.equal(restored.session.draftSummaries[0].id, draftId);
  assert.deepEqual(plain(restored.readings), []);

  const snapshotSource = {
    id: 'a'.repeat(16), library: 'user', itemKey: 'ITEM1234', key: 'ANN12345', attachmentKey: 'PDF12345',
    title: '历史来源', kind: 'highlight', pageIndex: 3, text: '历史摘录', comment: '历史备注',
    fingerprint: 'b'.repeat(64), url: 'zotero://open-pdf/library/items/PDF12345?page=4', stale: false,
  };
  collaborationSessionResponse = { session: {
    id: sessionId, revision: 7, title: '教师职业吸引力', sources: [],
    drafts: [{ id: draftId, revision: 6, title: '第一稿', sources: [snapshotSource], paragraphs: [{
      id: 'p1', text: '有来源的段落。', sourceIds: [snapshotSource.id], claims: [{ id: 'claim1', text: '有来源的论断。', sourceIds: [snapshotSource.id] }],
    }] }],
    draftSummaries: [{ id: draftId, revision: 6, title: '第一稿', paragraphCount: 1, claimCount: 1 }],
  } };
  collaborationFeedbackResponse = { id: sessionId, revision: 7, total: 0, nextOffset: null, feedback: [] };
  const detail = await context.uiTest.wbLoadCollaborationDraft(sessionId, draftId, 7);
  assert.equal(detail.draft.paragraphs[0].text, '有来源的段落。');
  assert.equal(detail.draft.sources[0].text, '历史摘录');
  assert.deepEqual(plain(bridgeCalls.filter(call => call.name === 'collaboration_session').at(-1).args), {
    action: 'get', id: sessionId, draftId,
  });
});

test('restoring a session replaces the full chat context only after host success and preserves old context on failure', async () => {
  await context.uiTest.wbClearAnnotationContext();
  const oldSource = { key: 'ANN00031', pageIndex: 1, text: '当前材料', comment: '当前备注' };
  await context.uiTest.wbAddAnnotationContext(oldSource, { library: 'user', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  const before = plain(context.uiTest.wbContextSnapshot());
  const session = { id: 'e'.repeat(24), sources: [{
    id: 'a'.repeat(16), library: 'user', itemKey: 'ITEM1234', key: 'ANN12345', attachmentKey: 'PDF12345',
    title: '恢复来源', kind: 'highlight', pageIndex: 4, text: '恢复后的原文', comment: '恢复备注',
    fingerprint: 'b'.repeat(64), url: 'zotero://open-pdf/library/items/PDF12345?page=5', stale: false,
  }] };
  contextUpdateError = new Error('宿主拒绝更新上下文');
  await assert.rejects(context.uiTest.wbReplaceContextWithCollaborationSession(session), /宿主拒绝/);
  assert.deepEqual(plain(context.uiTest.wbContextSnapshot()), before);
  contextUpdateError = null;
  const applied = await context.uiTest.wbReplaceContextWithCollaborationSession(session);
  assert.equal(applied.count, 1);
  assert.match(messageCalls.filter(call => call.kind === 'context').at(-1).args[0], /恢复来源[\s\S]*恢复后的原文[\s\S]*恢复备注/);
  assert.equal(messageCalls.filter(call => call.kind === 'context').at(-1).args[1].collaborationSessionId, session.id);
  const metadataSource = plain(messageCalls.filter(call => call.kind === 'context').at(-1).args[1].zotero[0]);
  assert.equal(metadataSource.id, session.sources[0].id);
  assert.equal(metadataSource.fingerprint, session.sources[0].fingerprint);
  assert.equal(metadataSource.text, undefined);
  assert.equal(metadataSource.comment, undefined);
  await context.uiTest.wbClearAnnotationContext();
});

test('human feedback handoff names the exact draft, claim, decision, and source identity', async () => {
  const source = { id: 'a'.repeat(16), title: '历史来源', itemKey: 'ITEM1234', key: 'ANN12345', library: 'user', url: 'zotero://open-pdf/library/items/PDF12345?page=4' };
  const message = context.uiTest.wbCollaborationFeedbackMessage(
    { id: 'c'.repeat(24), title: '协作会话' },
    { id: 'd'.repeat(24), revision: 3, title: '初稿', sources: [source] },
    { claimId: 'claim-1', text: '论断内容', sourceIds: [source.id] },
    { decision: 'needs_revision', comment: '只支持其中一部分', sourceIds: [source.id], revision: 9 },
  );
  assert.match(message, /初稿/);
  assert.match(message, /论断 claim-1/);
  assert.match(message, /研究者判断：部分支持/);
  assert.match(message, /只支持其中一部分/);
  assert.match(message, /sourceId a{16}/);
  assert.match(message, /zotero:\/\/open-pdf/);
  assert.equal(context.uiTest.wbCollaborationDecisionLabel('unclear'), '待核');
  assert.equal(context.uiTest.wbCollaborationDecisionLabel('contradicts'), '不支持');
  assert.equal(context.uiTest.wbCollaborationRangeLabel([[1, 3], [5, 5]]), '第 1–3 页、第 5 页');
});

test('historical draft source links remain openable while changed or unreadable snapshots are explicitly marked', () => {
  const source = { id: 'a'.repeat(16), title: '历史来源', pageIndex: 3, stale: true, staleReason: 'fingerprint_changed' };
  const changed = context.uiTest.wbCollaborationSourceReference({
    source, url: 'zotero://open-pdf/library/items/PDF12345?page=4', label: '历史来源', page: ' · PDF 第 4 页', onOpen() {},
  });
  const changedText = JSON.stringify(plain(changed));
  assert.match(changedText, /在 Zotero 中打开 历史来源/);
  assert.match(changedText, /原摘录已变化，请核对/);
  assert.match(changedText, /role":"status/);

  const unreadable = context.uiTest.wbCollaborationSourceReference({
    source: { ...source, staleReason: 'read_failed' }, url: source.url, label: '历史来源', page: '', onOpen() {},
  });
  assert.match(JSON.stringify(plain(unreadable)), /当前不可读取，请核对/);
  assert.equal(context.uiTest.wbCollaborationSourceStatus({ stale: false }), '来源版本一致');
  const current = context.uiTest.wbCollaborationSourceReference({ source: { ...source, stale: false }, url: source.url, label: '历史来源', onOpen() {} });
  assert.match(JSON.stringify(plain(current)), /来源版本一致/);
});

test('collaboration page presents selected-source count, page, quote, comment, removal and current-session actions', () => {
  const tree = context.uiTest.WorkbenchCollaboration({ sources: [{
    library: 'user', itemKey: 'ITEM1234', title: '来源文献', attachmentKey: 'PDF12345', annotationKey: 'ANN12345',
    page: 5, pageIndex: 4, text: '可回看的原文', comment: '研究者备注', url: 'zotero://open-pdf/library/items/PDF12345?page=5',
  }] });
  const collect = node => {
    if (node == null) return [];
    if (Array.isArray(node)) return node.flatMap(collect);
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    return [node.props?.className || '', node.props?.['aria-label'] || '', node.props?.children].flatMap(collect);
  };
  const rendered = collect(tree).join(' ');
  assert.match(rendered, /会话协作[\s\S]*1 条/);
  assert.match(rendered, /来源文献[\s\S]*PDF 第 5 页[\s\S]*可回看的原文[\s\S]*研究者备注/);
  assert.match(rendered, /在 Zotero 中打开 来源文献 PDF 第 5 页/);
  assert.match(rendered, /移除\s+来源文献\s+的材料/);
  assert.match(rendered, /向当前会话提问[\s\S]*基于选择写段落/);
  assert.match(rendered, /新建协作会话[\s\S]*恢复所选会话/);
});

test('annotation trash preview is not hidden by a stale startup connection state and still requires confirmation', async () => {
  await resetTrashState();
  await context.uiTest.wbPrepareAnnotationTrash({ key: 'ANN12345', pageIndex: 4 }, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'prepare_reader_annotation_trash',
    args: { library: 'g12', annotationKey: 'ANN12345', attachmentKey: 'PDF12345' },
  });
  await assert.rejects(context.uiTest.wbConfirmAnnotationTrash({ previewToken: 'a'.repeat(48), restorable: true, action: 'move_to_trash' }), /预览无效/);
  trashHandler=async()=>({status:'verified',action:'moved_to_trash',operationId:'c'.repeat(64),annotationKey:'ANN12345',restoreEntryAvailable:true});
  await context.uiTest.wbConfirmAnnotationTrash({ previewToken: 'b'.repeat(48), operationId: 'c'.repeat(64), requiresConfirmation: true, restorable: true, action: 'move_to_trash', annotation:{key:'ANN12345',library:'g12',attachmentKey:'PDF12345'} });
  trashHandler=null;
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'trash_reader_annotation', args: { previewToken: 'b'.repeat(48), confirmWrite: true },
  });
  assert.equal(en.widgetState.lastAnnotationTrashOperationId, 'c'.repeat(64), 'operation number is persisted before the confirmed write');
});

test('single removal is one explicit click that prepares, commits once, and keeps the original key undoable', async () => {
  await resetTrashState();
  const route={library:'g12',itemKey:'ITEM1234',attachmentKey:'PDF12345',title:'测试文献'};
  const annotation={key:'ANN10001',type:'highlight',pageIndex:3,text:'原文',comment:'备注'};
  const operationId='1'.repeat(64),previewToken='2'.repeat(48);
  let prepareCount=0,commitCount=0,commitArgs;
  prepareTrashHandler=async args=>{
    prepareCount++;
    assert.deepEqual(plain(args),{library:'g12',annotationKey:'ANN10001',attachmentKey:'PDF12345'});
    return {status:'previewed',action:'move_to_trash',requiresConfirmation:true,restorable:true,previewToken,operationId,
      annotation:{key:annotation.key,library:route.library,attachmentKey:route.attachmentKey}};
  };
  trashHandler=async args=>{
    commitCount++;commitArgs=args;
    return {status:'verified',action:'moved_to_trash',operationId,annotationKey:annotation.key,restoreEntryAvailable:true};
  };
  const result=await context.uiTest.wbRemoveReaderAnnotationOnce(annotation,route);
  assert.equal(result.operationId,operationId);
  assert.equal(prepareCount,1);
  assert.equal(commitCount,1);
  assert.deepEqual(plain(commitArgs),{previewToken,confirmWrite:true});
  assert.deepEqual(plain(context.uiTest.wbReaderTrashOperationIds()),[operationId]);
  assert.equal(context.uiTest.wbReaderTrashAttempt(annotation,route).status,'verified');
  readerOperationsHandler=async()=>({operations:[{operationId,status:'verified',library:route.library,annotationKey:annotation.key,attachmentKey:route.attachmentKey,restoreEntryAvailable:true,serverMatch:'current'}],total:1,nextOffset:null,currentServerId:'test-server'});
  await context.uiTest.wbRemoveReaderAnnotationOnce(annotation,route);
  assert.equal(prepareCount,1,'a duplicate click uses the recorded result and does not prepare or commit again');
  assert.equal(commitCount,1);
  prepareTrashHandler=null;trashHandler=null;
});

test('single and batch removal share one in-flight preflight and commit per target', async () => {
  await resetTrashState();
  const route={library:'g12',itemKey:'ITEM1234',attachmentKey:'PDF12345'};
  const annotation={key:'ANN10002',type:'highlight',pageIndex:2,text:'同一条'};
  const operationId='8'.repeat(64),previewToken='9'.repeat(48);
  let prepareCount=0,commitCount=0,releasePrepare;
  prepareTrashHandler=async()=>{
    prepareCount++;
    return new Promise(resolve=>{releasePrepare=()=>resolve({status:'previewed',action:'move_to_trash',requiresConfirmation:true,restorable:true,previewToken,operationId,annotation:{key:annotation.key,library:route.library,attachmentKey:route.attachmentKey}});});
  };
  trashHandler=async()=>{commitCount++;return {status:'verified',action:'moved_to_trash',operationId,annotationKey:annotation.key,restoreEntryAvailable:true};};
  const single=context.uiTest.wbRemoveReaderAnnotationOnce(annotation,route);
  const batch=context.uiTest.wbTrashReaderAnnotationsBatch([annotation],route);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prepareCount,1,'the second UI surface joins the first target promise');
  releasePrepare();
  const [singleResult,batchResult]=await Promise.all([single,batch]);
  assert.equal(singleResult.operationId,operationId);
  assert.deepEqual(plain(batchResult.map(result=>result.status)),['verified']);
  assert.equal(prepareCount,1);
  assert.equal(commitCount,1);
  prepareTrashHandler=null;trashHandler=null;
});

test('a failed no-write preflight can be explicitly retried on the next click', async () => {
  await resetTrashState();
  const route={library:'g12',itemKey:'ITEM1234',attachmentKey:'PDF12345'};
  const annotation={key:'ANN10003',type:'highlight',pageIndex:0,text:'预检暂时失败'};
  const operationId='a'.repeat(64),previewToken='b'.repeat(48);
  let prepareCount=0,commitCount=0;
  prepareTrashHandler=async()=>{
    prepareCount++;
    if(prepareCount===1)throw new Error('预检暂时失败；尚未提交修改。');
    return {status:'previewed',action:'move_to_trash',requiresConfirmation:true,restorable:true,previewToken,operationId,
      annotation:{key:annotation.key,library:route.library,attachmentKey:route.attachmentKey}};
  };
  trashHandler=async()=>{commitCount++;return {status:'verified',action:'moved_to_trash',operationId,annotationKey:annotation.key,restoreEntryAvailable:true};};
  const first=await context.uiTest.wbTrashReaderAnnotationsBatch([annotation],route);
  assert.equal(first[0].status,'failed');
  assert.equal(first[0].blocked,false);
  assert.equal(context.uiTest.wbReaderTrashAttempt(annotation,route),null);
  const second=await context.uiTest.wbTrashReaderAnnotationsBatch([annotation],route);
  assert.equal(second[0].status,'verified');
  assert.equal(prepareCount,2);
  assert.equal(commitCount,1);
  prepareTrashHandler=null;trashHandler=null;
});

test('failed critical prewrite tracking stops before submitting the Zotero write', async () => {
  await resetTrashState();
  const route={library:'g12',itemKey:'ITEM1234',attachmentKey:'PDF12345'};
  const annotation={key:'ANN10004',type:'highlight',pageIndex:0,text:'台账预写失败'};
  const operationId='f'.repeat(64),previewToken='e'.repeat(48);
  let commitCount=0;
  prepareTrashHandler=async()=>({status:'previewed',action:'move_to_trash',requiresConfirmation:true,restorable:true,previewToken,operationId,
    annotation:{key:annotation.key,library:route.library,attachmentKey:route.attachmentKey}});
  trashHandler=async()=>{commitCount++;return {status:'verified',action:'moved_to_trash',operationId,annotationKey:annotation.key,restoreEntryAvailable:true};};
  workbenchStateError=new Error('工作台操作状态暂不可保存');
  await assert.rejects(context.uiTest.wbRemoveReaderAnnotationOnce(annotation,route),/工作台操作状态暂不可保存/);
  assert.equal(commitCount,0,'the explicit Zotero write is not sent when critical prewrite tracking fails');
  assert.equal(context.uiTest.wbReaderTrashAttempt(annotation,route),null);
  workbenchStateError=null;prepareTrashHandler=null;trashHandler=null;
});

test('an unclassified transport error after submit becomes unknown and is never replayed', async () => {
  await resetTrashState();
  const route={library:'g12',itemKey:'ITEM1234',attachmentKey:'PDF12345'};
  const annotation={key:'ANN10005',type:'highlight',pageIndex:1,text:'连接中断'};
  const operationId='0'.repeat(64),previewToken='1'.repeat(48);
  let prepareCount=0,commitCount=0;
  prepareTrashHandler=async()=>{
    prepareCount++;
    return {status:'previewed',action:'move_to_trash',requiresConfirmation:true,restorable:true,previewToken,operationId,
      annotation:{key:annotation.key,library:route.library,attachmentKey:route.attachmentKey}};
  };
  trashHandler=async()=>{commitCount++;throw new Error('connection reset');};
  await assert.rejects(context.uiTest.wbRemoveReaderAnnotationOnce(annotation,route),/结果尚不确定/);
  assert.equal(context.uiTest.wbReaderTrashAttempt(annotation,route).status,'outcome-unknown');
  readerOperationsHandler=async()=>({operations:[{operationId,status:'outcome-unknown',library:route.library,annotationKey:annotation.key,attachmentKey:route.attachmentKey,restoreEntryAvailable:false}],total:1,nextOffset:null,currentServerId:'test-server'});
  await assert.rejects(context.uiTest.wbRemoveReaderAnnotationOnce(annotation,route),/不会重试/);
  assert.equal(prepareCount,1);
  assert.equal(commitCount,1);
  prepareTrashHandler=null;trashHandler=null;
});

test('batch removal preserves partial outcomes, blocks unknown replay, and one-click undo keeps each operation separate', async () => {
  await resetTrashState();
  const route={library:'g12',itemKey:'ITEM1234',attachmentKey:'PDF12345'};
  const first={key:'ANN20001',type:'highlight',pageIndex:1,text:'第一条'};
  const second={key:'ANN20002',type:'highlight',pageIndex:4,text:'第二条'};
  const operationIds={ANN20001:'3'.repeat(64),ANN20002:'4'.repeat(64)};
  const tokens={ANN20001:'5'.repeat(48),ANN20002:'6'.repeat(48)};
  const keyByToken=new Map(Object.entries(tokens).map(([key,token])=>[token,key]));
  let prepareCount=0,commitCount=0,restorePrepareCount=0,restoreCommitArgs;
  prepareTrashHandler=async args=>{
    prepareCount++;
    const annotationKey=args.annotationKey;
    return {status:'previewed',action:'move_to_trash',requiresConfirmation:true,restorable:true,
      previewToken:tokens[annotationKey],operationId:operationIds[annotationKey],
      annotation:{key:annotationKey,library:route.library,attachmentKey:route.attachmentKey}};
  };
  trashHandler=async args=>{
    commitCount++;
    const annotationKey=keyByToken.get(args.previewToken);
    if(annotationKey==='ANN20002')throw Object.assign(new Error('操作结果尚不确定；不要重复确认。'),{code:'outcome_unknown'});
    return {status:'verified',action:'moved_to_trash',operationId:operationIds[annotationKey],annotationKey,restoreEntryAvailable:true};
  };
  const firstPass=await context.uiTest.wbTrashReaderAnnotationsBatch([first,second],route);
  assert.deepEqual(plain(firstPass.map(item=>item.status)),['verified','outcome-unknown']);
  assert.equal(prepareCount,2);
  assert.equal(commitCount,2);
  assert.deepEqual(plain(context.uiTest.wbReaderTrashOperationIds()),[operationIds.ANN20001,operationIds.ANN20002]);
  readerOperationsHandler=async()=>({operations:[
    {operationId:operationIds.ANN20001,status:'verified',library:route.library,annotationKey:first.key,attachmentKey:route.attachmentKey,restoreEntryAvailable:true,serverMatch:'current'},
    {operationId:operationIds.ANN20002,status:'outcome-unknown',library:route.library,annotationKey:second.key,attachmentKey:route.attachmentKey,restoreEntryAvailable:false,serverMatch:'current'},
  ],total:2,nextOffset:null,currentServerId:'test-server'});
  const secondPass=await context.uiTest.wbTrashReaderAnnotationsBatch([first,second],route);
  assert.deepEqual(plain(secondPass.map(item=>item.status)),['verified','outcome-unknown']);
  assert.equal(prepareCount,2,'persisted success and unknown outcomes are not prepared again');
  assert.equal(commitCount,2,'unknown writes are never replayed');

  prepareRestoreHandler=async args=>{
    restorePrepareCount++;
    assert.equal(args.operationId,operationIds.ANN20001);
    return {status:'previewed',action:'restore_to_library',requiresConfirmation:true,sourceOperationId:args.operationId,
      previewToken:'7'.repeat(48),restoreOperationId:'8'.repeat(64),
      annotation:{key:first.key,library:route.library,attachmentKey:route.attachmentKey}};
  };
  restoreHandler=async args=>{
    restoreCommitArgs=args;
    return {status:'verified',action:'restored_to_library',operationId:'8'.repeat(64),annotationKey:first.key};
  };
  const restored=await context.uiTest.wbUndoReaderAnnotationRemoval(operationIds.ANN20001);
  assert.equal(restored.annotationKey,first.key);
  assert.equal(restorePrepareCount,1);
  assert.deepEqual(plain(restoreCommitArgs),{previewToken:'7'.repeat(48),confirmWrite:true});
  assert.deepEqual(plain(context.uiTest.wbReaderTrashOperationIds()),[operationIds.ANN20002],'undo removes only the matching original operation');
  assert.equal(context.uiTest.wbReaderTrashAttempt(first,route),null);
  assert.equal(context.uiTest.wbReaderTrashAttempt(second,route).status,'outcome-unknown');
  assert.equal(bridgeCalls.filter(call=>call.name==='trash_reader_annotation').length>0,true);
  prepareTrashHandler=null;trashHandler=null;prepareRestoreHandler=null;restoreHandler=null;
});

test('persistent recovery list paginates the backend ledger and supersedes stale widget cache', async () => {
  await resetTrashState();
  const first={operationId:'c'.repeat(64),status:'verified',library:'g12',annotationKey:'ANN30001',attachmentKey:'PDF30001',restoreEntryAvailable:true,serverMatch:'current'};
  const second={operationId:'d'.repeat(64),status:'outcome-unknown',library:'user',annotationKey:'ANN30002',attachmentKey:'PDF30002',restoreEntryAvailable:false,serverMatch:'unknown'};
  const offsets=[];
  readerOperationsHandler=async args=>{
    offsets.push(args.offset);
    return args.offset===0?{operations:[first],total:2,nextOffset:1,currentServerId:'test-server'}:
      {operations:[second],total:2,nextOffset:null,currentServerId:'test-server'};
  };
  await en.setWidgetState({lastAnnotationTrashOperationIds:['e'.repeat(64)],lastAnnotationTrashOperationId:'e'.repeat(64)});
  const operations=await context.uiTest.wbReadReaderTrashOperations();
  assert.deepEqual(offsets,[0,1]);
  assert.deepEqual(plain(operations.map(operation=>operation.operationId)),[first.operationId,second.operationId]);
  assert.deepEqual(plain(context.uiTest.wbReaderTrashOperationIds()),[first.operationId,second.operationId]);
  assert.equal(context.uiTest.wbReaderTrashLedgerOperation(second.operationId).serverMatch,'unknown');
  readerOperationsHandler=null;
});

test('full backend recovery history can exceed the bounded widget cache without blocking new entries', async () => {
  await resetTrashState();
  const operations=Array.from({length:260},(_,index)=>({
    operationId:String(index+1).padStart(64,'0'),status:'verified',library:'user',annotationKey:'ANN00001',attachmentKey:'PDF00001',restoreEntryAvailable:true,
  }));
  context.uiTest.wbSetReaderTrashLedgerOperations(operations);
  const newOperation='a'.repeat(64);
  await context.uiTest.wbTrackReaderTrashOperation(newOperation);
  assert.equal(context.uiTest.wbReaderTrashOperationIds().length,261,'the backend index remains complete beyond the widget cache cap');
  assert.equal(en.widgetState.lastAnnotationTrashOperationIds.length,256,'widget state is a bounded convenience cache');
  assert.equal(en.widgetState.lastAnnotationTrashOperationId,newOperation);
});

test('reconcile sends only the operation number to the read-only ledger verifier', async () => {
  const result = await context.uiTest.wbReconcileAnnotationOperation('f'.repeat(64));
  assert.equal(result.status, 'outcome-unknown');
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'reconcile_reader_annotation_operation', args: { operationId: 'f'.repeat(64) },
  });
});

test('verified trash keeps a persistent review key and restoration targets the exact original annotation', async () => {
  await resetTrashState();
  await resetTrashState();
  await context.uiTest.wbRememberTrashedAnnotation({ operationId: 'a'.repeat(64), restoreEntryAvailable: true });
  assert.equal(en.widgetState.lastAnnotationTrashOperationId, 'a'.repeat(64));
  const preview = {
    status: 'previewed', action: 'restore_to_library', requiresConfirmation: true,
    previewToken: 'd'.repeat(48), restoreOperationId: 'c'.repeat(64),
    sourceOperationId: 'a'.repeat(64), annotation: { key: 'ANN12345', attachmentKey: 'PDF12345' },
  };
  restoreCallError = new Error('操作结果尚不确定；请先核查，不要重复确认。');
  await assert.rejects(context.uiTest.wbConfirmAnnotationRestore(preview), /尚不确定/);
  assert.equal(en.widgetState.lastAnnotationRestoreOperationId, 'c'.repeat(64), 'unknown restore remains available for read-only status review');
  restoreCallError = null;
  const result = await context.uiTest.wbConfirmAnnotationRestore(preview);
  assert.deepEqual(plain(bridgeCalls.filter(call => call.name === 'restore_reader_annotation').at(-1)), {
    name: 'restore_reader_annotation', args: { previewToken: 'd'.repeat(48), confirmWrite: true },
  });
  assert.equal(result.annotationKey, 'ANN12345');
  assert.equal(en.widgetState.lastAnnotationTrashOperationId, null);
  assert.equal(en.widgetState.lastAnnotationRestoreOperationId, null);
  await assert.rejects(context.uiTest.wbConfirmAnnotationRestore({ ...preview, annotation: { key: 'DIFFERENT' } }), /预览无效/);
});

test('restore panel treats an unknown result as review-only and the native build wires the persistent recovery entry', () => {
  assert.ok(extensionSource.includes("last_reader_annotation_trash"));
  assert.ok(extensionSource.includes("source.status==='outcome-unknown'"));
  assert.ok(extensionSource.includes("reconcile_reader_annotation_operation"));
  assert.ok(extensionSource.includes("recordStatus==='outcome-unknown'"));
  assert.ok(extensionSource.includes("recordStatus!=='outcome-unknown'"));
  assert.ok(extensionSource.includes("restore_reader_annotation"));
  assert.ok(extensionSource.includes('restoreCompletion'), 'verified restore remains visible after the recovery entry is removed');
  assert.ok(extensionSource.includes('返回文库与阅读'));
  assert.ok(extensionSource.includes('wbRememberTrashedAnnotation(result)'));
  assert.ok(extensionSource.includes('按原 key 回读核实'));
  assert.ok(extensionSource.includes('wbReaderTrashOperationIds'));
  assert.ok(extensionCss.includes('.wb-restore-panel'));
  assert.ok(extensionCss.includes('.wb-restore-operation-picker'));
});

test('workbench_state merges library collapse preference with the navigation stack', async () => {
  await en.setWidgetState({ libraryCollapsed: true });
  await en.setWidgetState({ stack: [{ kind: 'library', library: 'user', query: {} }] });
  assert.equal(en.widgetState.libraryCollapsed, true);
  assert.equal(en.widgetState.stack[0].kind, 'library');
  assert.deepEqual(plain(bridgeCalls.at(-1)), { name: 'workbench_state', args: { state: plain(en.widgetState) } });
});

test('narrow single-click detail waits 500 ms and a slow double-click cancels navigation', () => {
  let opened = 0;
  context.uiTest.wbQueueItemOpen(() => opened++);
  advanceTimers(240);
  assert.equal(opened, 0, 'the old 240 ms deadline must not navigate during a slow double-click');
  context.uiTest.wbCancelItemOpen();
  advanceTimers(260);
  assert.equal(opened, 0, 'the second click cancels the pending single-click navigation');
  context.uiTest.wbQueueItemOpen(() => opened++);
  advanceTimers(499);
  assert.equal(opened, 0);
  advanceTimers(1);
  assert.equal(opened, 1, 'a standalone narrow-screen click still opens the item detail');
});

test('native panel build wires main-row double-click and popover actions at pinned upstream anchors', () => {
  assert.ok(pinnedPanel.includes('function n0e({item:t,selected:e,onToggle:n,onOpen:i,onOpenPdf:s,s:r})'));
  assert.ok(buildSource.includes('onDoubleClick:o=>{o.preventDefault(),d()}'));
  assert.ok(buildSource.includes('wbCancelItemOpen();p.pdf?m(p):xf({kind:"item",library:t,key:p.key})'));
  assert.ok(buildSource.includes('if(wbShouldInspect())a([p.key]);else wbQueueItemOpen'));
  assert.ok(buildSource.includes('wbAskAnnotation(question,t.annotation,i)'));
  assert.ok(buildSource.includes('wbAddAnnotationContext(t.annotation,i)'));
  assert.ok(buildSource.includes('wbRemoveReaderAnnotationOnce(t.annotation,i)'));
  assert.ok(buildSource.includes('children:"移除高亮"'));
  assert.ok(buildSource.includes('wbTrashReaderAnnotationsBatch(candidates,readerRoute)'));
  assert.ok(buildSource.includes('wbUndoReaderAnnotationRemoval(outcome.operationId)'));
  assert.ok(buildSource.includes('wbCopyReaderAnnotations(readerSelected,readerRoute)'));
  assert.ok(buildSource.includes('wbAddAnnotationContexts(readerSelected,readerRoute)'));
  assert.ok(buildSource.includes('replaceBetweenOnce(panel,'));
  assert.ok(buildSource.includes('workbench-reader-trash-result'));
  assert.ok(extensionSource.includes('Zotero 顶层回收站'));
  assert.ok(!buildSource.includes('wbCanAttemptAnnotationTrash'));
  assert.ok(buildSource.includes('wbRankBlock(c,"wb-detail-ranks")'));
  assert.ok(extensionSource.includes('恢复只针对原批注 key'));
});

test('saved annotation note editing is reachable from the popover and each PDF sidebar annotation row', () => {
  assert.equal((buildSource.match(/WorkbenchReaderAnnotationComment/g) || []).length, 2, 'the popover and sidebar each mount one editor');
  assert.ok(buildSource.includes('onSaved:()=>s()'), 'a verified popover edit closes the stale annotation snapshot');
  assert.ok(buildSource.includes('ie.kind==="annotation"&&(0,dt.jsx)(WorkbenchReaderAnnotationComment'), 'each Zotero sidebar annotation row has an independent note action');
  assert.ok(buildSource.includes('children:ie.kind==="annotation"?ie.annotation.text||"（无原文摘录）":ie.highlight.quote'));
  assert.ok(buildSource.includes('ie.kind==="annotation"&&ie.annotation.comment'), 'reader comments remain separate from original text');
  assert.match(extensionCss, /\.wb-reader-note-editor textarea\{[^}]*font-size:14px/);
  assert.match(extensionCss, /\.reader \.wb-reader-annotation-row\{[^}]*flex-wrap:wrap/);
  assert.match(extensionCss, /\.reader \.wb-reader-annotation-row>\.wb-reader-note\{[^}]*box-sizing:border-box;flex:0 0 calc\(100% - 30px\);max-width:calc\(100% - 30px\)/);
  assert.match(extensionCss, /\.reader \.wb-reader-annotation-row>\.wb-reader-note--open\{flex-basis:calc\(100% - 30px\);max-width:calc\(100% - 30px\)/);
  assert.ok(extensionSource.includes('wbRefreshAnnotationContextComment'));
  assert.ok(buildSource.includes('children:"原文摘录"')&&buildSource.includes('children:"阅读者备注"'));
});

test('annotation note editor reads the latest comment, preserves a draft across resource updates, and cancel sends no write', async () => {
  await resetAnnotationCommentHarness();
  const route = { library: 'user', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345' };
  const annotation = { key: 'ANN12345', type: 'highlight', pageIndex: 0, text: '作者原文', comment: '' };
  readAnnotationCommentHandler = args => ({ status: 'ready', ...args, comment: '服务端最新备注', annotationVersion: 31, attachmentVersion: 8, editable: true, editToken: 'a'.repeat(48), lastOperation: null });
  const harness = createHookHarness(context.uiTest.WorkbenchReaderAnnotationComment, { annotation, route });
  try {
    let tree = harness.render();
    const open = findTreeNode(tree, node => node.type === 'button' && treeText(node) === '添加笔记');
    assert.ok(open);
    open.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    let textarea = findTreeNode(tree, node => node.type === 'textarea');
    assert.equal(textarea.props.value, '服务端最新备注');
    assert.deepEqual(plain(bridgeCalls.filter(call => call.name === 'read_reader_annotation_comment').at(-1)), {
      name: 'read_reader_annotation_comment', args: { library: 'user', annotationKey: 'ANN12345', attachmentKey: 'PDF12345' },
    });
    textarea.props.onChange({ target: { value: '保留中的新草稿' } });
    tree = harness.render({ annotation: { ...annotation, comment: '资源刷新来的其他值' }, route });
    textarea = findTreeNode(tree, node => node.type === 'textarea');
    assert.equal(textarea.props.value, '保留中的新草稿', 'refreshing annotation props must not replace an in-progress draft');
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '取消').props.onClick();
    assert.equal(findTreeNode(harness.render(), node => node.type === 'textarea'), null);
    assert.equal(bridgeCalls.filter(call => call.name === 'update_reader_annotation_comment').length, 0);
  } finally { harness.restore(); }
});

test('verified annotation note save refreshes the reader and the selected AI context exactly once', async () => {
  await resetAnnotationCommentHarness();
  const route = { library: 'user', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345' };
  const annotation = { key: 'ANN12345', type: 'highlight', pageIndex: 2, text: '作者原文', comment: '旧备注' };
  await context.uiTest.wbAddAnnotationContext(annotation, route);
  readAnnotationCommentHandler = args => ({ status: 'ready', ...args, comment: '读取到的旧备注', annotationVersion: 42, attachmentVersion: 9, editable: true, editToken: 'b'.repeat(48), lastOperation: null });
  updateAnnotationCommentHandler = args => ({ status: 'verified', verified: true, changed: true, ...args, comment: args.comment, annotationVersion: 43, operationId: 'c'.repeat(64) });
  readerAnnotationDocument = { annotations: [{ key: 'ANN12345', text: '作者原文', comment: '更新后的阅读者备注' }] };
  const uri = 'reader-annotations://user/PDF12345';
  const cached = { data: { annotations: [{ key: 'ANN12345', text: '作者原文', comment: '读取到的旧备注' }] }, loading: false };
  annotationResourceCache.set(uri, cached);
  const notices = [];
  let savedCallbackCount = 0;
  const harness = createHookHarness(context.uiTest.WorkbenchReaderAnnotationComment, { annotation, route, notify: (...args) => notices.push(args), onSaved: () => savedCallbackCount++ });
  try {
    let tree = harness.render();
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '编辑笔记').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    const textarea = findTreeNode(tree, node => node.type === 'textarea');
    assert.equal(textarea.props.value, '读取到的旧备注');
    textarea.props.onChange({ target: { value: '更新后的阅读者备注' } });
    tree = harness.render();
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '保存').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    assert.equal(findTreeNode(tree, node => node.type === 'textarea'), null);
    const calls = bridgeCalls.filter(call => call.name === 'update_reader_annotation_comment');
    assert.equal(calls.length, 1);
    assert.deepEqual(plain(calls[0].args), {
      library: 'user', annotationKey: 'ANN12345', attachmentKey: 'PDF12345', editToken: 'b'.repeat(48),
      expectedVersion: 42, expectedComment: '读取到的旧备注', comment: '更新后的阅读者备注',
    });
    assert.equal(cached.data.annotations[0].comment, '更新后的阅读者备注');
    assert.ok(readerAnnotationRefreshes.includes(uri));
    assert.ok(readerAnnotationRefreshes.some(value => value?.tick === 5));
    assert.equal(savedCallbackCount, 1, 'the popover caller can close its stale annotation snapshot after verified save');
    assert.equal(context.uiTest.wbContextSnapshot()[0].comment, '更新后的阅读者备注');
    assert.match(messageCalls.filter(call => call.kind === 'context').at(-1).args[0], /阅读者备注：\n更新后的阅读者备注/);
    assert.ok(notices.some(([message]) => message === '笔记已保存并核实。'));
  } finally { harness.restore(); }
});

test('unknown annotation note writes keep the draft and only reconcile through a read-only check', async () => {
  await resetAnnotationCommentHarness();
  const priorUpdateCount = bridgeCalls.filter(call => call.name === 'update_reader_annotation_comment').length;
  const route = { library: 'user', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345' };
  const annotation = { key: 'ANN12345', type: 'highlight', pageIndex: 0, text: '原文', comment: '' };
  let phase = 0;
  readAnnotationCommentHandler = args => phase === 0
    ? ({ status: 'ready', ...args, comment: '旧备注', annotationVersion: 8, attachmentVersion: 2, editable: true, editToken: 'c'.repeat(48), lastOperation: null })
    : phase === 1
      ? ({ status: 'ready', ...args, comment: '旧备注', annotationVersion: 8, attachmentVersion: 2, editable: false, editToken: null, lastOperation: { status: 'outcome-unknown', message: '仍待核对' } })
      : ({ status: 'ready', ...args, comment: '研究者的新备注', annotationVersion: 9, attachmentVersion: 2, editable: true, editToken: 'd'.repeat(48), lastOperation: { status: 'verified', currentCommentMatchesRequested: true } });
  updateAnnotationCommentHandler = args => ({ status: 'outcome-unknown', verified: false, changed: null, ...args, operationId: 'e'.repeat(64), message: 'Timeout: tools/call' });
  readerAnnotationDocument = { annotations: [{ key: 'ANN12345', text: '原文', comment: '研究者的新备注' }] };
  const harness = createHookHarness(context.uiTest.WorkbenchReaderAnnotationComment, { annotation, route });
  try {
    let tree = harness.render();
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '添加笔记').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    findTreeNode(tree, node => node.type === 'textarea').props.onChange({ target: { value: '研究者的新备注' } });
    tree = harness.render();
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '保存').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    assert.equal(findTreeNode(tree, node => node.type === 'textarea').props.value, '研究者的新备注');
    assert.match(treeText(tree), /保存结果尚未核实，未重复提交；请先只读核对。/);
    assert.equal(bridgeCalls.filter(call => call.name === 'update_reader_annotation_comment').length - priorUpdateCount, 1);
    phase = 1;
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '只读核对').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    assert.equal(findTreeNode(tree, node => node.type === 'textarea').props.value, '研究者的新备注');
    assert.equal(bridgeCalls.filter(call => call.name === 'update_reader_annotation_comment').length - priorUpdateCount, 1, 'an unresolved readback must not resend the write');
    phase = 2;
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '只读核对').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    assert.equal(findTreeNode(tree, node => node.type === 'textarea'), null, 'an exact backend reconciliation refreshes the reader and closes the editor');
    assert.equal(bridgeCalls.filter(call => call.name === 'update_reader_annotation_comment').length - priorUpdateCount, 1);
  } finally { harness.restore(); }
});

test('a pending note read from a prior annotation cannot replace the new route editor', async () => {
  await resetAnnotationCommentHarness();
  const route = { library: 'user', itemKey: 'ITEM1234', title: '当前文献', attachmentKey: 'PDF12345' };
  const oldAnnotation = { key: 'ANN12345', type: 'highlight', pageIndex: 0, text: '旧原文', comment: '' };
  let resolveRead;
  readAnnotationCommentHandler = () => new Promise(resolve => { resolveRead = resolve; });
  const harness = createHookHarness(context.uiTest.WorkbenchReaderAnnotationComment, { annotation: oldAnnotation, route });
  try {
    let tree = harness.render();
    findTreeNode(tree, node => node.type === 'button' && treeText(node) === '添加笔记').props.onClick();
    tree = harness.render({ annotation: { key: 'ANN54321', type: 'highlight', pageIndex: 1, text: '新原文', comment: '' }, route: { ...route, attachmentKey: 'PDF54321' } });
    resolveRead({ status: 'ready', library: 'user', annotationKey: 'ANN12345', attachmentKey: 'PDF12345', comment: '旧来源备注', annotationVersion: 1, editable: true, editToken: 'f'.repeat(48) });
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render();
    assert.equal(findTreeNode(tree, node => node.type === 'textarea'), null);
    assert.ok(findTreeNode(tree, node => node.type === 'button' && treeText(node) === '添加笔记'));
  } finally { harness.restore(); }
});

test('saved annotation popover uses system typography, constrained width, and a collapsible body', () => {
  assert.match(extensionCss, /\.popover\s*\{[^}]*font-family:var\(--z-font/);
  assert.match(extensionCss, /\.popover \.quote\s*\{[^}]*font-family:inherit/);
  assert.match(extensionCss, /\.popover\s*\{[^}]*width:min\(380px/);
  assert.match(extensionCss, /\.popover \.wb-annotation-content/);
  assert.match(extensionCss, /\.wb-reader-note-editor textarea\{[^}]*font-size:14px/);
  assert.match(extensionCss, /\.wb-annotation-label\{/);
});
