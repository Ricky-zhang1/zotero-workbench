// 期刊等级识别：默认只读用户 Zotero 里已有的信息（extra 字段与标签），
// 可选联网查询 easyScholar 开放接口。等级是阅读辅助信息，不是认证结论；
// 来源必须随结果一起返回（P1 单一真值：Zotero 数据优先，easyScholar 明确标注）。

const CN_DIGIT = { '1': '一', '2': '二', '3': '三', '4': '四', 一: '一', 二: '二', 三: '三', 四: '四' };

// 把期刊名归一化成可比对的键：全角转半角、去空白与常见标点、统一小写。
export function normalizeVenue(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'\u2018\u2019"()\[\]{}<>\u300A\u300B\u00B7\u3001\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u2014\u2013_\-/|\\]+/g, '')
    .toLowerCase();
}

function isNegativeRankSegment(segment) {
  const status = '(?:否|不是|未收录|no\\b|false\\b|(?<![\\d.])0(?:\\.0+)?)';
  const separated = new RegExp(`(?:[:：=]\\s*|\\s+|^)${status}\\s*$`, 'i');
  const attached = new RegExp(`(?:\\bCSSCI\\b|南大核心|北大核心|中文核心|\\bAMI\\b|\\bSSCI\\b|\\bSCIE\\b|\\bSCI\\b|\\bESCI\\b|A\\s*&\\s*HCI|\\bJCR\\b|\\bIF\\b|影响因子)[^;]*?${status}\\s*$`, 'i');
  return separated.test(segment) || attached.test(segment);
}

function levelsFromSegment(s) {
  if (!s || isNegativeRankSegment(s)) return [];
  const found = [];
  const cssciToken = /(?<![\p{L}\p{N}])CSSCI(?:(?:\s*(?:扩展|擴展)(?:版)?)|(?=$|[\s:：/;，,]))/iu;
  if (cssciToken.test(s) || /南大核心/i.test(s)) {
    const cssciIndex = cssciToken.test(s) ? s.search(cssciToken) : s.search(/南大核心/i);
    const cssciContext = s.slice(Math.max(0, cssciIndex - 8), cssciIndex + 24);
    const extended = /扩展|擴展/i.test(cssciContext);
    found.push({ id: extended ? 'cssci-ext' : 'cssci', label: extended ? 'CSSCI 扩展版' : 'CSSCI' });
  }
  if (/北大核心|中文核心/.test(s)) found.push({ id: 'pku', label: '北大核心' });
  if (/\bAMI\b/i.test(s)) found.push({ id: 'ami', label: 'AMI' });
  if (/\bSSCI\b/i.test(s)) found.push({ id: 'ssci', label: 'SSCI' });
  if (/\bSCIE\b|\bSCI\b/i.test(s)) found.push({ id: 'sci', label: 'SCI' });
  if (/\bESCI\b/i.test(s)) found.push({ id: 'esci', label: 'ESCI' });
  if (/\bA\s*&\s*HCI\b/i.test(s)) found.push({ id: 'ahci', label: 'A&HCI' });
  const cas = s.match(/中科院\s*(?:大类)?\s*([一二三四1-4])\s*区/);
  if (cas) found.push({ id: 'cas' + cas[1], label: '中科院' + (CN_DIGIT[cas[1]] ?? cas[1]) + '区' });
  const jcr = s.match(/\bJCR\b\s*[:：]?\s*Q?\s*([1-4])/i);
  if (jcr) found.push({ id: 'jcr' + jcr[1], label: 'JCR Q' + jcr[1] });
  const impact = s.match(/(?:\bIF\b|影响因子)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i);
  if (impact && Number(impact[1]) > 0) found.push({ id: 'if' + impact[1], label: 'IF ' + impact[1] });
  return found;
}

// Parse each explicit value segment separately. Slash is accepted between the
// CSSCI and 南大核心 aliases, but separates unrelated rank/value pairs.
function levelsFromLine(line) {
  const normalized = String(line ?? '').normalize('NFKC').replace(/[\s\u3000]+/g, ' ').trim();
  if (!normalized) return [];
  if (/^(?:中文标题|文献标题|标题|题名|title)\s*[:：]/i.test(normalized)) return [];
  const protectedAliases = normalized
    .replace(/(\bCSSCI\b|南大核心)\s*\/\s*(\bCSSCI\b|南大核心)/gi, '$1§$2')
    .replace(/(中文核心(?:期刊)?|北大核心)\s*\/\s*(中文核心(?:期刊)?|北大核心)/gi, '$1§$2');
  const order = ['cssci', 'cssci-ext', 'pku', 'ami', 'ssci', 'sci', 'esci', 'ahci'];
  const levels = protectedAliases.split(/[;\r\n,，、|/]+/).flatMap(segment => levelsFromSegment(segment.replaceAll('§', '/').trim()));
  return levels.sort((left, right) => {
    const rank = id => id.startsWith('cas') ? 8 : id.startsWith('jcr') ? 9 : id.startsWith('if') ? 10 : order.indexOf(id);
    return rank(left.id) - rank(right.id);
  });
}

// extra 字段可能混杂 GSCC 快照、中文标题等无关行，逐行识别即可避开。
export function parseExtraLevels(extraText) {
  const levels = [];
  const seen = new Set();
  for (const line of String(extraText ?? '').split(/[\r\n]+/)) {
    for (const level of levelsFromLine(line))
      if (!seen.has(level.id)) { seen.add(level.id); levels.push(level); }
  }
  return levels;
}

// 标签可能是字符串数组（列表摘要）或 {tag} 数组（原始 API），统一后再识别。
export function recognizedRankTags(tags) {
  const levels = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const text = typeof raw === 'string' ? raw : String(raw?.tag ?? '');
    for (const level of levelsFromLine(text))
      if (!seen.has(level.id)) { seen.add(level.id); levels.push(level); }
  }
  return levels;
}

// 条目对象兼容三种形态：原始 API（data.extra/data.tags）、
// 工作台 library.item（fields.extra/tags）、已有摘要（extra/tags）。
export function journalLevelsForItem(raw) {
  const data = raw?.data ?? {};
  const extra = typeof data.extra === 'string' ? data.extra
    : typeof raw?.fields?.extra === 'string' ? raw.fields.extra
    : typeof raw?.extra === 'string' ? raw.extra : '';
  const merged = [...parseExtraLevels(extra)];
  const seen = new Set(merged.map(level => level.id));
  for (const level of recognizedRankTags(data.tags ?? raw?.tags ?? []))
    if (!seen.has(level.id)) { seen.add(level.id); merged.push(level); }
  return { levels: merged, source: 'zotero' };
}

// easyScholar 公开返回的排名键名只映射确认过的；未知键保留原文，
// 不猜测含义。空值跳过，避免把“未收录”显示成等级。
const EASYSCHOLAR_KEYS = {
  cssci: { id: 'cssci', label: 'CSSCI' },
  pku: { id: 'pku', label: '北大核心' },
  ami: { id: 'ami', label: 'AMI' },
  sci: { id: 'sci', label: 'SCI' },
  scie: { id: 'sci', label: 'SCI' },
  ssci: { id: 'ssci', label: 'SSCI' },
  ahci: { id: 'ahci', label: 'A&HCI' },
  esci: { id: 'esci', label: 'ESCI' }
};

export function levelsFromEasyScholar(ranks) {
  const levels = [];
  if (!ranks || typeof ranks !== 'object') return levels;
  for (const [key, value] of Object.entries(ranks)) {
    if (value === null || value === undefined || value === '' || value === 0) continue;
    const known = EASYSCHOLAR_KEYS[key.toLowerCase()];
    levels.push(known ? { ...known, detail: String(value) }
      : { id: 'es-' + key.toLowerCase(), label: `${key} ${value}` });
  }
  return levels;
}

export async function fetchEasyScholarRank(venue, secretKey, fetcher = fetch) {
  const name = String(venue ?? '').trim();
  if (!name) throw new Error('查询期刊等级需要期刊名。');
  if (!secretKey) throw new Error('在线查询需要 easyScholar secretKey（在 easyscholar.cc 免费注册），或设置环境变量 ZOTERO_EASYSCHOLAR_KEY。');
  const url = 'https://www.easyscholar.cc/open/getPublicationRank?secretKey=' + encodeURIComponent(secretKey)
    + '&publicationName=' + encodeURIComponent(name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try { response = await fetcher(url, { signal: controller.signal }); }
  catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'easyScholar 查询超时（10 秒），请稍后再试。' : 'easyScholar 查询失败：' + (error?.message ?? error));
  } finally { clearTimeout(timer); }
  if (response.status === 401 || response.status === 403)
    throw new Error('easyScholar 拒绝了 secretKey，请在 easyscholar.cc 检查或重新生成。');
  if (!response.ok) throw new Error(`easyScholar 查询失败（HTTP ${response.status}）。`);
  const payload = await response.json().catch(() => { throw new Error('easyScholar 返回的不是有效数据。'); });
  if (payload?.code !== 0)
    throw new Error('easyScholar 未接受该查询：' + String(payload?.msg ?? JSON.stringify(payload).slice(0, 120)));
  const ranks = payload?.data?.rank ?? null;
  return { venue: name, ranks, levels: levelsFromEasyScholar(ranks), source: 'easyscholar' };
}
