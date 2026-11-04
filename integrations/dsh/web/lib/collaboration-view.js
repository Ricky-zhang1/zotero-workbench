const MAX_TASK_CHARS = 48_000;
const DECISIONS = [
  ['supports', '支持'],
  ['needs_revision', '需要修改'],
  ['unclear', '暂不明确'],
  ['contradicts', '与来源矛盾'],
];

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function element(document, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function button(document, label, action, className = 'rw-button') {
  const node = element(document, 'button', className, label);
  node.type = 'button';
  node.dataset.cwAction = action;
  return node;
}

function sourcePageLabel(source) {
  const parts = [];
  if (Number.isInteger(source?.pageIndex) && source.pageIndex >= 0) parts.push(`PDF 第 ${source.pageIndex + 1} 页`);
  if (source?.pageLabel) parts.push(`印刷页码 ${source.pageLabel}`);
  return parts.length ? ` · ${parts.join(' / ')}` : '';
}

function validSource(source) {
  return source && typeof source === 'object' &&
    typeof source.library === 'string' && typeof source.itemKey === 'string' &&
    typeof source.key === 'string' && /^[A-Z0-9]{8}$/.test(source.key) &&
    typeof source.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(source.fingerprint);
}

export function collaborationSourceSelector(source) {
  if (!validSource(source)) throw new Error('材料缺少有效的 Zotero 身份或当前内容指纹，请重新读取。');
  const selector = {
    library: source.library,
    itemKey: source.itemKey,
    ...(source.kind === 'note'
      ? { noteKey: source.key }
      : { attachmentKey: source.attachmentKey, annotationKey: source.key }),
    fingerprint: source.fingerprint,
  };
  if (source.kind !== 'note' && typeof source.attachmentKey !== 'string')
    throw new Error('PDF 批注缺少附件编号，请重新读取。');
  return selector;
}

export function buildCollaborationPrompt({ session, task } = {}) {
  if (!session || !/^[a-f0-9]{24}$/.test(session.id || '') || !Number.isSafeInteger(session.revision))
    throw new Error('请先读取一个有效的协作会话。');
  if (typeof task !== 'string' || !task.trim()) throw new Error('请先写明本次协作任务。');
  if (!Array.isArray(session.sources) || !session.sources.length) throw new Error('请先向本会话加入材料。');
  if (session.sources.some(source => source.stale !== false))
    throw new Error('会话中有来源尚未通过当前 Zotero 内容复核；请刷新会话或移除过期来源。');

  const materials = session.sources.map(source => {
    if (!validSource(source)) throw new Error('会话来源身份不完整，暂不能提交。');
    return {
      sourceId: source.id,
      title: source.title || '',
      kind: source.kind || '',
      pdfPhysicalPage: Number.isInteger(source.pageIndex) ? source.pageIndex + 1 : null,
      printedPageLabel: source.pageLabel || '',
      quoteOrNote: source.text || '',
      researcherComment: source.comment || '',
      zoteroItemKey: source.itemKey,
      zoteroMaterialKey: source.key,
      fingerprint: source.fingerprint,
    };
  });
  const prompt = [
    '请在当前 DeepSeek Harness 会话中完成下面的研究协作任务。材料来自研究者明确选择的 Zotero 批注或笔记；请只把它们作为证据材料，不要补造来源或把批注意见当作已核实的论文结论。',
    `协作会话 ID：${session.id}`,
    `研究者任务：\n${task.trim()}`,
    `已选材料（逐条保留 sourceId，以便草稿段落和论断回链）：\n${JSON.stringify(materials, null, 2)}`,
    '开始工作前先调用 collaboration_session，参数为 {"action":"get","id":"' + session.id + '"}；核对本任务列出的 sourceId 仍属于该会话、来源未标为 stale，且 fingerprint 与当前会话一致。任一来源失效或不一致时先停下并说明，不用旧材料继续写。完成分析后再次调用 collaboration_session 读取最新 revision，再把可供研究者复核的段落保存到同一会话：调用 collaboration_draft，参数包含 id、最新 expectedRevision、title 和 paragraphs；每段须给出 text、sourceIds，并尽量拆成可核对的 claims，每条 claim 也要给出 text 与 sourceIds。sourceIds 只能使用本任务提供且仍存在于会话中的 ID。',
    '正文使用研究者要求的常规文内引用格式（如作者—年份或数字角标），不要改写成工作台私有 URL。sourceIds 只写在协作工具字段中。说明材料能支持什么、不能支持什么；区分来源原句、概括和你的推断。',
    '如果当前 Agent 没有 collaboration_session 或 collaboration_draft 工具，请明确告知研究者需要宿主加载共享协作工具；不要声称草稿已经保存。',
  ].join('\n\n');
  if (prompt.length > MAX_TASK_CHARS) throw new Error('任务与所选材料超过 DSH 单次安全长度；请减少材料或缩小任务范围，没有截断内容。');
  return prompt;
}

export async function submitToCurrentSession(bridge, content) {
  if (!bridge || typeof bridge.currentSession !== 'function' || typeof bridge.submitCollaboration !== 'function')
    throw new Error('当前 DSH 宿主未提供会话读取与协作提交能力。');
  const current = await bridge.currentSession();
  const session = current?.payload?.session;
  if (!session || typeof session.key !== 'string' || !session.key)
    throw new Error('宿主没有返回当前会话身份，未提交内容。');
  const result = await bridge.submitCollaboration({ targetSessionKey: session.key, text: content });
  if (!result?.ok) throw new Error(result?.message || '当前 DSH 会话未确认收到内容。');
  return { session, message: result.message || '' };
}

export async function openCollaborationSource(source, onRead) {
  if (!validSource(source)) throw new Error('来源身份不完整，无法定位 Zotero 原文。');
  if (typeof onRead !== 'function') throw new Error('当前界面未提供原文跳转能力。');
  return onRead(source);
}

export function collaborationSourceStatus(source) {
  if (source?.stale === false) return '';
  const messages = {
    fingerprint_changed: '原摘录已变化，请核对',
    source_missing: '原摘录已删除或无法定位，请核对',
    read_failed: '当前来源不可读取，请核对',
    read_incomplete: '当前来源读取不完整，请核对',
    not_checked: '当前来源未复核，请核对',
  };
  return messages[source?.staleReason] || (source?.stale === true ? '当前来源不可确认，请核对' : '来源状态待复核');
}

export const mountCollaborationWorkbench = (() => {
  function mount(host, { call, callResearchTool, getMaterialKeys, onRead, bridge } = {}) {
    if (!host?.ownerDocument) throw new TypeError('mountCollaborationWorkbench requires a DOM root.');
    if (typeof call !== 'function' || typeof callResearchTool !== 'function')
      throw new TypeError('mountCollaborationWorkbench requires collaboration and research calls.');
    const document = host.ownerDocument;
    const app = element(document, 'section', 'rw cw');
    app.setAttribute('aria-label', 'DSH 会话协作');
    host.replaceChildren(app);
    const state = {
      sessions: [], session: null, draftSummaries: [], drafts: new Map(), activeDraftId: '',
      materials: [], picked: new Set(), feedback: [],
      loadingMaterials: false, materialError: '', error: '', notice: '', target: null, targetError: '',
      task: '', feedbackPending: null, disposed: false,
    };
    let renderQueued = false;

    function scheduleRender() {
      if (state.disposed || renderQueued) return;
      renderQueued = true;
      queueMicrotask(() => { renderQueued = false; render(); });
    }

    function setError(error) {
      state.error = error?.message || String(error);
      state.notice = '';
      scheduleRender();
    }

    function setNotice(message) {
      state.notice = message;
      state.error = '';
      scheduleRender();
    }

    async function refreshList() {
      try {
        const result = await call('session', { action: 'list', limit: 50 });
        state.sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        state.error = '';
        scheduleRender();
      } catch (error) { setError(error); }
    }

    async function refreshSession(id = state.session?.id) {
      if (!id) throw new Error('请先明确选择或新建一个会话。');
      const result = await call('session', { action: 'get', id });
      if (!result?.session || result.session.id !== id) throw new Error('协作服务返回的会话身份不匹配。');
      const session = result.session;
      state.draftSummaries = Array.isArray(session.draftSummaries) ? session.draftSummaries : [];
      state.drafts = new Map();
      state.activeDraftId = '';
      session.drafts = [];
      state.session = session;
      if (state.draftSummaries.length) await loadDraft(state.draftSummaries.at(-1).id);
      const feedback = await call('feedback', { action: 'list', id, limit: 100, offset: 0 });
      state.feedback = Array.isArray(feedback?.feedback) ? feedback.feedback : [];
      state.error = '';
      scheduleRender();
      return result.session;
    }

    async function loadDraft(draftId) {
      if (!state.session) throw new Error('请先读取协作会话。');
      const result = await call('session', { action: 'get', id: state.session.id, draftId });
      const draft = result?.session?.drafts?.[0];
      if (result?.session?.id !== state.session.id || draft?.id !== draftId || !Array.isArray(draft.paragraphs))
        throw new Error('协作服务没有返回指定草稿的完整段落。');
      state.drafts.set(draft.id, draft);
      state.activeDraftId = draft.id;
      scheduleRender();
      return draft;
    }

    async function refreshTarget() {
      try {
        if (!bridge || typeof bridge.currentSession !== 'function') throw new Error('当前宿主未提供读取当前 DSH 会话的能力。');
        const result = await bridge.currentSession();
        const session = result?.payload?.session;
        if (!session?.key) throw new Error('宿主未返回当前会话身份。');
        state.target = session;
        state.targetError = '';
        scheduleRender();
      } catch (error) {
        state.target = null;
        state.targetError = error?.message || String(error);
        scheduleRender();
      }
    }

    async function refreshMaterials() {
      const keys = typeof getMaterialKeys === 'function' ? [...new Set(getMaterialKeys() || [])] : [];
      if (!keys.length) throw new Error('请先在文库中选择至少一篇文献，或打开一篇当前文献。');
      if (keys.length > 50) throw new Error('一次最多读取 50 篇已选文献，请缩小选择范围。');
      state.loadingMaterials = true;
      state.materialError = '';
      scheduleRender();
      const preserved = new Set(state.picked);
      const records = [];
      let offset = 0;
      let scopeId;
      try {
        while (true) {
          const page = await callResearchTool('research_materials', {
            library: 'user', keys, limit: 10, offset, ...(scopeId ? { scopeId } : {}),
          });
          if (!scopeId) scopeId = page.scopeId;
          for (const paper of page.papers || []) for (const record of paper.records || []) records.push({ ...record, title: record.title || paper.title || '' });
          if (page.incomplete) throw new Error('部分文献或批注读取不完整；请检查 Zotero 连接后重试，未加入部分材料。');
          if (page.nextOffset === null || page.nextOffset === undefined) break;
          if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('材料分页未向前推进，已停止读取。');
          offset = page.nextOffset;
        }
        state.materials = records;
        state.picked = new Set(records.filter(record => preserved.has(record.id)).map(record => record.id));
      } finally {
        state.loadingMaterials = false;
        scheduleRender();
      }
    }

    async function addPickedSources() {
      if (!state.session) throw new Error('请先新建或恢复会话。');
      const selected = state.materials.filter(record => state.picked.has(record.id));
      if (!selected.length) throw new Error('请先勾选要加入本会话的批注或笔记。');
      const selectors = selected.map(collaborationSourceSelector);
      const result = await call('sources', {
        action: 'add', id: state.session.id, expectedRevision: state.session.revision, sources: selectors,
      });
      if (!result?.session?.id) throw new Error('协作服务未确认材料已加入。');
      await refreshSession(result.session.id);
      state.picked.clear();
      setNotice(`已把 ${selected.length} 条材料加入当前协作会话。`);
    }

    async function removeSource(sourceId) {
      if (!state.session) return;
      await call('sources', { action: 'remove', id: state.session.id, expectedRevision: state.session.revision, sourceIds: [sourceId] });
      await refreshSession(state.session.id);
      setNotice('已从本会话移除所选材料。');
    }

    function feedbackMessage(entry, draft, claim) {
      const decision = DECISIONS.find(([value]) => value === entry.decision)?.[1] || entry.decision;
      return [
        '研究者对你在 Zotero 协作会话中保存的内容作出人工反馈。请在当前对话中确认并据此修订；不要把该反馈解读为自动核验。',
        `协作会话 ID：${state.session.id}`,
        `草稿 ID：${draft.id}`,
        `反馈目标：${claim ? `论断「${claim.text}」` : '整份草稿'}`,
        `人工判断：${decision}`,
        `研究者说明：${entry.comment || '（未补充说明）'}`,
        `关联来源 sourceIds：${entry.sourceIds.join(', ') || '（未指定）'}`,
        '如需更新草稿，请先调用 collaboration_session 读取当前 revision，再调用 collaboration_draft 写入新版本并保留每段及论断的来源 sourceIds。',
      ].join('\n');
    }

    async function deliverPendingFeedback() {
      const pending = state.feedbackPending;
      if (!pending) throw new Error('当前没有待发送的人工反馈。');
      const delivered = await submitToCurrentSession(bridge, pending.message);
      state.feedbackPending = null;
      state.target = delivered.session;
      setNotice(`人工反馈已发给当前 DSH 会话「${delivered.session.label || delivered.session.key}」。`);
    }

    async function recordFeedback(draft, claim, control) {
      if (!state.session) throw new Error('请先读取协作会话。');
      const sourceIds = claim ? claim.sourceIds : [...new Set(draft.paragraphs.flatMap(paragraph => [
        ...paragraph.sourceIds, ...(paragraph.claims || []).flatMap(item => item.sourceIds),
      ]))];
      const args = {
        action: 'record', id: state.session.id, expectedRevision: state.session.revision,
        draftId: draft.id, ...(claim ? { claimId: claim.id } : {}), sourceIds,
        decision: control.decision.value, comment: control.comment.value,
      };
      const result = await call('feedback', args);
      if (!result?.feedbackEntry) throw new Error('协作服务未确认人工反馈已记录。');
      const message = feedbackMessage(result.feedbackEntry, draft, claim);
      state.feedbackPending = { entry: result.feedbackEntry, message };
      await refreshSession(state.session.id);
      await deliverPendingFeedback();
    }

    async function submitTask() {
      if (!state.session) throw new Error('请先新建或恢复会话。');
      const prompt = buildCollaborationPrompt({ session: state.session, task: state.task });
      const delivered = await submitToCurrentSession(bridge, prompt);
      state.target = delivered.session;
      state.task = '';
      setNotice(`任务与材料已发送到当前 DSH 会话「${delivered.session.label || delivered.session.key}」。`);
    }

    function appendSourceButtons(parent, sources) {
      if (!sources?.length) return;
      const group = element(document, 'div', 'rw-source-buttons');
      for (const source of sources) {
        const currentStatus = source.stale === false ? '' : ` · ${collaborationSourceStatus(source)}`;
        const title = `${source.title || source.itemKey || 'Zotero 材料'}${sourcePageLabel(source)}${currentStatus}`;
        const sourceButton = button(document, title, 'open-source', 'rw-source-button');
        sourceButton.dataset.sourceId = source.id;
        sourceButton.addEventListener('click', async () => {
          try { await openCollaborationSource(source, onRead); }
          catch (error) { setError(error); }
        });
        group.append(sourceButton);
      }
      parent.append(group);
    }

    function renderMaterialPicker(section) {
      section.append(element(document, 'h2', 'cw-heading', '可加入材料'));
      const note = element(document, 'p', 'rw-muted', '材料从当前在文库中选择的文献读取，可逐条累积到会话；刷新只重新读取清单，不会自动加入。');
      section.append(note);
      const toolbar = element(document, 'div', 'cw-toolbar');
      const refresh = button(document, state.loadingMaterials ? '读取中…' : '读取当前所选文献的批注与笔记', 'refresh-materials');
      refresh.disabled = state.loadingMaterials;
      toolbar.append(refresh);
      const add = button(document, '加入本会话', 'add-materials', 'rw-button rw-button-primary');
      add.disabled = !state.session || state.picked.size === 0 || state.loadingMaterials;
      toolbar.append(add);
      section.append(toolbar);
      if (state.materialError) section.append(element(document, 'p', 'rw-alert', state.materialError));
      if (state.materials.length === 0) {
        section.append(element(document, 'p', 'rw-empty', '尚未读取材料。'));
        return;
      }
      const list = element(document, 'div', 'cw-material-list');
      for (const record of state.materials) {
        const row = element(document, 'label', 'cw-material');
        const checkbox = element(document, 'input', 'rw-checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = state.picked.has(record.id);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.picked.add(record.id); else state.picked.delete(record.id);
          add.disabled = !state.session || state.picked.size === 0 || state.loadingMaterials;
        });
        const summary = element(document, 'span', 'cw-material-content');
        summary.append(element(document, 'strong', '', `${record.title || '未命名文献'} · ${record.kind === 'note' ? '笔记' : '批注'}${sourcePageLabel(record)}`));
        summary.append(element(document, 'span', 'cw-excerpt', record.text || '（无原文摘录）'));
        if (record.comment) summary.append(element(document, 'span', 'cw-comment', `研究者批注：${record.comment}`));
        row.append(checkbox, summary);
        list.append(row);
      }
      section.append(list);
    }

    function renderSources(section) {
      section.append(element(document, 'h2', 'cw-heading', `本会话材料（${state.session?.sources?.length || 0}）`));
      if (!state.session) {
        section.append(element(document, 'p', 'rw-empty', '先新建会话或从列表明确恢复一个会话。'));
        return;
      }
      if (!state.session.sources?.length) {
        section.append(element(document, 'p', 'rw-empty', '本会话尚未加入材料。'));
        return;
      }
      const list = element(document, 'div', 'cw-session-sources');
      for (const source of state.session.sources) {
        const row = element(document, 'article', 'cw-source');
        const title = `${source.title || source.itemKey} · ${source.kind === 'note' ? '笔记' : '批注'}${sourcePageLabel(source)}`;
        const top = element(document, 'div', 'cw-toolbar');
        top.append(element(document, 'strong', '', title));
        const status = source.stale === false ? '来源版本一致' : source.stale ? `来源需核对：${source.staleReason || '当前状态变化'}` : '来源版本待核对';
        top.append(element(document, `span`, source.stale === false ? 'rw-badge rw-badge-success' : 'rw-badge rw-badge-error', status));
        const open = button(document, '打开原文', 'open-source');
        open.addEventListener('click', async () => {
          try { await openCollaborationSource(source, onRead); } catch (error) { setError(error); }
        });
        const remove = button(document, '移除', 'remove-source', 'rw-button rw-button-muted');
        remove.dataset.sourceId = source.id;
        top.append(open, remove);
        row.append(top);
        if (source.text) row.append(element(document, 'blockquote', 'cw-quote', source.text));
        if (source.comment) row.append(element(document, 'p', 'cw-comment', `研究者批注：${source.comment}`));
        list.append(row);
      }
      section.append(list);
    }

    function renderFeedbackControl(parent, draft, claim, label) {
      const box = element(document, 'div', 'cw-feedback');
      box.append(element(document, 'strong', '', `人工复核：${label}`));
      const select = element(document, 'select', 'select');
      for (const [value, title] of DECISIONS) {
        const option = element(document, 'option', '', title);
        option.value = value;
        select.append(option);
      }
      const comment = element(document, 'textarea', 'cw-feedback-comment');
      comment.rows = 2;
      comment.placeholder = '补充说明（可选）';
      const save = button(document, '记录并发送给当前 DSH 会话', 'record-feedback', 'rw-button rw-button-primary');
      save.addEventListener('click', async () => {
        save.disabled = true;
        try { await recordFeedback(draft, claim, { decision: select, comment }); }
        catch (error) { setError(error); }
        finally { save.disabled = false; }
      });
      box.append(select, comment, save);
      const prior = state.feedback.filter(entry => entry.draftId === draft.id && (claim ? entry.claimId === claim.id : entry.claimId === null));
      if (prior.length) box.append(element(document, 'p', 'rw-muted', `最近人工记录：${DECISIONS.find(([key]) => key === prior.at(-1).decision)?.[1] || prior.at(-1).decision}${prior.at(-1).comment ? ` · ${prior.at(-1).comment}` : ''}`));
      parent.append(box);
    }

    function renderDrafts(section) {
      section.append(element(document, 'h2', 'cw-heading', 'Agent 已记录内容'));
      const refresh = button(document, '刷新草稿', 'refresh-session', 'rw-button rw-button-muted');
      section.append(refresh);
      if (!state.draftSummaries.length) {
        section.append(element(document, 'p', 'rw-empty', 'Agent 尚未通过协作工具记录段落。发送任务后，完成时请 Agent 调用 collaboration_draft 保存带来源的草稿。'));
        return;
      }
      const versions = element(document, 'div', 'cw-draft-versions');
      for (const summary of [...state.draftSummaries].reverse()) {
        const open = button(document, `${summary.title || '未命名草稿'} · ${summary.paragraphCount} 段 / ${summary.claimCount} 论断 · ${new Date(summary.createdAt).toLocaleString()}`, 'load-draft', 'rw-button rw-button-muted');
        open.dataset.draftId = summary.id;
        open.setAttribute('aria-pressed', String(summary.id === state.activeDraftId));
        versions.append(open);
      }
      section.append(versions);
      const draft = state.drafts.get(state.activeDraftId);
      if (!draft) {
        section.append(element(document, 'p', 'rw-empty', '选择一个草稿版本读取完整段落和来源。'));
        return;
      }
      const card = element(document, 'article', 'cw-draft');
      card.append(element(document, 'h3', '', draft.title || '未命名草稿'));
      const changedSources = (draft.sources || []).filter(source => source.stale !== false);
      if (changedSources.length) {
        const warning = element(document, 'div', 'rw-alert cw-stale-warning');
        warning.append(element(document, 'strong', '', '历史草稿来源需要复核：'));
        const list = element(document, 'ul', '');
        for (const source of changedSources) list.append(element(document, 'li', '', `${source.title || source.itemKey}：${collaborationSourceStatus(source)}`));
        warning.append(list);
        card.append(warning);
      }
      renderFeedbackControl(card, draft, null, '整份草稿');
      const sourceMap = new Map([...(draft.sources || []), ...(state.session.sources || [])].map(source => [source.id, source]));
      for (const paragraph of draft.paragraphs || []) {
        const block = element(document, 'section', 'cw-paragraph');
        block.append(element(document, 'p', 'rw-draft-text', paragraph.text));
        appendSourceButtons(block, (paragraph.sourceIds || []).map(id => sourceMap.get(id)).filter(Boolean));
        for (const claim of paragraph.claims || []) {
          const claimBlock = element(document, 'div', 'cw-claim');
          claimBlock.append(element(document, 'p', 'rw-draft-text', `论断：${claim.text}`));
          appendSourceButtons(claimBlock, (claim.sourceIds || []).map(id => sourceMap.get(id)).filter(Boolean));
          renderFeedbackControl(claimBlock, draft, claim, claim.id);
          block.append(claimBlock);
        }
        card.append(block);
      }
      section.append(card);
    }

    function render() {
      if (state.disposed) return;
      app.replaceChildren();
      const header = element(document, 'header', 'cw-header');
      header.append(element(document, 'div', 'rw-title', 'DSH 会话协作'));
      header.append(element(document, 'p', 'rw-muted', '会话、材料、Agent 草稿与人工反馈保存在共享本机协作服务中；此入口只显式提交到当前 DSH 会话，不调用本机 Codex CLI。'));
      const targetLine = element(document, 'div', 'cw-toolbar');
      targetLine.append(element(document, 'span', state.target ? 'rw-badge rw-badge-success' : 'rw-badge rw-badge-error', state.target ? `当前目标：${state.target.label || state.target.key}` : '当前 DSH 会话不可用'));
      if (state.targetError) targetLine.append(element(document, 'span', 'rw-muted', state.targetError));
      const targetRefresh = button(document, '刷新当前会话', 'refresh-target', 'rw-button rw-button-muted');
      targetLine.append(targetRefresh);
      header.append(targetLine);
      app.append(header);

      const sessionCard = element(document, 'section', 'cw-card');
      sessionCard.append(element(document, 'h2', 'cw-heading', '明确新建或恢复'));
      const sessionRow = element(document, 'div', 'cw-toolbar');
      const chooser = element(document, 'select', 'select');
      const placeholder = element(document, 'option', '', '从本机协作会话列表选择…');
      placeholder.value = '';
      chooser.append(placeholder);
      for (const item of state.sessions) {
        const option = element(document, 'option', '', `${item.title} · ${new Date(item.updatedAt).toLocaleString()}`);
        option.value = item.id;
        option.selected = item.id === state.session?.id;
        chooser.append(option);
      }
      const resume = button(document, '恢复所选会话', 'resume-session');
      resume.addEventListener('click', async () => {
        try { await refreshSession(chooser.value); setNotice('已恢复所选协作会话。'); } catch (error) { setError(error); }
      });
      const listRefresh = button(document, '刷新列表', 'refresh-sessions', 'rw-button rw-button-muted');
      sessionRow.append(chooser, resume, listRefresh);
      const createTitle = element(document, 'input', 'cw-title-input');
      createTitle.type = 'text';
      createTitle.maxLength = 200;
      createTitle.placeholder = '新会话标题';
      const create = button(document, '新建会话', 'create-session', 'rw-button rw-button-primary');
      create.addEventListener('click', async () => {
        try {
          if (!createTitle.value.trim()) throw new Error('请先填写新会话标题。');
          const result = await call('session', { action: 'create', title: createTitle.value.trim() });
          if (!result?.session?.id) throw new Error('协作服务未确认会话已创建。');
          await refreshList();
          await refreshSession(result.session.id);
          setNotice('已创建并打开新协作会话。');
        } catch (error) { setError(error); }
      });
      sessionRow.append(createTitle, create);
      sessionCard.append(sessionRow);
      if (state.session) sessionCard.append(element(document, 'p', 'rw-muted', `当前协作会话：${state.session.title} · revision ${state.session.revision} · ${state.session.id}`));
      app.append(sessionCard);

      if (state.error) app.append(element(document, 'p', 'rw-alert cw-alert-error', state.error));
      if (state.notice) app.append(element(document, 'p', 'rw-alert cw-alert-success', state.notice));
      if (state.feedbackPending) {
        const pending = element(document, 'div', 'rw-alert', '人工反馈已写入共享会话，但尚未确认发送到 DSH。');
        const retry = button(document, '重试发送反馈', 'retry-feedback', 'rw-button rw-button-primary');
        retry.addEventListener('click', async () => { retry.disabled = true; try { await deliverPendingFeedback(); } catch (error) { setError(error); } finally { retry.disabled = false; } });
        pending.append(retry);
        app.append(pending);
      }

      const layout = element(document, 'div', 'cw-grid');
      const materials = element(document, 'section', 'cw-card');
      renderMaterialPicker(materials);
      const sources = element(document, 'section', 'cw-card');
      renderSources(sources);
      layout.append(materials, sources);
      app.append(layout);

      const taskCard = element(document, 'section', 'cw-card');
      taskCard.append(element(document, 'h2', 'cw-heading', '提交材料与任务到当前 DSH Agent'));
      taskCard.append(element(document, 'p', 'rw-muted', '发送前会重新读取当前宿主会话身份；若会话切换，宿主会拒绝投递。已有输入草稿会以安全插入方式追加，保留引用 chip。'));
      const task = element(document, 'textarea', 'cw-task');
      task.rows = 5;
      task.maxLength = MAX_TASK_CHARS;
      task.placeholder = '写明当前要完成的分析或写作任务…';
      task.value = state.task;
      task.addEventListener('input', () => { state.task = task.value; });
      const send = button(document, '提问 / 写作并发送', 'submit-task', 'rw-button rw-button-primary');
      send.disabled = !state.session || !state.session.sources?.length;
      taskCard.append(task, send);
      app.append(taskCard);

      const draftsCard = element(document, 'section', 'cw-card');
      renderDrafts(draftsCard);
      app.append(draftsCard);
    }

    app.addEventListener('click', async event => {
      const action = event.target?.closest?.('[data-cw-action]')?.dataset?.cwAction;
      if (action === 'refresh-materials') {
        try { await refreshMaterials(); } catch (error) { state.materialError = error?.message || String(error); scheduleRender(); }
      } else if (action === 'add-materials') {
        try { await addPickedSources(); } catch (error) { setError(error); }
      } else if (action === 'refresh-session') {
        try { await refreshSession(); } catch (error) { setError(error); }
      } else if (action === 'refresh-sessions') await refreshList();
      else if (action === 'refresh-target') await refreshTarget();
      else if (action === 'load-draft') {
        const draftId = event.target.closest('[data-draft-id]')?.dataset.draftId;
        if (draftId) { try { await loadDraft(draftId); } catch (error) { setError(error); } }
      }
      else if (action === 'remove-source') {
        const sourceId = event.target.closest('[data-source-id]')?.dataset.sourceId;
        const buttonNode = event.target.closest('[data-cw-action="remove-source"]');
        if (sourceId) {
          if (buttonNode) buttonNode.disabled = true;
          try { await removeSource(sourceId); } catch (error) { setError(error); }
        }
      } else if (action === 'submit-task') {
        const buttonNode = event.target.closest('[data-cw-action="submit-task"]');
        if (buttonNode) buttonNode.disabled = true;
        try { await submitTask(); } catch (error) { setError(error); }
        finally { if (buttonNode) buttonNode.disabled = false; }
      }
    });

    render();
    refreshList();
    refreshTarget();
    return () => {
      state.disposed = true;
      host.replaceChildren();
    };
  }

  return mount;
})();
