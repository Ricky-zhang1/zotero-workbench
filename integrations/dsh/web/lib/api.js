/**
 * Host half 只读 API 的浏览器端封装。
 *
 * 契约（task-6 / host-backend-dev 确认版）：
 *   GET /zotero-workbench/api/health
 *   GET /zotero-workbench/api/collections?library=user
 *   GET /zotero-workbench/api/items?library=user&q=&collection=&sort=&start=&limit=&mode=
 *   GET /zotero-workbench/api/item?library=user&key=K
 *   GET /zotero-workbench/api/pdf?library=user&key=K      （application/pdf，支持 Range）
 *
 * 错误统一为 { error: { code, message } }（非 2xx 时尽量解析）；网络层失败抛 ApiError。
 */

export const WORKBENCH_BASE = '/zotero-workbench';
export const API_BASE = `${WORKBENCH_BASE}/api`;
export const PDFJS_BASE = `${WORKBENCH_BASE}/pdfjs/`;

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

async function readError(response) {
  let message = '';
  let code = '';
  try {
    const data = await response.clone().json();
    const error = data && data.error;
    if (typeof error === 'string') message = error;
    else if (error && typeof error === 'object') {
      message = String(error.message || '');
      code = String(error.code || '');
    }
    if (!message && data && typeof data.message === 'string') message = data.message;
  } catch {
    try {
      const text = (await response.clone().text()).trim();
      if (text && text.length < 500) message = text;
    } catch {
      /* ignore */
    }
  }
  if (!message) {
    if (response.status === 404) message = '接口或资源不存在（404）';
    else if (response.status === 503) message = 'Zotero 未启动或不可达（503）';
    else if (response.status >= 500) message = `宿主服务异常（HTTP ${response.status}）`;
    else message = `请求失败（HTTP ${response.status}）`;
  }
  return new ApiError(message, { status: response.status, code });
}

function withTimeout(signal, ms = 25000) {
  if (typeof AbortSignal === 'undefined') return { signal, cleanup: () => {} };
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return { signal: timeout, cleanup: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([signal, timeout]), cleanup: () => {} };
  }
  return { signal, cleanup: () => {} };
}

export class ApiClient {
  constructor(base = API_BASE) {
    this.base = base.replace(/\/$/, '');
  }

  buildUrl(path, params = {}) {
    const url = new URL(`${this.base}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async requestJson(path, { method = 'GET', params = {}, body = null, signal } = {}) {
    const url = this.buildUrl(path, params);
    const { signal: combined, cleanup } = withTimeout(signal);
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body
          ? { Accept: 'application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new ApiError(
        `无法连接宿主服务：${error && error.message ? error.message : '网络错误'}`,
        { cause: error },
      );
    } finally {
      cleanup();
    }
    if (!response.ok) throw await readError(response);
    try {
      return await response.json();
    } catch (error) {
      throw new ApiError('宿主返回了无法解析的 JSON', { status: response.status, cause: error });
    }
  }

  async getJson(path, params = {}, { signal } = {}) {
    const url = this.buildUrl(path, params);
    const { signal: combined, cleanup } = withTimeout(signal);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: combined,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new ApiError(
        `无法连接宿主服务：${error && error.message ? error.message : '网络错误'}`,
        { cause: error },
      );
    } finally {
      cleanup();
    }
    if (!response.ok) throw await readError(response);
    try {
      return await response.json();
    } catch (error) {
      throw new ApiError('宿主返回了无法解析的 JSON', { status: response.status, cause: error });
    }
  }

  /**
   * @returns {Promise<{ok:boolean, version?:string, zotero?:{reachable?:boolean, version?:string}}>}
   */
  health({ signal } = {}) {
    return this.getJson('/health', {}, { signal });
  }

  /**
   * @returns {Promise<{libraries?:Array, collections?:Array, savedSearches?:Array}>}
   */
  collections(library = 'user', { signal } = {}) {
    return this.getJson('/collections', { library }, { signal });
  }

  /**
   * @param {{library?:string, q?:string, collection?:string, tag?:string,
   *          sort?:string, direction?:string, start?:number, limit?:number,
   *          mode?:string, signal?:AbortSignal}} options
   * @returns {Promise<{items?:Array, nextStart?:number|null, total?:number}>}
   */
  items(options = {}) {
    const { signal, ...params } = options;
    return this.getJson('/items', params, { signal });
  }

  /**
   * @returns {Promise<{item?:object, attachments?:Array, annotations?:Array,
   *                    notes?:Array, collectionNames?:object}>}
   */
  item({ library = 'user', key, signal } = {}) {
    if (!key) return Promise.reject(new ApiError('缺少条目 key'));
    return this.getJson('/item', { library, key }, { signal });
  }

  pdfUrl({ library = 'user', key } = {}) {
    return this.buildUrl('/pdf', { library, key }).toString();
  }

  /**
   * 引用与导出（Host P1）：GET /api/citations?keys=K1,K2&format=...&style=...&locale=...
   * @returns {Promise<{format:string, style:string, entries?:Array, text:string}>}
   */
  citations({ keys = [], format = 'bibtex', style = 'apa', locale = 'zh-CN', signal } = {}) {
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    if (!list.length) return Promise.reject(new ApiError('没有选中条目'));
    return this.getJson('/citations', { keys: list.join(','), format, style, locale }, { signal });
  }

  /**
   * 信息检查（Host P1）：GET /api/maintenance?view=unfiled|missingDOI|missingPDF&offset=&limit=
   * @returns {Promise<{view:string,total:number,offset:number,limit:number,items:Array,truncated?:boolean}>}
   */
  maintenance({ view = 'unfiled', offset = 0, limit = 50, version, signal } = {}) {
    return this.getJson('/maintenance', { view, offset, limit, version }, { signal });
  }

  /**
   * 单条引文记录（Host P1 角标定位）：GET /api/citation?id=<12hex>
   * @returns {Promise<{id:string,itemKey:string,attachmentKey:string,pageIndex:number,pageLabel:string,
   *   quote:string,rects:number[][],title:string,authors:string,year:string,venue:string,doi:string,
   *   verifiedAt:string,zoteroItemUrl:string,zoteroPdfUrl:string}>}
   */
  citation({ id, signal } = {}) {
    if (!id) return Promise.reject(new ApiError('缺少引文 id'));
    return this.getJson('/citation', { id }, { signal });
  }

  /**
   * 同一文献的多处引文：GET /api/citations?itemKey=<key>&limit=20
   * @returns {Promise<{itemKey:string,total:number,records:Array}>}
   */
  citationsByItem({ itemKey, limit = 20, signal } = {}) {
    if (!itemKey) return Promise.reject(new ApiError('缺少 itemKey'));
    return this.getJson('/citations', { itemKey, limit }, { signal });
  }

  /**
   * 存为 Zotero 批注（占位：仅在宿主 health.writes.annotations=true 时调用）。
   * 路径必须带 citation id：Host 路由是 POST /api/citation/<12hex>/annotation（P2.3），
   * 旧路径 /api/citation/annotation 在真实 Host 上会 405。
   */
  saveCitationAnnotation({ id } = {}) {
    if (!id || !/^[a-f0-9]{12}$/i.test(String(id))) {
      return Promise.reject(new ApiError('引文 id 无效，无法保存为 Zotero 批注'));
    }
    return this.requestJson(`/citation/${encodeURIComponent(id)}/annotation`, { method: 'POST' });
  }

  /**
   * 在 Zotero 中显示（Host P1）：POST /api/open
   * 独立打开模式下调用方应降级为复制 zotero:// URL。
   */
  open({ kind = 'item', key, attachmentKey = '', page = 0, annotationKey = '' } = {}) {
    return this.requestJson('/open', {
      method: 'POST',
      body: { kind, key, attachmentKey: attachmentKey || undefined, page: page || undefined, annotationKey: annotationKey || undefined },
    });
  }
}
