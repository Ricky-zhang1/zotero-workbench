import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bibliographyOnly} from '../src/domain/citations.mjs';
test('bibliography export removes nested private notes while preserving exact citation keys and titles',()=>{
 const bib='@article{exactKey2020,\n title = {A {nested} title},\n annote = {Private {nested, note}\n multiline},\n file = {/private/paper.pdf},\n year = {2020},\n note = "Personal \\"quote\\" text",\n}';
 const clean=bibliographyOnly(bib,'bibtex');assert.match(clean,/@article\{exactKey2020/);assert.match(clean,/title = \{A \{nested\} title\}/);assert.match(clean,/year = \{2020\}/);assert.doesNotMatch(clean,/Private|private\/|Personal|annote|file =/);
});
test('RIS and CSL exports exclude notes but keep public abstracts',()=>{
 const ris=bibliographyOnly('TY  - JOUR\nN1  - private\ncontinuation\nN2  - abstract\nL1  - /private/paper.pdf\nER  - ','ris');assert.doesNotMatch(ris,/private|continuation/);assert.match(ris,/abstract/);assert.match(ris,/ER/);
 const json=JSON.parse(bibliographyOnly('[{"id":"citekey","note":"private","abstract":"public"}]','csljson'));assert.deepEqual(json,[{id:'citekey',abstract:'public'}]);
});
test('field-looking content inside an abstract is preserved verbatim',()=>{
 const bib='@article{key,\n abstract={A formula,\n note = {not a private field}},\n note={private}\n}';
 const out=bibliographyOnly(bib,'bibtex');assert.match(out,/note = \{not a private field\}/);assert.doesNotMatch(out,/private\}\n\}/);
});
