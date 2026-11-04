import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReviewTransactions, digest, acceptedPreview } from '../src/domain/gateway.mjs';
const response = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const preview = response({ success: true, dryRun: true, created: false, data: { annotations: [{attachmentKey:'ABCD1234'}] }, metadata:{semanticAudit:'passed'} });
const written = response({ success: true, data: { annotations: [{ annotationKey:'EFGH5678',attachmentKey:'ABCD1234',pageIndex:1,created:true }] } });
const payload = { judgment:{claim:'Private claim'},locators:['{"text":"Private PDF text"}'],libraryID:1 };
async function fixture(t, options) {
  const dir=await mkdtemp(join(tmpdir(),'wb-transaction-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  return new ReviewTransactions(dir,options);
}
test('write requires same successful preview, unchanged payload, explicit confirmation and fresh token',async t=>{
  let now=100; const gate=await fixture(t,{now:()=>now,ttl:10}); let sent=0;
  const send=async()=>{sent++;return written;};
  await assert.rejects(gate.commit(payload,'missing',true,send),/dry-run/);
  const p=gate.prepare(payload,{auditReceipt:'exact',locatorResults:payload.locators},preview);
  await assert.rejects(gate.commit(payload,p.previewToken,false,send),/明确确认/);
  await assert.rejects(gate.commit({...payload,libraryID:2},p.previewToken,true,send),/变化/);
  now=111;await assert.rejects(gate.commit(payload,p.previewToken,true,send),/过期/);assert.equal(sent,0);
});
test('diagnostic-only, failed, queued and malformed upstream previews do not authorize writes',()=>{
  for(const r of [{isError:true},response({success:true,dryRun:true}),response({success:false}),response({status:'queued'}),response({...JSON.parse(preview.content[0].text),metadata:{semanticAudit:'not_supplied_locator_diagnostic_only'}})]) assert.throws(()=>acceptedPreview(r));
});
test('concurrent duplicate commits send once and do not persist private material',async t=>{
  const gate=await fixture(t);const p=gate.prepare(payload,{auditReceipt:'exact',locatorResults:payload.locators},preview);let sent=0;
  const send=async args=>{sent++;assert.equal(args.auditReceipt,'exact');assert.equal(args.confirmWrite,true);assert.equal(args.dryRun,false);return written;};
  const results=await Promise.allSettled([gate.commit(payload,p.previewToken,true,send),gate.commit(payload,p.previewToken,true,send)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(sent,1);
  const path=join(gate.directory,p.operationId+'.json'),saved=await readFile(path,'utf8');assert.doesNotMatch(saved,/Private|exact/);
  assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await gate.status(p.operationId)).status,'acknowledged');
});
test('lost write response stays unknown across server restarts and cannot be resubmitted',async t=>{
  const gate=await fixture(t);let sent=0;const p=gate.prepare(payload,{},preview);
  await assert.rejects(gate.commit(payload,p.previewToken,true,async()=>{sent++;throw new Error('connection lost after server commit');}),/connection lost/);
  const restarted=new ReviewTransactions(gate.directory);const again=restarted.prepare(payload,{},preview);
  await assert.rejects(restarted.commit(payload,again.previewToken,true,async()=>{sent++;return written;}),/outcome-unknown/);
  assert.equal(sent,1);assert.equal((await restarted.status(p.operationId)).status,'outcome-unknown');
});
test('stable identity ignores object key order but binds exact locator text',()=>{
  assert.equal(digest({a:1,b:2}),digest({b:2,a:1}));assert.notEqual(digest(payload),digest({...payload,locators:['different']}));
});
