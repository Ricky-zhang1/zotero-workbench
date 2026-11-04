/**
 * 角标跳转定位 → 引文临时高亮 + 浮层（sidebar / workspace 共用）。
 *
 * 触发：宿主 iframe postMessage
 *   { source:'zotero-workbench-host', type:'reveal-citation', payload:{ id } }
 * 数据：
 *   GET /api/citation?id=<12hex>                单条引文记录
 *   GET /api/citations?itemKey=<itemKey>&limit=20  同一文献的多处引文
 * 记录形状见 task-13 契约（rects 为 PDF 用户空间坐标，与批注同公式叠加）。
 *
 * 应用层通过 openInReader(record) 负责：加载条目详情 → 打开 PDF → 跳到 pageIndex+1，
 * 并保证 resolve 时该页已渲染完成；本控制器随后调用 PdfViewer.setQuoteHighlights 画橙色
 * 临时高亮（.pdf-quote-highlight）、滚动并显示浮层。
 *
 * 浮层按钮：[在 Zotero 中显示] [复制原文] [存为 Zotero 批注（需要 Zotero 10，默认 disabled）]
 * 以及同文献多处引文的切换（下拉 + 上一处/下一处）。
 */

import { copyText, escapeHtml, icon, toast } from './dom.js';
import { zoteroPdfUrl } from './normalize.js';

function formatVerifiedAt(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value);
}

function normalizeRecords(rawRecords, fallback) {
  const list = Array.isArray(rawRecords) ? rawRecords.filter((record) => record && record.id) : [];
  if (!list.length) return fallback ? [fallback] : [];
  if (fallback && !list.some((record) => record.id === fallback.id)) list.unshift(fallback);
  return list;
}

function pageLabelOf(record) {
  if (record.pageLabel) return String(record.pageLabel);
  return String(Number(record.pageIndex) + 1);
}

export class CitationRevealController {
  /**
   * @param {{
   *   mount: HTMLElement,
   *   api: import('./api.js').ApiClient,
   *   bridge: import('./host-bridge.js').HostBridge,
   *   getViewer: () => import('./pdf-viewer.js').PdfViewer|null,
   *   getWritesAnnotations?: () => boolean,
   *   openInReader: (record: object) => Promise<void>,
   *   onAfterOpen?: (record: object) => void,
   * }} options
   */
  constructor({ mount, api, bridge, getViewer, getWritesAnnotations = () => false, openInReader, onAfterOpen = null }) {
    this.mount = mount;
    this.api = api;
    this.bridge = bridge;
    this.getViewer = getViewer;
    this.getWritesAnnotations = getWritesAnnotations;
    this.openInReader = openInReader;
    this.onAfterOpen = onAfterOpen;

    this.visible = false;
    this.loading = false;
    this.state = { records: [], index: 0, current: null };
    /** 单调请求序号：任何 await 后 seq 不匹配即作废（hide/新 reveal/switch 都会 ++） */
    this.seq = 0;
    /** 在途 reveal id / nonce（用于同 id 重发去重） */
    this.inFlightId = '';
    this.inFlightNonce = '';
    /** client 重试协议：同一 nonce 只处理一次；最近 50 个 */
    this.seenNonces = new Set();
    this.nonceOrder = [];
    /** 用户关闭后的 id 短冷却：无 nonce 的旧式重发不再弹回浮层 */
    this.dismissed = null;
    this.dismissCooldownMs = 5000;
    this.bar = null;
    this._onClick = (event) => this.#handleClick(event);
    this._onChange = (event) => this.#handleChange(event);
    this.#build();
  }

  get currentRecord() {
    return this.state.current;
  }

  get records() {
    return this.state.records;
  }

  isVisible() {
    // 单一状态源：visible 与 bar.hidden 始终一致，避免二者分裂。
    return Boolean(this.visible && this.bar && !this.bar.hidden);
  }

  #build() {
    const bar = document.createElement('section');
    bar.className = 'citation-reveal-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', '引文定位');
    bar.addEventListener('click', this._onClick);
    bar.addEventListener('change', this._onChange);
    this.mount.appendChild(bar);
    this.bar = bar;
  }

  #rememberNonce(nonce) {
    if (!nonce) return false;
    const value = String(nonce);
    if (this.seenNonces.has(value)) return true;
    this.seenNonces.add(value);
    this.nonceOrder.push(value);
    while (this.nonceOrder.length > 50) {
      const old = this.nonceOrder.shift();
      this.seenNonces.delete(old);
    }
    return false;
  }

  #shouldIgnoreDismissed(id, nonce) {
    const dismissed = this.dismissed;
    if (!dismissed || dismissed.id !== id) return false;
    if (Date.now() - dismissed.at > this.dismissCooldownMs) {
      this.dismissed = null;
      return false;
    }
    // 同一 nonce 的重发必须忽略；无 nonce 的旧式重发在冷却期内也不弹回。
    if (!nonce) return true;
    return dismissed.nonce === String(nonce);
  }

  #syncBarVisibility() {
    if (!this.bar) return;
    this.bar.hidden = !this.visible;
  }

  /**
   * 处理宿主 reveal-citation：拉取引文 + 同文献列表 → 打开阅读器 → 高亮 → 浮层。
   * 关键正确性：
   *  - requestSeq：所有 await 后 token 不匹配即终止，绝不写 state / render / toast；
   *  - hide() 会 ++seq，使在途请求作废（关闭后不会被“加载完成”重新弹回）；
   *  - nonce：client 重试同一 nonce 只处理一次；新 nonce 可重新定位；
   *  - 无 nonce 的同一 id 重发在关闭后 5s 冷却期内忽略。
   * @param {string} id 12hex 引文 id
   * @param {{nonce?:string}} options
   */
  async reveal(id, { nonce = '' } = {}) {
    if (!id) return;
    const normalizedId = String(id);
    if (nonce && this.#rememberNonce(nonce)) return; // 同 nonce 重试：忽略
    if (this.#shouldIgnoreDismissed(normalizedId, nonce)) return;
    if (this.inFlightId === normalizedId && (!nonce || this.inFlightNonce === String(nonce))) return;

    const seq = ++this.seq;
    this.inFlightId = normalizedId;
    this.inFlightNonce = nonce ? String(nonce) : '';
    this.dismissed = null;
    this.visible = true;
    this.loading = true;
    this.state = { records: [], index: 0, current: null };
    this.#render();
    this.#syncBarVisibility();
    try {
      const record = await this.api.citation({ id: normalizedId });
      if (seq !== this.seq) return;
      let group = null;
      try {
        group = await this.api.citationsByItem({ itemKey: record.itemKey, limit: 20 });
      } catch (error) {
        // 多引文列表失败不阻塞单条定位
        console.warn('[zotero-workbench] 读取同文献引文列表失败', error);
      }
      if (seq !== this.seq) return;
      const records = normalizeRecords(group?.records, record);
      const index = Math.max(0, records.findIndex((entry) => entry.id === record.id));
      this.state = { records, index, current: records[index] };
      await this.#activate(records[index], seq);
      if (seq !== this.seq) return;
      this.loading = false;
      this.#render();
      this.#syncBarVisibility();
    } catch (error) {
      if (seq !== this.seq) return;
      this.loading = false;
      this.hide({ rememberDismiss: false });
      toast(`定位引文失败：${error && error.message ? error.message : error}`, { tone: 'error', timeout: 4200 });
    } finally {
      if (seq === this.seq) {
        this.inFlightId = '';
        this.inFlightNonce = '';
      }
    }
  }

  /** 供应用层在 boot 完成后 flush 排队请求时复用（避免并发重复激活同一 id）。 */
  async revealQueued(id, nonce = '') {
    if (!id) return;
    if (nonce && this.seenNonces.has(String(nonce))) return;
    if (this.inFlightId === String(id) && (!nonce || this.inFlightNonce === String(nonce))) return;
    if (!nonce && this.visible && this.state.current && this.state.current.id === String(id)) return;
    return this.reveal(id, { nonce });
  }

  /**
   * 隐藏浮层并使在途请求作废。用户点击 X 时 rememberDismiss=true，
   * 让同一 id 的后续重发（尤其是无 nonce 的旧式重发）不会立刻把浮层弹回来。
   */
  hide({ rememberDismiss = true } = {}) {
    this.seq += 1;
    const currentId = (this.state.current && this.state.current.id) || this.inFlightId || '';
    const currentNonce = this.inFlightNonce || '';
    this.visible = false;
    this.loading = false;
    this.inFlightId = '';
    this.inFlightNonce = '';
    this.#syncBarVisibility();
    this.state = { records: [], index: 0, current: null };
    // 清掉浮层文本，避免隐藏后仍能被读屏/自动化读到旧定位内容（P3 清理）。
    if (this.bar) {
      const body = this.bar.querySelector('.crb-body');
      if (body) body.innerHTML = '';
      const status = this.bar.querySelector('.crb-status');
      if (status) status.textContent = '';
    }
    if (rememberDismiss && currentId) {
      this.dismissed = { id: String(currentId), at: Date.now(), nonce: currentNonce };
    }
    const viewer = this.getViewer();
    viewer?.clearQuoteHighlights?.();
  }

  /** 应用层在阅读视图被关闭/切换时调用：清高亮并隐藏（不阻止后续新 nonce 的定位）。 */
  clear() {
    this.hide({ rememberDismiss: false });
  }

  async #activate(record, seq) {
    if (!record) return;
    if (seq !== this.seq) return;
    this.#setStatus(`正在定位：第 ${pageLabelOf(record)} 页…`);
    await this.openInReader(record);
    if (seq !== this.seq) return;
    const viewer = this.getViewer();
    if (!viewer || !viewer.isOpen) throw new Error('PDF 阅读器尚未就绪');
    await viewer.setQuoteHighlights({
      key: record.id,
      pageIndex: Number(record.pageIndex) || 0,
      rects: Array.isArray(record.rects) ? record.rects : [],
    });
    if (seq !== this.seq) return;
    viewer.scrollToQuoteHighlight();
    this.onAfterOpen?.(record);
  }

  async switchTo(index) {
    if (this.loading) return;
    const records = this.state.records;
    if (!records.length) return;
    const nextIndex = Math.min(records.length - 1, Math.max(0, Number(index) || 0));
    if (nextIndex === this.state.index && this.state.current) return;
    const record = records[nextIndex];
    const seq = ++this.seq;
    this.state.index = nextIndex;
    this.state.current = record;
    this.loading = true;
    this.#render();
    try {
      await this.#activate(record, seq);
      if (seq !== this.seq) return;
    } catch (error) {
      if (seq !== this.seq) return;
      toast(`切换引文失败：${error && error.message ? error.message : error}`, { tone: 'error' });
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.#render();
      }
    }
  }

  #setStatus(text) {
    const status = this.bar?.querySelector('.crb-status');
    if (status) status.textContent = text;
  }

  #saveButtonState() {
    const button = this.bar?.querySelector('[data-crb="save-annotation"]');
    if (!button) return;
    const enabled = Boolean(this.getWritesAnnotations());
    button.disabled = !enabled;
    button.title = enabled
      ? '保存为 Zotero 阅读高亮（需要 Zotero 10 与宿主写能力）'
      : '需要 Zotero 10（宿主 health.writes.annotations=false）';
  }

  #render() {
    if (!this.bar) return;
    const record = this.state.current;
    const records = this.state.records;
    const loading = this.loading;
    if (!record) {
      this.bar.innerHTML = `
        <div class="crb-head">
          <span class="crb-status">${loading ? '正在定位引文…' : '未定位到引文'}</span>
          <span class="crb-spacer"></span>
          <button class="icon-btn" type="button" data-crb="close" aria-label="关闭引文定位">${icon('x')}</button>
        </div>`;
      return;
    }
    const verified = formatVerifiedAt(record.verifiedAt);
    const pageLabel = pageLabelOf(record);
    const metaBits = [record.authors, record.year, record.venue].filter(Boolean).map((bit) => escapeHtml(bit));
    const multiple = records.length > 1;
    const options = records
      .map(
        (entry, index) =>
          `<option value="${index}" ${index === this.state.index ? 'selected' : ''}>第 ${escapeHtml(pageLabelOf(entry))} 页 · ${escapeHtml(
            String(entry.quote || '').slice(0, 30),
          )}…</option>`,
      )
      .join('');
    this.bar.innerHTML = `
      <div class="crb-head">
        <span class="crb-status">${loading ? '正在定位…' : `已定位：第 ${escapeHtml(pageLabel)} 页 · 原文已核对`}</span>
        <span class="crb-verified" title="核对时间">${verified ? `核对于 ${escapeHtml(verified)}` : ''}</span>
        <span class="crb-spacer"></span>
        <button class="icon-btn" type="button" data-crb="close" aria-label="关闭引文定位并清除高亮">${icon('x')}</button>
      </div>
      <blockquote class="crb-quote" title="${escapeHtml(record.quote || '')}">${escapeHtml(
        record.quote || '（无引文原文）',
      )}</blockquote>
      <div class="crb-meta">
        <span class="crb-title">${escapeHtml(record.title || '（无题名）')}</span>
        ${metaBits.length ? `<span class="crb-byline">${metaBits.join(' · ')}</span>` : ''}
      </div>
      <div class="crb-actions">
        <button class="btn btn-primary" type="button" data-crb="open-zotero">${icon('external', 13)}<span>在 Zotero 中显示</span></button>
        <button class="btn" type="button" data-crb="copy">${icon('copy', 13)}<span>复制原文</span></button>
        <button class="btn" type="button" data-crb="save-annotation" title="需要 Zotero 10">${icon('quote', 13)}<span>存为 Zotero 批注</span></button>
        <span class="crb-spacer"></span>
        ${
          multiple
            ? `<div class="crb-multi">
                <span class="crb-multi-label">该文献共 ${records.length} 处引文</span>
                <button class="icon-btn" type="button" data-crb="prev" aria-label="上一处引文">${icon('chevronRight', 12)}</button>
                <select class="select crb-select" data-crb="select" aria-label="切换同文献引文">${options}</select>
                <button class="icon-btn crb-next" type="button" data-crb="next" aria-label="下一处引文">${icon('chevronRight', 12)}</button>
              </div>`
            : ''
        }
      </div>`;
    this.#saveButtonState();
  }

  async #handleClick(event) {
    const target = event.target.closest('[data-crb]');
    if (!target) return;
    const action = target.dataset.crb;
    const record = this.state.current;
    if (action === 'close') {
      this.hide({ rememberDismiss: true });
      return;
    }
    if (!record || this.loading) return;
    if (action === 'prev') {
      this.switchTo(this.state.index - 1);
    } else if (action === 'next') {
      this.switchTo(this.state.index + 1);
    } else if (action === 'copy') {
      const ok = await copyText(record.quote || '');
      toast(ok ? '已复制引文原文' : '复制失败，请手动复制', { tone: ok ? 'info' : 'error' });
    } else if (action === 'open-zotero') {
      await this.#openInZotero(record);
    } else if (action === 'save-annotation') {
      if (target.disabled) return;
      try {
        await this.api.saveCitationAnnotation({ id: record.id });
        toast('宿主已受理保存批注请求');
      } catch (error) {
        toast(`保存为 Zotero 批注失败：${error && error.message ? error.message : error}`, {
          tone: 'error',
          timeout: 4200,
        });
      }
    }
  }

  #handleChange(event) {
    const select = event.target.closest('[data-crb="select"]');
    if (!select) return;
    this.switchTo(Number(select.value));
  }

  async #openInZotero(record) {
    const page = (Number(record.pageIndex) || 0) + 1;
    const payload = {
      kind: 'pdf',
      key: record.itemKey,
      attachmentKey: record.attachmentKey || undefined,
      page,
    };
    const fallbackUrl =
      record.zoteroPdfUrl ||
      zoteroPdfUrl({ key: record.itemKey, attachmentKey: record.attachmentKey, page });
    if (this.bridge && this.bridge.connected) {
      try {
        const ack = await this.bridge.request('open-zotero', payload, { timeout: 5000 });
        toast(ack.ok ? ack.message || '已在 Zotero 中显示' : ack.message || '宿主打开失败', {
          tone: ack.ok ? 'info' : 'error',
        });
        return;
      } catch (error) {
        if (error.code !== 'host-unavailable' && error.code !== 'host-timeout') {
          toast(`打开失败：${error.message}`, { tone: 'error' });
          return;
        }
        toast('对话桥未响应，已改为复制 Zotero 深链', { tone: 'error' });
      }
    }
    const copied = await copyText(fallbackUrl);
    toast(copied ? `已复制 Zotero 深链：${fallbackUrl}` : `复制失败，链接：${fallbackUrl}`, {
      tone: copied ? 'info' : 'error',
      timeout: 3600,
    });
  }
}
