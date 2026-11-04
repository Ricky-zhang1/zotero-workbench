import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderTemplate,renderReadingCard,maintenanceRows} from '../src/domain/workspace.mjs';
test('templates support nested optional sections and reject typos or unclosed blocks',()=>{
 assert.equal(renderTemplate('{{#title}}{{title}}{{#year}} ({{year}}){{/year}}{{/title}}',{title:'Title',year:2020}),'Title (2020)');
 assert.equal(renderTemplate('{{#doi}}DOI {{doi}}{{/doi}}',{doi:''}),'');
 assert.throws(()=>renderTemplate('{{author}}',{}),/未知/);
 assert.throws(()=>renderTemplate('{{#doi}}{{/title}}',{}),/未配对/);
 assert.throws(()=>renderTemplate('{{#doi}}',{}),/未闭合/);
});
test('reading export retains source identity and exact excerpts even with a custom template',()=>{
 const item={library:'g123',key:'ABCD1234',title:'A title',creators:[{name:'Organisation'}],fields:{DOI:'10.1234/a'},year:'2020'};
 const packet={incomplete:true,papers:[{itemKey:item.key,attachments:[{attachmentKey:'PDFK1234',sha256:'fingerprint',annotations:[{key:'ANNK1234',type:'highlight',pageIndex:3,pageLabel:'iv',text:'Raw {text}\nline',comment:'Reader interpretation'}]}]}]};
 const text=renderReadingCard(item,packet,{metadataTemplate:'{{title}}\n{{annotations}}'});
 assert.match(text,/> Raw \{text\}\n> line/);assert.match(text,/Reader interpretation/);
 assert.match(text,/zotero:\/\/open-pdf\/groups\/123\/items\/PDFK1234\?page=4&annotation=ANNK1234/);
 assert.match(text,/fingerprint/);assert.match(text,/引用采用尚未核查/);assert.match(text,/未完整读取/);
 const minimal=renderReadingCard(item,null,{metadataTemplate:'{{title}}'});assert.match(minimal,/g123\/ABCD1234/);
});
test('maintenance excludes standalone notes and attachments and uses actual PDF child types',()=>{
 const rows=[{key:'A',data:{itemType:'journalArticle',title:'Missing',DOI:'',collections:[]}},{key:'B',data:{itemType:'book',title:'Book',DOI:'10.1234/x',collections:['C']}},{key:'N',data:{itemType:'note'}},{key:'F',data:{itemType:'attachment'}}];
 const attachments=[{data:{contentType:'application/pdf',parentItem:'B'}},{data:{contentType:'text/html',parentItem:'A'}}];
 for(const view of ['unfiled','missingDOI','missingPDF']){
  const result=maintenanceRows(rows,attachments,view);assert.equal(result.regularCount,2);assert.deepEqual(result.matches.map(x=>x.key),['A']);
 }
});
