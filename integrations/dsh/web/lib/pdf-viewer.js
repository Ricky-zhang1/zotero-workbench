/**
 * PDF 阅读器（基于宿主提供的 pdf.js）。
 *
 * 加载策略（task-6 契约 + Lead 批准的双路径）：
 *   1. 主路径：动态 import /zotero-workbench/pdfjs/build/pdf.mjs
 *      workerSrc = /zotero-workbench/pdfjs/build/pdf.worker.mjs（与主模块同目录）
 *   2. 回退：/zotero-workbench/app/vendor/pdfjs/pdf.min.mjs（应用内自带的
 *      pdfjs-dist@6.3.289 构建）——用 fetch + Blob URL import，worker 同样用
 *      /app/vendor/pdfjs/pdf.worker.min.mjs 的 Blob URL，
 *      这样即使宿主 /app 静态路由的 .mjs MIME 配置有问题也能加载。
 *
 * cMap / standard_fonts / wasm 一律使用宿主路由 /zotero-workbench/pdfjs/...，
 * 与仓库 dist/pdfjs 的版本一致（Lead 确认保留这三个目录的路由）。
 */

const HOST_SOURCE = {
  kind: 'host',
  module: '/zotero-workbench/pdfjs/build/pdf.mjs',
  worker: '/zotero-workbench/pdfjs/build/pdf.worker.mjs',
};

const BUNDLED_SOURCE = {
  kind: 'bundled',
  module: '/zotero-workbench/app/vendor/pdfjs/pdf.min.mjs',
  worker: '/zotero-workbench/app/vendor/pdfjs/pdf.worker.min.mjs',
};

const ASSET_OPTIONS = {
  cMapUrl: '/zotero-workbench/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/zotero-workbench/pdfjs/standard_fonts/',
  wasmUrl: '/zotero-workbench/pdfjs/wasm/',
};

const PDF_LOAD_TIMEOUT_MS = 45000;
const MAX_ZOOM = 5;
const MIN_ZOOM = 0.2;
const MAX_DPR = 2;

/** Zotero 标准高亮色（annotationColor 原样返回时的兜底色）。 */
export const ZOTERO_ANNOTATION_COLORS = [
  '#ffd400',
  '#ff6666',
  '#5fb236',
  '#2ea8e5',
  '#a28ae5',
  '#e56eee',
  '#f19837',
  '#aaaaaa',
];

let pdfjsPromise = null;

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal, credentials: 'same-origin' });
  } finally {
    clearTimeout(timer);
  }
}

async function importBundledModule(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const code = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await import(/* webpackIgnore: true */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function resolveWorkerUrl(source) {
  if (source.kind === 'host') {
    // 预检 worker 是否存在；HEAD 不被支持（405/501）时也放行，交给 pdf.js 实际加载。
    try {
      const head = await fetchWithTimeout(source.worker, { method: 'HEAD' }, 8000);
      if (!head.ok && head.status !== 405 && head.status !== 501) {
        throw new Error(`worker HTTP ${head.status}`);
      }
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('worker 预检超时');
      throw error;
    }
    return source.worker;
  }
  const response = await fetchWithTimeout(source.worker);
  if (!response.ok) throw new Error(`worker HTTP ${response.status}`);
  const code = await response.text();
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

async function loadSource(source) {
  let module;
  if (source.kind === 'host') {
    // 先用 fetch 探测模块是否存在（fetch 的 4xx 不进控制台；直接 dynamic import 404 会留一条报错噪音）。
    const probe = await fetchWithTimeout(source.module, { method: 'HEAD' }, 8000);
    if (!probe.ok && probe.status !== 405 && probe.status !== 501) {
      throw new Error(`module HTTP ${probe.status}`);
    }
    module = await import(/* webpackIgnore: true */ source.module);
  } else {
    module = await importBundledModule(source.module);
  }
  if (!module || typeof module.getDocument !== 'function') {
    throw new Error('模块缺少 getDocument 导出');
  }
  const workerUrl = await resolveWorkerUrl(source);
  module.GlobalWorkerOptions.workerSrc = workerUrl;
  return {
    lib: module,
    kind: source.kind,
    version: typeof module.version === 'string' ? module.version : '',
  };
}

/** 惰性加载并缓存 pdf.js；两种来源都失败时抛带明细的错误。 */
export function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const failures = [];
    // bundled 优先：宿主 dist/pdfjs/build 当前不存在（上游 build 内联），盲试会留 404 控制台噪音；
    // 若未来宿主带真实构建，再恢复 HOST 优先（下方 HEAD 探测可避免 404 噪音，但 fetch 4xx 仍会进控制台）。
    for (const source of [BUNDLED_SOURCE, HOST_SOURCE]) {
      try {
        return await loadSource(source);
      } catch (error) {
        failures.push(`${source.kind === 'host' ? '宿主 pdf.js' : '内置 pdf.js'}：${error && error.message ? error.message : error}`);
      }
    }
    pdfjsPromise = null;
    const error = new Error(`PDF.js 加载失败。${failures.join('；')}`);
    error.details = failures;
    throw error;
  })();
  return pdfjsPromise;
}

export function describePdfError(error) {
  if (!error) return '未知错误';
  const name = error.name || '';
  const message = String(error.message || error);
  if (name === 'PasswordException') return '这份 PDF 有打开密码，暂不支持解密预览。';
  if (name === 'InvalidPDFException' || /invalid pdf structure/i.test(message)) {
    return 'PDF 文件结构无效或已损坏。';
  }
  if (name === 'MissingPDFException' || /\b404\b/.test(message)) {
    return '找不到 PDF 文件（可能已从 Zotero 存储中移除）。';
  }
  if (name === 'UnexpectedResponseException') {
    const status = error.status ? `（HTTP ${error.status}）` : '';
    return `读取 PDF 时服务器返回异常${status}。`;
  }
  if (/fake worker|worker/i.test(message)) {
    return 'PDF.js worker 加载失败（检查宿主 /zotero-workbench/pdfjs/ 路由）。';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '无法获取 PDF 数据（网络或宿主服务异常）。';
  }
  if (/PDF\.js 加载失败/.test(message)) return message;
  return message;
}

/**
 * 单页 PDF 阅读器。由 app.js 创建并按需调用 open/goToPage/setZoom 等。
 */
export class PdfViewer {
  /**
   * @param {{
   *   scrollEl: HTMLElement,
   *   pageEl: HTMLElement,
   *   onStatus?: (status: {status:string, message?:string, numPages?:number, source?:string, version?:string}) => void,
   *   onProgress?: (progress: {loaded:number, total:number, percent:number|null}) => void,
   *   onPageChange?: (info: {page:number, numPages:number, scale:number, fitMode:string}) => void,
   *   onTextLayer?: (ok:boolean, error?:Error) => void,
   *   onAnnotationClick?: (annotation:object, context:{event:MouseEvent, rectEl:HTMLElement}) => void,
   *   onOverlayRendered?: (info:{page:number, count:number}) => void,
   *   onQuoteRendered?: (info:{page:number, count:number, key:string}) => void,
   * }} options
   */
  constructor({ scrollEl, pageEl, onStatus, onProgress, onPageChange, onTextLayer, onAnnotationClick, onOverlayRendered, onQuoteRendered }) {
    this.scrollEl = scrollEl;
    this.pageEl = pageEl;
    this.onStatus = onStatus || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onPageChange = onPageChange || (() => {});
    this.onTextLayer = onTextLayer || (() => {});
    this.onAnnotationClick = onAnnotationClick || (() => {});
    this.onOverlayRendered = onOverlayRendered || (() => {});
    this.onQuoteRendered = onQuoteRendered || (() => {});
    /** 临时引文高亮：{ key, pageIndex, rects:[[x1,y1,x2,y2],...] }（PDF 用户空间 rect） */
    this.quoteHighlight = null;
    this.quoteLayerEl = null;
    /** 批注覆盖层数据：每项 { key,pageIndex,rects:number[][],color,text,comment,pageLabel,... } */
    this.annotations = [];
    this.highlightedAnnotationKey = '';
    this.overlayEl = null;

    this.lib = null;
    this.source = '';
    this.libVersion = '';
    this.doc = null;
    this.pageNumber = 1;
    this.fitMode = 'width';
    this.zoomScale = 1;
    this.scale = 1;
    this.token = 0;
    this.renderTask = null;
    this.textLayer = null;
    this.currentUrl = '';
    this.disposed = false;
    this._resizeTimer = null;

    this._onResize = () => {
      if (!this.doc) return;
      // 阅读区在 tab 切走/隐藏时宽度为 0：跳过，等重新可见再按真实宽度重绘。
      if (this.scrollEl.clientWidth < 60) return;
      if (this.fitMode !== 'width') {
        this.#layoutOnly();
        return;
      }
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        if (!this.doc || this.disposed) return;
        this.rerender();
      }, 180);
    };

    if (typeof ResizeObserver === 'function') {
      this._observer = new ResizeObserver(this._onResize);
      this._observer.observe(scrollEl);
    } else {
      window.addEventListener('resize', this._onResize);
    }
  }

  get numPages() {
    return this.doc ? this.doc.numPages : 0;
  }

  get isReady() {
    return Boolean(this.doc && this.lib && this.pageEl.childElementCount > 0);
  }

  get isOpen() {
    return Boolean(this.doc);
  }

  get loadingSource() {
    return this.source;
  }

  async open(url, { startPage = 1 } = {}) {
    if (this.disposed) return;
    this.clearQuoteHighlights();
    this.close();
    const token = ++this.token;
    this.currentUrl = url;
    this.pageNumber = startPage;
    this.onStatus({ status: 'loading' });
    try {
      if (!this.lib) {
        const loaded = await loadPdfjs();
        if (token !== this.token) return;
        this.lib = loaded.lib;
        this.source = loaded.kind;
        this.libVersion = loaded.version;
      }
      const loadingTask = this.lib.getDocument({
        url,
        ...ASSET_OPTIONS,
        disableAutoFetch: true,
        rangeChunkSize: 1 << 16,
        // 让宿主按 Range 分块取；同时避免超大 PDF 一次性读入。
        disableStream: false,
        // 只保留错误级日志：中文 PDF 常见 Type1 charstring 警告会淹没控制台。
        verbosity: 0,
      });
      if (loadingTask.onProgress) {
        loadingTask.onProgress = (progress) => {
          if (token !== this.token) return;
          const total = Number(progress.total) || 0;
          const loaded = Number(progress.loaded) || 0;
          this.onProgress({
            loaded,
            total,
            percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null,
          });
        };
      }
      const timeout = setTimeout(() => {
        if (token === this.token) loadingTask.destroy();
      }, PDF_LOAD_TIMEOUT_MS);
      let doc;
      try {
        doc = await loadingTask.promise;
      } finally {
        clearTimeout(timeout);
      }
      if (token !== this.token) {
        doc.destroy();
        return;
      }
      this.doc = doc;
      this.pageNumber = Math.min(Math.max(1, startPage), doc.numPages) || 1;
      await this.#render(token);
      if (token !== this.token) return;
      this.onStatus({
        status: 'ready',
        numPages: doc.numPages,
        source: this.source,
        version: this.libVersion,
      });
    } catch (error) {
      if (token !== this.token) return;
      if (error && (error.name === 'AbortException' || error.name === 'RenderingCancelledException')) return;
      this.doc = null;
      this.pageEl.replaceChildren();
      this.onStatus({ status: 'error', message: describePdfError(error) });
    }
  }

  close() {
    this.token += 1;
    if (this.renderTask) {
      try {
        this.renderTask.cancel();
      } catch {
        /* ignore */
      }
      this.renderTask = null;
    }
    if (this.textLayer) {
      try {
        this.textLayer.cancel?.();
      } catch {
        /* ignore */
      }
      this.textLayer = null;
    }
    if (this.doc) {
      try {
        this.doc.destroy();
      } catch {
        /* ignore */
      }
      this.doc = null;
    }
    this.source = '';
    this.quoteLayerEl = null;
    this.pageEl.replaceChildren();
  }

  async goToPage(pageNumber) {
    if (!this.doc) return;
    const target = Math.min(Math.max(1, Math.trunc(Number(pageNumber)) || 1), this.doc.numPages);
    if (target === this.pageNumber && this.pageEl.childElementCount > 0) {
      this.scrollEl.scrollTop = 0;
      return;
    }
    this.pageNumber = target;
    this.scrollEl.scrollTop = 0;
    const token = ++this.token;
    try {
      await this.#render(token);
    } catch (error) {
      if (token !== this.token) return;
      if (error && (error.name === 'AbortException' || error.name === 'RenderingCancelledException')) return;
      this.onStatus({ status: 'error', message: describePdfError(error) });
    }
  }

  nextPage() {
    return this.goToPage(this.pageNumber + 1);
  }

  prevPage() {
    return this.goToPage(this.pageNumber - 1);
  }

  async setFitWidth() {
    this.fitMode = 'width';
    await this.rerender();
  }

  async setZoom(scale) {
    this.fitMode = 'custom';
    this.zoomScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(scale) || 1));
    await this.rerender();
  }

  async zoomIn(step = 1.15) {
    const next = (this.fitMode === 'width' ? this.scale : this.zoomScale) * step;
    await this.setZoom(next);
  }

  async zoomOut(step = 1.15) {
    const next = (this.fitMode === 'width' ? this.scale : this.zoomScale) / step;
    await this.setZoom(next);
  }

  async rerender() {
    if (!this.doc) return;
    const token = ++this.token;
    try {
      await this.#render(token);
    } catch (error) {
      if (token !== this.token) return;
      if (error && (error.name === 'AbortException' || error.name === 'RenderingCancelledException')) return;
      this.onStatus({ status: 'error', message: describePdfError(error) });
    }
  }

  /**
   * 设置当前 PDF 的批注（用于在页面上绘制矩形覆盖层）；会重绘当前页。
   * @param {Array<{key:string,pageIndex:number,rects:number[][],color?:string,text?:string,comment?:string,pageLabel?:string}>} list
   */
  setAnnotations(list) {
    this.annotations = Array.isArray(list) ? list.filter((entry) => entry && Array.isArray(entry.rects)) : [];
    if (this.doc && this.pageEl.childElementCount > 0) {
      this.rerender().catch((error) => console.warn('[zotero-workbench] 批注层重绘失败', error));
    }
  }

  /**
   * 设置临时引文高亮（角标定位）。
   * rects 来自 /api/citation 记录，坐标是 PDF 用户空间（原点左下），
   * 渲染时与批注一样用 viewport.convertToViewportPoint 转 CSS px。
   * @param {{key?:string, pageIndex:number, rects:number[][]}|null} quote
   */
  setQuoteHighlights(quote) {
    this.quoteHighlight = quote && Array.isArray(quote.rects) && Number.isFinite(Number(quote.pageIndex))
      ? { key: String(quote.key || 'quote'), pageIndex: Number(quote.pageIndex), rects: quote.rects }
      : null;
    if (!this.quoteHighlight) {
      this.clearQuoteHighlights();
      return Promise.resolve();
    }
    if (this.doc && this.pageNumber - 1 === this.quoteHighlight.pageIndex) {
      return this.rerender().catch((error) => {
        console.warn('[zotero-workbench] 引文高亮重绘失败', error);
      });
    }
    return Promise.resolve();
  }

  clearQuoteHighlights() {
    this.quoteHighlight = null;
    if (this.quoteLayerEl) {
      try {
        this.quoteLayerEl.remove();
      } catch {
        /* ignore */
      }
      this.quoteLayerEl = null;
    }
    for (const node of this.pageEl.querySelectorAll('.pdf-quote-layer')) node.remove();
  }

  /** 滚动到引文高亮并重新触发闪烁动画。 */
  scrollToQuoteHighlight() {
    const node = this.pageEl.querySelector('.pdf-quote-highlight');
    if (!node) return false;
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    node.classList.remove('is-flash');
    // 强制重排以重新触发动画（同文献多处引文切换时也能看到闪烁）
    void node.offsetWidth;
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 2200);
    return true;
  }

  #renderQuoteHighlight(viewport, pageEl) {
    if (this.quoteLayerEl) {
      this.quoteLayerEl.remove();
      this.quoteLayerEl = null;
    }
    const quote = this.quoteHighlight;
    if (!quote || quote.pageIndex !== this.pageNumber - 1) return;
    const layer = document.createElement('div');
    layer.className = 'pdf-quote-layer';
    layer.setAttribute('aria-hidden', 'true');
    let count = 0;
    for (const rect of quote.rects || []) {
      const box = this.#rectToCss(viewport, rect);
      if (!box || box.width < 0.5 || box.height < 0.5) continue;
      const node = document.createElement('div');
      node.className = 'pdf-quote-highlight is-flash';
      node.dataset.quoteKey = quote.key;
      node.style.left = `${box.left}px`;
      node.style.top = `${box.top}px`;
      node.style.width = `${box.width}px`;
      node.style.height = `${box.height}px`;
      layer.appendChild(node);
      count += 1;
    }
    pageEl.appendChild(layer);
    this.quoteLayerEl = layer;
    this.onQuoteRendered({ page: this.pageNumber, count, key: quote.key });
  }

  /** 高亮某条批注（滚动到可视区域并闪烁）。 */
  scrollToAnnotation(annotationKey) {
    const rectEl = this.pageEl.querySelector(`.pdf-annotation-rect[data-annotation-key="${CSS.escape(annotationKey)}"]`);
    if (!rectEl) return false;
    rectEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    rectEl.classList.add('is-flash');
    setTimeout(() => rectEl.classList.remove('is-flash'), 1400);
    return true;
  }

  /**
   * 把 Zotero annotationPosition.rects 的矩形转换到当前页 CSS 坐标。
   *
   * 坐标事实（annotation-coords 实测 RECTS.md，task-10）：rects 是 **PDF 用户空间坐标**
   * （原点左下、y 向上、单位 pt，非归一化）。pdf.js 6.3.289 的 PageViewport 只有
   * convertToViewportPoint（没有 convertToViewportRectangle）；用两个对角点转换后取
   * min/max 即可（PDF 旋转只有 0/90/180/270，affine 变换后仍是轴对齐矩形）。
   *
   * 返回 CSS px；canvas 位图按 DPR 放大，但 overlay 是 DOM，只能用 CSS px，不能再乘 DPR。
   * 跨页 rects（nextPageRects）属于 pageIndex+1，调用方不应传入当前页列表。
   */
  #rectToCss(viewport, rect) {
    if (!Array.isArray(rect) || rect.length < 4) return null;
    const [x1, y1, x2, y2] = rect.map(Number);
    if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) return null;
    let ax;
    let ay;
    let bx;
    let by;
    if (typeof viewport.convertToViewportPoint === 'function') {
      [ax, ay] = viewport.convertToViewportPoint(x1, y1);
      [bx, by] = viewport.convertToViewportPoint(x2, y2);
    } else {
      // 兜底：与 convertToViewportPoint 等价的显式变换（rotation=0/180、userUnit=1 的常见情况）。
      const [a, b, c, d, e, f] = viewport.transform;
      ax = a * x1 + c * y1 + e;
      ay = b * x1 + d * y1 + f;
      bx = a * x2 + c * y2 + e;
      by = b * x2 + d * y2 + f;
    }
    return {
      left: Math.min(ax, bx),
      top: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    };
  }

  #renderAnnotationOverlay(viewport, pageEl) {
    const layer = document.createElement('div');
    layer.className = 'pdf-annotation-layer';
    const pageIndex = this.pageNumber - 1;
    let count = 0;
    for (const annotation of this.annotations) {
      if (Number(annotation.pageIndex) !== pageIndex) continue;
      const color = String(annotation.color || '').trim() || '#ffd400';
      for (const rect of annotation.rects || []) {
        const box = this.#rectToCss(viewport, rect);
        if (!box || box.width < 0.5 || box.height < 0.5) continue;
        const node = document.createElement('button');
        node.type = 'button';
        node.className = `pdf-annotation-rect${annotation.key === this.highlightedAnnotationKey ? ' is-active' : ''}`;
        node.dataset.annotationKey = String(annotation.key || '');
        node.style.left = `${box.left}px`;
        node.style.top = `${box.top}px`;
        node.style.width = `${box.width}px`;
        node.style.height = `${box.height}px`;
        node.style.setProperty('--ann-color', color);
        node.setAttribute(
          'aria-label',
          `批注${annotation.pageLabel ? `（第 ${annotation.pageLabel} 页）` : ''}：${String(annotation.text || '').slice(0, 40)}`,
        );
        node.title = annotation.comment || annotation.text || '查看批注';
        node.addEventListener('click', (event) => {
          event.stopPropagation();
          this.highlightedAnnotationKey = String(annotation.key || '');
          this.onAnnotationClick(annotation, { event, rectEl: node });
          for (const other of layer.querySelectorAll('.pdf-annotation-rect.is-active')) {
            other.classList.remove('is-active');
          }
          node.classList.add('is-active');
        });
        layer.appendChild(node);
        count += 1;
      }
    }
    pageEl.appendChild(layer);
    this.overlayEl = layer;
    this.onOverlayRendered({ page: this.pageNumber, count });
    return layer;
  }

  /** 只更新页面容器尺寸（自定义缩放时滚动容器尺寸变化不需要重绘清晰度）。 */
  #layoutOnly() {
    const page = this.pageEl;
    if (!page.dataset.pdfWidth) return;
    page.style.width = `${page.dataset.pdfWidth}px`;
  }

  async #render(token) {
    if (!this.doc || token !== this.token) return;
    const page = await this.doc.getPage(this.pageNumber);
    if (token !== this.token) return;

    if (this.renderTask) {
      try {
        this.renderTask.cancel();
      } catch {
        /* ignore */
      }
      this.renderTask = null;
    }
    if (this.textLayer) {
      try {
        this.textLayer.cancel?.();
      } catch {
        /* ignore */
      }
      this.textLayer = null;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.setAttribute('aria-label', `PDF 第 ${this.pageNumber} 页`);
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';

    const baseViewport = page.getViewport({ scale: 1 });
    const available = Math.max(160, this.scrollEl.clientWidth - 40);
    let scale;
    if (this.fitMode === 'width') {
      scale = available / baseViewport.width;
    } else {
      scale = this.zoomScale;
    }
    scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    this.scale = scale;

    const viewport = page.getViewport({ scale });
    const cssWidth = Math.max(1, Math.floor(viewport.width));
    const cssHeight = Math.max(1, Math.floor(viewport.height));
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));

    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const pageEl = this.pageEl;
    pageEl.replaceChildren(canvas, textDiv);
    pageEl.style.width = `${cssWidth}px`;
    pageEl.style.height = `${cssHeight}px`;
    pageEl.dataset.pdfWidth = String(cssWidth);
    pageEl.dataset.pdfHeight = String(cssHeight);
    pageEl.style.setProperty('--scale-factor', String(viewport.scale));
    pageEl.style.setProperty('--total-scale-factor', String(viewport.scale));
    pageEl.style.setProperty('--scale-round-x', '1px');
    pageEl.style.setProperty('--scale-round-y', '1px');

    const renderTask = page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      background: '#ffffff',
    });
    this.renderTask = renderTask;
    try {
      await renderTask.promise;
    } finally {
      if (this.renderTask === renderTask) this.renderTask = null;
    }
    if (token !== this.token) return;

    // 文字层：PDF 文字可选择/复制（非致命，失败也保留画布）。
    try {
      const textContent = await page.getTextContent();
      if (token !== this.token) return;
      const TextLayer = this.lib && this.lib.TextLayer;
      if (typeof TextLayer === 'function') {
        const layer = new TextLayer({
          textContentSource: textContent,
          container: textDiv,
          viewport,
        });
        await layer.render();
        if (token !== this.token) {
          try {
            layer.cancel?.();
          } catch {
            /* ignore */
          }
          return;
        }
        textDiv.style.width = `${cssWidth}px`;
        textDiv.style.height = `${cssHeight}px`;
        this.textLayer = layer;
        this.onTextLayer(true);
      }
    } catch (error) {
      if (token !== this.token) return;
      this.onTextLayer(false, error);
    }

    // 批注矩形覆盖层（z-index 在文字层之上：点击高亮优先，未覆盖区域仍可选字）。
    if (this.annotations.length) {
      this.#renderAnnotationOverlay(viewport, pageEl);
    } else {
      this.onOverlayRendered({ page: this.pageNumber, count: 0 });
    }
    // 临时引文高亮层（橙色，角标定位；与批注层独立）。
    this.#renderQuoteHighlight(viewport, pageEl);

    this.onPageChange({
      page: this.pageNumber,
      numPages: this.doc.numPages,
      scale: this.scale,
      fitMode: this.fitMode,
    });
  }

  dispose() {
    this.disposed = true;
    if (this._observer) this._observer.disconnect();
    else window.removeEventListener('resize', this._onResize);
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this.close();
  }
}
