// Read-only candidate review, independently implemented. No merge or write API.
export class DuplicateScanError extends Error {}
const text = value => String(value ?? '').trim();
const norm = value => text(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
export function normalizeDOI(value) {
  let s = text(value).normalize('NFKC').replace(/^doi\s*:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  try { s = decodeURIComponent(s); } catch { return ''; }
  return /^10\.\d{4,9}\/\S+$/i.test(s) ? s.toLowerCase() : '';
}
const fields = ['title','date','DOI','itemType','edition','volume','issue','pages','publicationTitle','bookTitle','creators'];
const authorText = data => (data.creators || []).map(c => c.name || [c.firstName,c.lastName].filter(Boolean).join(' ')).join('；');
function differences(a,b) {
  return fields.flatMap(field => {
    const left = field === 'creators' ? authorText(a) : text(a[field]);
    const right = field === 'creators' ? authorText(b) : text(b[field]);
    if (left === right) return [];
    return [{field,left,right,kind:left && right ? 'different' : 'missing'}];
  });
}
export function duplicateCandidates(rows) {
  const regular = rows.filter(r => r?.key && r.data?.itemType && !r.data.deleted && !['attachment','note','annotation'].includes(r.data.itemType));
  const buckets = new Map(), byKey = new Map(regular.map(r => [r.key,r])), matches = new Map();
  if (byKey.size !== regular.length) throw new DuplicateScanError('文库返回重复条目身份，请重新读取。');
  const add = (bucket,key) => { if(!buckets.has(bucket)) buckets.set(bucket,[]); buckets.get(bucket).push(key); };
  for (const r of regular) {
    const d=r.data, doi=normalizeDOI(d.DOI), title=norm(d.title), year=text(d.date).match(/\b\d{4}\b/)?.[0];
    const creator=(d.creators||[]).find(c=>c.creatorType==='author');
    const author=creator && norm(creator.name || [creator.firstName,creator.lastName].filter(Boolean).join(' '));
    if(doi) add('doi:'+doi,r.key);
    if([...title].length>=8 && year && author) add('title:'+JSON.stringify([title,year,author,d.itemType]),r.key);
  }
  let comparisons=0, limited=false;
  const MAX_COMPARISONS=50000, MAX_PEERS=8;
  const seen=new Set();
  outer: for(const [bucket,keys] of [...buckets].sort(([a],[b])=>a.localeCompare(b))) {
    keys.sort();
    for(let i=0;i<keys.length;i++) for(let j=i+1;j<keys.length;j++) {
      if(comparisons++>=MAX_COMPARISONS){limited=true;break outer;}
      const left=byKey.get(keys[i]),right=byKey.get(keys[j]),a=left.data,b=right.data;
      const pair=left.key+':'+right.key;
      if(seen.has(pair)) continue;
      const sameDOI=bucket.startsWith('doi:');
      if(!sameDOI) {
        const da=normalizeDOI(a.DOI),db=normalizeDOI(b.DOI);
        if(da && db && da!==db) continue;
        if(['edition','volume','issue','pages','bookTitle'].some(f=>text(a[f]) && text(b[f]) && norm(a[f])!==norm(b[f]))) continue;
      }
      seen.add(pair);
      const reason=sameDOI?'DOI 相同（已规范化）':'标题、年份、首位作者和类型相同';
      for(const [one,two] of [[left,right],[right,left]]) {
        if(!matches.has(one.key)) matches.set(one.key,{count:0,peers:[]});
        const entry=matches.get(one.key);entry.count++;
        if(entry.peers.length<MAX_PEERS) entry.peers.push({key:two.key,title:text(two.data.title)||'(未命名)',reason,differences:differences(one.data,two.data)});
      }
    }
  }
  const items=[...matches].sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>{
    const r=byKey.get(key),d=r.data;
    return {key,title:text(d.title)||'(未命名)',itemType:d.itemType,year:text(d.date).match(/\d{4}/)?.[0]||'',date:text(d.date),creators:d.creators||[],publicationTitle:text(d.publicationTitle),DOI:text(d.DOI),
      duplicateMatches:entry.peers,duplicateCount:entry.count,peersTruncated:entry.count>entry.peers.length};
  });
  return {regularCount:regular.length,items,pairCount:seen.size,comparisonTruncated:limited,status:'candidates-only',policy:'doi-or-title-year-author-type-v1'};
}

// Both hosts use the same scan contract. No cache, no write, explicit partial results.
export async function scanDuplicateCandidates(readPage, prefix, {version, maxItems=5000}={}) {
  if(!Number.isInteger(maxItems)||maxItems<1||maxItems>5000)throw new DuplicateScanError('扫描上限必须在 1–5000 之间。');
  let total=null, currentVersion=null;
  const rows=[], seen=new Set();
  function check(page) {
    const v=page.headers.get('last-modified-version'), rawTotal=page.headers.get('total-results');
    const n=Number(rawTotal);
    if(!Array.isArray(page.data)||!v||!/^\d+$/.test(v)||rawTotal===null||!/^\d+$/.test(rawTotal)||!Number.isSafeInteger(n)) throw new DuplicateScanError('无法确认文库总数或版本，请重新读取。');
    if(currentVersion===null){currentVersion=v;total=n;}
    if(v!==currentVersion||n!==total||(version!==undefined && String(version)!==v)) throw new DuplicateScanError('文库在检查期间发生变化，请从第一页重新检查。');
  }
  do {
    const limit=Math.min(100,maxItems-rows.length);
    const page=await readPage(`${prefix}/items/top?start=${rows.length}&limit=${limit}`);check(page);
    if(!page.data.length && rows.length<Math.min(total,maxItems)) throw new DuplicateScanError('文库分页不完整，请重新检查。');
    if(page.data.length>limit||rows.length+page.data.length>total) throw new DuplicateScanError('文库分页数量不一致。');
    for(const row of page.data){if(!row?.key||seen.has(row.key))throw new DuplicateScanError('文库分页重叠，请重新检查。');seen.add(row.key);rows.push(row);}
  }while(rows.length<Math.min(total,maxItems));
  check(await readPage(`${prefix}/items/top?start=0&limit=1`));
  return {...duplicateCandidates(rows),version:currentVersion,scanned:rows.length,sourceTotal:total,truncated:rows.length<total};
}
