import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LibraryActions, ReviewTransactions} from '../src/domain/gateway.mjs';
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'wb-library-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const rows=new Map([['ABCD1234',{key:'ABCD1234',version:1,data:{itemType:'journalArticle',title:'Before',date:'2020'}}]]);let writes=0,localWrites=0;
 const session={ready:async()=>{},emit:()=>{},client:{baseUrl:'http://127.0.0.1:23119',status:{serverId:'zotero-server-1',writes:'available'}},cleanItem:async x=>x,writer:{
  create:async(lib,kind,objects)=>{localWrites++;const keys=objects.map((item,index)=>{const key=item.itemType==='note'?'NOTE1234':'NEWK1234';rows.set(key,{key,version:2,data:item});return key;});return keys;},
  patchItem:async(lib,key,update)=>{localWrites++;const current=rows.get(key);const patch=update(current);current.data={...current.data,...patch};current.version++;return {changed:true,item:current};}
 },library:{items:async()=>({items:[],total:0}),raw:async(lib,key)=>{if(!rows.has(key))throw new Error('not found');return rows.get(key);}}};
 const client={url:'http://localhost/mcp',call:async()=>{writes++;throw new Error('MCP writes must not be called');}};
 const transactions=new ReviewTransactions(directory);const actions=new LibraryActions({session,client,transactions,parseIdentifier:x=>({kind:'doi',value:x}),resolveIdentifier:async()=>({source:'doi',item:{itemType:'journalArticle',title:'Resolved',DOI:'10.1234/test',creators:[]}})});
 return {actions,session,client,rows,writes:()=>writes,localWrites:()=>localWrites};
}
test('metadata recognition does not write; confirmation creates item and verifies readback',async t=>{
 const f=await fixture(t);const p=await f.actions.prepare({action:'import',identifier:'10.1234/test'});assert.equal(f.writes(),0);assert.equal(p.summary.title,'Resolved');
 assert.deepEqual(p.summary.writeTransport,{id:'local-api',legacy:false});
 await assert.rejects(f.actions.commit(p.previewToken,false),/明确确认/);assert.equal(f.writes(),0);
 const result=await f.actions.commit(p.previewToken,true);assert.equal(result.status,'verified');assert.equal(result.key,'NEWK1234');assert.equal(f.localWrites(),1);assert.equal(f.writes(),0);
});
test('DOI duplicate beyond first candidate is found and prevents creation',async t=>{
 const f=await fixture(t);f.rows.set('OTHER123',{version:1,data:{DOI:'10.5678/no'}});f.rows.set('MATCH123',{version:1,data:{DOI:'10.1234/TEST'}});
 f.session.library.items=async()=>({items:[{key:'OTHER123',itemType:'journalArticle'},{key:'MATCH123',title:'Existing',itemType:'journalArticle'}],total:2});
 const result=await f.actions.prepare({action:'import',identifier:'10.1234/test'});assert.equal(result.status,'duplicate');assert.equal(result.duplicate.key,'MATCH123');assert.equal(f.writes(),0);
});
test('changed source item blocks a stale metadata preview without overwriting edits',async t=>{
 const f=await fixture(t);const p=await f.actions.prepare({action:'metadata',key:'ABCD1234',fields:{title:'After'}});
 f.rows.get('ABCD1234').version=2;await assert.rejects(f.actions.commit(p.previewToken,true),/其他操作修改/);assert.equal(f.writes(),0);
});
test('metadata uses the local version guarded patch writer',async t=>{
 const f=await fixture(t);const p=await f.actions.prepare({action:'metadata',key:'ABCD1234',fields:{title:'After'}});
 const result=await f.actions.commit(p.previewToken,true);assert.equal(result.status,'verified');assert.equal(f.rows.get('ABCD1234').data.title,'After');assert.equal(f.localWrites(),1);assert.equal(f.writes(),0);
});
test('notes are escaped to Zotero HTML and verified by readback content and parent identity',async t=>{
 const f=await fixture(t);const text='A < B & C\n<script>alert("x")</script>';
 const p=await f.actions.prepare({action:'note',key:'ABCD1234',text});
 const result=await f.actions.commit(p.previewToken,true);assert.equal(result.status,'verified');
 assert.equal(result.readback.contentVerified,true);assert.equal(result.readback.identityVerified,true);
 assert.match(result.readback.storedHtml,/&lt;script&gt;/);assert.doesNotMatch(result.readback.storedHtml,/<script>/);assert.equal(f.writes(),0);
});
test('mismatched note content remains pending after a local write',async t=>{
 const f=await fixture(t);const p=await f.actions.prepare({action:'note',key:'ABCD1234',text:'Expected'});
 const original=f.session.library.raw;f.session.library.raw=async(lib,key)=>{const raw=await original(lib,key);if(key==='NOTE1234')raw.data.note='<div><p>Different</p></div>';return raw;};
 const result=await f.actions.commit(p.previewToken,true);assert.equal(result.status,'acknowledged-readback-pending');assert.equal(result.readback.identityVerified,true);assert.equal(result.readback.contentVerified,false);
});
test('local write errors stay unknown and never fall back to the MCP writer',async t=>{
 const f=await fixture(t);f.session.writer.create=async()=>{throw new Error('local API timeout');};
 const p=await f.actions.prepare({action:'import',identifier:'10.1234/test'});await assert.rejects(f.actions.commit(p.previewToken,true),/local API timeout/);
 const next=await f.actions.prepare({action:'import',identifier:'10.1234/test'});await assert.rejects(f.actions.commit(next.previewToken,true),/已提交/);assert.equal(f.writes(),0);
});
test('Zotero 9 selects the reachable legacy MCP writer during preview and never calls local write',async t=>{
 const f=await fixture(t);f.session.client.status.writes='unsupported';let mcpWrites=0;
 f.client.ready=async()=>{};f.client.list=async()=>({tools:[{name:'write_item'}]});
 f.client.call=async(name,args)=>{mcpWrites++;assert.equal(name,'write_item');const key='MCPITEM1';f.rows.set(key,{key,version:2,data:{itemType:args.itemType,...args.fields,creators:args.creators,tags:args.tags.map(tag=>({tag}))}});return {structuredContent:{success:true,data:{itemKey:key}}};};
 const p=await f.actions.prepare({action:'import',identifier:'10.1234/test'});assert.deepEqual(p.summary.writeTransport,{id:'legacy-zotero-mcp',legacy:true});
 const result=await f.actions.commit(p.previewToken,true);assert.equal(result.status,'verified');assert.equal(result.key,'MCPITEM1');assert.equal(mcpWrites,1);assert.equal(f.localWrites(),0);
});
test('unknown local write capability refuses preview without probing or calling MCP',async t=>{
 const f=await fixture(t);f.session.client.status.writes='unknown';let mcpCalls=0;
 f.client.ready=async()=>{mcpCalls++;};f.client.list=async()=>{mcpCalls++;return {tools:[{name:'write_item'}]};};f.client.call=async()=>{mcpCalls++;};
 await assert.rejects(f.actions.prepare({action:'import',identifier:'10.1234/test'}),/尚未确认/);assert.equal(mcpCalls,0);assert.equal(f.localWrites(),0);
});
test('legacy preview requires its action tool before issuing a token',async t=>{
 const f=await fixture(t);f.session.client.status.writes='unsupported';f.client.ready=async()=>{};f.client.list=async()=>({tools:[{name:'write_note'}]});
 await assert.rejects(f.actions.prepare({action:'import',identifier:'10.1234/test'}),/未提供 write_item/);
});
test('library writes with lost response cannot replay after re-preview',async t=>{
 const f=await fixture(t);let n=0;f.session.writer.create=async()=>{n++;throw new Error('timeout');};
 const p=await f.actions.prepare({action:'import',identifier:'10.1234/test'});await assert.rejects(f.actions.commit(p.previewToken,true),/timeout/);
 const q=await f.actions.prepare({action:'import',identifier:'10.1234/test'});await assert.rejects(f.actions.commit(q.previewToken,true),/已提交/);assert.equal(n,1);
});
