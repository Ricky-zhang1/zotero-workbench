#!/usr/bin/env node
// Test-only Codex-native MCP Apps host for inspecting the compiled panel in a browser.
// It uses this repository's real StdioClient/server, but never connects to a Codex chat.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { StdioClient } from '../tests/mcp-client.mjs';

const PANEL_URI = 'ui://zotero/panel.html';
const DISPLAY_MODES = new Set(['inline', 'fullscreen']);
const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
const READ_ONLY_TOOLS = new Set([
  'open_workbench', 'workbench_state', 'workbench_status', 'panel_refresh',
  'list_collections', 'search_library', 'get_item', 'search_annotations',
  'read_fulltext', 'find_in_pdf', 'cite', 'open_item', 'show_items',
  'clear_highlights', 'collect_evidence', 'research_materials', 'research_job',
  'review_operation', 'inspect_item', 'lookup_journal_levels', 'render_reading_card',
  'library_maintenance', 'export_selection', 'citation_source_list', 'read_page_text'
]);
const PREPARE_TOOLS = new Set(['prepare_reader_annotation_trash', 'prepare_library_action']);
const DENIED_TOOL_NAMES = new Set([
  'start_research_job', 'cancel_research_job', 'trash_reader_annotation',
  'commit_library_action', 'save_reader_highlights', 'create_reader_highlight',
  'highlight', 'save_highlights', 'add_item', 'attach_pdf',
  'update_item', 'add_note', 'create_collection', 'authorize_writes', 'review_evidence',
  'register_citation'
]);
const MAX_RPC_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ENTRIES = 120;
const MAX_LOG_TEXT = 1400;

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function boundedText(value, max = MAX_LOG_TEXT) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  if (text.length > max) return `${text.slice(0, max)}… [已截断]`;
  return text;
}

function isAllowedResourceUri(uri) {
  if (typeof uri !== 'string' || uri.length > 1200) return false;
  let decoded;
  try { decoded = decodeURIComponent(uri); } catch { return false; }
  if (decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part === '.')) return false;
  if (uri === PANEL_URI || uri === 'ui://zotero/state.json') return true;
  return [
    /^ui:\/\/zotero\/setup\/check\/[A-Za-z0-9]+$/,
    /^ui:\/\/zotero\/lib\/(?:user|g[1-9]\d*)\/collections\.json$/,
    /^ui:\/\/zotero\/lib\/(?:user|g[1-9]\d*)\/items\/[A-Za-z0-9_-]{1,1200}\.json$/,
    /^ui:\/\/zotero\/lib\/(?:user|g[1-9]\d*)\/(?:item|annotations)\/[A-Z0-9]{8}\.json$/,
    /^ui:\/\/zotero\/lib\/(?:user|g[1-9]\d*)\/pdf\/[A-Z0-9]{8}\/info\.json$/,
    /^ui:\/\/zotero\/lib\/(?:user|g[1-9]\d*)\/pdf\/[A-Z0-9]{8}\/\d+$/,
    /^ui:\/\/zotero\/pdfjs\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/
  ].some(pattern => pattern.test(uri));
}

function createFixture({ client, toolMap, panelHtml, initialMode = 'fullscreen' }) {
  const logs = [];
  const appModes = new Set();
  const state = { mode: DISPLAY_MODES.has(initialMode) ? initialMode : 'fullscreen', initialized: false };
  const record = (kind, message) => {
    logs.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind, message: boundedText(message) });
    if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  };

  function assertToolAllowed(name, args = {}) {
    const tool = toolMap.get(name);
    if (!tool) throw new RpcError(-32001, `Fixture 未知工具：${name}`);
    if (DENIED_TOOL_NAMES.has(name)) throw new RpcError(-32001, `Fixture 安全策略已阻止工具：${name}`);
    const prepare = PREPARE_TOOLS.has(name);
    if (!prepare && !READ_ONLY_TOOLS.has(name)) throw new RpcError(-32001, `Fixture 默认拒绝未列入白名单的工具：${name}`);
    if (tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint !== true)
      throw new RpcError(-32001, `Fixture 只允许只读工具或 prepare 预览：${name}`);
    if (name === 'lookup_journal_levels' && args?.online === true)
      throw new RpcError(-32001, 'Fixture 禁止触发在线期刊查询。');
    return { tool, prepare };
  }

  async function dispatch(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      throw new RpcError(-32600, '无效的 JSON-RPC 请求。');
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    const hasId = Object.hasOwn(message, 'id');
    switch (message.method) {
      case 'ui/initialize': {
        const appInfo = params.appInfo;
        const appCapabilities = params.appCapabilities;
        const requestedProtocol = params.protocolVersion;
        if (!appInfo || typeof appInfo.name !== 'string' || typeof appInfo.version !== 'string'
            || !appCapabilities || typeof requestedProtocol !== 'string')
          throw new RpcError(-32602, 'ui/initialize 缺少 appInfo、appCapabilities 或 protocolVersion。');
        appModes.clear();
        for (const mode of Array.isArray(appCapabilities.availableDisplayModes) ? appCapabilities.availableDisplayModes : [])
          if (DISPLAY_MODES.has(mode)) appModes.add(mode);
        if (appModes.size === 0) appModes.add('inline');
        if (!appModes.has(state.mode)) state.mode = appModes.has('fullscreen') ? 'fullscreen' : 'inline';
        state.initialized = true;
        record('协议', `ui/initialize · ${appInfo.name} ${appInfo.version} · ${requestedProtocol}`);
        return {
          protocolVersion: PROTOCOL_VERSIONS.has(requestedProtocol) ? requestedProtocol : '2025-11-25',
          hostInfo: { name: 'codex-native-panel-fixture', version: '0.1.0' },
          hostCapabilities: {
            serverTools: {},
            serverResources: {},
            openLinks: {},
            logging: {},
            message: { text: {} },
            updateModelContext: { text: {} }
          },
          hostContext: {
            theme: 'light',
            displayMode: state.mode,
            availableDisplayModes: [...appModes],
            locale: 'zh-CN',
            userAgent: 'codex-native-panel-fixture/0.1.0',
            platform: 'desktop'
          }
        };
      }
      case 'ui/notifications/initialized':
        state.initialized = true;
        record('协议', 'ui/notifications/initialized');
        return undefined;
      case 'ui/notifications/size-changed':
        record('面板尺寸通知', params);
        return undefined;
      case 'tools/call': {
        if (!state.initialized) throw new RpcError(-32002, '请先完成 ui/initialize 握手。');
        const name = params.name;
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
        const { prepare } = assertToolAllowed(name, args);
        record(prepare ? 'Prepare 预览' : '工具读取', `${name} · 参数字段：${Object.keys(args).join(', ') || '无'}`);
        const result = await client.call(name, args);
        const structured = result?.structuredContent;
        const summary = structured && typeof structured === 'object'
          ? `返回字段：${Object.keys(structured).slice(0, 12).join(', ')}`
          : `返回内容：${Array.isArray(result?.content) ? result.content.length : 0} 项`;
        record('工具回执', `${name} · ${summary}${result?.isError ? ' · 工具报告错误' : ''}`);
        return result;
      }
      case 'resources/read': {
        if (!state.initialized) throw new RpcError(-32002, '请先完成 ui/initialize 握手。');
        if (!isAllowedResourceUri(params.uri)) {
          record('已拦截', `资源不在本地读取白名单：${String(params.uri ?? '')}`);
          throw new RpcError(-32001, 'Fixture 只开放本项目 UI、文库和 PDF.js 资源。');
        }
        record('资源读取', String(params.uri));
        const result = await client.read(params.uri);
        const entry = result?.contents?.[0];
        record('资源回执', `${params.uri} · ${entry?.text?.length ?? entry?.blob?.length ?? 0} 字符/字节`);
        return result;
      }
      case 'ui/message': {
        const content = Array.isArray(params.content) ? params.content : [];
        const text = content.filter(item => item?.type === 'text').map(item => String(item.text ?? '')).join('\n');
        record('本地消息捕获', `角色 ${params.role ?? '未知'}（不会发送到对话）\n${text || '[无文本内容]'}`);
        return {};
      }
      case 'ui/update-model-context': {
        const content = Array.isArray(params.content) ? params.content : [];
        const text = content.filter(item => item?.type === 'text').map(item => String(item.text ?? '')).join('\n');
        record('本地上下文捕获', `不会加入 Codex 对话\n${text || '[无文本内容]'}${params.structuredContent ? `\n结构化字段：${Object.keys(params.structuredContent).join(', ')}` : ''}`);
        return {};
      }
      case 'notifications/message':
        record('应用日志', params);
        return undefined;
      case 'ping':
        return {};
      case 'ui/open-link': {
        const url = String(params.url ?? '');
        record('本地链接捕获', `${url}（fixture 不会打开外部应用）`);
        return {};
      }
      default:
        throw new RpcError(-32601, `Fixture 未实现方法：${message.method}`);
    }
  }

  const wrapperHtml = `<!doctype html>
<html lang="zh-CN" data-mode="${state.mode}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zotero Workbench · Codex Native Host Fixture</title>
  <style>
    :root{color-scheme:light;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#252525;background:#f4f3f0}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column}
    header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 14px;background:#fff;border-bottom:1px solid #dedbd5;flex-wrap:wrap}
    .title{font-weight:650;white-space:nowrap}.hint{font-size:12px;color:#68645e;margin-left:12px}
    .controls{display:flex;align-items:center;gap:6px}.controls button{font:inherit;font-size:12px;padding:5px 10px;border:1px solid #d8d5ce;border-radius:6px;background:#fff;color:#34312d;cursor:pointer}
    .controls button[aria-pressed="true"]{border-color:#7193c2;background:#eef4fc;color:#24476e}
    .stage{width:100%;height:calc(100vh - 88px);min-height:520px;padding:8px;background:#f4f3f0;transition:width .15s ease}
    .stage iframe{width:100%;height:100%;display:block;border:1px solid #dedbd5;border-radius:8px;background:#fff}
    html[data-mode="inline"] .stage{width:min(480px,100%);height:calc(100vh - 88px)}
    details.logs{background:#fff;border-top:1px solid #dedbd5;padding:5px 14px;max-height:170px;overflow:auto;font-size:12px}
    details.logs summary{cursor:pointer;color:#57534d}#log{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:#514c45;max-height:125px;overflow:auto}
    .safety{color:#596f5c}.note{padding-left:8px}
    @media(max-width:700px){header{align-items:flex-start}.hint{display:block;margin:2px 0 0}.stage{padding:4px}html[data-mode="inline"] .stage{width:100%}}
  </style>
</head>
<body>
  <header>
    <div><span class="title">Codex 原生面板验收</span><span class="hint safety">本机 StdioClient · Zotero 写入与 AI 任务已拦截</span><span class="hint">对话消息和上下文只保存在本页日志</span></div>
    <div class="controls" role="group" aria-label="面板显示模式">
      <button type="button" data-mode-button="inline" aria-pressed="${state.mode === 'inline'}">侧栏</button>
      <button type="button" data-mode-button="fullscreen" aria-pressed="${state.mode === 'fullscreen'}">全屏</button>
      <span class="note hint">ui/message 不会发给真实会话</span>
    </div>
  </header>
  <main class="stage"><iframe id="app" title="Zotero Workbench 原生 MCP App" src="about:blank"></iframe></main>
  <details class="logs"><summary>本地宿主日志 · 仅本页可见，不连接 Codex 对话</summary><pre id="log">等待原生面板初始化…</pre></details>
  <script>
    (()=>{
      const frame=document.getElementById('app'), log=document.getElementById('log');
      const buttons=[...document.querySelectorAll('[data-mode-button]')];
      const origin=location.origin; let mode=document.documentElement.dataset.mode;
      const post=(message)=>frame.contentWindow?.postMessage(message,origin);
      function setMode(next,notify=true){
        if(!['inline','fullscreen'].includes(next))return false;
        mode=next;document.documentElement.dataset.mode=next;
        buttons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.modeButton===next)));
        if(notify)post({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:next}});
        return true;
      }
      buttons.forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.modeButton)));
      window.addEventListener('message',async event=>{
        if(event.source!==frame.contentWindow||event.origin!==origin)return;
        const message=event.data;
        if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')return;
        if(message.method==='ui/request-display-mode'){
          const requested=message.params?.mode;
          if(['inline','fullscreen'].includes(requested))setMode(requested,false);
          if(Object.hasOwn(message,'id'))post({jsonrpc:'2.0',id:message.id,result:{mode}});
          post({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:mode}});
          return;
        }
        try{
          const response=await fetch('/__rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)});
          if(Object.hasOwn(message,'id')){
            const payload=await response.json();
            post(payload);
          }
        }catch(error){
          if(Object.hasOwn(message,'id'))post({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:String(error?.message||error)}});
        }
      });
      // Install the host listener before loading the cached local panel resource.
      frame.src='/panel';
      async function refreshLog(){
        try{const response=await fetch('/__logs');const rows=await response.json();log.textContent=rows.map(row=>'['+row.at+'] '+row.kind+'\\n'+row.message).join('\\n\\n')||'等待原生面板初始化…';log.scrollTop=log.scrollHeight;}catch{}
      }
      refreshLog();setInterval(refreshLog,900);
    })();
  </script>
</body>
</html>`;

  async function handleRpc(req, res) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_RPC_BYTES) throw new RpcError(-32600, '请求内容超过本地验收上限。');
    }
    let message;
    try { message = JSON.parse(body); } catch { throw new RpcError(-32700, 'JSON 无法解析。'); }
    const hasId = Object.hasOwn(message ?? {}, 'id');
    try {
      const result = await dispatch(message);
      if (!hasId) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : -32000;
      const messageText = error instanceof Error ? error.message : String(error);
      if (message?.method === 'tools/call' || message?.method === 'resources/read') record('调用失败', `${message.method} · ${messageText}`);
      if (!hasId) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: messageText } }));
    }
  }

  const http = createServer(async (req, res) => {
    const host = String(req.headers.host ?? '');
    const requestHost = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestHost)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Loopback host only.'); return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Same-origin fixture only.'); return;
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    try {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(wrapperHtml); return;
    }
    if (req.method === 'GET' && path === '/panel') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(panelHtml); return;
    }
    if (req.method === 'POST' && path === '/__rpc') { await handleRpc(req, res); return; }
    if (req.method === 'GET' && path === '/__logs') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(logs)); return;
    }
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error?.code === -32600 ? 413 : 400;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  return {
    http,
    dispatch,
    logs,
    assertToolAllowed,
    get mode() { return state.mode; },
    async listen(port = 4173) {
      http.listen(port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        http.once('listening', resolve);
        http.once('error', reject);
      });
      return http.address();
    },
    async close() {
      await new Promise(resolve => http.listening ? http.close(resolve) : resolve());
    }
  };
}

async function createClientAndFixture() {
  const client = new StdioClient({});
  try {
    await client.ready();
    const listed = await client.request('tools/list', {});
    const panel = await client.read(PANEL_URI);
    const panelHtml = panel?.contents?.[0]?.text;
    if (typeof panelHtml !== 'string' || !panelHtml.includes('ui/initialize'))
      throw new Error(`MCP server did not return the native panel resource ${PANEL_URI}.`);
    const toolMap = new Map((listed.tools ?? []).map(tool => [tool.name, tool]));
    return { client, fixture: createFixture({ client, toolMap, panelHtml }), toolMap, panelHtml };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function selfTest() {
  const { client, fixture, panelHtml, toolMap } = await createClientAndFixture();
  try {
    assert.equal(toolMap.get('list_collections')?.annotations?.readOnlyHint, true);
    assert.equal(toolMap.get('trash_reader_annotation')?.annotations?.destructiveHint, true);
    assert.ok(panelHtml.includes('2025-11-25'), 'compiled panel should use the pinned MCP Apps protocol version');
    assert.equal(isAllowedResourceUri(PANEL_URI), true);
    assert.equal(isAllowedResourceUri('https://example.com/private'), false);
    assert.equal(isAllowedResourceUri('ui://zotero/setup/check/abc123'), true);
    assert.equal(isAllowedResourceUri('ui://zotero/setup/handoff/abc123'), false);
    const init = await fixture.dispatch({
      jsonrpc: '2.0', id: 1, method: 'ui/initialize',
      params: { protocolVersion: '2025-11-25', appInfo: { name: 'zotero', version: '0.2.1' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] } }
    });
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.equal(init.hostContext.displayMode, 'fullscreen');
    assert.deepEqual(init.hostContext.availableDisplayModes, ['inline', 'fullscreen']);
    assert.equal(fixture.dispatch && fixture.mode, 'fullscreen');
    assert.throws(() => fixture.assertToolAllowed('start_research_job', {}), /安全策略|白名单/);
    assert.throws(() => fixture.assertToolAllowed('trash_reader_annotation', {}), /安全策略/);
    assert.equal(fixture.assertToolAllowed('prepare_library_action', {}).prepare, true);
    assertToolPreparePolicy(toolMap);
    await fixture.dispatch({ jsonrpc: '2.0', id: 2, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'fixture-only sample' }] } });
    await fixture.dispatch({ jsonrpc: '2.0', id: 3, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'local context only' }] } });
    assert.equal(fixture.logs.filter(row => row.kind === '本地消息捕获').length, 1);
    assert.equal(fixture.logs.filter(row => row.kind === '本地上下文捕获').length, 1);
    assert.match(fixture.logs.find(row => row.kind === '本地消息捕获').message, /不会发送到对话/);
    assert.match(fixture.logs.find(row => row.kind === '本地上下文捕获').message, /不会加入 Codex 对话/);
    const address = await fixture.listen(0);
    const url = `http://127.0.0.1:${address.port}`;
    const rootResponse = await fetch(url);
    assert.equal(rootResponse.status, 200);
    const wrapper = await rootResponse.text();
    assert.match(wrapper, /本页日志/);
    assert.match(wrapper, /src="about:blank"/);
    assert.ok(wrapper.indexOf("window.addEventListener('message'") < wrapper.indexOf("frame.src='/panel'"), 'host listener must be installed before the panel is loaded');
    const panelResponse = await fetch(`${url}/panel`);
    assert.equal(panelResponse.status, 200);
    assert.equal(await panelResponse.text(), panelHtml);
    const blocked = await fetch(`${url}/__rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'trash_reader_annotation', arguments: {} } })
    });
    const rejected = await blocked.json();
    assert.equal(rejected.error?.code, -32001);
    const proxiedRead = await fetch(`${url}/__rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'workbench_state', arguments: {} } })
    });
    const readReply = await proxiedRead.json();
    assert.equal(readReply.result?.structuredContent?.state, null, 'allowlisted read must reach the real StdioClient');
    const logsResponse = await fetch(`${url}/__logs`);
    assert.equal(logsResponse.status, 200);
    console.log(`Self-test passed: actual StdioClient initialized, native panel resource loaded (${panelHtml.length} chars), MCP Apps handshake schema handled, local-only messages captured, unsafe tools blocked, HTTP ${url}/ and /panel served.`);
  } finally {
    await fixture.close();
    client.close();
  }
}

function assertToolPreparePolicy(toolMap) {
  for (const name of PREPARE_TOOLS) {
    const tool = toolMap.get(name);
    assert.ok(tool, `missing prepare tool ${name}`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} must remain a preview tool`);
    assert.notEqual(tool.annotations?.destructiveHint, true, `${name} must not be destructive`);
  }
}

const portArgIndex = process.argv.indexOf('--port');
const requestedPort = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.ZOTERO_DEV_HOST_PORT ?? 4173);
if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
    throw new Error('Port must be an integer between 0 and 65535.');
  const { client, fixture } = await createClientAndFixture();
  try {
    const address = await fixture.listen(requestedPort);
    console.log(`Codex native panel fixture ready at http://127.0.0.1:${address.port}`);
    console.log('本机验收专用：只读工具 + prepare 预览；Zotero 写入、AI 任务和外部对话发送均被阻止。');
    console.log('Use Ctrl+C to stop.');
    const shutdown = async () => {
      await fixture.close();
      client.close();
    };
    process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  } catch (error) {
    await fixture.close();
    client.close();
    throw error;
  }
}
