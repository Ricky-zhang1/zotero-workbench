/**
 * DSH 主题同步。
 *
 * 侧边栏阅读器被宿主用**同源 iframe** 加载，因此可以（在 try/catch 里）读取
 * 父文档的 --dsw-alias-* CSS 变量，映射成本应用的 --rb-* 本地变量；
 * 跨域 / 父文档不可用时退回 prefers-color-scheme。
 *
 * DSH 主题变量名参考（不同版本可能增减，缺失即跳过）：
 *   --dsw-alias-bg-base / bg-layer-1 / bg-layer-2
 *   --dsw-alias-label-primary / label-secondary / label-tertiary
 *   --dsw-alias-border-l1 / border-l2
 *   --dsw-alias-brand-primary
 *   --dsw-alias-state-error-primary / state-warning-primary / state-success-primary
 */

const VAR_MAP = [
  ['--dsw-alias-bg-base', '--rb-bg'],
  ['--dsw-alias-bg-layer-1', '--rb-surface'],
  ['--dsw-alias-bg-layer-2', '--rb-surface-2'],
  ['--dsw-alias-bg-layer-3', '--rb-surface-3'],
  ['--dsw-alias-label-primary', '--rb-fg'],
  ['--dsw-alias-label-secondary', '--rb-fg-muted'],
  ['--dsw-alias-label-tertiary', '--rb-fg-subtle'],
  ['--dsw-alias-border-l1', '--rb-border'],
  ['--dsw-alias-border-l2', '--rb-border-strong'],
  ['--dsw-alias-brand-primary', '--rb-accent'],
  ['--dsw-alias-state-error-primary', '--rb-danger'],
  ['--dsw-alias-state-warning-primary', '--rb-warning'],
  ['--dsw-alias-state-success-primary', '--rb-success'],
];

const LOCAL_VARS = [
  ...VAR_MAP.map((pair) => pair[1]),
  '--rb-reading-bg',
  '--rb-accent-fg',
  '--rb-hover',
  '--rb-active',
  '--rb-accent-weak',
  '--rb-danger-weak',
  '--rb-warning-weak',
  '--rb-shadow-sm',
  '--rb-shadow',
  '--rb-shadow-page',
];

function safeParent() {
  try {
    const parent = window.parent;
    if (!parent || parent === window) return null;
    const doc = parent.document;
    if (!doc || !doc.documentElement) return null;
    // 触发跨域检查：不同源访问会抛 SecurityError。
    void doc.documentElement.nodeName;
    return parent;
  } catch {
    return null;
  }
}

function parseColorLuminance(value) {
  const text = String(value || '').trim();
  if (!text || text.startsWith('var(') || text.startsWith('light-dark(')) return null;
  let r = null;
  let g = null;
  let b = null;
  let match = text.match(/^#([0-9a-f]{3,8})$/i);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((ch) => ch + ch).join('');
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    match = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (match) {
      r = Number(match[1]);
      g = Number(match[2]);
      b = Number(match[3]);
    }
  }
  if (r === null || Number.isNaN(r)) return null;
  const channel = (value255) => {
    const c = value255 / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function detectParentDark(parent) {
  if (!parent) return null;
  try {
    const doc = parent.document;
    const root = doc.documentElement;
    const style = parent.getComputedStyle(root);

    const scheme = String(style.colorScheme || style.getPropertyValue('color-scheme') || '').toLowerCase();
    if (scheme) {
      const hasDark = scheme.includes('dark');
      const hasLight = scheme.includes('light');
      if (hasDark && !hasLight) return true;
      if (hasLight && !hasDark) return false;
    }

    const bgToken = style.getPropertyValue('--dsw-alias-bg-base');
    const luminance = parseColorLuminance(bgToken) ?? parseColorLuminance(style.backgroundColor);
    if (luminance !== null) return luminance < 0.4;

    const marker = `${root.dataset.theme || ''} ${root.className || ''} ${doc.body ? doc.body.className : ''}`;
    if (/\bdark\b/i.test(marker)) return true;
    if (/\blight\b/i.test(marker)) return false;

    if (typeof parent.matchMedia === 'function') {
      return parent.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch {
    /* 父文档不可读，忽略 */
  }
  return null;
}

function readParentVariables(parent) {
  const values = {};
  if (!parent) return values;
  try {
    const style = parent.getComputedStyle(parent.document.documentElement);
    for (const [source, target] of VAR_MAP) {
      const value = style.getPropertyValue(source);
      if (value && value.trim()) values[target] = value.trim();
    }
  } catch {
    /* 跨域或父文档不存在，返回空映射 */
  }
  return values;
}

function applyTheme({ dark, variables }) {
  const root = document.documentElement;
  for (const name of LOCAL_VARS) root.style.removeProperty(name);

  if (dark !== null) root.dataset.theme = dark ? 'dark' : 'light';
  else root.dataset.theme = systemPrefersDark() ? 'dark' : 'light';

  // 深色模式下如果 DSH 没给 reading 底色，用本地暗色兜底；浅色同理。
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

  if (!variables['--rb-reading-bg']) {
    root.style.setProperty(
      '--rb-reading-bg',
      root.dataset.theme === 'dark' ? '#0a0c0f' : '#e6e4df',
    );
  }
  // accent 前景色按底色亮度粗算（品牌色偏亮时用深色文字）。
  const accent = variables['--rb-accent'];
  const luminance = parseColorLuminance(accent);
  if (luminance !== null) {
    root.style.setProperty('--rb-accent-fg', luminance > 0.55 ? '#0d1117' : '#ffffff');
  }
}

function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * 启动主题同步。
 * @returns {{refresh:() => void, dispose:() => void, getTheme:() => string}}
 */
export function initTheme() {
  const parent = safeParent();
  let disposed = false;
  let rafId = 0;
  const observers = [];
  const cleanups = [];

  const refresh = () => {
    if (disposed) return;
    const dark = detectParentDark(parent);
    applyTheme({
      dark: dark === null ? systemPrefersDark() : dark,
      variables: readParentVariables(parent),
    });
  };

  const scheduleRefresh = () => {
    if (rafId || disposed) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      refresh();
    });
  };

  refresh();

  // 监听父文档主题属性变化（DSH 切换 light/dark 时通常改 html class/style）。
  if (parent) {
    try {
      const observer = new MutationObserver(scheduleRefresh);
      observer.observe(parent.document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
      });
      const body = parent.document.body;
      if (body) {
        observer.observe(body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme'],
        });
      }
      observers.push(observer);
    } catch {
      /* 跨文档监听失败：仅保留系统事件 */
    }
  }

  // 系统主题变化（父页面同步切换时这里也会触发，重复 refresh 无副作用）。
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => scheduleRefresh();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      cleanups.push(() => media.removeEventListener('change', onChange));
    } else if (typeof media.addListener === 'function') {
      media.addListener(onChange);
      cleanups.push(() => media.removeListener(onChange));
    }
  } catch {
    /* ignore */
  }

  return {
    refresh,
    getTheme: () => document.documentElement.dataset.theme || 'light',
    dispose() {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      for (const observer of observers) {
        try {
          observer.disconnect();
        } catch {
          /* ignore */
        }
      }
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
