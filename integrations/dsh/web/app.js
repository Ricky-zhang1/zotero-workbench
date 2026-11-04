import { installEarlyHostMessageQueue } from './lib/host-bridge.js';

/**
 * Reader Web App 入口。
 *
 * 两种形态：
 *   - 默认（?mode=sidebar 或缺省）：DSH 右栏紧凑阅读器，由 lib/sidebar-app.js 驱动；
 *   - ?mode=workspace：全页 Zotero 工作区（左侧导航 / 多选 / 详情栏 / 条目与引用 tab，
 *     PDF 阅读 + 批注矩形浮层），由 lib/workspace-app.js 驱动。
 *
 * 两种形态共用全局的 #toast / #copy-pop / #boot-screen 与同一套 API 客户端。
 */

// 必须在任何动态 import（sidebar/workspace app）之前安装：
// 父页面可能在本应用 bridge.start() 前就发来 reveal-citation / hello。
installEarlyHostMessageQueue();

const params = new URLSearchParams(window.location.search);
const requestedMode = params.get('mode');
const mode = requestedMode === 'workspace' ? 'workspace' : 'sidebar';

document.documentElement.dataset.mode = mode;
document.body.dataset.mode = mode;
window.__ZOTERO_WORKBENCH_MODE__ = mode;

async function main() {
  if (mode === 'workspace') {
    const sidebarRoot = document.getElementById('app');
    if (sidebarRoot) sidebarRoot.hidden = true;
    const root = document.getElementById('workspace-root');
    if (!root) throw new Error('缺少 #workspace-root 容器');
    root.hidden = false;
    const { startWorkspaceApp } = await import('./lib/workspace-app.js');
    await startWorkspaceApp({ root });
    return;
  }
  const { startSidebarApp } = await import('./lib/sidebar-app.js');
  startSidebarApp();
}

main().catch((error) => {
  console.error('[zotero-workbench] 启动失败', error);
  const boot = document.getElementById('boot-screen');
  if (boot) {
    boot.classList.remove('is-hidden');
    boot.classList.add('is-error');
    const title = document.getElementById('boot-title');
    const message = document.getElementById('boot-message');
    const retry = document.getElementById('boot-retry');
    const spinner = document.getElementById('boot-spinner');
    if (title) title.textContent = '工作台启动失败';
    if (message) message.textContent = error?.message || String(error);
    if (retry) {
      retry.hidden = false;
      retry.addEventListener('click', () => window.location.reload(), { once: true });
    }
    if (spinner) spinner.hidden = true;
  }
});
