import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('src/ui/panel-extension.js', root), 'utf8');
const helper = source.slice(source.indexOf('var wbReaderHighlightSaving ='), source.indexOf('function wbAnnotationSource('));
const quote = { library:'user', itemKey:'PAPER001', text:'A selected passage', pageIndex:1 };
function fixture({result={verified:true,annotationKey:'ANNO0001',attachmentKey:'PDF00001'}, annotations=[{key:'ANNO0001'}], save}={}) {
  const calls=[];
  const uri='annotations:user:PDF00001';
  const cached={data:{annotations:[]},refs:1};
  const context={
    en:{call:async(name,args)=>{calls.push({name,args});return save ? save() : result;},
      readJson:async value=>{calls.push({read:value});return {annotations,highlights:[]};}},
    rr:{annotations:(library,key)=>`annotations:${library}:${key}`},
    wf:new Map([[uri,cached]]),Co:{tick:2},rl:state=>{context.Co={...context.Co,...state};}
  };
  vm.createContext(context);
  vm.runInContext(helper,context);
  return {context,cached,calls,run:()=>context.wbSaveReaderHighlight(quote)};
}
test('save verifies the exact annotation and refreshes the mounted resource without navigation',async()=>{
  const f=fixture();await f.run();
  assert.equal(f.calls[0].name,'create_reader_highlight');
  assert.equal(f.calls[0].args.page,2);
  assert.equal(f.cached.data.annotations[0].key,'ANNO0001');
  assert.equal(f.cached.refs,1);
  assert.equal(f.context.Co.tick,3);
});
test('unverified writes never become a saved notification or refresh',async()=>{
  const f=fixture({result:{saved:true,verified:false,annotationKey:'ANNO0001',attachmentKey:'PDF00001'}});
  await assert.rejects(f.run(),/尚未回读核实/);
  assert.equal(f.calls.length,1);
  assert.equal(f.context.Co.tick,2);
});
test('a missing saved key in the actual PDF list does not count as visible success',async()=>{
  const f=fixture({annotations:[{key:'ANOTHER1'}]});
  await assert.rejects(f.run(),/尚未在 PDF 批注列表/);
  assert.equal(f.cached.data.annotations.length,0);
});
test('deduplicated existing annotations also refresh from the real PDF list',async()=>{
  const f=fixture({result:{existing:true,saved:false,annotationKey:'ANNO0001',attachmentKey:'PDF00001'}});
  await f.run();assert.equal(f.cached.data.annotations[0].key,'ANNO0001');
});
test('repeat clicks during a pending save do not submit another write',async()=>{
  let finish;
  const f=fixture({save:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=f.run();
  await assert.rejects(f.run(),/正在保存/);
  finish({verified:true,annotationKey:'ANNO0001',attachmentKey:'PDF00001'});
  await pending;
  assert.equal(f.calls.filter(call=>call.name==='create_reader_highlight').length,1);
});
test('PDF selection has an explicit visible color independent of host theme',async()=>{
  const css=await readFile(new URL('src/ui/panel-extension.css',root),'utf8');
  assert.match(css,/\.wb-shell \.textLayer ::selection\{background:rgba\(59,130,246,\.32\);color:transparent\}/);
  const build=await readFile(new URL('scripts/build.mjs',root),'utf8');
  assert.match(build,/wbReaderHighlightUi\.WorkbenchReaderHighlightControls,\{quote:A\.quote,notify:i,onSaved:\(\)=>T\(null\)\}/);
  const controls=await readFile(new URL('src/ui/reader-highlight-controls.js',root),'utf8');
  assert.match(controls,/wbSaveReaderHighlight\(quote, args\)/);
});
