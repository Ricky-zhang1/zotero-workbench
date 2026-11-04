/**
 * 开发用引用/导出生成器（Node 标准库，无第三方）。
 *
 * dev-server 的 mock 模式与 --mode live 共用：把 Zotero item JSON（或 mock item data）
 * 转换成 BibTeX / BibLaTeX / RIS / CSL-JSON / 近似 APA 纯文本，形状对齐 Host P1
 * `/api/citations` 契约：{format, style, entries:[{key,itemType,...}], text}。
 *
 * 注意：这是 dev 实现，真实 Host half 的生成器在 integrations/dsh/index.js；
 * 两者字段语义一致，但真实实现可能更完整（例如更多条目类型、CSL locale 细节）。
 */

const BIBTEX_TYPES = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  book: 'book',
  bookSection: 'incollection',
  conferencePaper: 'inproceedings',
  thesis: 'phdthesis',
  report: 'techreport',
  manuscript: 'unpublished',
  webpage: 'misc',
};

const RIS_TYPES = {
  journalArticle: 'JOUR',
  magazineArticle: 'MGZN',
  newspaperArticle: 'NEWS',
  book: 'BOOK',
  bookSection: 'CHAP',
  conferencePaper: 'CPAPER',
  thesis: 'THES',
  report: 'RPRT',
  manuscript: 'MANSCPT',
  webpage: 'ELEC',
};

const CSL_TYPES = {
  journalArticle: 'article-journal',
  magazineArticle: 'article-magazine',
  newspaperArticle: 'article-newspaper',
  book: 'book',
  bookSection: 'chapter',
  conferencePaper: 'paper-conference',
  thesis: 'thesis',
  report: 'report',
  manuscript: 'manuscript',
  webpage: 'webpage',
  preprint: 'article',
};

function escapeBib(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_])/g, '\\$1')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function escapeRis(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

function toWork(item) {
  const data = item && item.data ? item.data : item || {};
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const authors = creators
    .filter((creator) => !creator.creatorType || creator.creatorType === 'author')
    .map((creator) => {
      if (creator.name) return { literal: String(creator.name) };
      const family = creator.lastName ? String(creator.lastName) : '';
      const given = creator.firstName ? String(creator.firstName) : '';
      if (!family && !given) return null;
      return { family, given };
    })
    .filter(Boolean);
  const yearMatch = String(data.date || '').match(/\d{4}/);
  const pages = String(data.pages || '').trim();
  const pageParts = pages.split(/\s*[-–—]\s*/).filter(Boolean);
  return {
    key: String(item?.key || data.key || ''),
    itemType: String(data.itemType || 'document'),
    title: String(data.title || '(无标题)'),
    authors,
    year: yearMatch ? yearMatch[0] : '',
    date: String(data.date || ''),
    container: String(
      data.publicationTitle || data.proceedingsTitle || data.bookTitle || data.websiteTitle || '',
    ),
    publisher: String(data.publisher || ''),
    volume: String(data.volume || ''),
    issue: String(data.issue || ''),
    pages,
    pageStart: pageParts[0] || '',
    pageEnd: pageParts[1] || '',
    DOI: String(data.DOI || ''),
    url: String(data.url || ''),
    language: String(data.language || ''),
  };
}

function bibAuthor(author) {
  if (author.literal) return escapeBib(author.literal);
  const given = author.given ? author.given.replace(/\s+/g, ' ') : '';
  return given ? `${escapeBib(author.family)}, ${escapeBib(given)}` : escapeBib(author.family);
}

function bibEntry(work, format) {
  const type = BIBTEX_TYPES[work.itemType] || 'misc';
  const fields = [];
  if (work.authors.length) fields.push(['author', work.authors.map(bibAuthor).join(' and ')]);
  fields.push(['title', `{${escapeBib(work.title)}}`]);
  fields.push(['year', escapeBib(work.year)]);
  if (work.container) {
    fields.push([format === 'biblatex' ? (type === 'incollection' || type === 'inproceedings' ? 'booktitle' : 'journaltitle') : type === 'incollection' || type === 'inproceedings' ? 'booktitle' : 'journal', escapeBib(work.container)]);
  }
  if (work.volume) fields.push(['volume', escapeBib(work.volume)]);
  if (work.issue) fields.push([format === 'biblatex' ? 'number' : 'number', escapeBib(work.issue)]);
  if (work.pages) fields.push(['pages', escapeBib(work.pages.replace(/\s*[-–—]\s*/g, '--'))]);
  if (work.publisher) fields.push(['publisher', escapeBib(work.publisher)]);
  if (work.DOI) fields.push(['doi', escapeBib(work.DOI)]);
  if (work.url) fields.push(['url', escapeBib(work.url)]);
  const fieldLines = fields
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `  ${name} = {${value}}`)
    .join(',\n');
  const command = format === 'biblatex' ? 'article' === type ? 'article' : type : type;
  return `@${command}{${work.key},\n${fieldLines}\n}`;
}

function risEntry(work) {
  const lines = [`TY  - ${RIS_TYPES[work.itemType] || 'GEN'}`];
  for (const author of work.authors) {
    lines.push(`AU  - ${escapeRis(author.literal || [author.family, author.given].filter(Boolean).join(', '))}`);
  }
  lines.push(`TI  - ${escapeRis(work.title)}`);
  if (work.container) lines.push(`${work.itemType === 'journalArticle' ? 'JO' : 'T2'}  - ${escapeRis(work.container)}`);
  if (work.year) lines.push(`PY  - ${work.year}`);
  if (work.volume) lines.push(`VL  - ${escapeRis(work.volume)}`);
  if (work.issue) lines.push(`IS  - ${escapeRis(work.issue)}`);
  if (work.pageStart) lines.push(`SP  - ${escapeRis(work.pageStart)}`);
  if (work.pageEnd) lines.push(`EP  - ${escapeRis(work.pageEnd)}`);
  if (work.DOI) lines.push(`DO  - ${escapeRis(work.DOI)}`);
  if (work.url) lines.push(`UR  - ${escapeRis(work.url)}`);
  lines.push('ER  -');
  return lines.join('\n');
}

function cslEntry(work) {
  const csl = {
    id: work.key,
    type: CSL_TYPES[work.itemType] || 'article',
    title: work.title,
  };
  if (work.authors.length) {
    csl.author = work.authors.map((author) =>
      author.literal ? { literal: author.literal } : { family: author.family, given: author.given },
    );
  }
  if (work.year) csl.issued = { 'date-parts': [[Number(work.year)]] };
  if (work.container) csl['container-title'] = work.container;
  if (work.volume) csl.volume = work.volume;
  if (work.issue) csl.issue = work.issue;
  if (work.pages) csl.page = work.pages.replace(/\s*[-–—]\s*/g, '-');
  if (work.DOI) csl.DOI = work.DOI;
  if (work.url) csl.URL = work.url;
  if (work.publisher) csl.publisher = work.publisher;
  if (work.language) csl.language = work.language;
  return csl;
}

function apaAuthors(work) {
  const names = work.authors.map((author) => {
    if (author.literal) return author.literal;
    const given = String(author.given || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}.`)
      .join(' ');
    return given ? `${author.family}, ${given}` : author.family;
  });
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(', ')}, ... ${names[names.length - 1]}`;
}

function textEntry(work) {
  const authors = apaAuthors(work) || work.title;
  const year = work.year ? `(${work.year}).` : '(n.d.).';
  const title = work.title.endsWith('.') ? work.title : `${work.title}.`;
  const parts = [`${authors} ${year} ${title}`];
  if (work.container) {
    let venue = work.container;
    if (work.volume) venue += `, ${work.volume}`;
    if (work.issue) venue += `(${work.issue})`;
    if (work.pages) venue += `, ${work.pages}`;
    parts.push(`${venue}.`);
  }
  if (work.DOI) parts.push(`https://doi.org/${work.DOI}`);
  else if (work.url) parts.push(work.url);
  return parts.join(' ');
}

/**
 * @param {Array<object>} items Zotero item JSON（含 data）或 mock data 数组
 * @param {{format?:string, style?:string, locale?:string}} options
 * @returns {{format:string, style:string, entries:Array<object>, text:string}}
 */
export function buildCitations(items, { format = 'bibtex', style = 'apa', locale = 'zh-CN' } = {}) {
  const works = (Array.isArray(items) ? items : []).map(toWork).filter((work) => work.key);
  const entries = [];
  const texts = [];
  for (const work of works) {
    if (format === 'bibtex' || format === 'biblatex') {
      const bib = bibEntry(work, format);
      entries.push({ key: work.key, itemType: work.itemType, bib });
      texts.push(bib);
    } else if (format === 'ris') {
      const ris = risEntry(work);
      entries.push({ key: work.key, itemType: work.itemType, ris });
      texts.push(ris);
    } else if (format === 'csljson') {
      const csljson = cslEntry(work);
      entries.push({ key: work.key, itemType: work.itemType, csljson });
      texts.push(JSON.stringify(csljson, null, 2));
    } else {
      const citation = textEntry(work);
      entries.push({ key: work.key, itemType: work.itemType, citation });
      texts.push(citation);
    }
  }
  let text;
  if (format === 'csljson') text = `[\n${texts.map((entry) => indent(entry, 2)).join(',\n')}\n]`;
  else if (format === 'ris') text = texts.join('\n\n');
  else text = texts.join('\n\n');
  return { format, style, locale, entries, text, count: entries.length };
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return String(text)
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
