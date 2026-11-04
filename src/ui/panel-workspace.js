var wbInspectorEnabled=true;
var wbItemOpenTimer=null;
function wbQueueItemOpen(open){clearTimeout(wbItemOpenTimer);wbItemOpenTimer=setTimeout(()=>{wbItemOpenTimer=null;open();},500);}
function wbCancelItemOpen(){if(wbItemOpenTimer){clearTimeout(wbItemOpenTimer);wbItemOpenTimer=null;}}
function wbShouldInspect(){return wbInspectorEnabled&&window.matchMedia('(min-width: 1080px)').matches;}
// List summaries carry the same parsed levels as inspect_item. Keep a tag
// fallback for older summaries while preserving every recognized family.
function wbRankIsNegative(segment){var status='(?:否|不是|未收录|no\\b|false\\b|(?<![\\d.])0(?:\\.0+)?)';return new RegExp(`(?:[:：=]\\s*|\\s+|^)${status}\\s*$`,'i').test(segment)||new RegExp(`(?:\\bCSSCI\\b|南大核心|北大核心|中文核心|\\bAMI\\b|\\bSSCI\\b|\\bSCIE\\b|\\bSCI\\b|\\bESCI\\b|A\\s*&\\s*HCI|\\bJCR\\b|\\bIF\\b|影响因子)[^;]*?${status}\\s*$`,'i').test(segment);}
function wbRankLabels(raw){
  var normalized=String(raw??'').normalize('NFKC').replace(/[\s\u3000]+/g,' ').trim();
  if(!normalized)return [];
  var protectedAliases=normalized.replace(/(\bCSSCI\b|南大核心)\s*\/\s*(\bCSSCI\b|南大核心)/gi,'$1§$2').replace(/(中文核心(?:期刊)?|北大核心)\s*\/\s*(中文核心(?:期刊)?|北大核心)/gi,'$1§$2');
  var segments=protectedAliases.split(/[;\r\n,，、|/]+/),out=[];
  var add=function(label){if(label&&!out.includes(label))out.push(label);};
  for(var segment of segments){
    var s=segment.replace(/§/g,'/').trim();
    if(!s||/^(?:中文标题|文献标题|标题|题名|title)\s*[:：]/i.test(s)||wbRankIsNegative(s))continue;
    var cssciToken=/(?<![\p{L}\p{N}])CSSCI(?:(?:\s*(?:扩展|擴展)(?:版)?)|(?=$|[\s:：/;，,]))/iu;
    if(cssciToken.test(s)||/南大核心/i.test(s)){var ci=cssciToken.test(s)?s.search(cssciToken):s.search(/南大核心/i),context=s.slice(Math.max(0,ci-8),ci+24);add(/扩展|擴展/i.test(context)?'CSSCI 扩展版':'CSSCI');}
    if(/北大核心|中文核心/.test(s))add('北大核心');
    if(/\bAMI\b/i.test(s))add('AMI');
    if(/\bSSCI\b/i.test(s))add('SSCI');
    if(/\bSCIE\b|\bSCI\b/i.test(s))add('SCI');
    if(/\bESCI\b/i.test(s))add('ESCI');
    if(/\bA\s*&\s*HCI\b/i.test(s))add('A&HCI');
    var cas=s.match(/中科院\s*(?:大类)?\s*([一二三四1-4])\s*区/);
    if(cas)add('中科院'+({'1':'一','2':'二','3':'三','4':'四','一':'一','二':'二','三':'三','四':'四'})[cas[1]]+'区');
    var jcr=s.match(/\bJCR\b\s*[:：]?\s*Q?\s*([1-4])/i);
    if(jcr)add('JCR Q'+jcr[1]);
    var impact=s.match(/(?:\bIF\b|影响因子)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i);
    if(impact&&Number(impact[1])>0)add('IF '+impact[1]);
  }
  var rankOrder=['CSSCI','CSSCI 扩展版','北大核心','AMI','SSCI','SCI','ESCI','A&HCI'];
  var rank=function(label){var index=rankOrder.indexOf(label);if(index>=0)return index;if(label.startsWith('中科院'))return 8;if(label.startsWith('JCR'))return 9;if(label.startsWith('IF '))return 10;return 11;};
  return [...new Set(out)].sort((a,b)=>rank(a)-rank(b));
}
function wbRankTags(tags){var out=[];(Array.isArray(tags)?tags:[]).forEach(function(t){wbRankLabels(typeof t==='string'?t:t?.tag).forEach(function(label){if(!out.some(level=>level.label===label))out.push({id:'tag-'+label,label});});});return out;}
function wbRankLevels(item){var out=[],seen=new Set();var add=level=>{var label=String(level?.label||'').trim();if(!label||seen.has(label))return;seen.add(label);out.push({id:String(level.id||'tag-'+label),label});};(Array.isArray(item?.journalLevels)?item.journalLevels:[]).forEach(add);var extra=typeof item?.fields?.extra==='string'?item.fields.extra:typeof item?.extra==='string'?item.extra:'';wbRankLabels(extra).forEach(label=>add({id:'extra-'+label,label}));wbRankTags(item?.tags).forEach(add);return out;}
function wbRankTone(level){var id=String(level?.id||'').toLowerCase(),label=String(level?.label||'').toLowerCase();if(id.includes('cssci')||label.includes('cssci'))return 'cssci';if(id.includes('pku')||label.includes('核心'))return 'core';if(id.includes('ami')||label.includes('ami'))return 'ami';if(id.includes('jcr')||label.includes('jcr')||label.startsWith('if '))return 'jcr';return 'international';}
function wbRankChips(item){return wbRankLevels(item).map(function(level){return wh('span',{key:'wb-rank-'+level.id+'-'+level.label,className:'wb-rank wb-rank--'+wbRankTone(level),title:'Zotero 中已有的期刊等级'},level.label);});}
function wbRankBlock(item,className){var chips=wbRankChips(item);return chips.length?wh('div',{className:['wb-ranks',className].filter(Boolean).join(' ')},...chips):null;}
function wbInspectorItem(result){var item=result?.item||result||{};return {...item,journalLevels:Array.isArray(result?.journalLevels)?result.journalLevels:(Array.isArray(item.journalLevels)?item.journalLevels:[])};}
var wbMetadataTranslations=new Map();
function wbMetadataTranslationKey(library,key){return `${String(library||'user')}/${String(key||'')}`;}
function wbMetadataSourceText(item,field){return wbNormalizePlainText(field==='abstract'?(item?.abstract??item?.abstractNote??''):(item?.title??''));}
function wbMetadataSource(item){var abstractKnown=typeof item?.abstract==='string'||typeof item?.abstractNote==='string',languageValue=item?.language??item?.fields?.language;return {title:{known:typeof item?.title==='string',text:wbMetadataSourceText(item,'title')},abstract:{known:abstractKnown,text:wbMetadataSourceText(item,'abstract')},language:{known:typeof languageValue==='string',text:String(languageValue??'').trim()}};}
function wbMetadataSourceSnapshot(item){var source=wbMetadataSource(item);return JSON.stringify([source.title.known,source.title.text,source.abstract.known,source.abstract.text,source.language.known,source.language.text]);}
function wbMetadataSourcesCompatible(left,right){if(!left||!right)return false;return ['title','abstract','language'].every(field=>!left[field]?.known||!right[field]?.known||left[field].text===right[field].text);}
function wbMetadataMergeSources(left,right){var merged={};for(var field of ['title','abstract','language'])merged[field]=right[field]?.known?right[field]:left[field]||right[field];return merged;}
function wbMetadataNeedsTranslation(item){if(['attachment','note','annotation'].includes(String(item?.itemType||'').toLowerCase()))return false;var title=wbMetadataSourceText(item,'title'),abstract=wbMetadataSourceText(item,'abstract');return !!((title&&wbMetadataRequiresTranslation(title))||(abstract&&wbMetadataRequiresTranslation(abstract)));}
function wbMetadataTranslationFieldValid(field,original,sourceKnown=true){return !!field&&typeof field==='object'&&!Array.isArray(field)&&Object.keys(field).length===4&&typeof field.original==='string'&&(!sourceKnown||field.original===original)&&typeof field.translation==='string'&&typeof field.translated==='boolean'&&typeof field.available==='boolean'&&field.available===(field.original.length>0)&&(field.available?Boolean(field.translation.trim())&&(!field.translated?field.translation===field.original:true):field.translation===''&&!field.translated);}
function wbValidateMetadataTranslation(result,{library,key,item}){
  var source=wbMetadataSource(item),languageKnown=source.language.known;
  var titleOriginal=source.title.text,abstractOriginal=source.abstract.text;
  if(!result||typeof result!=='object'||Array.isArray(result)||result.format!=='zotero-workbench/metadata-translation'||result.version!==1||result.targetLanguage!=='zh-CN'||result.library!==library||result.itemKey!==key||!/^([a-f0-9]{64})$/.test(result.sourceFingerprint||'')||typeof result.language!=='string'||(languageKnown&&result.language!==source.language.text)||result.provenance?.translationVersion!=='zotero-workbench-zh-v1'||result.provenance?.generatedReadOnly!==true||result.coverage?.complete!==true||result.coverage?.fields!==2||!Number.isInteger(result.coverage?.translated)||!wbMetadataTranslationFieldValid(result.title,titleOriginal,source.title.known)||!wbMetadataTranslationFieldValid(result.abstract,abstractOriginal,source.abstract.known)||result.coverage.translated!==Number(result.title.translated)+Number(result.abstract.translated))
    throw new Error('标题与摘要译文未通过当前来源核对，已隐藏译文；请重新读取后重试。');
  return result;
}
function wbPublishMetadataTranslation(entry){var current=wbMetadataTranslations.get(entry.key);if(current&&current!==entry)return entry;wbMetadataTranslations.set(entry.key,entry);if(wbMetadataTranslations.size>100){var oldest=wbMetadataTranslations.keys().next().value;if(oldest!==entry.key)wbMetadataTranslations.delete(oldest);}window.dispatchEvent(new CustomEvent('workbench-metadata-translation',{detail:{key:entry.key}}));return entry;}
function wbSetMetadataTranslationState(entry,patch){Object.assign(entry,patch);entry.updatedAt=Date.now();return wbPublishMetadataTranslation(entry);}
function wbMetadataEntryMatchesItem(entry,item){if(!entry?.result)return true;var source=wbMetadataSource(item),result=entry.result;if(source.title.known&&result.title.original!==source.title.text)return false;if(source.abstract.known&&result.abstract.original!==source.abstract.text)return false;if(source.language.known&&result.language!==source.language.text)return false;return true;}
function wbMetadataItemForSource(entry){return {key:entry.keyId,title:entry.source.title.known?entry.source.title.text:undefined,abstract:entry.source.abstract.known?entry.source.abstract.text:undefined,language:entry.source.language.known?entry.source.language.text:undefined};}
function wbMetadataTranslationState(library,key,item){var id=wbMetadataTranslationKey(library,key),entry=wbMetadataTranslations.get(id);return entry&&wbMetadataSourcesCompatible(entry.source,wbMetadataSource(item))&&wbMetadataEntryMatchesItem(entry,item)?entry:null;}
function wbWaitMetadataPoll(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
async function wbReadMetadataTranslationJob(entry,initial,item){
  var snapshot=initial,delay=800;
  while(snapshot?.status==='running'||snapshot?.status==='starting'){
    wbSetMetadataTranslationState(entry,{status:snapshot.status,jobId:entry.jobId,stage:snapshot.stage||'翻译标题与摘要',progress:Number.isFinite(snapshot.progress)?snapshot.progress:0,error:'',result:null});
    await wbWaitMetadataPoll(delay);delay=Math.min(2500,Math.round(delay*1.35));
    try{snapshot=await en.call('research_job',{id:entry.jobId});}
    catch(error){wbSetMetadataTranslationState(entry,{status:'check-error',error:'任务状态暂时无法读取；任务编号已保留，可继续查询。',result:null});return entry;}
  }
  if(snapshot?.status==='verification_required')return wbSetMetadataTranslationState(entry,{status:'verification_required',jobId:entry.jobId,stage:snapshot.stage||'来源待核验',error:snapshot.error||'来源暂时无法重新核验；译文已隐藏。',result:null});
  if(snapshot?.status!=='completed'||!snapshot.result){var terminal=['failed','cancelled','interrupted'].includes(snapshot?.status);return wbSetMetadataTranslationState(entry,{status:terminal?'failed':'check-error',jobId:terminal?null:entry.jobId,stage:snapshot?.stage||'',error:snapshot?.error||'标题与摘要翻译未完成；原文仍可查看。',result:null});}
  try{var result=wbValidateMetadataTranslation(snapshot.result,{library:entry.library,key:entry.keyId,item:wbMetadataItemForSource(entry)});return wbSetMetadataTranslationState(entry,{status:'completed',jobId:entry.jobId,stage:'已核验',progress:100,error:'',result});}
  catch(error){return wbSetMetadataTranslationState(entry,{status:'failed',jobId:null,stage:'来源已变化',error:error.message||'译文与当前文献内容不一致；已隐藏译文。',result:null});}
}
function wbRequestMetadataTranslation(library,item,{retry=false,automatic=false}={}){
  var key=String(item?.key||item?.itemKey||'');if(!key)return Promise.reject(new Error('缺少文献 key，无法翻译标题与摘要。'));
  if(!wbMetadataNeedsTranslation(item))return Promise.resolve(null);
  var id=wbMetadataTranslationKey(library,key),source=wbMetadataSource(item),entry=wbMetadataTranslations.get(id);
  if(!entry||!wbMetadataSourcesCompatible(entry.source,source)){entry={key:id,library:String(library||'user'),keyId:key,source,status:'idle',jobId:null,result:null,error:'',stage:'',progress:0,promise:null};wbMetadataTranslations.set(id,entry);}
  else entry.source=wbMetadataMergeSources(entry.source,source);
  if(entry.promise)return entry.promise;
  if(entry.status==='failed'&&!retry)return Promise.resolve(entry);
  if(entry.status==='check-error'&&!retry)return Promise.resolve(entry);
  var useExisting=Boolean(entry.jobId&&(entry.status==='completed'||entry.status==='verification_required'||entry.status==='check-error'));
  if(entry.status==='verification_required'&&!retry)return Promise.resolve(entry);
  if(entry.status==='completed'&&!retry&&automatic&&!useExisting)return Promise.resolve(entry);
  wbSetMetadataTranslationState(entry,{status:useExisting?'checking':'starting',result:null,error:'',stage:useExisting?'重新核验当前来源':'读取标题与摘要'});
  var operation=(async()=>{
    var initial;
    if(useExisting)initial=await en.call('research_job',{id:entry.jobId});
    else{
      initial=await en.call('start_research_job',{kind:'translate_metadata',library:entry.library,key:entry.keyId});
      if(typeof initial?.id!=='string'||! /^[a-f0-9]{24}$/.test(initial.id))throw new Error('翻译服务未返回有效任务编号。');
      entry.jobId=initial.id;
    }
    return wbReadMetadataTranslationJob(entry,initial,item);
  })().catch(error=>wbSetMetadataTranslationState(entry,{status:'failed',jobId:null,stage:'未完成',error:error?.message||'标题与摘要翻译失败；原文仍可查看。',result:null})).finally(()=>{entry.promise=null;});
  entry.promise=operation;
  return operation;
}
function wbUseMetadataTranslation(library,key,item,auto){
  var id=wbMetadataTranslationKey(library,key),snapshot=wbMetadataSourceSnapshot(item),[revision,setRevision]=ar.useState(0);
  ar.useEffect(()=>{var update=event=>{if(event?.detail?.key===id)setRevision(value=>value+1);};window.addEventListener('workbench-metadata-translation',update);return()=>window.removeEventListener('workbench-metadata-translation',update);},[id]);
  ar.useEffect(()=>{if(auto&&key&&wbMetadataNeedsTranslation(item))void wbRequestMetadataTranslation(library,item,{automatic:true});},[id,snapshot,auto]);
  return {entry:wbMetadataTranslationState(library,key,item),revision};
}
function wbMetadataStatusAction(entry,item){if(!entry)return null;if(['starting','running','checking'].includes(entry.status))return wh('span',{className:'wb-metadata-translation-status','aria-live':'polite'},entry.status==='checking'?'核验译文中…':entry.stage||'翻译中…');if(entry.status==='verification_required'||entry.status==='check-error')return wh('button',{type:'button',className:'wb-metadata-translation-retry',onClick:event=>{event.stopPropagation();void wbRequestMetadataTranslation(entry.library,item,{retry:true,automatic:false});}},entry.status==='verification_required'?'重新核验译文':'继续查询译文');if(entry.status==='failed')return wh('button',{type:'button',className:'wb-metadata-translation-retry',onClick:event=>{event.stopPropagation();void wbRequestMetadataTranslation(entry.library,item,{retry:true,automatic:false});}},'重试翻译');if(entry.status==='completed')return null;if(entry.error)return wh('span',{className:'wb-metadata-translation-status',role:'status'},entry.error);return null;}
function WorkbenchMetadataFieldTranslation({library,item,field='title',auto=false}){
  var key=item?.key||item?.itemKey||'',state=wbUseMetadataTranslation(library,key,item,auto),entry=state.entry,result=entry?.result?.[field];
  if(!entry&&!wbMetadataNeedsTranslation(item))return null;
  var nodes=[];
  if(result?.available&&result.translated)nodes.push(wh('div',{key:'translation-'+field,className:'wb-metadata-machine-translation'},wh('span',{className:'wb-metadata-translation-label'},field==='title'?'中文对照 · 机器译文':'摘要中文对照 · 机器译文'),wh('p',{className:'wb-metadata-translation-text'},result.translation)));
  if(field==='title'&&entry){if(entry.error)nodes.push(wh('span',{key:'error',className:'wb-metadata-translation-error',role:'status'},entry.error));nodes.push(wh('span',{key:'action',className:'wb-metadata-translation-action'},wbMetadataStatusAction(entry,item)));}
  return nodes.length?wh('div',{className:'wb-metadata-translation-block'},...nodes):null;
}
function WorkbenchMetadataListTitle({library,item}){
  var key=item?.key||item?.itemKey||'',state=wbUseMetadataTranslation(library,key,item,false),title=state.entry?.result?.title;
  return title?.available&&title.translated?wh('span',{className:'wb-metadata-list-translation'},wh('span',{className:'wb-metadata-translation-label'},'中文对照 · 机器译文'),wh('span',null,title.translation)):null;
}
function WorkbenchMetadataListControl({library,item}){
  var key=item?.key||item?.itemKey||'',state=wbUseMetadataTranslation(library,key,item,false),entry=state.entry;
  if(!wbMetadataNeedsTranslation(item))return null;
  var label=['starting','running','checking'].includes(entry?.status)?'正在翻译…':entry?.status==='verification_required'||entry?.status==='check-error'?'重新核验译文':entry?.status==='failed'?'重试翻译标题与摘要':'翻译标题与摘要';
  return wh('button',{type:'button',className:'wb-metadata-list-translate',disabled:['starting','running','checking'].includes(entry?.status),onClick:event=>{event.preventDefault();event.stopPropagation();void wbRequestMetadataTranslation(library,item,{retry:true,automatic:false});},onMouseDown:event=>event.stopPropagation(),onDoubleClick:event=>{event.preventDefault();event.stopPropagation();}},label);
}
function WorkbenchCollections({route,version,onMaintenance,open}) {
  var library=route.library||'user';
  var [doc,setDoc]=ar.useState(null),[error,setError]=ar.useState('');
  var [expanded,setExpanded]=ar.useState(()=>new Set());
  ar.useEffect(()=>{var disposed=false;setDoc(null);setError('');en.ready().then(()=>en.call('list_collections',{library})).then(r=>{if(!disposed)setDoc(r);}).catch(e=>{if(!disposed)setError(e.message);});return()=>{disposed=true;};},[library,version]);
  var pick=key=>E0({kind:'library',library,query:key?{collection:key}:{}});
  var nodes=parent=>(doc?.collections||[]).filter(c=>(c.parent||null)===parent);
  var toggleExpanded=key=>setExpanded(current=>{var next=new Set(current);next.has(key)?next.delete(key):next.add(key);return next;});
  var branch=(node,visited)=>{
    if(visited.has(node.key))return null;var path=new Set([...visited,node.key]),children=nodes(node.key),isExpanded=expanded.has(node.key),count=Number(node.numItems)||0;
    return wh('div',{key:node.key,className:'wb-folder'},wh('div',{className:'wb-folder-row'},children.length?wh('button',{type:'button',className:'wb-folder-toggle'+(isExpanded?' is-open':''),onClick:()=>toggleExpanded(node.key),'aria-label':`${isExpanded?'收起':'展开'}${node.name}的子分类`,'aria-expanded':isExpanded,title:isExpanded?'收起子分类':'展开子分类'},'›'):wh('span',{className:'wb-folder-toggle-placeholder','aria-hidden':'true'}),wh('button',{type:'button',className:route.query?.collection===node.key?'wb-folder-label current':'wb-folder-label',onClick:()=>pick(node.key),title:node.name},wh('span',{className:'wb-folder-name'},node.name),count>0&&wh('span',{className:'wb-folder-count'},`${count}篇`))),isExpanded&&children.length?wh('div',{className:'wb-folder-children'},...children.map(c=>branch(c,path))):null);
  };
  return wh('aside',{className:'wb-collections'+(open?' wb-collections-open':''),'aria-label':'文库分类'},wh('h2',null,'文库'),wh('button',{className:'wb-folder-label wb-folder-all',onClick:()=>pick(null)},wh('span',{className:'wb-folder-name'},'全部文献')),
    wh('h3',null,'信息检查'),...[['unfiled','未归类'],['missingDOI','缺少 DOI'],['missingPDF','缺少 PDF'],['duplicates','疑似重复']].map(([id,title])=>wh('button',{key:id,className:'wb-folder-label',onClick:()=>onMaintenance(id)},title)),
    wh('h3',null,'分类'),error&&wh('p',{className:'wb-alert'},error),...nodes(null).map(node=>branch(node,new Set())),
    !!doc?.searches?.length&&wh('h3',null,'保存的搜索'),...(doc?.searches||[]).map(s=>wh('button',{key:s.key,className:'wb-folder-label',onClick:()=>E0({kind:'library',library,query:{search:s.key}})},s.name)));
}
function WorkbenchInspector({library,selection,active,version,onActions,onEvidence}) {
  var key=selection.library===library&&selection.keys.length===1?selection.keys[0]:null;
  var [item,setItem]=ar.useState(null),[error,setError]=ar.useState('');
  ar.useEffect(()=>{var disposed=false;setItem(null);setError('');if(!active||!key)return;en.call('inspect_item',{library,key}).then(r=>{if(!disposed)setItem(wbInspectorItem(r));}).catch(e=>{if(!disposed)setError(e.message);});return()=>{disposed=true;};},[key,library,active,version]);
  return wh('aside',{className:'wb-inspector','aria-label':'文献详情栏'},wh('h2',null,'文献详情'),
    !key?wh('p',{className:'muted'},selection.keys.length>1?`已选 ${selection.keys.length} 篇。可批量引用或导出。`:'点击一篇文献，在这里查看元数据。'):
    error?wh('div',{className:'wb-alert',role:'alert'},error):!item?wh('p',{className:'muted'},'读取中…'):wh('div',null,
      wh('div',{className:'wb-eyebrow'},item.itemType),wh('h3',null,wbNormalizePlainText(item.title)),wh(WorkbenchMetadataFieldTranslation,{library,item,field:'title',auto:true}),
      wh('p',null,item.creators.map(c=>c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).join('；')),
      wh('p',{className:'muted'},[item.venue,item.year].filter(Boolean).join(' · ')),
      !!item.journalLevels?.length&&wh('p',{className:'wb-ranks'},item.journalLevels.map(level=>wh('span',{key:level.id,className:'wb-rank',title:'来自 Zotero extra/标签的期刊等级'},level.label))),
      wh('dl',null,...[['DOI',item.fields.DOI||'未填写'],['页码',item.fields.pages||'未填写'],['语言',item.fields.language||'未填写']].flatMap(([label,value])=>[wh('dt',{key:label+'d'},label),wh('dd',{key:label+'v'},value)])),
      wh('div',{className:'wb-action-tabs'},wh('button',{className:'btn primary sm',disabled:!item.pdf,onClick:()=>xf({kind:'reader',library,itemKey:item.parent||item.key,attachmentKey:item.pdf.key})},'阅读 PDF'),wh('button',{className:'btn outline sm',onClick:onEvidence},'查看批注'),wh('button',{className:'btn outline sm',onClick:onActions},'引用与导出')),
      wh('button',{className:'btn ghost sm',onClick:()=>xf({kind:'item',library,key})},'打开完整详情'),
      item.abstract&&wh('details',{open:true},wh('summary',null,'摘要'),wh('p',{className:'wb-abstract'},wbNormalizePlainText(item.abstract)),wh(WorkbenchMetadataFieldTranslation,{library,item,field:'abstract'})),
      !!item.tags.length&&wh('p',{className:'wb-small'},'标签：'+item.tags.join(' · ')),
      wh('p',{className:'wb-small'},`Zotero ${library}/${key}`)));
}
