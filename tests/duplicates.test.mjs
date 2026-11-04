import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateCandidates, normalizeDOI, scanDuplicateCandidates } from '../src/domain/duplicates.mjs';
const row=(key,fields={})=>({key,data:{itemType:'journalArticle',title:'Teacher shortages and policy',date:'2020',creators:[{creatorType:'author',lastName:'Smith',firstName:'Alex'}],...fields}});
test('DOI prefixes normalize; invalid identifiers do not match',()=>{
 assert.equal(normalizeDOI('https://doi.org/10.1234%2FABC'),'10.1234/abc');
 assert.equal(normalizeDOI('doi:10.1234/ABC'),'10.1234/abc');
 for(const value of ['foo','https://elsewhere/10.1234/x','10.1234/with space','%XY'])assert.equal(normalizeDOI(value),'');
});
test('same DOI retains conflicting fields for human review; inputs remain unchanged',()=>{
 const rows=[row('A',{DOI:'10.1234/x',edition:'1'}),row('B',{DOI:'https://doi.org/10.1234/X',title:'Different title',edition:'2'})];
 const before=JSON.stringify(rows),result=duplicateCandidates(rows);
 assert.equal(result.pairCount,1);assert.equal(result.items.length,2);
 assert.equal(result.items[0].duplicateMatches[0].differences.find(d=>d.field==='edition').right,'2');
 assert.equal(JSON.stringify(rows),before);assert.deepEqual(duplicateCandidates([...rows].reverse()),result);
});
test('same title needs author/year/type; conflicting identifiers, editions and chapters excluded',()=>{
 assert.equal(duplicateCandidates([row('A'),row('B')]).pairCount,1);
 for(const change of [{creators:[]},{date:''},{itemType:'book'},{edition:'2'},{pages:'5-8'},{DOI:'10.1234/other'},{bookTitle:'Different book'}]){
  assert.equal(duplicateCandidates([row('A',{edition:'1',pages:'1-4',DOI:'10.1234/base',bookTitle:'Original book'}),row('B',change)]).pairCount,0,JSON.stringify(change));
 }
 assert.equal(duplicateCandidates([row('A',{title:'Editorial'}),row('B',{title:'Editorial',creators:[]})]).pairCount,0);
 assert.equal(duplicateCandidates([row('A',{title:'Preface'}),row('B',{title:'Preface'})]).pairCount,0);
});
test('no transitive merge inference; ignore notes and deleted records; bound display',()=>{
 const r=duplicateCandidates([row('A',{DOI:'10.1234/a'}),row('B'),row('C',{DOI:'10.1234/c'}),row('D',{deleted:true}),row('E',{itemType:'note'})]);
 assert.equal(r.pairCount,2);assert.equal(r.items.find(i=>i.key==='A').duplicateCount,1);
 const big=duplicateCandidates(Array.from({length:10},(_,i)=>row(String(i))));
 assert.equal(big.items[0].duplicateCount,9);assert.equal(big.items[0].duplicateMatches.length,8);assert.equal(big.items[0].peersTruncated,true);
});
const pages=(rows,mutate)=>async path=>{
 const u=new URL(path,'http://local'),start=Number(u.searchParams.get('start')),limit=Number(u.searchParams.get('limit'));
 const page={data:rows.slice(start,start+limit),headers:new Headers({'total-results':String(rows.length),'last-modified-version':'7'})};
 mutate?.(page,start,limit);return page;
};
test('snapshot scan finds distant matches across all pages and binds continuation version',async()=>{
 const rows=Array.from({length:203},(_,i)=>row(String(i),{title:'Unique publication '+i}));rows[202]=row('202',{title:rows[0].data.title});
 const result=await scanDuplicateCandidates(pages(rows),'/api/users/0',{version:'7'});
 assert.equal(result.scanned,203);assert.equal(result.pairCount,1);assert.equal(result.version,'7');assert.equal(result.truncated,false);
 await assert.rejects(scanDuplicateCandidates(pages(rows),'/api/users/0',{version:'6'}),/变化/);
});
test('snapshot refuses missing totals, changed versions, overlapping and empty pages',async()=>{
 const rows=Array.from({length:101},(_,i)=>row(String(i)));
 for(const mutation of [(p)=>p.headers.delete('total-results'),(p,s)=>{if(s)p.headers.set('last-modified-version','8')},(p,s)=>{if(s)p.data=[rows[0]]},(p,s)=>{if(s)p.data=[]}]){
  await assert.rejects(scanDuplicateCandidates(pages(rows,mutation),'/api/users/0'));
 }
});
test('bounded scan explicitly reports incomplete coverage, including zero matches',async()=>{
 const rows=Array.from({length:101},(_,i)=>row(String(i),{title:'Unique paper '+i}));
 const result=await scanDuplicateCandidates(pages(rows),'/api/users/0',{maxItems:100});
 assert.equal(result.scanned,100);assert.equal(result.sourceTotal,101);assert.equal(result.truncated,true);assert.equal(result.pairCount,0);
});
test('final snapshot check rejects changes after the last page',async()=>{
 let calls=0;const read=pages([row('A')],p=>{if(++calls===2)p.headers.set('last-modified-version','8')});
 await assert.rejects(scanDuplicateCandidates(read,'/api/users/0'),/变化/);
});
test('comparison limits are explicit and original full-width field values remain visible',()=>{
 const big=duplicateCandidates(Array.from({length:320},(_,i)=>row(String(i))));
 assert.equal(big.comparisonTruncated,true);assert.equal(big.pairCount,50000);
 const r=duplicateCandidates([row('A',{DOI:'10.1234/a',title:'标题：原文'}),row('B',{DOI:'10.1234/a',title:'标题:原文'})]);
 assert.equal(r.items[0].duplicateMatches[0].differences[0].left,'标题：原文');
});
