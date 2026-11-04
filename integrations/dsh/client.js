// zotero-workbench-dsh — Client half.
//
// 两个界面入口：
//   1. 左侧边栏入口（sidebar.panellist）+ 全页工作区（main 槽，key = zotero-workbench）
//      —— iframe 加载 /zotero-workbench/app/?mode=workspace（文库浏览、多选、详情、引用、PDF 阅读）
//   2. 右栏 tab（dsh-better-sidebar）—— iframe 加载 /zotero-workbench/app/?mode=sidebar（紧凑阅读器）
//
// 两个 iframe 都通过同源 postMessage 与这里通信，由本文件调用 DSH 客户端服务：
//   - add-to-chat / ask：写入当前会话输入框（必要时自动提交）
//   - open-zotero：POST /zotero-workbench/api/open（zotero:// 深链，由 Host 半侧打开）
//   - open-workspace：切到全页工作区面板
//
// 硬约束：__ModuleLoader__ 形态；id 与 package.json name 相同；只 require('react')；
// 跨插件服务一律嵌套 ctx.plugin 等待，静态 inject 只放 always-on 的 slots。
window.__ModuleLoader__.load({
  id: 'zotero-workbench-dsh',
  factory(require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    // Host 半的阅读器路由前缀（相对，兼容反代目录前缀）。
    var APP_RELATIVE = 'zotero-workbench/app/';
    var OPEN_API_RELATIVE = 'zotero-workbench/api/open';
    var WORKSPACE_ID = 'zotero-workbench';
    var TAB_ID = 'zotero-workbench:reader';
    var HOST_SOURCE = 'zotero-workbench-host';
    var APP_SOURCE = 'zotero-workbench';
    // 角标链接：https://zotero-wb.invalid/c/<citationId>
    // 用 https 伪域名是刻意的：DSH 聊天 markdown 只允许 http(s)/mailto，
    // 且 dsh-better-sidebar 的外部链接接管只接管 http(s) 链接。
    var CITATION_HOST = 'zotero-wb.invalid';
    var CITATION_HREF_PREFIX = 'https://' + CITATION_HOST + '/c/';
    var CITATION_PATTERN = /^https:\/\/zotero-wb\.invalid\/c\/([a-f0-9]{12})$/;
    var runtimeCtx = null;
    var pendingWorkspaceCitation = null;
    var workspaceCitationNonce = '';
    var workspaceFrame = null;
    var readerFrame = null;
    var lastReaderReadyAt = 0;

    /** 页面目录基址：剥掉 query（启动 token 在 query 里）与 hash，强制以 / 结尾。 */
    function directoryBase() {
      var raw = (typeof document !== 'undefined' && document.baseURI) || 'http://dsh.invalid/';
      var url = new URL(raw, 'http://dsh.invalid/');
      url.search = '';
      url.hash = '';
      if (url.pathname.charAt(url.pathname.length - 1) !== '/') url.pathname += '/';
      return url.href;
    }

    function appUrl(mode) {
      var url = new URL(APP_RELATIVE, directoryBase());
      url.searchParams.set('mode', mode);
      return url.href;
    }

    function openApiUrl() {
      return new URL(OPEN_API_RELATIVE, directoryBase()).href;
    }

    function citationIdFromHref(href) {
      if (typeof href !== 'string') return null;
      var match = CITATION_PATTERN.exec(href);
      return match ? match[1] : null;
    }

    function newCitationNonce() {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function revealCitationTo(frame, id, nonce) {
      if (!frame || !frame.contentWindow || !id) return;
      try {
        frame.contentWindow.postMessage({
          source: HOST_SOURCE,
          type: 'reveal-citation',
          payload: { id: id, nonce: nonce || '' },
        }, window.location.origin);
      } catch (error) { /* 未加载完成时忽略，稍后会重试 */ }
    }

    function betterSidebarOf(ctx) {
      try {
        if (!ctx) return null;
        var service = ctx.get('betterSidebar');
        return service && typeof service.registerTab === 'function' ? service : null;
      } catch (error) {
        return null;
      }
    }

    function openCitationFallback(id) {
      pendingWorkspaceCitation = id;
      workspaceCitationNonce = newCitationNonce();
      try {
        var layout = runtimeCtx && runtimeCtx.get('layout');
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(WORKSPACE_ID);
      } catch (error) { /* ignore */ }
      var frame = workspaceFrame;
      if (frame) {
        var nonce = workspaceCitationNonce;
        window.setTimeout(function () {
          revealCitationTo(frame, id, nonce);
          if (pendingWorkspaceCitation === id) pendingWorkspaceCitation = null;
        }, 400);
      }
    }

    /** descriptor.icon / panellist icon 的两种调用约定都兼容：number 或 { size }。 */
    function iconSizeOf(sizeArg) {
      if (typeof sizeArg === 'number' && sizeArg > 0) return sizeArg;
      if (sizeArg && typeof sizeArg.size === 'number' && sizeArg.size > 0) return sizeArg.size;
      return 16;
    }

    function ReaderIcon(sizeArg) {
      var s = iconSizeOf(sizeArg);
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3.5 2.5h5l2.5 2.5h1.5v8.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z' }),
        h('path', { d: 'M8.5 2.5V5h2.5' }),
        h('path', { d: 'M5 8h6M5 10.5h4' }),
      );
    }

    // ---- 两个 iframe 容器 --------------------------------------------------
    var SIDEBAR_ROOT_STYLE = {
      display: 'flex', flexDirection: 'column', flex: '1 1 auto',
      width: '100%', height: '100%', minWidth: 0, minHeight: 0,
      overflow: 'hidden', background: 'var(--dsw-alias-bg-base)',
    };
    var FRAME_STYLE = {
      flex: '1 1 auto', width: '100%', height: '100%', minHeight: 0,
      border: 0, display: 'block', background: 'transparent', colorScheme: 'normal',
    };
    var WORKSPACE_ROOT_STYLE = {
      position: 'relative', width: '100%', height: '100%',
      minWidth: 0, minHeight: 0, overflow: 'hidden',
      background: 'var(--dsw-alias-bg-base)',
    };
    var WORKSPACE_FRAME_STYLE = {
      position: 'absolute', inset: 0, display: 'block',
      width: '100%', height: '100%', border: 0,
      background: 'transparent', colorScheme: 'normal',
    };

    /** 右栏 tab：紧凑阅读器（mode=sidebar）；tab.path 携带角标 URL。 */
    function ZoteroReaderTab(props) {
      var frameRef = React.useRef(null);
      var visible = !props || props.visible !== false;
      var tabPath = props && props.tab ? props.tab.path : undefined;
      var citationId = citationIdFromHref(tabPath);

      React.useEffect(function () {
        readerFrame = frameRef.current;
        return function () {
          if (readerFrame === frameRef.current) readerFrame = null;
        };
      }, []);

      React.useEffect(function () {
        var frame = frameRef.current;
        if (!frame || !frame.contentWindow) return;
        try {
          frame.contentWindow.postMessage({ source: 'zotero-workbench-host', type: 'visibility', visible: visible }, window.location.origin);
        } catch (error) { /* 未加载完成时忽略 */ }
      }, [visible]);

      // 角标 URL 变化（或 tab 首次挂载）后，把 citation id 交给阅读器。
      // 子页会把早到的消息排队；这里仍重发两次，覆盖 iframe 冷启动的时序。
      React.useEffect(function () {
        if (!citationId) return;
        var frame = frameRef.current;
        // 同一次点击的所有重发共用一个 nonce：子页只处理一次，
        // 不会把用户刚关闭的浮层重新打开；再次点击角标会生成新 nonce。
        var nonce = newCitationNonce();
        var timers = [
          window.setTimeout(function () { revealCitationTo(frame, citationId, nonce); }, 500),
          window.setTimeout(function () { revealCitationTo(frame, citationId, nonce); }, 1600),
        ];
        try {
          var sidebar = betterSidebarOf(runtimeCtx);
          if (sidebar && typeof sidebar.updateTab === 'function' && props && props.tab) {
            sidebar.updateTab(props.tab.id, { title: 'Zotero 原文' });
          }
        } catch (error) { /* ignore */ }
        return function () {
          timers.forEach(function (timer) { window.clearTimeout(timer); });
        };
      }, [citationId]);

      function onLoad() { readerFrame = frameRef.current; }
      return h('div', { style: SIDEBAR_ROOT_STYLE },
        h('iframe', {
          ref: frameRef,
          src: appUrl('sidebar'),
          onLoad: onLoad,
          title: 'Zotero 文献阅读器',
          style: FRAME_STYLE,
          allow: 'fullscreen',
        }));
    }

    /** 全页工作区（mode=workspace）：左侧边栏入口或 layout.selectPanel 打开。 */
    function ZoteroWorkspace() {
      var frameRef = React.useRef(null);
      React.useEffect(function () {
        workspaceFrame = frameRef.current;
        return function () {
          if (workspaceFrame === frameRef.current) workspaceFrame = null;
        };
      }, []);
      function onLoad() {
        var frame = frameRef.current;
        workspaceFrame = frame;
        if (pendingWorkspaceCitation) {
          var id = pendingWorkspaceCitation;
          var nonce = workspaceCitationNonce;
          pendingWorkspaceCitation = null;
          window.setTimeout(function () { revealCitationTo(frame, id, nonce); }, 300);
        }
      }
      return h('div', { style: WORKSPACE_ROOT_STYLE },
        h('iframe', {
          ref: frameRef,
          src: appUrl('workspace'),
          title: 'Zotero 文献工作台',
          style: WORKSPACE_FRAME_STYLE,
          allow: 'fullscreen',
          onLoad: onLoad,
        }));
    }

    // ---- 会话集成 ----------------------------------------------------------
    function hasText(value) {
      return typeof value === 'string' && value.trim() !== '';
    }

    /** 当前处于主视图的会话 binding（uiSession.adapter.current）。 */
    function currentSession(ctx) {
      try {
        var uiSession = ctx.get('uiSession');
        var source = uiSession && uiSession.adapter && uiSession.adapter.current;
        var snapshot = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined;
        if (!snapshot || typeof snapshot.key !== 'string' || snapshot.key === '') return null;
        return snapshot;
      } catch (error) {
        return null;
      }
    }

    function sessionContextOf(ctx, snapshot) {
      if (snapshot && snapshot.ctx) return snapshot.ctx;
      try {
        var sessions = ctx.get('sessions');
        if (sessions && typeof sessions.scope === 'function' && snapshot && snapshot.key) return sessions.scope(snapshot.key);
      } catch (error) { /* ignore */ }
      return undefined;
    }

    /** 输入框编辑器投影：chip 在编辑器里占 1 个字符，跨 chip 的偏移要折叠。 */
    function foldedOffset(draft, occurrences, at) {
      var folded = at;
      var list = Array.isArray(occurrences) ? occurrences : [];
      for (var i = 0; i < list.length; i += 1) {
        var occurrence = list[i];
        if (!occurrence) continue;
        var offset = Number(occurrence.offset) || 0;
        var length = Number(occurrence.length) || 0;
        if (offset + length <= at) folded -= Math.max(0, length - 1);
      }
      return Math.max(0, folded);
    }

    function hasSafeOccurrences(draft, occurrences) {
      if (!Array.isArray(occurrences)) return false;
      var spans = occurrences.map(function (entry) {
        return { offset: Number(entry && entry.offset), length: Number(entry && entry.length) };
      }).sort(function (a, b) { return a.offset - b.offset; });
      var previousEnd = 0;
      for (var i = 0; i < spans.length; i += 1) {
        var span = spans[i];
        if (!Number.isInteger(span.offset) || !Number.isInteger(span.length) || span.offset < previousEnd ||
            span.length < 1 || span.offset + span.length > draft.length) return false;
        previousEnd = span.offset + span.length;
      }
      return true;
    }

    function leadFor(draft) {
      if (!hasText(draft)) return '';
      return /\s$/.test(draft) ? '' : ' ';
    }

    function sessionLabel(snapshot) {
      var props = snapshot && snapshot.props ? snapshot.props : {};
      var label = snapshot && (snapshot.title || snapshot.name) || props.title || props.subject || '';
      if (hasText(label)) return String(label).trim().slice(0, 100);
      var key = snapshot && typeof snapshot.key === 'string' ? snapshot.key : '';
      return key ? '当前会话 · ' + key.slice(-8) : '当前会话';
    }

    function sessionDescriptor(ctx) {
      var snapshot = currentSession(ctx);
      return snapshot ? { key: snapshot.key, label: sessionLabel(snapshot) } : null;
    }

    /**
     * 只通过当前会话的 conversation.input 安全追加文本；不调用 Codex CLI，
     * 不使用 inputActions.setDraft 兜底覆盖已有草稿或引用 chip。
     */
    function appendToCurrentDraft(ctx, snapshot, text, { requireSubmit = false } = {}) {
      if (!hasText(text)) throw new Error('没有可加入对话的内容。');
      if (!snapshot || typeof snapshot.key !== 'string' || snapshot.key === '') {
        throw new Error('当前会话身份不可用，请重新选择目标会话。');
      }
      var actions = snapshot.props ? snapshot.props.inputActions : undefined;
      if (requireSubmit && (!actions || typeof actions.submit !== 'function')) {
        throw new Error('当前 DSH 会话没有可用的发送操作；内容未加入输入框。');
      }
      var actx = sessionContextOf(ctx, snapshot);
      var conversation = null;
      try { conversation = ctx.get('conversation'); } catch (error) { conversation = null; }
      var input = null;
      if (conversation && conversation.input && typeof conversation.input.for === 'function' && actx) {
        try { input = conversation.input.for(actx); } catch (error) { input = null; }
      }
      if (input && input.state && typeof input.state.getSnapshot === 'function') {
        var state = input.state.getSnapshot() || {};
        if (typeof state.draft !== 'string') {
          throw new Error('当前 DSH 输入框未提供可核对的草稿状态；内容未加入。');
        }
        var draft = typeof state.draft === 'string' ? state.draft : '';
        if (!hasSafeOccurrences(draft, state.occurrences)) {
          throw new Error('当前 DSH 输入框未提供有效的引用 chip 位置；内容未加入。');
        }
        var chips = state.occurrences;
        var payload = leadFor(draft) + text;
        var chipped = chips.length > 0 || state.phase === 'claimed';
        if (chipped && state.draftRev !== undefined && state.draftRev !== null && actx && typeof actx.emit === 'function') {
          var at = draft.length;
          var start = foldedOffset(draft, chips, at);
          actx.emit('slash/input-insert-text', { text: payload, span: { draftRev: state.draftRev, start: start, end: start } });
        } else if (!chipped && typeof input.setDraft === 'function') {
          input.setDraft(draft + payload);
        } else {
          throw new Error('当前输入框无法安全保留引用 chip；内容未加入。');
        }
      } else {
        throw new Error('当前 DSH 版本未提供安全的会话输入框接口；内容未加入。');
      }
      return actions;
    }

    function submitDraft(actions) {
      if (actions && typeof actions.submit === 'function') {
        actions.submit();
        return true;
      }
      return false;
    }

    function describeError(error) {
      if (error instanceof Error && error.message) return error.message;
      return String(error || '未知错误');
    }

    function buildRefsText(payload) {
      var items = payload && Array.isArray(payload.items) ? payload.items : [];
      var lines = [];
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i] || {};
        var title = item.title || item.key || '未命名条目';
        var meta = item.meta ? '（' + item.meta + '）' : '';
        lines.push('- ' + title + meta + (item.key ? ' — zotero://select/library/items/' + item.key : ''));
      }
      return lines.join('\n');
    }

    // ---- postMessage 桥 ----------------------------------------------------
    function reply(source, payload) {
      if (!source) return;
      try { source.postMessage(payload, window.location.origin); } catch (error) { /* ignore */ }
    }

    function ack(source, id, ok, message, payload) {
      reply(source, { source: HOST_SOURCE, type: 'ack', id: id, ok: !!ok, message: message || '', payload: payload || null });
    }

    function openInZotero(ctx, payload) {
      var body = {
        kind: payload && payload.kind === 'pdf' ? 'pdf' : 'item',
        key: payload && typeof payload.key === 'string' ? payload.key : '',
        attachmentKey: payload && typeof payload.attachmentKey === 'string' ? payload.attachmentKey : undefined,
        page: payload && Number.isFinite(Number(payload.page)) ? Number(payload.page) : undefined,
        annotationKey: payload && typeof payload.annotationKey === 'string' ? payload.annotationKey : undefined,
      };
      return fetch(openApiUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok || (data && data.ok === false)) {
            throw new Error((data && data.error && data.error.message) || ('HTTP ' + response.status));
          }
          return data;
        });
      });
    }

    function selectWorkspacePanel(ctx) {
      try {
        var layout = ctx.get('layout');
        if (layout && typeof layout.selectPanel === 'function') {
          layout.selectPanel(WORKSPACE_ID);
          return true;
        }
      } catch (error) { /* ignore */ }
      return false;
    }

    /** 提问自动发送后回到会话面板，让用户直接看到回答（仅在当前停在工作区时切换）。 */
    function returnToConversation(ctx) {
      try {
        var layout = ctx.get('layout');
        if (!layout || typeof layout.selectPanel !== 'function') return;
        var info = layout.panelInfo && typeof layout.panelInfo.getSnapshot === 'function' ? layout.panelInfo.getSnapshot() : null;
        if (info && info.activePanelId !== WORKSPACE_ID) return;
        layout.selectPanel(null);
      } catch (error) { /* ignore */ }
    }

    function handleMessage(ctx, event) {
      if (event.origin !== window.location.origin) return;
      var data = event.data;
      if (!data || data.source !== APP_SOURCE || typeof data.type !== 'string') return;
      var id = data.id;
      if ((data.type === 'current-session' || data.type === 'collaboration-submit') &&
          (!workspaceFrame || event.source !== workspaceFrame.contentWindow) &&
          (!readerFrame || event.source !== readerFrame.contentWindow)) return;
      if (data.type === 'ready') {
        lastReaderReadyAt = Date.now();
        reply(event.source, {
          source: HOST_SOURCE, type: 'hello', mode: 'dsh',
          capabilities: ['add-to-chat', 'ask', 'current-session', 'collaboration-submit', 'open-zotero', 'open-workspace', 'reveal-citation'],
        });
        var pending = pendingWorkspaceCitation;
        if (pending && workspaceFrame && event.source === workspaceFrame.contentWindow) {
          pendingWorkspaceCitation = null;
          reply(event.source, { source: HOST_SOURCE, type: 'reveal-citation', payload: { id: pending, nonce: workspaceCitationNonce } });
        }
        return;
      }
      if (data.type === 'current-session') {
        var descriptor = sessionDescriptor(ctx);
        ack(event.source, id, !!descriptor, descriptor ? '' : '当前没有打开的 DSH 会话。', { session: descriptor });
        return;
      }
      if (data.type === 'open-workspace') {
        var opened = selectWorkspacePanel(ctx);
        ack(event.source, id, opened, opened ? '' : '未找到 Zotero 工作区面板。');
        return;
      }
      if (data.type === 'open-compact-reader') {
        // 全页工作台的「紧凑模式」按钮：打开/复用右栏阅读器 tab。
        // 注意：workspace 是全局 main 面板，显示时右侧边栏没有挂载的会话
        // （sidebarRight.mounted 为 undefined），直接 openTab 会被排队。
        // 先切回会话，让右侧边栏有 mounted session，再打开 tab。
        try {
          var layout = ctx.get('layout');
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null);
        } catch (error) { /* ignore */ }
        var sidebar = betterSidebarOf(ctx);
        window.setTimeout(function () {
          var ok = false;
          if (sidebar && typeof sidebar.openTab === 'function') {
            try {
              sidebar.openTab({ type: TAB_ID, path: 'zotero-workbench:reader', title: 'Zotero 文献' });
              ok = true;
            } catch (error) { ok = false; }
          }
          ack(event.source, id, ok, ok ? '已在右侧边栏打开阅读器' : '当前环境没有右侧边栏，请使用全页工作台。');
        }, 350);
        return;
      }
      if (data.type === 'open-zotero') {
        openInZotero(ctx, data.payload).then(function (result) {
          ack(event.source, id, true, result && result.url ? result.url : '');
        }).catch(function (error) {
          ack(event.source, id, false, describeError(error));
        });
        return;
      }
      if (data.type === 'add-to-chat' || data.type === 'ask') {
        var snapshot = currentSession(ctx);
        if (!snapshot) {
          ack(event.source, id, false, '当前没有打开的会话，请先在左侧打开或新建一个对话。');
          return;
        }
        var payload = data.payload || {};
        var text = hasText(payload.text) ? payload.text : buildRefsText(payload);
        if (data.type === 'ask' && hasText(payload.question)) {
          text = payload.question + (hasText(payload.context) ? '\n\n' + payload.context : '');
        }
        if (data.type === 'add-to-chat' && !hasText(payload.text) && hasText(buildRefsText(payload))) {
          text = '请参考以下 Zotero 文献：\n' + buildRefsText(payload);
        }
        try {
          var actions = appendToCurrentDraft(ctx, snapshot, text);
          var submitted = false;
          if (data.type === 'ask') submitted = submitDraft(actions);
          if (submitted) returnToConversation(ctx);
          ack(event.source, id, true, submitted ? '已发送' : '已加入输入框');
        } catch (error) {
          ack(event.source, id, false, describeError(error));
        }
        return;
      }
      if (data.type === 'collaboration-submit') {
        var target = data.payload || {};
        var snapshot = currentSession(ctx);
        if (!snapshot) {
          ack(event.source, id, false, '当前没有打开的 DSH 会话；内容未发送。');
          return;
        }
        if (typeof target.targetSessionKey !== 'string' || target.targetSessionKey !== snapshot.key) {
          ack(event.source, id, false, '当前会话已变化或目标未确认；内容未加入，请刷新目标会话后重试。');
          return;
        }
        if (!hasText(target.text) || target.text.length > 50000) {
          ack(event.source, id, false, '协作任务内容为空或超过 50000 字符；内容未加入。');
          return;
        }
        try {
          var actions = appendToCurrentDraft(ctx, snapshot, target.text, { requireSubmit: true });
          if (!submitDraft(actions)) throw new Error('当前 DSH 会话没有可用的发送操作；内容未发送。');
          returnToConversation(ctx);
          ack(event.source, id, true, '已提交到 ' + sessionLabel(snapshot), { session: { key: snapshot.key, label: sessionLabel(snapshot) } });
        } catch (error) {
          ack(event.source, id, false, describeError(error));
        }
        return;
      }
    }

    function installBridge(ctx) {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return function () {};
      var onMessage = function (event) { handleMessage(ctx, event); };
      window.addEventListener('message', onMessage);
      return function () { window.removeEventListener('message', onMessage); };
    }

    // ---- 注册 --------------------------------------------------------------
    function registerMainSurface(sctx) {
      return function () {
        var disposers = [];
        disposers.push(sctx.slots.inject('main', function () {
          return sctx.slots.register({ name: 'main', key: WORKSPACE_ID }, ZoteroWorkspace);
        }));
        disposers.push(sctx.slots.inject('sidebar.panellist', function () {
          return sctx.slots.register({
            name: 'sidebar.panellist',
            id: WORKSPACE_ID,
            order: 12,
            label: function () { return 'Zotero 工作台'; },
          }, function ZoteroPanelIcon(props) { return ReaderIcon(iconSizeOf(props)); });
        }));
        disposers.push(sctx.effect(function () { return installBridge(sctx); }, 'zotero-workbench: iframe bridge'));
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch (error) { /* ignore */ }
          }
        };
      };
    }

    function registerReaderTab(sctx) {
      sctx.plugin({
        inject: ['betterSidebar'],
        apply: function (sidebarCtx) {
          var betterSidebar = sidebarCtx.betterSidebar;
          if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') return;
          sidebarCtx.effect(function () {
            return betterSidebar.registerTab({
              id: TAB_ID,
              title: 'Zotero 文献',
              description: '浏览 Zotero 文库、阅读 PDF 与批注；完整工作台见左侧 Zotero 入口',
              order: 120,
              single: true,
              // 接管聊天里的角标链接：https://zotero-wb.invalid/c/<citationId>
              // （DSH 的外部链接接管只处理 http(s)，所以角标必须用 https 伪域名）
              urlTarget: function (url) {
                if (url.protocol !== 'https:' || url.hostname !== CITATION_HOST) return false;
                return CITATION_PATTERN.test(url.href);
              },
              icon: function (sizeArg) { return ReaderIcon(iconSizeOf(sizeArg)); },
              component: ZoteroReaderTab,
            });
          }, 'zotero-workbench: right-sidebar reader tab');
        },
      });
    }

    function injectCitationStyles() {
      if (typeof document === 'undefined' || !document.head) return function () {};
      var style = document.createElement('style');
      style.setAttribute('data-zotero-workbench', 'citation-badges');
      style.textContent = [
        'a[href^="https://zotero-wb.invalid/c/"]{',
        '  display:inline-block;font-size:.72em;line-height:1;vertical-align:super;',
        '  padding:0 .28em;margin:0 .12em;border-radius:4px;font-weight:600;',
        '  text-decoration:none;color:var(--dsw-alias-brand-primary,#2f51f9);',
        '  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#2f51f9) 14%, transparent);',
        '}',
        'a[href^="https://zotero-wb.invalid/c/"]:hover{',
        '  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#2f51f9) 26%, transparent);',
        '}',
      ].join('\n');
      document.head.appendChild(style);
      return function () { style.remove(); };
    }

    /**
     * 角标链接兜底路由：无论 better-sidebar 是否接管，都自己拦截角标链接。
     * 原因：better-sidebar 的 urlTarget 只在「tab 类型已注册且未禁用」时接管；
     * 若页面还停留在旧 client 模块、或该 tab 类型被禁用，链接会落到浏览器，
     * 打开 https://zotero-wb.invalid/... 并显示 ERR_CONNECTION_CLOSED。
     * 这里先 preventDefault，再优先走 betterSidebar.openTab，失败则打开全页工作台。
     */
    function installCitationFallback() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return function () {};
      function handleAnchor(anchor) {
        var id = citationIdFromHref(anchor && anchor.href);
        if (!id) return false;
        var sidebar = betterSidebarOf(runtimeCtx);
        var opened = false;
        if (sidebar && typeof sidebar.openTab === 'function') {
          try {
            sidebar.openTab({ type: TAB_ID, url: anchor.href, title: 'Zotero 原文' });
            opened = true;
          } catch (error) { opened = false; }
        }
        if (opened) {
          // tab 类型可能被用户在侧边卡设置里禁用：openTab 会静默返回。
          // 1s 后只认「可见的」阅读器 iframe（隐藏 tab 宽度为 0），且没有新的 ready 握手，
          // 才退回全页工作台；避免旧 iframe 造成假成功。
          window.setTimeout(function () {
            var visibleFrame = false;
            var frames = document.querySelectorAll('iframe[src*="mode=sidebar"]');
            for (var i = 0; i < frames.length; i += 1) {
              var rect = frames[i].getBoundingClientRect();
              if (rect.width > 40 && rect.height > 40) { visibleFrame = true; break; }
            }
            var freshReady = Date.now() - lastReaderReadyAt < 1600;
            if (!visibleFrame && !freshReady) openCitationFallback(id);
          }, 1000);
        } else {
          openCitationFallback(id);
        }
        return true;
      }
      function onClick(event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        var anchor = target.closest('a[href]');
        if (!anchor) return;
        var id = citationIdFromHref(anchor.href);
        if (!id) return;
        // 中键/滚轮点击也必须兜底：否则浏览器会直接打开
        // https://zotero-wb.invalid/... 并显示 ERR_CONNECTION_CLOSED。
        // 在 window 捕获阶段先于 dsh-better-sidebar 的 document 监听处理。
        event.preventDefault();
        event.stopPropagation();
        handleAnchor(anchor);
      }
      window.addEventListener('click', onClick, true);
      window.addEventListener('auxclick', onClick, true);
      return function () {
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('auxclick', onClick, true);
      };
    }

    function apply(ctx) {
      // slots 是 always-on 的核心服务；其余跨插件服务都在使用时惰性获取（ctx.get），
      // betterSidebar 用嵌套 ctx.plugin 等待，避免静态 inject pending 拖垮 Web GUI boot。
      ctx.plugin({
        inject: ['slots'],
        apply: function (slotsCtx) {
          runtimeCtx = slotsCtx;
          slotsCtx.effect(registerMainSurface(slotsCtx), 'zotero-workbench: main surface');
          slotsCtx.effect(function () { return injectCitationStyles(); }, 'zotero-workbench: citation badge styles');
          slotsCtx.effect(function () { return installCitationFallback(); }, 'zotero-workbench: citation click fallback');
          registerReaderTab(slotsCtx);
        },
      });
    }

    return { name: 'zotero-workbench-dsh', apply: apply };
  },
});
