/**
 * 与 DSH 宿主的 postMessage 通信桥（iframe 同源）。
 *
 * 协议（与 Lead/客户端定稿）：
 *   子页 → 父页：
 *     { source:'zotero-workbench', type:'ready' }                       （握手，500ms 重试，最多 10 次）
 *     { source:'zotero-workbench', id, type:'add-to-chat', payload:{text} }
 *     { source:'zotero-workbench', id, type:'ask', payload:{question, context} }
 *     { source:'zotero-workbench', id, type:'current-session' }
 *     { source:'zotero-workbench', id, type:'collaboration-submit', payload:{targetSessionKey,text} }
 *     { source:'zotero-workbench', id, type:'open-zotero', payload:{kind,key,attachmentKey?,page?,annotationKey?} }
 *     { source:'zotero-workbench', id, type:'open-workspace' }
 *   父页 → 子页：
 *     { source:'zotero-workbench-host', type:'hello', mode:'dsh', capabilities:[...] }
 *     { source:'zotero-workbench-host', type:'ack', id, ok:boolean, message:string }
 *
 * 独立打开（dev-server / 浏览器直开）时没有 hello，connected 保持 false，
 * 调用方据此降级为「复制到剪贴板 + toast」。
 */

export const SOURCE = 'zotero-workbench';
export const HOST_SOURCE = 'zotero-workbench-host';
export const READY_RETRY_INTERVAL_MS = 500;
export const READY_MAX_RETRIES = 10;

export function isEmbedded() {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * 早期 host 消息队列
 *
 * 父页面可能在 iframe 还没执行到 bridge.start() 时就发 reveal-citation / hello；
 * app.js 在任何动态 import 之前调用 installEarlyHostMessageQueue()，把消息暂存，
 * HostBridge.start() 时统一回放。
 * ------------------------------------------------------------------ */
let earlyQueueActive = false;
const EARLY_HOST_MESSAGES = [];
const MAX_EARLY_MESSAGES = 50;

export function installEarlyHostMessageQueue() {
  if (earlyQueueActive) return;
  earlyQueueActive = true;
  // 供 dev 夹具/自测判断「app.js 已装好早期监听、bridge 尚未 start」的窗口。
  try {
    window.__ZOTERO_WB_EARLY_QUEUE_READY__ = true;
  } catch {
    /* ignore */
  }
  window.addEventListener('message', (event) => {
    if (!earlyQueueActive) return;
    if (event.origin && window.location.origin && event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== HOST_SOURCE) return;
    if (data.type === 'ack') return; // ack 只对进行中的请求有意义，启动前不可能有
    if (EARLY_HOST_MESSAGES.length < MAX_EARLY_MESSAGES) {
      EARLY_HOST_MESSAGES.push({ origin: event.origin, data });
    }
  });
}

function drainEarlyHostMessages() {
  earlyQueueActive = false;
  return EARLY_HOST_MESSAGES.splice(0);
}

export function createMessageId(prefix = 'msg') {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
  } catch {
    /* ignore */
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hostUnavailableError() {
  const error = new Error('未检测到 DSH 宿主对话桥（独立打开模式）');
  error.code = 'host-unavailable';
  return error;
}

function hostTimeoutError(type) {
  const error = new Error(`宿主未在超时时间内回执（${type}）`);
  error.code = 'host-timeout';
  return error;
}

export class HostBridge {
  /**
   * @param {{mode?:'sidebar'|'workspace', onHello?:Function, onStatus?:Function,
   *          onHostMessage?:Function, requestTimeoutMs?:number}} options
   */
  constructor({ mode = 'sidebar', onHello = null, onStatus = null, onHostMessage = null, requestTimeoutMs = 3000 } = {}) {
    this.mode = mode;
    this.onHello = onHello;
    this.onStatus = onStatus;
    this.onHostMessage = onHostMessage;
    this.requestTimeoutMs = requestTimeoutMs;

    this.started = false;
    this.embedded = isEmbedded();
    this.connected = false;
    this.capabilities = [];
    this.readyAttempts = 0;
    this.retryTimer = null;
    this.pending = new Map();
    this._onMessage = (event) => this.#handleMessage(event);
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.embedded) {
      this.#emitStatus();
      return;
    }
    window.addEventListener('message', this._onMessage);
    // 回放 bridge.start() 之前父页面发来的 hello / reveal-citation 等消息。
    const earlyQueued = drainEarlyHostMessages();
    try {
      window.__ZOTERO_WB_EARLY_QUEUE_DRAINED__ = earlyQueued.length;
    } catch {
      /* ignore */
    }
    for (const entry of earlyQueued) this.#handleMessage(entry);
    this.#sendReady();
    this.retryTimer = setInterval(() => {
      if (this.connected || this.readyAttempts >= READY_MAX_RETRIES) {
        this.#stopRetry();
        if (!this.connected) this.#emitStatus();
        return;
      }
      this.#sendReady();
    }, READY_RETRY_INTERVAL_MS);
    // 启动后即使很快收到 hello，也确保 5s 后清理计时器。
    setTimeout(() => {
      if (!this.connected) this.#emitStatus();
    }, READY_RETRY_INTERVAL_MS * (READY_MAX_RETRIES + 1));
  }

  stop() {
    this.#stopRetry();
    window.removeEventListener('message', this._onMessage);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(hostUnavailableError());
      this.pending.delete(id);
    }
  }

  get isHostAvailable() {
    return this.connected;
  }

  hasCapability(name) {
    return this.capabilities.includes(name);
  }

  #sendReady() {
    this.readyAttempts += 1;
    try {
      window.parent.postMessage({ source: SOURCE, type: 'ready', mode: this.mode }, window.location.origin);
    } catch {
      /* 父页不可达时忽略；独立打开不会走到这里 */
    }
  }

  #stopRetry() {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  #emitStatus() {
    try {
      this.onStatus?.({
        embedded: this.embedded,
        connected: this.connected,
        capabilities: this.capabilities.slice(),
      });
    } catch (error) {
      console.warn('[zotero-workbench] host status handler failed', error);
    }
  }

  #handleMessage(event) {
    // 同源围栏：只接受来自同一 origin 的消息（DSH iframe 与父页面同源）。
    if (event.origin && window.location.origin && event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== HOST_SOURCE) return;

    if (data.type === 'hello') {
      const firstHello = !this.connected;
      this.connected = true;
      this.capabilities = Array.isArray(data.capabilities) ? data.capabilities.slice() : [];
      this.#stopRetry();
      this.#emitStatus();
      if (firstHello) {
        try {
          this.onHello?.(data);
        } catch (error) {
          console.warn('[zotero-workbench] host hello handler failed', error);
        }
      }
      return;
    }

    if (data.type === 'ack') {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: data.ok !== false,
        message: typeof data.message === 'string' ? data.message : '',
        payload: data.payload && typeof data.payload === 'object' ? data.payload : null,
        raw: data,
      });
      return;
    }

    // 其它宿主主动消息（reveal-citation 等）：交给应用层处理。
    try {
      this.onHostMessage?.(data);
    } catch (error) {
      console.warn('[zotero-workbench] host message handler failed', error);
    }
  }

  /**
   * 发送一条需要 ack 的请求。未连接时立即 reject（code=host-unavailable），调用方做降级。
   * @returns {Promise<{ok:boolean, message:string, payload:object|null, raw:object}>}
   */
  request(type, payload = {}, { timeout = this.requestTimeoutMs, requireCapability = '' } = {}) {
    if (!this.connected) return Promise.reject(hostUnavailableError());
    if (requireCapability && !this.capabilities.includes(requireCapability)) {
      const error = new Error(`宿主未声明能力：${requireCapability}`);
      error.code = 'host-capability-missing';
      return Promise.reject(error);
    }
    const id = createMessageId(type.replace(/[^a-z-]/gi, ''));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(hostTimeoutError(type));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, type });
      try {
        window.parent.postMessage({ source: SOURCE, id, type, payload }, window.location.origin);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(hostUnavailableError());
      }
    });
  }

  /** sidebar 模式请求宿主切到全页工作区。 */
  openWorkspace() {
    return this.request('open-workspace', {}, { timeout: 4000 });
  }

  /** 明确读取当前 DSH 会话身份；不支持时由调用方显示不可用。 */
  currentSession() {
    return this.request('current-session', {}, { timeout: 4000, requireCapability: 'current-session' });
  }

  /** 将协作任务提交到已确认的当前 DSH 会话；不回退到 CLI 或剪贴板。 */
  submitCollaboration({ targetSessionKey, text } = {}) {
    return this.request('collaboration-submit', { targetSessionKey, text }, {
      timeout: 8000,
      requireCapability: 'collaboration-submit',
    });
  }
}

export function createHostBridge(options = {}) {
  return new HostBridge(options);
}
