/**
 * DOM / 格式化 / 小工具集合。
 * 纯浏览器 API，无第三方依赖。
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** HTML 转义：所有来自文库的字符串都要经过它再拼进 innerHTML。 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 把可能含 HTML 的 Zotero 笔记转成纯文本（不执行、不渲染 HTML）。 */
export function plainText(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function debounce(fn, wait = 250) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatDate(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return text;
}

/** 作者：兼容 host 契约的 creators:{authors:[名],year}、Zotero 的 creators:[{name|firstName/lastName}]。 */
export function creatorsText(creators) {
  if (!creators) return '';
  const authors = Array.isArray(creators) ? creators : creators.authors;
  if (Array.isArray(authors)) {
    return authors
      .map((author) => {
        if (!author) return '';
        if (typeof author === 'string') return author;
        if (author.name) return author.name;
        const parts = [author.firstName, author.lastName].filter(Boolean);
        return parts.length ? parts.join(' ') : author.creatorType ? '' : '';
      })
      .filter(Boolean)
      .join('、');
  }
  return String(authors || '');
}

export function yearText(creators, date) {
  if (creators && creators.year) return String(creators.year);
  const match = String(date || '').match(/(\d{4})/);
  return match ? match[1] : '';
}

const ITEM_TYPE_LABELS = {
  journalArticle: '期刊论文',
  magazineArticle: '杂志文章',
  newspaperArticle: '报纸文章',
  conferencePaper: '会议论文',
  book: '图书',
  bookSection: '图书章节',
  thesis: '学位论文',
  report: '报告',
  preprint: '预印本',
  manuscript: '手稿',
  webpage: '网页',
  blogPost: '博客',
  forumPost: '论坛帖',
  document: '文档',
  dataset: '数据集',
  program: '软件',
  computerProgram: '软件',
  artwork: '艺术品',
  film: '影片',
  audioRecording: '音频',
  videoRecording: '视频',
  interview: '访谈',
  letter: '信件',
  memo: '备忘录',
  patent: '专利',
  standard: '标准',
  statute: '法规',
  case: '判例',
  note: '笔记',
  attachment: '附件',
};

export function itemTypeLabel(type) {
  if (!type) return '文献';
  return ITEM_TYPE_LABELS[type] || String(type);
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => {
      if (!tag) return '';
      if (typeof tag === 'string') return tag.trim();
      return String(tag.tag || tag.name || '').trim();
    })
    .filter(Boolean);
}

/** 只允许安全颜色值，防止把来自文库的任意字符串塞进 CSS。 */
export function safeCssColor(value, fallback = 'var(--rb-accent)') {
  const text = String(value || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return text;
  if (/^rgba?\([\d\s.,%]+\)$/i.test(text)) return text;
  if (/^hsla?\([\d\s.,%deg]+\)$/i.test(text)) return text;
  if (/^[a-z]{3,20}$/i.test(text)) return text;
  return fallback;
}

/* ---------- 图标（16×16 stroke，颜色继承 currentColor） ---------- */

const ICONS = {
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/>',
  x: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  chevronRight: '<path d="m6.4 3.8 4.2 4.2-4.2 4.2"/>',
  arrowLeft: '<path d="M12.5 8H3.8M6.8 5 3.8 8l3 3"/>',
  arrowRight: '<path d="M3.5 8h8.7M9.2 5l3 3-3 3"/>',
  zoomIn:
    '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5M5.1 7h3.8M7 5.1v3.8"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5M5.1 7h3.8"/>',
  fit: '<path d="M3.2 6.2V3.2h3M12.8 6.2V3.2h-3M3.2 9.8v3h3M12.8 9.8v3h-3"/>',
  refresh:
    '<path d="M13 8a5 5 0 1 1-1.55-3.62M13.2 3.2v3.1h-3.1"/>',
  external: '<path d="M9.2 3.2h3.6v3.6M12.8 3.2 7.6 8.4M11 9.2v3.2H3.6V5.2h3.2"/>',
  copy:
    '<rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.2"/><path d="M10.6 5.4V4.1A1.1 1.1 0 0 0 9.5 3H4.1A1.1 1.1 0 0 0 3 4.1v5.4a1.1 1.1 0 0 0 1.1 1.1h1.3"/>',
  doc: '<path d="M4 2.4h5L12 5.4v8.2H4z"/><path d="M9 2.4v3h3"/><path d="M6 8.6h4M6 10.8h4"/>',
  quote:
    '<path d="M6.1 3.8C4 4.9 2.9 6.5 2.9 8.9c.9-.4 1.9.2 1.9 1.3 0 .9-.7 1.7-1.7 1.7C1.9 11.9 1 10.7 1 9.1c0-3 1.7-5.5 4.7-6.4zM13.4 3.8c-2.1 1.1-3.2 2.7-3.2 5.1.9-.4 1.9.2 1.9 1.3 0 .9-.7 1.7-1.7 1.7-1.2 0-2.1-1.2-2.1-2.8 0-3 1.7-5.5 4.7-6.4z"/>',
  note: '<path d="M3 2.8h10v7.4l-3.2 3.2H3z"/><path d="M9.8 13.4v-3.2H13"/>',
  collection: '<path d="M2.4 5.2h4l1.3 1.5h5.9v6.6H2.4z"/><path d="M2.4 5.2V3.6h4"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.2v3.4M8 5.2h.01"/>',
  warn: '<path d="M8 2.4 14 13H2z"/><path d="M8 6.4v3.1M8 11.4h.01"/>',
  doc2: '<path d="M3.2 2.4h6L12.8 6v7.6H3.2z"/><path d="M3.2 9.2h9.6"/>',
  book: '<path d="M2.8 3.2h4.4c.5 0 1 .4 1 1v8.4c0-.6-.5-1-1-1H2.8zM13.2 3.2H8.8c-.5 0-1 .4-1 1v8.4c0-.6.5-1 1-1h4.4z"/>',
  chevronDown: '<path d="m4 6.4 4 4 4-4"/>',
};

export function icon(name, size = 16) {
  const body = ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/* ---------- 轻提示 ---------- */

let toastTimer = null;
export function toast(message, { tone = 'info', timeout = 2600 } = {}) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('is-error', tone === 'error');
  node.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('is-visible');
    toastTimer = null;
  }, timeout);
}

/* ---------- 复制 ---------- */

export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 继续走兜底方案 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 首次绘制前的骨架行 HTML。 */
export function skeletonRows(count = 5) {
  let html = '';
  for (let index = 0; index < count; index += 1) {
    const first = 46 + ((index * 13) % 34);
    const second = 30 + ((index * 17) % 30);
    html += `<div class="skeleton-row" aria-hidden="true"><div class="skeleton-line" style="width:${first}%"></div><div class="skeleton-line" style="width:${second}%"></div></div>`;
  }
  return html;
}
