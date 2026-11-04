// Evidence collection: real annotations with full lineage (P4). Read-only.
import { libraryPrefix } from '../../dist/runtime.mjs';
import { itemKey, annotationLink } from './library.mjs';

export function evidenceMarkdown(packet) {
  const escape = value => String(value ?? '').replace(/[\\[\]<>]/g, '\\$&');
  const lines = ['# Zotero 阅读材料', '', '这些链接是原文导航入口；引用是否成立仍须按具体论文论断核查。', ''];
  for (const paper of packet.papers) {
    lines.push(`## ${escape(paper.title)}`, '', `文献：${paper.library}/${paper.itemKey}`, '');
    for (const attachment of paper.attachments) {
      lines.push(`附件：${attachment.attachmentKey}；PDF SHA-256：${attachment.sha256 || '未取得，不能确认 PDF 版本'}`, '');
      for (const annotation of attachment.annotations) {
        lines.push(`### ${escape(annotation.type)} · 批注页标 ${escape(annotation.pageLabel)} · PDF 第 ${annotation.pageIndex + 1} 页`, '');
        if (annotation.text) lines.push(...annotation.text.split('\n').map(line => `> ${line}`), '');
        if (annotation.comment) lines.push('阅读者备注（与原文摘录分开）：', '', annotation.comment, '');
        lines.push(`[回到原文](${annotation.url})`, '', `批注：${annotation.key}；作者身份：未确认；引用采用：未核查`, '');
      }
    }
    for (const error of paper.errors || []) lines.push(`未完整读取：${escape(error.message)}`, '');
  }
  if (packet.errors?.length) lines.push('## 未完成条目', '', ...packet.errors.map(e => `- ${e.itemKey}: ${escape(e.message)}`), '');
  lines.push(`已处理 ${packet.processed} / ${packet.total} 篇；后续起点：${packet.nextOffset ?? '当前范围读取结束'}`, '', 'Lattics：导入 Markdown 时关闭“自动生成卡片”以保留 Zotero 回链。本文件不创建 Lattics 原生文献对象。');
  return lines.join('\n');
}

export async function scopeKeys(session, { library, keys, collection, recursive }) {
  if (keys?.length) return [...new Set(keys)].map(itemKey);
  if (!collection) throw new Error('请先选择文献或一个分类；批注整理不默认扫描整个文库。');
  const tree = await session.library.collections(library);
  if (!tree.collections.some(c => c.key === collection)) throw new Error('分类不存在或已删除。');
  const scopes = new Set([collection]);
  if (recursive) {
    let before;
    do { before = scopes.size; for (const node of tree.collections) if (scopes.has(node.parent)) scopes.add(node.key); } while (before !== scopes.size);
  }
  const found = new Set();
  for (const scope of scopes) {
    for (let start = 0; ; ) {
      const page = await session.library.items(library, { collection: scope, limit: 100, start, sort: 'title', direction: 'asc' });
      for (const entry of page.items) if (!['note'].includes(entry.itemType)) found.add(entry.key);
      start += page.items.length;
      if (start >= page.total) break;
      if (!page.items.length) throw new Error('分类分页不完整，请刷新后重试。');
    }
  }
  return [...found];
}

export async function paperEvidence(session, library, key) {
  let item = await session.library.item(library, key);
  if (item.itemType === 'attachment') {
    const raw = await session.library.raw(library, key);
    if (raw.data.parentItem) item = await session.library.item(library, raw.data.parentItem);
  }
  const paper = { library, itemKey: item.key, title: item.title, creators: item.creators, year: item.year,
    abstract: item.abstract, readLevel: 'annotations-only', adoption: 'unreviewed', attachments: [], errors: [] };
  for (const attachment of item.attachments.filter(a => a.isPdf)) {
    try {
      const { data: rawAnnotations } = await session.client.getJson(`${libraryPrefix(library)}/items/${attachment.key}/children?itemType=annotation`);
      let info;
      try { info = await session.pdfInfo(library, attachment.key); }
      catch (error) { paper.errors.push({ attachmentKey: attachment.key, message: error.message }); }
      const annotations = [];
      for (const raw of rawAnnotations) {
        const a = raw.data;
        let position;
        try { position = JSON.parse(a.annotationPosition); }
        catch { paper.errors.push({ annotationKey: raw.key, message: '批注位置不可解析，未生成回链。' }); continue; }
        if (!Number.isInteger(position.pageIndex) || position.pageIndex < 0) {
          paper.errors.push({ annotationKey: raw.key, message: '缺少物理页码，未生成回链。' }); continue;
        }
        annotations.push({ key: raw.key, type: a.annotationType, text: a.annotationText || '', comment: a.annotationComment || '',
          color: a.annotationColor, tags: a.tags || [], pageIndex: position.pageIndex, pageLabel: a.annotationPageLabel || '',
          dateModified: a.dateModified, sortIndex: a.annotationSortIndex || '', provenance: 'unconfirmed', adoption: 'unreviewed',
          url: annotationLink(library, attachment.key, raw.key, position.pageIndex) });
      }
      annotations.sort((a, b) => a.pageIndex - b.pageIndex || a.sortIndex.localeCompare(b.sortIndex) || a.key.localeCompare(b.key));
      paper.attachments.push({ attachmentKey: attachment.key, sha256: info?.sha256 || null, annotations });
    } catch (error) { paper.errors.push({ attachmentKey: attachment.key, message: error.message }); }
  }
  return paper;
}
