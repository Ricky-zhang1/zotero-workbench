// Shared tool contracts power both this human UI and the Agent interface.
function WorkbenchActions({route,selection,maintenanceRequest}) {
  var library=route.library||'user';
  var keys=selection.library===library&&selection.keys.length?selection.keys:route.kind==='reader'?[route.itemKey]:route.kind==='item'?[route.key]:route.kind==='items'?route.keys:[];
  var key=keys.length===1?keys[0]:null;
  var [mode,setMode]=ar.useState('export'),[identifier,setIdentifier]=ar.useState(''),[manualTitle,setManualTitle]=ar.useState(''),[manualAuthor,setManualAuthor]=ar.useState(''),[manualDate,setManualDate]=ar.useState('');
  var [format,setFormat]=ar.useState('text'),[style,setStyle]=ar.useState('apa'),[output,setOutput]=ar.useState(''),[note,setNote]=ar.useState('');
  var [preview,setPreview]=ar.useState(null),[busy,setBusy]=ar.useState(false),[error,setError]=ar.useState(''),[notice,setNotice]=ar.useState('');
  var [editTitle,setEditTitle]=ar.useState(''),[editDate,setEditDate]=ar.useState(''),[editing,setEditing]=ar.useState(false);
  var [metadataTemplate,setMetadataTemplate]=ar.useState(wbTemplateDefaults.metadata),[annotationTemplate,setAnnotationTemplate]=ar.useState(wbTemplateDefaults.annotation),[includeAnnotations,setIncludeAnnotations]=ar.useState(false);
  var [qualityView,setQualityView]=ar.useState('missingDOI'),[quality,setQuality]=ar.useState(null);
  var epoch=ar.useRef(0);
  ar.useEffect(()=>{setQuality(null);},[library]);
  ar.useEffect(()=>{epoch.current++;setPreview(null);setOutput('');setError('');setNotice('');setNote('');setEditing(false);setBusy(false);},[library,keys.join(','),mode]);
  ar.useEffect(()=>{if(maintenanceRequest){epoch.current++;setBusy(false);setMode('quality');setQualityView(maintenanceRequest.view);setQuality(null);}},[maintenanceRequest]);
  var execute=async(fn,receive)=>{var id=++epoch.current;setBusy(true);setError('');setNotice('');try{var result=await fn();if(id===epoch.current)receive(result);}catch(e){if(id===epoch.current)setError(e.message);}finally{if(id===epoch.current)setBusy(false);}};
  var stage=args=>execute(()=>en.call('prepare_library_action',args),value=>setPreview(value));
  var save=()=>execute(()=>en.call('commit_library_action',{previewToken:preview.previewToken,confirmWrite:true}),value=>{
    setPreview(null);setNotice(value.status==='duplicate'?'文库已有同 DOI 条目，没有重复导入。':value.status==='verified'?'已保存到 Zotero，并回读核对元数据。':'Zotero 已返回保存回执，请回读条目确认内容。');
    if(value.key)xf({kind:'item',library:'user',key:value.key});
  });
  var copy=()=>execute(()=>navigator.clipboard.writeText(output),()=>setNotice('已复制，可粘贴到稿件或文献文件。'));
  var download=()=>{var ext={text:'txt',bibtex:'bib',biblatex:'bib',ris:'ris',csljson:'json'}[format];var url=URL.createObjectURL(new Blob([output],{type:'text/plain;charset=utf-8'}));var a=document.createElement('a');a.href=url;a.download='references.'+ext;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);setNotice('已请求下载；若宿主拦截，请使用复制或下方文本。');};
  var clearPreview=fn=>e=>{fn(e.target.value);setPreview(null);};
  return wh('div',{className:'wb-content'},
    wh('header',{className:'wb-heading'},wh('span',{className:'wb-eyebrow'},'你与 AGENT 共用同一文库'),wh('h1',null,'条目、笔记与引用'),wh('p',null,keys.length?`当前范围：${keys.length} 篇文献。保存前会显示操作预览。`:'从文库勾选文献或打开一篇论文；导入新条目无需先选择。')),
    wh('div',{className:'wb-action-tabs',role:'group','aria-label':'条目操作'},...[["export","引用与导出"],["import","导入条目"],["note","阅读笔记"],["metadata","修改信息"],["card","文献卡片"],["quality","文库检查"]].map(([id,label])=>wh('button',{className:mode===id?'btn primary':'btn outline',key:id,'aria-pressed':mode===id,onClick:()=>setMode(id)},label))),
    error&&wh('div',{className:'wb-alert',role:'alert'},error),notice&&wh('div',{className:'wb-notice',role:'status'},notice),
    mode==='export'&&wh('section',{className:'wb-form'},
      wh('p',{className:'wb-small'},'引用导出不包含个人笔记和附件路径。阅读摘录请在“证据与写作”中另行导出。'),
      wh('label',null,'导出格式',wh('select',{disabled:busy,'aria-label':'导出格式',value:format,onChange:e=>{setFormat(e.target.value);setOutput('');}},...['text','bibtex','biblatex','ris','csljson'].map(f=>wh('option',{key:f,value:f},{text:'格式化引用',bibtex:'BibTeX',biblatex:'BibLaTeX',ris:'RIS',csljson:'CSL JSON'}[f])))),
      format==='text'&&wh('label',null,'引用样式',wh('select',{disabled:busy,'aria-label':'引用样式',value:style,onChange:e=>{setStyle(e.target.value);setOutput('');}},...['apa','chicago-author-date','ieee','nature','china-national-standard-gb-t-7714-2015-numeric'].map(s=>wh('option',{key:s,value:s},s)))),
      wh('button',{className:'btn primary',disabled:busy||!keys.length||keys.length>200,onClick:()=>execute(()=>en.call('export_selection',{library,keys,format,style,locale:'zh-CN'}),r=>setOutput(r.text))},busy?'生成中…':'生成引用或导出文本'),
      !keys.length&&wh('p',{className:'muted'},'请先在文库选择条目。'),keys.length>200&&wh('p',{className:'muted'},'请分批选择，每次最多 200 篇。'),
      output&&wh('div',null,wh('textarea',{'aria-label':'引用导出结果',readOnly:true,value:output,rows:12}),wh('div',{className:'wb-action-tabs'},wh('button',{className:'btn outline',onClick:copy},'复制'),wh('button',{className:'btn outline',onClick:download},'下载文件')))),
    mode==='import'&&wh('section',{className:'wb-form'},
      wh('h2',null,'通过 DOI 或 arXiv 识别'),wh('p',{className:'wb-small'},'编号将发送到 doi.org 或 arXiv 查询元数据。核对后再保存到个人文库；不会自动下载 PDF。'),
      wh('input',{disabled:busy,'aria-label':'DOI 或 arXiv',placeholder:'10.… / arXiv 编号',value:identifier,onChange:clearPreview(setIdentifier)}),
      wh('button',{className:'btn primary',disabled:busy||!identifier.trim(),onClick:()=>stage({action:'import',identifier:identifier.trim()})},busy?'识别中…':'识别并预览'),
      wh('details',null,wh('summary',null,'没有编号？手动录入'),
        wh('input',{disabled:busy,'aria-label':'手动标题',placeholder:'文献标题',value:manualTitle,onChange:clearPreview(setManualTitle)}),
        wh('input',{disabled:busy,'aria-label':'手动作者',placeholder:'作者姓名（以单字段保存）',value:manualAuthor,onChange:clearPreview(setManualAuthor)}),
        wh('input',{disabled:busy,'aria-label':'手动年份',placeholder:'年份',value:manualDate,onChange:clearPreview(setManualDate)}),
        wh('button',{className:'btn outline',disabled:busy||!manualTitle.trim(),onClick:()=>stage({action:'import',metadata:{itemType:'journalArticle',title:manualTitle.trim(),date:manualDate,creators:manualAuthor?[{name:manualAuthor,creatorType:'author'}]:[]}})},'预览手动条目'))),
    mode==='note'&&wh('section',{className:'wb-form'},wh('h2',null,'保存阅读笔记'),
      wh('p',{className:'wb-small'},key&&library==='user'?'将作为当前文献的子笔记保存；支持 Markdown。':'请在个人文库选择一篇普通文献。'),
      wh('textarea',{'aria-label':'阅读笔记',rows:10,value:note,onChange:clearPreview(setNote),placeholder:'记录你的理解、疑问和写作想法…'}),
      wh('button',{className:'btn primary',disabled:busy||!key||library!=='user'||!note.trim(),onClick:()=>stage({action:'note',key,text:note})},'预览笔记')),
    mode==='metadata'&&wh('section',{className:'wb-form'},wh('h2',null,'修改当前条目信息'),
      wh('p',{className:'wb-small'},'一次修改一篇个人文库文献；保存前显示原值与新值。'),
      wh('button',{className:'btn outline',disabled:busy||!key||library!=='user',onClick:()=>execute(()=>en.call('inspect_item',{library,key}),r=>{var item=r.item||r;setEditTitle(item.title||'');setEditDate(item.fields?.date||item.year||'');setEditing(true);setPreview(null);})},'读取当前信息'),
      editing&&wh('div',null,wh('label',null,'标题',wh('input',{disabled:busy,'aria-label':'修改标题',value:editTitle,onChange:clearPreview(setEditTitle)})),wh('label',null,'日期',wh('input',{disabled:busy,'aria-label':'修改日期',value:editDate,onChange:clearPreview(setEditDate)})),
        wh('button',{className:'btn primary',disabled:busy||!editTitle.trim(),onClick:()=>stage({action:'metadata',key,fields:{title:editTitle,date:editDate}})},'预览修改'))),
    mode==='card'&&wh('section',{className:'wb-form'},wh('h2',null,'文献与批注的模板导出'),
      wh('p',{className:'wb-small'},'一次导出当前一篇文献。支持 {{title}}、{{authors}}、{{year}}、{{journal}}、{{doi}}、{{abstract}}、{{annotations}} 和条件块 {{#字段}}…{{/字段}}。文件始终附带真实 Zotero 身份和阅读状态。'),
      wh('label',null,wh('input',{type:'checkbox',checked:includeAnnotations,disabled:busy,onChange:e=>{setIncludeAnnotations(e.target.checked);setOutput('');}}),'包含当前文献的真实批注'),
      wh('label',null,'文献模板',wh('textarea',{'aria-label':'文献模板',value:metadataTemplate,rows:9,disabled:busy,onChange:e=>{setMetadataTemplate(e.target.value);setOutput('');}})),
      includeAnnotations&&wh('label',null,'批注模板',wh('textarea',{'aria-label':'批注模板',value:annotationTemplate,rows:8,disabled:busy,onChange:e=>{setAnnotationTemplate(e.target.value);setOutput('');}})),
      wh('button',{className:'btn primary',disabled:busy||!key,onClick:()=>execute(()=>en.call('render_reading_card',{library,key,includeAnnotations,metadataTemplate,annotationTemplate}),r=>setOutput(r.text))},busy?'生成中…':'生成文献卡片'),
      output&&wh('div',null,wh('textarea',{'aria-label':'文献卡片结果',readOnly:true,value:output,rows:14}),wh('button',{className:'btn outline',onClick:copy},'复制 Markdown'))),
    mode==='quality'&&wh('section',{className:'wb-form'},wh('h2',null,'文库信息检查'),
      wh('p',{className:'wb-small'},'主动读取当前文库的条目和附件元数据。不会读取 PDF 正文或自动修改条目。“缺少 DOI”表示 DOI 字段为空，部分文献可能本来没有 DOI。'),
      wh('select',{'aria-label':'文库检查类型',value:qualityView,disabled:busy,onChange:e=>{setQualityView(e.target.value);setQuality(null);}},...[['unfiled','未归类'],['missingDOI','缺少 DOI'],['missingPDF','缺少 PDF'],['duplicates','疑似重复']].map(([value,label])=>wh('option',{value,key:value},label))),
      wh('button',{className:'btn primary',disabled:busy,onClick:()=>execute(()=>en.call('library_maintenance',{library,view:qualityView}),setQuality)},busy?'检查中…':'开始检查'),
      quality&&wh('div',null,wh('p',{role:'status'},`检查 ${quality.regularCount} 篇文献，符合当前条件 ${quality.total} 篇。${qualityView==='duplicates'?' 以下为待核对候选，不代表已确认重复。':''}${quality.truncated||quality.comparisonTruncated?' 扫描达到上限，当前结果不覆盖全部候选。':''}`),
        wh('ul',{className:'wb-maintenance-list'},...quality.items.map(item=>wh('li',{key:item.key},wh('button',{className:'btn ghost',onClick:()=>{xf({kind:'item',library,key:item.key});window.dispatchEvent(new Event('workbench-show-library'));}},item.title),wh('p',{className:'wb-small'},[item.year,item.key].filter(Boolean).join(' · ')),wh(WorkbenchDuplicateReview,{item,library})))),
        quality.nextOffset!==null&&wh('button',{className:'btn outline',disabled:busy,onClick:()=>execute(()=>en.call('library_maintenance',{library,view:qualityView,offset:quality.nextOffset,version:quality.version}),r=>setQuality(p=>({...r,items:[...p.items,...r.items]})))},'继续读取'))),
    preview&&wh('section',{className:'wb-preview','aria-label':'操作预览'},wh('h2',null,'请核对本次操作'),
      preview.duplicate?wh('p',null,preview.message||'文库已存在：',preview.duplicate.title):wh('div',null,
        wh('p',null,preview.summary.title),preview.summary.date&&wh('p',null,preview.summary.date),preview.summary.DOI&&wh('p',null,'DOI: '+preview.summary.DOI),
        preview.summary.creators&&wh('p',null,preview.summary.creators.map(c=>c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).join('；')),
        preview.summary.text&&wh('pre',{className:'wb-note-preview'},preview.summary.text),
        preview.summary.before&&wh('dl',null,...Object.keys(preview.summary.after).flatMap(k=>[wh('dt',{key:k+'label'},k),wh('dd',{key:k},`${preview.summary.before[k]||'（空）'} → ${preview.summary.after[k]||'（空）'}`)])),
        wh('p',{className:'wb-small'},'目标：个人文库。预览有效期为 15 分钟。'),
        wh('button',{className:'btn primary',disabled:busy,onClick:save},busy?'保存中…':'确认保存到 Zotero')))
  );
}

function WorkbenchDuplicateReview({item,library}) {
  if(!item.duplicateMatches?.length)return null;
  var labels={title:'标题',date:'日期',DOI:'DOI',itemType:'类型',edition:'版次',volume:'卷',issue:'期',pages:'页码',publicationTitle:'期刊',bookTitle:'书名',creators:'作者'};
  return wh('details',{className:'wb-duplicate-review'},wh('summary',null,`与 ${item.duplicateCount} 条文献可能重复 · 核对差异`),
    ...item.duplicateMatches.map(peer=>wh('section',{key:peer.key},wh('p',null,peer.reason),
      wh('button',{className:'btn ghost',onClick:()=>{xf({kind:'item',library,key:peer.key});window.dispatchEvent(new Event('workbench-show-library'));}},peer.title+' · '+peer.key),
      peer.differences.length?wh('table',null,wh('thead',null,wh('tr',null,...['字段','当前条目','对方条目'].map(t=>wh('th',{key:t},t)))),wh('tbody',null,...peer.differences.map(d=>wh('tr',{key:d.field},wh('th',null,labels[d.field]||d.field),wh('td',null,d.left||'未填写'),wh('td',null,d.right||'未填写'))))):wh('p',null,'比较字段一致，仍需核对附件和笔记。'))),
    item.peersTruncated&&wh('p',null,'这里只展示前 8 条匹配；其余条目可在候选列表中查看。'));
}
