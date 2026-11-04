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
      wh('div',{className:'wb-eyebrow'},item.itemType),wh('h3',null,item.title),
      wh('p',null,item.creators.map(c=>c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).join('；')),
      wh('p',{className:'muted'},[item.venue,item.year].filter(Boolean).join(' · ')),
      !!item.journalLevels?.length&&wh('p',{className:'wb-ranks'},item.journalLevels.map(level=>wh('span',{key:level.id,className:'wb-rank',title:'来自 Zotero extra/标签的期刊等级'},level.label))),
      wh('dl',null,...[['DOI',item.fields.DOI||'未填写'],['页码',item.fields.pages||'未填写'],['语言',item.fields.language||'未填写']].flatMap(([label,value])=>[wh('dt',{key:label+'d'},label),wh('dd',{key:label+'v'},value)])),
      wh('div',{className:'wb-action-tabs'},wh('button',{className:'btn primary sm',disabled:!item.pdf,onClick:()=>xf({kind:'reader',library,itemKey:item.parent||item.key,attachmentKey:item.pdf.key})},'阅读 PDF'),wh('button',{className:'btn outline sm',onClick:onEvidence},'查看批注'),wh('button',{className:'btn outline sm',onClick:onActions},'引用与导出')),
      wh('button',{className:'btn ghost sm',onClick:()=>xf({kind:'item',library,key})},'打开完整详情'),
      item.abstract&&wh('details',{open:true},wh('summary',null,'摘要'),wh('p',{className:'wb-abstract'},item.abstract)),
      !!item.tags.length&&wh('p',{className:'wb-small'},'标签：'+item.tags.join(' · ')),
      wh('p',{className:'wb-small'},`Zotero ${library}/${key}`)));
}
