import { annotationLink } from './library.mjs';
export const CARD_TEMPLATE = '# {{title}}\n\n{{authors}} · {{year}}\n{{#journal}}{{journal}}\n{{/journal}}{{#doi}}DOI: {{doi}}\n{{/doi}}\n{{#abstract}}## 摘要\n\n{{abstract}}\n{{/abstract}}{{#annotations}}\n## 阅读批注\n\n{{annotations}}\n{{/annotations}}';
export const ANNOTATION_TEMPLATE = '### PDF 第 {{page}} 页{{#pageLabel}} · 批注页标 {{pageLabel}}{{/pageLabel}}\n\n{{#text}}{{text}}\n\n{{/text}}{{#comment}}阅读者备注：\n\n{{comment}}\n\n{{/comment}}[回到原文]({{zoteroUrl}})\n';
export const TEMPLATE_FIELDS = ['title','authors','year','journal','doi','abstract','annotations','itemKey','library','zoteroUrl','type','page','pageLabel','text','comment','color'];
export function renderTemplate(template, values) {
  if (template.length > 20000) throw new Error('模板长度不能超过 20,000 字符。');
  const pattern=/{{\s*([#/]?)([a-zA-Z][a-zA-Z0-9]*)\s*}}/g;
  const root=[], stack=[{name:null,nodes:root}];let cursor=0,match;
  while((match=pattern.exec(template))){
    stack.at(-1).nodes.push(template.slice(cursor,match.index));cursor=pattern.lastIndex;
    const [,kind,name]=match;if(!TEMPLATE_FIELDS.includes(name))throw new Error(`未知模板字段：${name}`);
    if(kind==='#'){if(stack.length>12)throw new Error('模板嵌套过深。');const node={name,nodes:[]};stack.at(-1).nodes.push(node);stack.push(node);}
    else if(kind==='/'){if(stack.length===1||stack.at(-1).name!==name)throw new Error(`模板条件未配对：${name}`);stack.pop();}
    else stack.at(-1).nodes.push({name});
  }
  stack.at(-1).nodes.push(template.slice(cursor));if(stack.length!==1)throw new Error(`模板条件未闭合：${stack.at(-1).name}`);
  const emit=nodes=>nodes.map(n=>typeof n==='string'?n:n.nodes?(values[n.name]?emit(n.nodes):''):String(values[n.name]??'')).join('');
  return emit(root);
}
const md=value=>String(value??'').replace(/[\\`*_[\]<>#]/g,'\\$&');
export function renderReadingCard(item,packet,{metadataTemplate=CARD_TEMPLATE,annotationTemplate=ANNOTATION_TEMPLATE}={}) {
  const paper=packet?.papers?.find(p=>p.itemKey===item.key);
  const annotations=(paper?.attachments||[]).flatMap(a=>a.annotations.map(n=>renderTemplate(annotationTemplate,{
    type:n.type,page:n.pageIndex+1,pageLabel:n.pageLabel,text:n.text?n.text.split('\n').map(l=>'> '+l).join('\n'):'',comment:n.comment||'',color:n.color||'',
    zoteroUrl:annotationLink(item.library,a.attachmentKey,n.key,n.pageIndex)
  }))).join('\n');
  const namespace=item.library==='user'?'library':`groups/${item.library.slice(1)}`;
  const url=`zotero://select/${namespace}/items/${item.key}`;
  const values={title:md(item.title),authors:md((item.creators||[]).map(c=>c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).join('；')),year:md(item.year||''),journal:md(item.venue||''),doi:md(item.fields?.DOI||''),abstract:item.abstract||'',annotations,itemKey:item.key,library:item.library,zoteroUrl:url};
  let text=renderTemplate(metadataTemplate,values);
  text+=`\n\n---\n[Zotero 文献](${url}) · ${item.library}/${item.key}\n`;
  for(const a of paper?.attachments||[])text+=`\n附件 ${a.attachmentKey} · PDF SHA-256: ${a.sha256||'未取得'}\n`;
  text+='\n阅读材料；引用采用尚未核查。批注页标以 Zotero 记录为准。\n';
  if(packet?.incomplete)text+='\n注意：有材料未完整读取，不能视为全部批注。\n';
  return text;
}
export function maintenanceRows(rows,attachments,view) {
  const pdfParents=new Set(attachments.filter(r=>r.data?.contentType==='application/pdf').map(r=>r.data.parentItem).filter(Boolean));
  const regular=rows.filter(r=>!['attachment','note','annotation'].includes(r.data?.itemType));
  const matched=regular.filter(r=>view==='unfiled'?!(r.data.collections||[]).length:view==='missingDOI'?!String(r.data.DOI||'').trim():!pdfParents.has(r.key));
  return {regularCount:regular.length,matches:matched.map(r=>({key:r.key,title:r.data.title||'(未命名)',year:String(r.data.date||'').match(/\d{4}/)?.[0]||'',itemType:r.data.itemType}))};
}
