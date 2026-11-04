import { execFile } from 'node:child_process';

const KEY = '[A-Z0-9]{8}';
const LIBRARY = '(?:library|groups/[1-9][0-9]{0,19})';
const selectPattern = new RegExp(`^zotero://select/${LIBRARY}/items/(${KEY})$`);
const openPdfPattern = new RegExp(`^(zotero://open-pdf/${LIBRARY}/items/${KEY})(?:\\?(.+))?$`);
const pagePattern = /^[1-9][0-9]{0,5}$/;
const annotationPattern = new RegExp(`^${KEY}$`);

/**
 * Accept only Zotero's documented item and PDF annotation URI shapes. The
 * original string is passed as one argv entry only after this exact match.
 */
export function parseZoteroLink(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Zotero 回链格式无效。');
  const select = selectPattern.exec(value);
  if (select) return { kind: 'select', itemKey: select[1], url: value };
  const pdf = openPdfPattern.exec(value);
  if (pdf) {
    const [, base, rawQuery] = pdf;
    let page = null, annotationKey = null;
    if (rawQuery !== undefined) {
      for (const part of rawQuery.split('&')) {
        const pair = /^([a-z]+)=([^&=]+)$/.exec(part);
        if (!pair) throw new Error('Zotero 回链参数格式无效。');
        const [, name, rawValue] = pair;
        if (name === 'page') {
          if (page !== null || !pagePattern.test(rawValue)) throw new Error('Zotero PDF 页码无效。');
          page = Number(rawValue);
          if (page > 100000) throw new Error('Zotero PDF 页码超出范围。');
        } else if (name === 'annotation') {
          if (annotationKey !== null || !annotationPattern.test(rawValue)) throw new Error('Zotero 批注 key 无效。');
          annotationKey = rawValue;
        } else {
          throw new Error('Zotero 回链包含不支持的参数。');
        }
      }
    }
    const params = [];
    if (page !== null) params.push(`page=${page}`);
    if (annotationKey !== null) params.push(`annotation=${annotationKey}`);
    const url = params.length ? `${base}?${params.join('&')}` : base;
    const attachmentKey = /\/items\/([A-Z0-9]{8})$/.exec(base)?.[1];
    return { kind: 'open-pdf', attachmentKey, page, annotationKey, url };
  }
  throw new Error('仅支持 Zotero 文献定位，以及无参数、页码或批注 key 定位的 PDF 回链。');
}

function launch(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, error => error ? reject(error) : resolve());
  });
}

/**
 * Ask the operating system to open a validated Zotero URI. A successful
 * return only means the OS accepted the request; it cannot prove that Zotero
 * displayed the requested item or page.
 */
export async function openZoteroLink(value, { platform = process.platform, execFileImpl = launch } = {}) {
  const link = parseZoteroLink(value);
  const executable = platform === 'darwin' ? '/usr/bin/open'
    : platform === 'linux' ? '/usr/bin/xdg-open'
      : null;
  if (!executable) throw new Error(`当前平台 ${platform} 不支持安全打开 Zotero 回链。`);
  await execFileImpl(executable, [link.url], { shell: false, windowsHide: true, timeout: 5000 });
  return {
    accepted: true,
    transport: 'operating-system',
    kind: link.kind,
    url: link.url,
    message: '操作系统已接收打开请求；这不证明 Zotero 已显示或定位到目标。',
  };
}
