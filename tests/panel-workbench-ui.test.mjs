import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
let researchMaterialsResponse = null;
let collaborationSessionResponse = null;
let collaborationFeedbackResponse = null;
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
    if (name === 'research_materials') return researchMaterialsResponse;
    if (name === 'collaboration_session') {
      if (args.action === 'list') return { sessions: [] };
      return collaborationSessionResponse;
    }
    if (name === 'collaboration_feedback') return collaborationFeedbackResponse;
    if (name === 'collaboration_read') return { readings: [] };
    if (name === 'trash_reader_annotation') return { status: 'verified', action: 'moved_to_trash', operationId: 'a'.repeat(64), restoreEntryAvailable: true };
    if (name === 'restore_reader_annotation') {
      if (restoreCallError) throw restoreCallError;
      return { status: 'verified', action: 'restored_to_library', operationId: 'c'.repeat(64), annotationKey: 'ANN12345' };
    }
    if (name === 'reconcile_reader_annotation_operation') return { status: 'outcome-unknown', action: 'unresolved', operationId: args.operationId };
    return {};
  },
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
  window: { matchMedia: () => ({ matches: true }), dispatchEvent: () => true },
  Event: class { constructor(type) { this.type = type; } },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  console,
};
const plain = (value) => JSON.parse(JSON.stringify(value));
vm.createContext(context);
vm.runInContext(`${workspaceSource}\n${extensionSource}\nglobalThis.uiTest = { wbConnectionSummary, wbRankLabels, wbRankLevels, wbRankTone, wbRankBlock, wbInspectorItem, wbAnnotationSource, wbAnnotationPrompt, wbAskAnnotation, wbAddAnnotationContext, wbRemoveAnnotationContext, wbClearAnnotationContext, wbContextSnapshot, wbContextKey, wbContextPayload, wbContextMetadata, wbSendAnnotationContextMessage, wbReadCollaborationMaterialRecords, wbCollaborationSourceSelectors, wbListCollaborationSessions, wbListCollaborationFeedback, wbLoadCollaborationSession, wbLoadCollaborationDraft, wbCollaborationDecisionLabel, wbCollaborationRangeLabel, wbCollaborationContextSources, wbCollaborationSourceStatus, wbCollaborationSourceReference, wbReplaceContextWithCollaborationSession, wbSetCollaborationContextSession, wbCollaborationFeedbackMessage, wbSendCollaborationFeedbackMessage, WorkbenchCollaboration, wbPrepareAnnotationTrash, wbConfirmAnnotationTrash, wbRememberTrashedAnnotation, wbPrepareAnnotationRestore, wbConfirmAnnotationRestore, wbReconcileAnnotationOperation, WorkbenchAnnotationRestore, wbQueueItemOpen, wbCancelItemOpen };`, context);

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
    { key: 'ANN12345', pageIndex: 4, text: '原文摘录', comment: '阅读者备注' },
    { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' },
  );
  assert.deepEqual(plain(source), {
    library: 'g12', itemKey: 'ITEM1234', title: 'ITEM1234', attachmentKey: 'PDF12345', annotationKey: 'ANN12345',
    pageIndex: 4, page: 5, url: 'zotero://open-pdf/groups/12/items/PDF12345?page=5&annotation=ANN12345', text: '原文摘录', comment: '阅读者备注',
  });
  assert.match(context.uiTest.wbAnnotationPrompt(source), /PDF 附件：PDF12345[\s\S]*物理页：5[\s\S]*Zotero 回链：zotero:\/\/open-pdf\/groups\/12[\s\S]*原文摘录：[\s\S]*阅读者备注：[\s\S]*阅读者备注/);
  await context.uiTest.wbAddAnnotationContext({ key: 'ANN12345', pageIndex: 4, text: '原文摘录', comment: '阅读者备注' }, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  assert.match(messageCalls.at(-1).args[0], /批注：ANN12345[\s\S]*物理页：5[\s\S]*原文摘录：[\s\S]*阅读者备注/);
  assert.equal(messageCalls.findLast(call => call.kind === 'context').args[1].zotero[0].url, source.url);
  assert.equal(messageCalls.findLast(call => call.kind === 'context').args[1].zotero[0].text, undefined);
  assert.equal(messageCalls.findLast(call => call.kind === 'context').args[1].zotero[0].comment, undefined);
  await context.uiTest.wbAskAnnotation('解释这条批注', { key: 'ANN12345', pageIndex: 4, text: '原文摘录', comment: '阅读者备注' }, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  assert.match(messageCalls.at(-1).args[0], /解释这条批注[\s\S]*批注：ANN12345[\s\S]*物理页：5[\s\S]*Zotero 回链：zotero:\/\/open-pdf\/groups\/12[\s\S]*原文摘录：[\s\S]*阅读者备注/);
  assert.throws(
    () => context.uiTest.wbAnnotationSource({ key: 'ANN12345', pageIndex: null }, { itemKey: 'ITEM1234', attachmentKey: 'PDF12345' }),
    /缺少条目、附件或物理页定位/,
  );
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
  await context.uiTest.wbPrepareAnnotationTrash({ key: 'ANN12345', pageIndex: 4 }, { library: 'g12', itemKey: 'ITEM1234', attachmentKey: 'PDF12345' });
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'prepare_reader_annotation_trash',
    args: { library: 'g12', annotationKey: 'ANN12345', attachmentKey: 'PDF12345' },
  });
  await assert.rejects(context.uiTest.wbConfirmAnnotationTrash({ previewToken: 'a'.repeat(48), restorable: true, action: 'move_to_trash' }), /预览无效/);
  await context.uiTest.wbConfirmAnnotationTrash({ previewToken: 'b'.repeat(48), operationId: 'c'.repeat(64), requiresConfirmation: true, restorable: true, action: 'move_to_trash' });
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'trash_reader_annotation', args: { previewToken: 'b'.repeat(48), confirmWrite: true },
  });
  assert.equal(en.widgetState.lastAnnotationTrashOperationId, 'c'.repeat(64), 'operation number is persisted before the confirmed write');
});

test('reconcile sends only the operation number to the read-only ledger verifier', async () => {
  const result = await context.uiTest.wbReconcileAnnotationOperation('f'.repeat(64));
  assert.equal(result.status, 'outcome-unknown');
  assert.deepEqual(plain(bridgeCalls.at(-1)), {
    name: 'reconcile_reader_annotation_operation', args: { operationId: 'f'.repeat(64) },
  });
});

test('verified trash keeps a persistent review key and restore confirmation targets the exact original annotation', async () => {
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
  assert.ok(buildSource.includes('wbRememberTrashedAnnotation(result)'));
  assert.ok(buildSource.includes('恢复只有在精确回读确认后才算完成'));
  assert.ok(extensionCss.includes('.wb-restore-panel'));
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
  assert.ok(buildSource.includes('wbPrepareAnnotationTrash(t.annotation,i)'));
  assert.ok(buildSource.includes('wbConfirmAnnotationTrash(trashPreview)'));
  assert.ok(buildSource.includes('children:"移除高亮…"'));
  assert.ok(buildSource.includes(':"确认移除高亮"'));
  assert.ok(buildSource.includes('Zotero 顶层回收站'));
  assert.ok(!buildSource.includes('wbCanAttemptAnnotationTrash'));
  assert.ok(buildSource.includes('wbRankBlock(c,"wb-detail-ranks")'));
  assert.ok(buildSource.includes('可按原 key 单独恢复，并须通过回读确认'));
});

test('saved annotation popover uses system typography, constrained width, and a collapsible body', () => {
  assert.match(extensionCss, /\.popover\s*\{[^}]*font-family:var\(--z-font/);
  assert.match(extensionCss, /\.popover \.quote\s*\{[^}]*font-family:inherit/);
  assert.match(extensionCss, /\.popover\s*\{[^}]*width:min\(380px/);
  assert.match(extensionCss, /\.popover \.wb-annotation-content/);
});
