import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPagination } from '../src/transports/zotero-local.mjs';
import { RickyClient } from '../src/transports/zotero-mcp.mjs';
import { installCumulativeItems, annotationLink, localUrl, annotationFingerprint, annotationPageIndex, findExistingAnnotation } from '../src/domain/library.mjs';
import { evidenceMarkdown } from '../src/domain/evidence.mjs';
const response = (total, version = '1') => ({ headers: new Headers({ 'total-results': String(total), 'last-modified-version': version }) });
test('library load-more crosses 500 items and reuses previous pages', async () => {
  const calls = [];
  const library = {versionOf:()=>1, async items(id, query) {
    const start=query.start||0, count=Math.min(query.limit,1374-start);calls.push([start,query.limit]);
    return {library:id,version:1,total:1374,query,items:Array.from({length:count},(_,i)=>({key:String(start+i)}))};
  }};
  installCumulativeItems(library);
  assert.equal((await library.items('user',{limit:550,start:0})).items.length,550);
  assert.equal((await library.items('user',{limit:600,start:0})).items.length,600);
  assert.deepEqual(calls,[[0,500],[500,50],[550,50]]);
  const all=await library.items('user',{limit:1500,start:0});assert.equal(all.items.length,1374);assert.equal(new Set(all.items.map(i=>i.key)).size,1374);
});
test('collection pagination follows all pages, including exact 100 boundaries', async () => {
  const calls = []; const client = { async getJson(path) {
    const url = new URL(path, 'http://local'); const start = Number(url.searchParams.get('start') || 0); calls.push(start);
    return { data: Array.from({ length: Math.min(100, 200 - start) }, (_, n) => ({ key: String(start + n) })), response: response(200) };
  }}; installPagination(client);
  assert.equal((await client.getJson('/api/users/0/collections')).data.length, 200); assert.deepEqual(calls, [0, 100]);
});
test('a changed library or truncated page is not treated as complete', async () => {
  let count = 0; const client = { async getJson() { count++; return { data: count === 1 ? [{ key: 'A' }] : [], response: response(2) }; }};
  installPagination(client); await assert.rejects(client.getJson('/api/users/0/items/ABCD1234/children'), /incomplete/);
  const changed = { async getJson() { return { data: [{ key: 'A' }], response: response(2, String(++count)) }; }};
  installPagination(changed); await assert.rejects(changed.getJson('/api/users/0/collections'), /changed/);
});
test('explicit list pagination stays bounded', async () => {
  let called; const client = { async getJson(path) { called = path; return { data: [], response: response(200) }; }};
  installPagination(client); await client.getJson('/api/users/0/items?limit=5'); assert.equal(called, '/api/users/0/items?limit=5');
});
test('links use actual physical page and correct user/group namespace', () => {
  assert.equal(annotationLink('user', 'ABCD1234', 'EFGH5678', 4), 'zotero://open-pdf/library/items/ABCD1234?page=5&annotation=EFGH5678');
  assert.equal(annotationLink('g123', 'ABCD1234', 'EFGH5678', 0), 'zotero://open-pdf/groups/123/items/ABCD1234?page=1&annotation=EFGH5678');
  assert.throws(() => annotationLink('g123', 'ABCD1234', 'EFGH5678', undefined));
  assert.throws(() => localUrl('https://example.com/mcp'));
  assert.throws(() => localUrl('http://user:pass@127.0.0.1:23120/mcp'));
});
test('Markdown preserves quotation and comment as different fields', () => {
  const markdown = evidenceMarkdown({ processed: 1, total: 1, nextOffset: null, errors: [], papers: [{ title: 'Paper', library: 'user', itemKey: 'ABCD1234', errors: [], attachments: [{ attachmentKey: 'EFGH5678', sha256: 'abc', annotations: [{ key: 'JKLM1234', type: 'highlight', pageIndex: 5, pageLabel: 'iv', text: 'Original\nquotation', comment: 'My interpretation', url: 'zotero://example' }] }] }] });
  assert.match(markdown, /> Original\n> quotation/); assert.match(markdown, /阅读者备注/); assert.match(markdown, /批注页标 iv · PDF 第 6 页/); assert.match(markdown, /引用采用：未核查/);
});
test('MCP JSON and streaming responses retain session and request identity', async () => {
  const calls = []; const fake = async (url, options) => {
    const request = JSON.parse(options.body); calls.push({request, headers: options.headers});
    if (!request.id) return new Response(null, {status: 202});
    const result = request.method === 'initialize' ? {protocolVersion:'2025-03-26', serverInfo: {name:'fixture'}} : {content:[{type:'text',text:'real response'}]};
    return request.method === 'initialize'
      ? new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}), {headers:{'content-type':'application/json','mcp-session-id':'session-1'}})
      : new Response(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:request.id,result})}\n\n`, {headers:{'content-type':'text/event-stream'}});
  };
  const client = new RickyClient(undefined, fake); const result = await client.call('get_libraries', {});
  assert.equal(result.content[0].text, 'real response'); assert.equal(calls[2].headers['Mcp-Session-Id'], 'session-1');
});
test('expired MCP session reinitializes once for reads, never automatically replays writes',async()=>{
  for(const readOnly of [true,false]) {
    let initialize=0,calls=0;
    const fake=async(url,options)=>{
      const q=JSON.parse(options.body);
      if(q.method==='notifications/initialized')return new Response(null,{status:202});
      if(q.method==='initialize'){initialize++;return new Response(JSON.stringify({id:q.id,result:{protocolVersion:'2025-03-26'}}),{headers:{'mcp-session-id':'s'+initialize}});}
      calls++;return calls===1?new Response('expired',{status:404}):new Response(JSON.stringify({id:q.id,result:{content:[]}}));
    };
    const client=new RickyClient(undefined,fake);
    if(readOnly){await client.call('get_content',{}, {readOnly});assert.equal(initialize,2);assert.equal(calls,2);}
    else {await assert.rejects(client.call('create_review_highlight',{}),/404/);assert.equal(initialize,1);assert.equal(calls,1);}
  }
});
test('SSE parser accepts CRLF boundaries split between network chunks',async()=>{
  const fake=async(url,options)=>{
    const q=JSON.parse(options.body);
    const bytes=new TextEncoder().encode(`data: ${JSON.stringify({id:q.id,result:{answer:'中文'}})}\r\n\r\n`);
    return new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  };
  const client=new RickyClient(undefined,fake);assert.deepEqual(await client.request('tools/list',{}),{answer:'中文'});
});
test('pagination rejects an oversized last page rather than certifying completeness',async()=>{
  let n=0;const c={getJson:async()=>({data:++n===1?[{key:'1'}]:[{key:'2'},{key:'3'}],response:response(2)})};installPagination(c);
  await assert.rejects(c.getJson('/api/users/0/collections'),/more items/);
});

test('highlight dedupe fingerprint strips all whitespace and ignores case, requires page match when given', () => {
  const rows = [
    { key: 'AAAA1111', data: { annotationType: 'highlight', annotationText: '编外 用师 问题', annotationPosition: JSON.stringify({ pageIndex: 3 }) } },
    { key: 'BBBB2222', data: { annotationType: 'note', annotationText: '编外用师问题', annotationPosition: JSON.stringify({ pageIndex: 3 }) } },
  ];
  assert.equal(findExistingAnnotation(rows, 4, ' 编外用师　问题 ')?.key, 'AAAA1111');
  assert.equal(findExistingAnnotation(rows, 5, '编外用师问题'), null);
  assert.equal(findExistingAnnotation(rows, undefined, '编外用师问题')?.key, 'AAAA1111');
  assert.equal(findExistingAnnotation(rows, undefined, '完全不同的内容'), null);
  assert.equal(annotationPageIndex('{bad json'), null);
  assert.equal(annotationFingerprint('A  B\nC'), 'abc');
});

test('top-level item scans follow pagination instead of silently stopping at the first page',async()=>{
 const calls=[],client={getJson:async path=>{const u=new URL(path,'http://local');const start=Number(u.searchParams.get('start')||0);calls.push(start);return {data:Array.from({length:Math.min(100,203-start)},(_,i)=>({key:String(start+i)})),response:response(203)};}};
 installPagination(client);assert.equal((await client.getJson('/api/users/0/items/top')).data.length,203);assert.deepEqual(calls,[0,100,200]);
});
