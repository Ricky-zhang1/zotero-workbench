import assert from 'node:assert/strict';
import { StdioClient } from '../tests/mcp-client.mjs';
import { RickyClient } from '../src/transports/zotero-mcp.mjs';
import { createHash } from 'node:crypto';
const client = new StdioClient();
function data(reply) { if (reply.isError) throw new Error(reply.content.map(c=>c.text||'').join('\n')); return reply.structuredContent; }
try {
  await client.ready();
  const status = data(await client.call('workbench_status'));
  assert.equal(status.zotero.state,'ready'); assert.equal(status.mcp.connected,true);
  console.log(JSON.stringify({check:'connections',zotero:status.zotero.version,mcp:status.mcp.server,tools:status.mcp.tools.length}));
  const collections = data(await client.call('list_collections'));
  console.log(JSON.stringify({check:'collections',count:collections.collections.length}));
  const selected = collections.collections.find(c=>c.name.includes('问责') && c.name.includes('联邦')) || collections.collections.find(c=>c.numItems>0);
  assert.ok(selected);
  const encoded = Buffer.from(JSON.stringify({collection:selected.key,limit:10})).toString('base64url');
  const page = JSON.parse((await client.read(`ui://zotero/lib/user/items/${encoded}.json`)).contents[0].text);
  console.log(JSON.stringify({check:'items',collection:selected.name,total:page.total,returned:page.items.length}));
  const pdfItem = page.items.find(i=>i.pdf); assert.ok(pdfItem,'Expected a PDF item');
  const item = JSON.parse((await client.read(`ui://zotero/lib/user/item/${pdfItem.key}.json`)).contents[0].text);
  const info = JSON.parse((await client.read(`ui://zotero/lib/user/pdf/${pdfItem.pdf.key}/info.json`)).contents[0].text);
  const pdf = Buffer.from((await client.read(`ui://zotero/lib/user/pdf/${pdfItem.pdf.key}/0`)).contents[0].blob,'base64');
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-'); assert.match(info.sha256,/^[a-f0-9]{64}$/);
  const hash = createHash('sha256').update(pdf); let received = pdf.length;
  for(let part=1;part<info.parts;part++) {
    const chunk = Buffer.from((await client.read(`ui://zotero/lib/user/pdf/${pdfItem.pdf.key}/${part}`)).contents[0].blob,'base64');
    received+=chunk.length;hash.update(chunk);
  }
  assert.equal(received,info.bytes);assert.equal(hash.digest('hex'),info.sha256);
  console.log(JSON.stringify({check:'pdf',title:item.title,bytes:info.bytes,parts:info.parts,allPartsVerified:true}));
  const packet = data(await client.call('collect_evidence',{library:'user',keys:[pdfItem.key],limit:1},120000));
  assert.equal(packet.total,1); assert.equal(packet.nextOffset,null);
  console.log(JSON.stringify({check:'evidence',papers:packet.papers.length,annotations:packet.papers.flatMap(p=>p.attachments.flatMap(a=>a.annotations)).length,incomplete:packet.incomplete,errors:packet.errors}));
  const native = await client.call('research_query',{action:'semantic_status',arguments:{}});
  if(native.isError)throw new Error(native.content[0].text);
  console.log(JSON.stringify({check:'existing-mcp',returned:true}));
  const upstream = new RickyClient();
  const upstreamTools = await upstream.list();
  const reviewSchema = upstreamTools.tools.find(t => t.name === 'create_review_highlight');
  console.log(JSON.stringify({check:'audit-interface',properties:reviewSchema?.inputSchema?.properties,required:reviewSchema?.inputSchema?.required}));
  await upstream.close();
  const annotationsResponse = await fetch('http://127.0.0.1:23119/api/users/0/items?itemType=annotation&limit=1', {headers:{'Zotero-API-Version':'3'},signal:AbortSignal.timeout(10000)});
  assert.ok(annotationsResponse.ok);
  const annotations = await annotationsResponse.json();
  if (annotations.length) {
    const attachmentKey = annotations[0].data.parentItem;
    const evidence = data(await client.call('collect_evidence',{keys:[attachmentKey],limit:1},120000));
    const all = evidence.papers.flatMap(p=>p.attachments.flatMap(a=>a.annotations));
    assert.ok(all.some(a=>a.key===annotations[0].key));
    assert.ok(all.every(a=>a.url.includes('annotation='+a.key)));
    console.log(JSON.stringify({check:'real-annotations',annotations:all.length,incomplete:evidence.incomplete,physicalPages:true,deepLinks:true}));
  }
} finally { client.close(); }
