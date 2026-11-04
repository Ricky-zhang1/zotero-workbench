#!/usr/bin/env node
/**
 * Reader web app 本地开发服务器（仅 dev 用，Node 标准库，无第三方依赖）。
 *
 * 用法：
 *   node integrations/dsh/web/dev-server.mjs                 # mock 数据（默认，含真实 PDF 文件）
 *   node integrations/dsh/web/dev-server.mjs --mode live     # 代理本机真实 Zotero 本地 API
 *   node integrations/dsh/web/dev-server.mjs --port 8787 --host 127.0.0.1
 *   node integrations/dsh/web/dev-server.mjs --pdf /path/to/file.pdf
 *
 * 环境变量：
 *   MOCK_PAGE_CAP=8          mock 模式每页返回条数上限（默认 8，用于验证「加载更多」）
 *   MOCK_API_FAIL=1          mock 模式的 /api/collections|items|item|pdf 返回 503，用于验证错误态
 *   DEV_PDFJS_BUILD=vendor   /zotero-workbench/pdfjs/build/* 用应用内 vendor 构建模拟宿主（默认）
 *   DEV_PDFJS_BUILD=missing  模拟当前仓库真实情况：dist/pdfjs 没有 build/，用于验证前端兜底加载
 *   ZOTERO_URL=http://127.0.0.1:23119   live 模式的 Zotero 本地 API
 *   ZOTERO_STORAGE=~/Zotero/storage     live 模式的 Zotero 附件目录
 *
 * 路由（与 Host half 契约一致）：
 *   GET /zotero-workbench/app/            -> web/ 静态应用
 *   GET /zotero-workbench/api/health
 *   GET /zotero-workbench/api/collections?library=user
 *   GET /zotero-workbench/api/items?library=user&q=&collection=&start=&limit=&sort=&mode=
 *   GET /zotero-workbench/api/item?library=user&key=K
 *   GET /zotero-workbench/api/pdf?library=user&key=K   （支持 HEAD / Range 206）
 *   GET /zotero-workbench/api/citations?keys=K1,K2&format=bibtex|biblatex|ris|csljson|text&style=apa
 *   GET /zotero-workbench/api/citations?itemKey=K&limit=20   （角标定位：同文献多处引文）
 *   GET /zotero-workbench/api/citation?id=<12hex>            （角标定位：单条引文）
 *   POST /zotero-workbench/api/citation/<12hex>/annotation   （占位；需要 Zotero 10）
 *   POST /zotero-workbench/api/citation/annotation           （旧路径兼容：410 提示改用带 id 路径）
 *   GET /zotero-workbench/api/maintenance?view=unfiled|missingDOI|missingPDF&offset=0&limit=50
 *   POST /zotero-workbench/api/open  {kind:'item'|'pdf', key, attachmentKey?, page?, annotationKey?}
 *   GET /zotero-workbench/pdfjs/build/* 与 cmaps/standard_fonts/wasm/*
 *
 * 另外提供两个 dev 夹具：
 *   /dev/theme-host?theme=light|dark  同源父页面里放 iframe 加载本应用，定义 --dsw-alias-*
 *                                     主题变量并可切换 light/dark，验证 iframe 主题同步。
 *   /dev/host-fixture?mode=workspace|sidebar[&reveal=<12hex>][&early=1][&itemKey=K]
 *                                     模拟 DSH 父页面：握手（延迟 700ms 回 hello，验证 ready 重试）、
 *                                     对 add-to-chat / ask / open-zotero / open-workspace 回 ack，
 *                                     支持向 iframe 发 reveal-citation（early=1 可在 ready 前发），
 *                                     消息记录在 window.__HOST_LOG__，用于验证 postMessage 协议。
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockBackend, MOCK_ITEM_COUNT } from './dev-mock.mjs';
import { createLiveBackend, findAnyZoteroPdf } from './dev-live.mjs';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(WEB_DIR, '../../..');
const PDFJS_DIST_DIR = path.join(REPO_ROOT, 'dist', 'pdfjs');
const VENDOR_PDFJS_DIR = path.join(WEB_DIR, 'vendor', 'pdfjs');
const APP_PREFIX = '/zotero-workbench/app';
const API_PREFIX = '/zotero-workbench/api';
const PDFJS_PREFIX = '/zotero-workbench/pdfjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const options = {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT) || 8787,
    mode: process.env.MODE || 'mock',
    pdf: process.env.MOCK_PDF || '',
    pageCap: Number(process.env.MOCK_PAGE_CAP) || 8,
    fail: process.env.MOCK_API_FAIL === '1',
    pdfjsBuild: process.env.DEV_PDFJS_BUILD || 'vendor',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--host') options.host = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--pdf') options.pdf = next();
    else if (arg === '--page-cap') options.pageCap = Number(next());
    else if (arg === '--fail') options.fail = true;
    else if (arg === '--pdfjs-build') options.pdfjsBuild = next();
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node dev-server.mjs [--mode mock|live] [--port 8787] [--pdf file.pdf] [--pdfjs-build vendor|missing]');
      process.exit(0);
    }
  }
  if (!['mock', 'live'].includes(options.mode)) {
    console.error(`未知模式：${options.mode}（可选 mock / live）`);
    process.exit(1);
  }
  return options;
}

/* ------------------------------ 工具 ------------------------------ */

function log(message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[dev ${time}] ${message}`);
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = Number(error?.status) || 500;
  sendJson(response, status, {
    error: {
      code: error?.code || (status === 404 ? 'not_found' : 'internal_error'),
      message: error?.message || '开发服务器内部错误',
    },
  });
}

function sendText(response, status, text) {
  const body = Buffer.from(String(text));
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readJsonBody(request, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('请求体过大');
        error.status = 413;
        error.code = 'payload_too_large';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        const parseError = new Error('请求体不是合法 JSON');
        parseError.status = 400;
        parseError.code = 'bad_request';
        reject(parseError);
      }
    });
    request.on('error', reject);
  });
}

function safeJoin(baseDir, relativePath) {
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const target = path.resolve(baseDir, normalized);
  if (target !== baseDir && !target.startsWith(`${baseDir}${path.sep}`)) return null;
  return target;
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveFile(request, response, filePath, { range = false } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: { code: 'not_found', message: `文件不存在：${path.basename(filePath)}` } });
    return;
  }
  if (!info.isFile()) {
    sendJson(response, 404, { error: { code: 'not_found', message: '不是文件' } });
    return;
  }
  const headers = {
    'Content-Type': mimeFor(filePath),
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    ETag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
  };

  if (range) {
    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (!match || (match[1] === '' && match[2] === '')) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      let start;
      let end;
      if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
          response.end();
          return;
        }
        start = Math.max(0, info.size - suffix);
        end = info.size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? info.size - 1 : Math.min(Number(match[2]), info.size - 1);
      }
      if (!Number.isFinite(start) || start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      headers['Content-Length'] = end - start + 1;
      response.writeHead(206, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(filePath, { start, end });
      stream.on('error', () => response.destroy());
      stream.pipe(response);
      return;
    }
  }

  headers['Content-Length'] = info.size;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

async function serveStatic(request, response, baseDir, relativePath) {
  const decoded = (() => {
    try {
      return decodeURIComponent(relativePath);
    } catch {
      return relativePath;
    }
  })();
  const target = safeJoin(baseDir, decoded);
  if (!target) {
    sendJson(response, 403, { error: { code: 'forbidden_path', message: '路径越界' } });
    return;
  }
  let info = await stat(target).catch(() => null);
  if (info && info.isDirectory()) {
    const indexTarget = path.join(target, 'index.html');
    info = await stat(indexTarget).catch(() => null);
    if (info) {
      await serveFile(request, response, indexTarget);
      return;
    }
  }
  if (!info) {
    sendJson(response, 404, { error: { code: 'not_found', message: `静态资源不存在：${decoded}` } });
    return;
  }
  await serveFile(request, response, target);
}

/* ------------------------------ 最小 PDF（无本机 PDF 时兜底） ------------------------------ */

let fallbackPdfPromise = null;
function getFallbackPdfPath() {
  if (fallbackPdfPromise) return fallbackPdfPromise;
  fallbackPdfPromise = (async () => {
    const content = [
      'BT',
      '/F1 20 Tf',
      '72 720 Td',
      '(Zotero Workbench mock PDF) Tj',
      '0 -30 Td',
      '/F1 11 Tf',
      '(No local Zotero PDF was found; this is a generated placeholder.) Tj',
      '0 -18 Td',
      '(Use --pdf /path/to/file.pdf to serve a real PDF.) Tj',
      'ET',
    ].join('\n');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    const dir = path.join(tmpdir(), 'zotero-workbench-dev');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'fallback-mock.pdf');
    await writeFile(filePath, pdf);
    return filePath;
  })();
  return fallbackPdfPromise;
}

async function resolveMockPdfPath(explicitPath) {
  if (explicitPath) {
    const info = await stat(explicitPath).catch(() => null);
    if (info?.isFile()) return path.resolve(explicitPath);
    log(`⚠️  指定的 --pdf 不存在：${explicitPath}，继续自动查找`);
  }
  const knownDir = path.join(homedir(), 'Zotero', 'storage', '4GCTAFMJ');
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(knownDir);
    const pdfName = entries.find((name) => /\.pdf$/i.test(name));
    if (pdfName) return path.join(knownDir, pdfName);
  } catch {
    /* 继续自动查找 */
  }
  const found = await findAnyZoteroPdf().catch(() => '');
  if (found) return found;
  log('⚠️  未找到本机 PDF，已生成最小占位 PDF（可用 --pdf 指定真实文件）');
  return getFallbackPdfPath();
}

/* ------------------------------ 主题同步夹具（仅 dev） ------------------------------ */

const THEME_HOST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 主题同步夹具</title>
<style>
  :root {
    --dsw-alias-bg-base: #f1f2f4;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-label-primary: #191b20;
    --dsw-alias-label-secondary: #5c6470;
    --dsw-alias-label-tertiary: #8b919b;
    --dsw-alias-border-l1: #e2e5e9;
    --dsw-alias-border-l2: #c9ced5;
    --dsw-alias-brand-primary: #2563eb;
    --dsw-alias-state-error-primary: #cf3a3a;
    --dsw-alias-state-warning-primary: #a86a00;
    --dsw-alias-state-success-primary: #1d7f43;
    color-scheme: light;
  }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
    font-size: 13px;
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
  }
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    padding: 0 12px;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
    background: var(--dsw-alias-bg-layer-1);
  }
  .bar strong { font-weight: 600; }
  .bar .hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
  .bar .state { margin-left: auto; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
  .bar button {
    height: 26px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-primary);
    cursor: pointer;
  }
  .bar button[aria-pressed="true"] {
    border-color: transparent;
    background: var(--dsw-alias-brand-primary);
    color: #fff;
  }
  iframe {
    flex: 1;
    display: block;
    width: 100%;
    min-height: 0;
    border: 0;
    background: var(--dsw-alias-bg-base);
  }
</style>
</head>
<body>
  <div class="bar">
    <strong>DSH 主题同步夹具</strong>
    <span class="hint">父页面定义 --dsw-alias-*，iframe 内应用应自动映射并跟随切换</span>
    <span class="state" id="state">light</span>
    <button type="button" data-set-theme="light" aria-pressed="true">浅色</button>
    <button type="button" data-set-theme="dark" aria-pressed="false">深色</button>
  </div>
  <iframe id="app" title="Zotero 文献工作台"></iframe>
  <script>
    const PALETTES = {
      light: {
        '--dsw-alias-bg-base': '#f1f2f4',
        '--dsw-alias-bg-layer-1': '#ffffff',
        '--dsw-alias-label-primary': '#191b20',
        '--dsw-alias-label-secondary': '#5c6470',
        '--dsw-alias-label-tertiary': '#8b919b',
        '--dsw-alias-border-l1': '#e2e5e9',
        '--dsw-alias-border-l2': '#c9ced5',
        '--dsw-alias-brand-primary': '#2563eb',
        '--dsw-alias-state-error-primary': '#cf3a3a',
        '--dsw-alias-state-warning-primary': '#a86a00',
        '--dsw-alias-state-success-primary': '#1d7f43',
      },
      dark: {
        '--dsw-alias-bg-base': '#0f1115',
        '--dsw-alias-bg-layer-1': '#171a1f',
        '--dsw-alias-label-primary': '#e8eaee',
        '--dsw-alias-label-secondary': '#9aa3ae',
        '--dsw-alias-label-tertiary': '#6d7580',
        '--dsw-alias-border-l1': '#2a2f37',
        '--dsw-alias-border-l2': '#3d444f',
        '--dsw-alias-brand-primary': '#5b8def',
        '--dsw-alias-state-error-primary': '#f16d6d',
        '--dsw-alias-state-warning-primary': '#e0a33a',
        '--dsw-alias-state-success-primary': '#4fbf7f',
      },
    };
    function applyTheme(theme) {
      const palette = PALETTES[theme] || PALETTES.light;
      const root = document.documentElement;
      for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value);
      root.style.colorScheme = theme;
      document.getElementById('state').textContent = theme;
      for (const button of document.querySelectorAll('[data-set-theme]')) {
        button.setAttribute('aria-pressed', String(button.dataset.setTheme === theme));
      }
    }
    for (const button of document.querySelectorAll('[data-set-theme]')) {
      button.addEventListener('click', () => applyTheme(button.dataset.setTheme));
    }
    const params = new URLSearchParams(location.search);
    applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
    document.getElementById('app').src =
      '/zotero-workbench/app/' + (params.get('mode') === 'workspace' ? '?mode=workspace' : '');
  </script>
</body>
</html>`;

const HOST_FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DSH 宿主模拟（postMessage 桥夹具）</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; font-size: 13px; background: #f1f2f4; color: #191b20; }
  .bar { flex: none; display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 12px; border-bottom: 1px solid #e2e5e9; background: #fff; }
  .bar strong { font-weight: 600; }
  .bar .muted { color: #8b919b; font-size: 11px; }
  .bar .status { margin-left: auto; color: #5c6470; font-variant-numeric: tabular-nums; }
  .bar button { height: 26px; padding: 0 10px; border: 1px solid #c9ced5; border-radius: 6px; background: #fff; cursor: pointer; }
  iframe { flex: 1; display: block; width: 100%; min-height: 0; border: 0; background: #f1f2f4; }
</style>
</head>
<body>
  <div class="bar">
    <strong>DSH 宿主模拟</strong>
    <span class="muted">延迟 700ms 回 hello（验证 ready 重试）；消息记录到 window.__HOST_LOG__</span>
    <span class="status" id="status">消息 0</span>
    <span id="reveal-buttons"></span>
    <button type="button" id="clear">清空日志</button>
    <button type="button" id="to-sidebar">切 sidebar</button>
    <button type="button" id="to-workspace">切 workspace</button>
  </div>
  <iframe id="app" src="" title="Zotero 工作台"></iframe>
  <script>
    (function () {
      var params = new URLSearchParams(location.search);
      var mode = params.get('mode') === 'sidebar' ? 'sidebar' : 'workspace';
      var iframe = document.getElementById('app');
      window.__HOST_LOG__ = [];
      window.__HOST_MODE__ = mode;
      function appUrl(nextMode) {
        return '/zotero-workbench/app/?mode=' + nextMode;
      }
      function updateStatus() {
        document.getElementById('status').textContent = '消息 ' + window.__HOST_LOG__.length;
      }
      function hello() {
        if (!iframe.contentWindow) return;
        iframe.contentWindow.postMessage(
          { source: 'zotero-workbench-host', type: 'hello', mode: 'dsh', capabilities: ['add-to-chat', 'ask', 'open-zotero', 'open-workspace'] },
          location.origin,
        );
      }
      window.addEventListener('message', function (event) {
        if (event.origin !== location.origin) return;
        var data = event.data || {};
        if (data.source !== 'zotero-workbench') return;
        window.__HOST_LOG__.push({ at: Date.now(), type: data.type, id: data.id || null, payload: data.payload || null });
        updateStatus();
        if (data.type === 'ready') {
          // 故意延迟：前端应按 500ms 重试 ready，直到收到 hello。
          setTimeout(hello, 700);
          return;
        }
        var message = 'mock 已处理：' + data.type;
        var ok = true;
        if (data.type === 'add-to-chat') message = '已加入对话输入框（mock）';
        else if (data.type === 'ask') message = '已发送提问（mock）';
        else if (data.type === 'open-zotero') message = '已在 Zotero 中显示（mock）';
        else if (data.type === 'open-workspace') {
          message = '已切到全页工作区（mock）';
          setTimeout(function () { iframe.src = appUrl('workspace'); }, 100);
        }
        if (!data.id) return;
        iframe.contentWindow.postMessage(
          { source: 'zotero-workbench-host', type: 'ack', id: data.id, ok: ok, message: message },
          location.origin,
        );
      });
      function sendReveal(id) {
        if (!iframe.contentWindow || !id) return;
        iframe.contentWindow.postMessage(
          { source: 'zotero-workbench-host', type: 'reveal-citation', payload: { id: String(id) } },
          location.origin,
        );
      }
      window.__REVEAL_CITATION__ = sendReveal;
      var revealParam = params.get('reveal');
      var revealEarly = params.get('early') === '1';
      var revealSent = false;
      iframe.addEventListener('load', function () {
        if (!revealParam || revealSent) return;
        revealSent = true;
        if (!revealEarly) {
          setTimeout(function () { sendReveal(revealParam); }, 700);
          return;
        }
        // early=1：等 app.js 装好早期消息监听（__ZOTERO_WB_EARLY_QUEUE_READY__），
        // 但通常 bridge.start() 还没执行，从而精确验证「消息早于 ready」的排队逻辑。
        var attempts = 0;
        var timer = setInterval(function () {
          attempts += 1;
          var readyCount = (window.__HOST_LOG__ || []).filter(function (entry) { return entry.type === 'ready'; }).length;
          if (iframe.contentWindow && iframe.contentWindow.__ZOTERO_WB_EARLY_QUEUE_READY__) {
            clearInterval(timer);
            window.__REVEAL_SENT_BEFORE_READY__ = readyCount === 0;
            sendReveal(revealParam);
            return;
          }
          if (attempts > 300) clearInterval(timer);
        }, 10);
      });
      var citationItemKey = params.get('itemKey') || '3DWU883L';
      fetch('/zotero-workbench/api/citations?itemKey=' + encodeURIComponent(citationItemKey))
        .then(function (response) { return response.json(); })
        .then(function (data) {
          var holder = document.getElementById('reveal-buttons');
          if (!holder || !data || !data.records) return;
          data.records.slice(0, 3).forEach(function (record, index) {
            var button = document.createElement('button');
            button.type = 'button';
            button.textContent = '定位引文 ' + (index + 1) + '（第 ' + (record.pageIndex + 1) + ' 页）';
            button.addEventListener('click', function () { sendReveal(record.id); });
            holder.appendChild(button);
          });
        })
        .catch(function () { /* 没有 citation mock 时忽略按钮 */ });
      iframe.src = appUrl(mode);
      document.getElementById('clear').addEventListener('click', function () {
        window.__HOST_LOG__ = [];
        updateStatus();
      });
      document.getElementById('to-sidebar').addEventListener('click', function () { iframe.src = appUrl('sidebar'); });
      document.getElementById('to-workspace').addEventListener('click', function () { iframe.src = appUrl('workspace'); });
    })();
  </script>
</body>
</html>`;

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let backend;
  let pdfDescription = '';

  if (options.mode === 'live') {
    backend = createLiveBackend();
    log(`模式：live（代理 ${process.env.ZOTERO_URL || 'http://127.0.0.1:23119'}）`);
  } else {
    const pdfPath = await resolveMockPdfPath(options.pdf);
    pdfDescription = pdfPath;
    backend = createMockBackend({ pageCap: options.pageCap, pdfPath, fail: options.fail });
    log(`模式：mock（${MOCK_ITEM_COUNT} 个条目 / 5 个分类 / 单页上限 ${options.pageCap}）`);
    log(`mock PDF：${pdfPath}`);
    if (options.fail) log('⚠️  MOCK_API_FAIL=1：API 将返回 503');
  }
  log(`/zotero-workbench/pdfjs/build/* 来源：${options.pdfjsBuild === 'missing' ? '404（模拟 dist/pdfjs 无 build）' : '应用内 vendor 构建'}`);

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = request.method || 'GET';

    response.on('finish', () => {
      log(`${method} ${pathname}${url.search ? '?' + url.searchParams.toString() : ''} -> ${response.statusCode} (${Date.now() - startedAt}ms)`);
    });

    try {
      // 首页跳转到应用入口
      if (pathname === '/' || pathname === '/index.html') {
        response.writeHead(302, { Location: `${APP_PREFIX}/`, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (pathname === APP_PREFIX) {
        response.writeHead(302, { Location: `${APP_PREFIX}/`, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }

      // ---- postMessage 桥夹具（仅 dev） ----
      if (pathname === '/dev/host-fixture' || pathname === '/dev/host-fixture/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(HOST_FIXTURE_HTML),
          'Cache-Control': 'no-store',
        });
        response.end(HOST_FIXTURE_HTML);
        return;
      }

      // ---- 主题同步夹具（仅 dev） ----
      if (pathname === '/dev/theme-host' || pathname === '/dev/theme-host/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(THEME_HOST_HTML),
          'Cache-Control': 'no-store',
        });
        response.end(THEME_HOST_HTML);
        return;
      }

      // ---- 应用静态资源 ----
      if (pathname === `${APP_PREFIX}/` || pathname.startsWith(`${APP_PREFIX}/`)) {
        const relative = pathname.slice(APP_PREFIX.length + 1) || 'index.html';
        await serveStatic(request, response, WEB_DIR, relative);
        return;
      }

      // ---- pdf.js 静态资源 ----
      if (pathname === PDFJS_PREFIX || pathname.startsWith(`${PDFJS_PREFIX}/`)) {
        const relative = pathname.slice(PDFJS_PREFIX.length + 1);
        if (relative.startsWith('build/')) {
          if (options.pdfjsBuild === 'missing') {
            sendJson(response, 404, {
              error: { code: 'not_found', message: '模拟宿主：dist/pdfjs 没有 build/ 目录（DEV_PDFJS_BUILD=missing）' },
            });
            return;
          }
          const fileName = relative.slice('build/'.length);
          const map = {
            'pdf.mjs': 'pdf.min.mjs',
            'pdf.worker.mjs': 'pdf.worker.min.mjs',
          };
          if (map[fileName]) {
            await serveFile(request, response, path.join(VENDOR_PDFJS_DIR, map[fileName]));
          } else {
            sendJson(response, 404, { error: { code: 'not_found', message: `未提供的 pdf.js 构建文件：${fileName}` } });
          }
          return;
        }
        await serveStatic(request, response, PDFJS_DIST_DIR, relative);
        return;
      }

      // ---- API ----
      if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
        const route = pathname.slice(API_PREFIX.length);
        const query = Object.fromEntries(url.searchParams.entries());
        const annotationPath = /^\/citation\/([a-f0-9]{12})\/annotation$/.exec(route);
        if (annotationPath) {
          if (method !== 'POST') {
            sendJson(response, 405, { error: { code: 'method_not_allowed', message: `${route} 只支持 POST` } });
            return;
          }
          await readJsonBody(request).catch(() => ({}));
          sendJson(response, 200, await backend.saveCitationAnnotation({ id: annotationPath[1] }));
          return;
        }
        if (route === '/citation/annotation') {
          if (method !== 'POST') {
            sendJson(response, 405, { error: { code: 'method_not_allowed', message: `${route} 只支持 POST` } });
            return;
          }
          await readJsonBody(request).catch(() => ({}));
          sendJson(response, 410, {
            error: {
              code: 'deprecated_path',
              message: '旧路径已停用：请使用 POST /zotero-workbench/api/citation/<12hex>/annotation',
            },
          });
          return;
        }
        if (route === '/open') {
          if (method !== 'POST') {
            sendJson(response, 405, { error: { code: 'method_not_allowed', message: '/api/open 只支持 POST' } });
            return;
          }
          const body = await readJsonBody(request);
          sendJson(response, 200, await backend.open(body || {}));
          return;
        }
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(response, 405, { error: { code: 'method_not_allowed', message: '该接口只支持 GET/HEAD' } });
          return;
        }
        switch (route) {
          case '/health': {
            sendJson(response, 200, await backend.health());
            return;
          }
          case '/collections': {
            sendJson(response, 200, await backend.collections(query.library || 'user'));
            return;
          }
          case '/items': {
            const payload = await backend.items({
              q: query.q || '',
              collection: query.collection || '',
              sort: query.sort || 'dateModified',
              direction: query.direction || '',
              start: Number(query.start) || 0,
              limit: Number(query.limit) || 25,
              mode: query.mode || 'all',
              tag: query.tag || '',
            });
            sendJson(response, 200, payload);
            return;
          }
          case '/item': {
            sendJson(response, 200, await backend.item({ library: query.library || 'user', key: query.key || '' }));
            return;
          }
          case '/citation': {
            sendJson(response, 200, await backend.citation({ id: query.id || '' }));
            return;
          }
          case '/pdf': {
            const { filePath } = await backend.pdf({ library: query.library || 'user', key: query.key || '' });
            await serveFile(request, response, filePath, { range: true });
            return;
          }
          case '/citations': {
            if (query.itemKey) {
              sendJson(
                response,
                200,
                await backend.citationsForItem({ itemKey: query.itemKey, limit: Number(query.limit) || 20 }),
              );
              return;
            }
            sendJson(
              response,
              200,
              await backend.citations({
                keys: query.keys || '',
                format: query.format || 'bibtex',
                style: query.style || 'apa',
                locale: query.locale || 'zh-CN',
              }),
            );
            return;
          }
          case '/maintenance': {
            sendJson(
              response,
              200,
              await backend.maintenance({
                view: query.view || 'unfiled',
                offset: Number(query.offset) || 0,
                limit: Number(query.limit) || 50,
              }),
            );
            return;
          }
          case '': {
            sendJson(response, 200, {
              ok: true,
              routes: [
                '/health',
                '/collections',
                '/items',
                '/item',
                '/pdf',
                '/citations',
                '/citation',
                '/citation/:id/annotation',
                '/maintenance',
                '/open',
              ],
              mode: backend.mode,
            });
            return;
          }
          default: {
            sendJson(response, 404, { error: { code: 'not_found', message: `未知 API：${route}` } });
            return;
          }
        }
      }

      // ---- 兜底 ----
      if (pathname.startsWith('/zotero-workbench/')) {
        sendJson(response, 404, { error: { code: 'not_found', message: `未知路径：${pathname}` } });
        return;
      }
      sendText(response, 404, `未知路径：${pathname}\n应用入口：http://${request.headers.host || `${options.host}:${options.port}`}${APP_PREFIX}/`);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (Number(error?.status)) {
        sendError(response, error);
      } else {
        log(`内部错误：${error && error.stack ? error.stack : error}`);
        sendJson(response, 500, {
          error: { code: 'internal_error', message: error && error.message ? error.message : String(error) },
        });
      }
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${options.port} 已被占用；换一个 --port 或用 PORT=... 重试。`);
      process.exit(1);
    }
    console.error('开发服务器错误：', error);
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    const origin = `http://${options.host}:${options.port}`;
    console.log('');
    console.log('  Zotero 文献工作台 · Reader web app 开发服务器');
    console.log(`  模式      ${backend.mode}`);
    console.log(`  应用入口  ${origin}${APP_PREFIX}/   （浏览器打开即可自测）`);
    console.log(`  API       ${origin}${API_PREFIX}/health`);
    if (pdfDescription) console.log(`  Mock PDF  ${pdfDescription}`);
    console.log('  提示      修改 web/ 下文件后刷新浏览器即可；这是 dev 服务器，不是 DSH 插件。');
    console.log('');
  });

  process.on('SIGINT', () => {
    log('收到 SIGINT，关闭服务器');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  });
}

main().catch((error) => {
  console.error('启动 dev-server 失败：', error);
  process.exit(1);
});
