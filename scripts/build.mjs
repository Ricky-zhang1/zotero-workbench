import { CARD_TEMPLATE, ANNOTATION_TEMPLATE } from '../src/domain/workspace.mjs';
import { zoteroPlainText } from '../src/domain/plain-text.mjs';
import { metadataRequiresTranslation } from '../src/domain/metadata-translation-heuristic.mjs';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const vendor = resolve(root, 'vendor/zcode-zotero-0.2.1');
const checksums = JSON.parse(await readFile(resolve(root, 'vendor/SHA256SUMS.json'), 'utf8'));
for (const [file, hash] of Object.entries(checksums)) {
  if (createHash('sha256').update(await readFile(resolve(root, 'vendor', file))).digest('hex') !== hash)
    throw new Error(`Vendor checksum mismatch: ${file}`);
}
const textfoldRoot = resolve(root, 'vendor/textfold');
const textfoldChecksums = JSON.parse(await readFile(resolve(textfoldRoot, 'SHA256SUMS.json'), 'utf8'));
async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__pycache__') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
const textfoldFiles = (await walkFiles(textfoldRoot))
  .filter((path) => path.endsWith('.py') || ['LICENSE', 'NOTICE', 'FORMAT.md', 'UPSTREAM.json', 'requirements-lock.txt'].includes(path.slice(path.lastIndexOf('/') + 1)))
  .map((path) => path.slice(textfoldRoot.length + 1).replaceAll('\\', '/'))
  .sort();
const expectedTextfoldFiles = Object.keys(textfoldChecksums).sort();
if (JSON.stringify(textfoldFiles) !== JSON.stringify(expectedTextfoldFiles))
  throw new Error('TextFold checksum manifest does not match the vendored source file set');
for (const [file, hash] of Object.entries(textfoldChecksums)) {
  if (createHash('sha256').update(await readFile(resolve(textfoldRoot, file))).digest('hex') !== hash)
    throw new Error(`TextFold checksum mismatch: ${file}`);
}
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Patch anchor is not unique: ${before.slice(0, 100)}`);
  // Treat injected source as literal text: JS source may contain replacement
  // tokens such as "$&", "$'", or "$`" inside regular expressions and strings.
  return text.replace(before, () => after);
}
function replaceBetweenOnce(text, start, end, replacement) {
  if (text.split(start).length !== 2 || text.split(end).length !== 2)
    throw new Error(`Patch region is not unique: ${start.slice(0, 100)}`);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`Patch region end is missing: ${end.slice(0, 100)}`);
  return text.slice(0, from) + replacement + text.slice(to);
}
function inlineExportModule(source, namespace, label) {
  const names = [...source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]);
  if (!names.length || new Set(names).size !== names.length)
    throw new Error(`${label} exports changed; refusing to inline it into the Codex panel.`);
  const body = source.replace(/^export\s+/gm, '');
  if (/^\s*(?:import|export)\s/m.test(body))
    throw new Error(`${label} contains an unsupported module declaration.`);
  return `var ${namespace}=(function(){\n${body}\nreturn {${names.join(',')}};\n})();`;
}
function checkPanelInlineScripts(html) {
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  let checked = 0;
  for (let index = 0; index < blocks.length; index++) {
    const source = blocks[index][1].trim();
    if (!source) continue;
    try {
      new Script(source, { filename: `panel-inline-${index}.js` });
      checked++;
    } catch (error) {
      throw new Error(`Generated panel inline script ${index} does not parse: ${error.message}`);
    }
  }
  if (!checked) throw new Error('Generated panel contains no inline JavaScript to validate.');
}
await mkdir(resolve(root, 'dist/ui'), { recursive: true });
const researchViewSource = await readFile(resolve(root, 'src/ui/research-view.js'), 'utf8');
const researchViewInlineBody = researchViewSource.replace(/^export const mountResearchWorkbench\s*=/m, 'const mountResearchWorkbench =');
if (researchViewInlineBody === researchViewSource || /^export\s/m.test(researchViewInlineBody))
  throw new Error('Research view entry point changed; refusing to assemble the Codex panel.');
const researchViewInline = `var mountResearchWorkbench=(function(){\n${researchViewInlineBody}\nreturn mountResearchWorkbench;\n})();`;
const highlightPresetsSource = await readFile(resolve(root, 'src/ui/highlight-presets.js'), 'utf8');
const highlightPresetsInline = inlineExportModule(highlightPresetsSource, 'wbHighlightPresets', 'Highlight presets');
const readerHighlightControlsSource = await readFile(resolve(root, 'src/ui/reader-highlight-controls.js'), 'utf8');
const readerHighlightControlsInline = inlineExportModule(readerHighlightControlsSource, 'wbReaderHighlightUi', 'Reader highlight controls');
const researchViewCss = await readFile(resolve(root, 'src/ui/research-view.css'), 'utf8');
const panelWorkspaceCss = await readFile(resolve(root, 'src/ui/panel-workspace.css'), 'utf8');
const panelExtensionCss = await readFile(resolve(root, 'src/ui/panel-extension.css'), 'utf8');
await mkdir(resolve(root, 'integrations/dsh/web/lib'), { recursive: true });
await writeFile(resolve(root, 'integrations/dsh/web/lib/research-view.js'), researchViewSource);
await writeFile(resolve(root, 'integrations/dsh/web/lib/plain-text.js'), await readFile(resolve(root, 'src/domain/plain-text.mjs'), 'utf8'));
await writeFile(resolve(root, 'integrations/dsh/web/lib/metadata-translation-heuristic.js'), await readFile(resolve(root, 'src/domain/metadata-translation-heuristic.mjs'), 'utf8'));
await writeFile(resolve(root, 'integrations/dsh/web/research-view.css'), researchViewCss);
let runtime = await readFile(resolve(vendor, 'dist/server.mjs'), 'utf8');
// Keep Zotero Extra in list summaries so the maintained library wrapper can
// parse journal levels locally from the same raw fields as inspect_item.
runtime = replaceOnce(runtime,
  '    tags: (data.tags ?? []).map((tag2) => tag2.tag),\n    numChildren:',
  '    tags: (data.tags ?? []).map((tag2) => tag2.tag),\n    extra: typeof data.extra === "string" ? data.extra : "",\n    numChildren:');
const main = '// src/adapters/main.ts\nvar log =';
if (runtime.split(main).length !== 2) throw new Error('Upstream entry point changed');
runtime = runtime.split(main)[0];
runtime = replaceOnce(runtime, 'var SERVER_NAME = "zotero";', 'var SERVER_NAME = "zotero-workbench";');
runtime = replaceOnce(runtime, 'var PLUGIN_VERSION = "0.2.1";', `var PLUGIN_VERSION = ${JSON.stringify(version)};`);
runtime = replaceOnce(runtime, 'var APP_NAME = "ZCode";', 'var APP_NAME = "Zotero Workbench";');
runtime = replaceOnce(runtime,
  'const panelMeta = { ui: { prefersBorder: false }, "zcode/csp": { wasmUnsafeEval: true } };',
  'const panelMeta = { ui: { prefersBorder: false }, "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" } };');
runtime = replaceOnce(runtime, 'It lasts for this session; use save: true or save_highlights to store it as a real Zotero annotation.', 'Session-only candidate marker. Direct save is disabled; use review_evidence with a successful previewToken and explicit user authorization.');
runtime = replaceOnce(runtime, 'Also save it to Zotero as an annotation now.${writeNote}', 'Unsupported in Workbench. Keep false; use the reviewed preview/commit workflow.');
runtime = replaceOnce(runtime, 'Save your session highlights to Zotero as highlight annotations on the PDF (with their comments), so they stay in the user\'s library. Without ids, saves all unsaved highlights (or those on key).${writeNote}', 'Disabled compatibility endpoint. Use review_evidence: first dryRun=true, then the returned previewToken with unchanged materials and explicit user authorization.');
runtime += '\nexport { ZoteroSession, createZoteroMcpServer, StdioServerTransport, external_exports as z, ZoteroError, libraryPrefix, summarize, parseAnnotation, parseIdentifier, resolveIdentifier };\n';
await writeFile(resolve(root, 'dist/runtime.mjs'), runtime);
let panel = await readFile(resolve(vendor, 'dist/ui/panel.html'), 'utf8');
// Route upstream panel opens through the maintained feedback wrapper. Apply
// these replacements before appending panel-extension.js so its own external
// URL branch can continue to call en.openLink without becoming recursive.
panel = replaceOnce(panel,
  'onClick:()=>void en.openLink(AJ(t.library,c.key))',
  'onClick:()=>void wbOpenTargetWithFeedback(AJ(t.library,c.key)).catch(()=>{})');
panel = replaceOnce(panel,
  'en.openLink(d==="DOI"?`https://doi.org/${m}`:m)',
  'wbOpenTargetWithFeedback(d==="DOI"?`https://doi.org/${m}`:m).catch(()=>{})');
panel = replaceOnce(panel,
  'onClick:()=>void en.openLink(xC(t.library,t.attachmentKey,x+1))',
  'onClick:()=>void wbOpenTargetWithFeedback(xC(t.library,t.attachmentKey,x+1)).catch(()=>{})');
panel = replaceOnce(panel,
  'en.openLink(v1)',
  'wbOpenTargetWithFeedback(v1).catch(()=>{})');
panel = replaceOnce(panel,
  'onClick:()=>void en.openLink(`${xC(i.library,i.attachmentKey)}?annotation=${t.annotation.key}`)',
  'onClick:()=>void wbOpenTargetWithFeedback(`${xC(i.library,i.attachmentKey)}?annotation=${t.annotation.key}`).catch(()=>{})');
let panelExtensionInline = (await readFile(resolve(root, 'src/ui/panel-extension.js'), 'utf8')).replace('__WORKBENCH_VERSION__', version);
panelExtensionInline = replaceOnce(panelExtensionInline,
  'async function wbSaveReaderHighlight(quote) {',
  'async function wbSaveReaderHighlight(quote, preset) {');
panelExtensionInline = replaceOnce(panelExtensionInline,
  'library:quote.library,key:quote.itemKey,quote:quote.text,page:quote.pageIndex+1\n    });',
  'library:quote.library,key:quote.itemKey,quote:quote.text,page:quote.pageIndex+1,color:preset?.color,tags:preset?.tags??[]\n    });');
// Mount the maintained feature component inside the same React tree as the upstream reader.
panel = replaceOnce(panel,
  'var Sne=si(ds(),1);(0,kne.createRoot)(document.getElementById("root")).render((0,Sne.jsx)(vne,{}));WJ();',
  `var wbTemplateDefaults=${JSON.stringify({metadata:CARD_TEMPLATE,annotation:ANNOTATION_TEMPLATE})};${highlightPresetsInline}\nvar wbNormalizePlainText=${zoteroPlainText.toString()};var wbMetadataRequiresTranslation=${metadataRequiresTranslation.toString()};\n${await readFile(resolve(root, 'src/ui/panel-workspace.js'), 'utf8')}\n${await readFile(resolve(root, 'src/ui/panel-actions.js'), 'utf8')}\n${researchViewInline}\n${panelExtensionInline}\n${readerHighlightControlsInline}\nvar Sne=si(ds(),1);(0,kne.createRoot)(document.getElementById("root")).render((0,Sne.jsx)(WorkbenchRoot,{}));WJ();`);
panel = replaceOnce(panel,
  'function XJ({library:t,list:e,s:n,notify:i,footer:s}){let[r,a]=(0,Ks.useState)([]),',
  'function XJ({library:t,list:e,s:n,notify:i,footer:s}){let[r,a]=(0,Ks.useState)([]);(0,Ks.useEffect)(()=>{wbSetSelection(t,r);return()=>wbSetSelection(t,[])},[t,r.join(",")]);let ');
panel = replaceOnce(panel,
  'function n0e({item:t,selected:e,onToggle:n,onOpen:i,onOpenPdf:s,s:r}){',
  'function n0e({library:u,item:t,selected:e,onToggle:n,onOpen:i,onOpenPdf:s,onOpenDoubleClick:d,s:r}){');
panel = replaceOnce(panel,
  '(0,Ge.jsx)("span",{className:"item-title",children:t.title})',
  '(0,Ge.jsx)("span",{className:"item-title",children:wbNormalizePlainText(t.title)})');
panel = replaceOnce(panel,
  '(0,Ge.jsx)("span",{className:"item-title",children:wbNormalizePlainText(t.title)}),(0,Ge.jsxs)("span",{className:"item-meta"',
  '(0,Ge.jsx)("span",{className:"item-title",children:wbNormalizePlainText(t.title)}),(0,Ge.jsx)(WorkbenchMetadataListTitle,{library:u,item:t}),(0,Ge.jsxs)("span",{className:"item-meta"');
panel = replaceOnce(panel,
  '"aria-label":t.title,className:"check"',
  '"aria-label":wbNormalizePlainText(t.title),className:"check"');
panel = replaceOnce(panel,
  'className:"item-main",onClick:o=>o.metaKey||o.ctrlKey||o.shiftKey?n(o):i(),children:',
  'className:"item-main",onClick:o=>o.metaKey||o.ctrlKey||o.shiftKey?n(o):i(),onDoubleClick:o=>{o.preventDefault(),d()},children:');
panel = replaceOnce(panel,
  'onOpenPdf:()=>m(p)},p.key)',
  'onOpenPdf:()=>m(p),onOpenDoubleClick:()=>{wbCancelItemOpen();p.pdf?m(p):xf({kind:"item",library:t,key:p.key})}},p.key)');
panel = replaceOnce(panel,
  '(0,Ge.jsx)(n0e,{item:p,s:n,selected:r.includes(p.key)',
  '(0,Ge.jsx)(n0e,{library:t,item:p,s:n,selected:r.includes(p.key)');
panel = replaceOnce(panel, 'd=p=>xf({kind:"item",library:t,key:p.key}),m=p=>', 'd=p=>{if(wbShouldInspect())a([p.key]);else wbQueueItemOpen(()=>xf({kind:"item",library:t,key:p.key}))},m=p=>');
// List summaries may carry journalLevels parsed from both Zotero extra and tags.
panel = replaceOnce(panel,
  'children:[(0,Ge.jsx)("span",{className:"type",children:r.itemTypes[t.itemType]??t.itemType}),a&&(0,Ge.jsx)("span",{className:"ellipsis",children:a})]',
  'children:[(0,Ge.jsx)("span",{className:"type",children:r.itemTypes[t.itemType]??t.itemType}),a&&(0,Ge.jsx)("span",{className:"ellipsis",children:a}),...wbRankChips(t)]');
panel = replaceOnce(panel,
  '...wbRankChips(t)]})]}),t.pdf&&(0,Ge.jsx)("button",{type:"button",className:"pdf-chip"',
  '...wbRankChips(t)]})]}),(0,Ge.jsx)(WorkbenchMetadataListControl,{library:u,item:t}),t.pdf&&(0,Ge.jsx)("button",{type:"button",className:"pdf-chip"');
panel = replaceOnce(panel,
  '(0,ft.jsx)("p",{className:"muted",children:[c.venue,c.year].filter(Boolean).join(" \\xB7 ")}),(0,ft.jsxs)("div",{className:"actions"',
  '(0,ft.jsx)("p",{className:"muted",children:[c.venue,c.year].filter(Boolean).join(" \\xB7 ")}),wbRankBlock(c,"wb-detail-ranks"),(0,ft.jsxs)("div",{className:"actions"');
panel = replaceOnce(panel,
  '(0,ft.jsx)("h2",{className:"detail-title",children:c.title})',
  '(0,ft.jsx)("h2",{className:"detail-title",children:wbNormalizePlainText(c.title)}),(0,ft.jsx)(WorkbenchMetadataFieldTranslation,{library:t.library,item:c,field:"title",auto:!0})');
panel = replaceOnce(panel,
  'children:c.abstract',
  'children:wbNormalizePlainText(c.abstract)');
panel = replaceOnce(panel,
  'children:wbNormalizePlainText(c.abstract)}),c.abstract.length>360',
  'children:wbNormalizePlainText(c.abstract)}),(0,ft.jsx)(WorkbenchMetadataFieldTranslation,{library:t.library,item:c,field:"abstract"}),c.abstract.length>360');
// Saving a model-created highlight must enter the existing audited workflow.
// Reader popover: let the user highlight their own selection and save it directly.
panel = replaceOnce(panel,
  'en.call("save_highlights",{ids:[t.highlight.id]}).then(()=>r(n.saved)).catch(h=>r(Aa(h),"error")).finally(()=>o(!1))',
  't.highlight.origin==="user"?en.call("save_reader_highlights",{ids:[t.highlight.id]}).then(()=>r(n.saved)).catch(h=>r(Aa(h),"error")).finally(()=>o(!1)):wbRequestHighlightReview(t.highlight)');
panel = replaceOnce(panel, 'a?n.saving:n.saveToZotero', 'a?n.saving:t.highlight.origin==="user"?"保存到 Zotero":n.saveToZotero');
panel = replaceOnce(panel,
  '(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>P(!0),children:[(0,dt.jsx)(Nt,{name:"message",size:14}),n.ask]})',
  '(0,dt.jsx)(wbReaderHighlightUi.WorkbenchReaderHighlightControls,{quote:A.quote,notify:i,onSaved:()=>T(null)}),(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>P(!0),children:[(0,dt.jsx)(Nt,{name:"message",size:14}),n.ask]})');
panel = replaceOnce(panel, 'saveToZotero:"Save to Zotero"', 'saveToZotero:"Review before saving"');
panel = replaceOnce(panel, 'saveToZotero:"\\u4FDD\\u5B58\\u5230 Zotero"', 'saveToZotero:"核查后保存"');
// Give saved-annotation popovers a collapsible quote/comment block and the same
// context and ask actions already available for text selected in the PDF.
panel = replaceOnce(panel,
  'function Kbe({mark:t,anchor:e,s:n,route:i,onClose:s,notify:r}){let[a,o]=(0,gn.useState)(!1),l=(0,gn.useRef)(null);',
  'function Kbe({mark:t,anchor:e,s:n,route:i,onClose:s,notify:r}){let[a,o]=(0,gn.useState)(!1),l=(0,gn.useRef)(null),[askOpen,setAskOpen]=(0,gn.useState)(!1),[trashBusy,setTrashBusy]=(0,gn.useState)(!1);');
panel = replaceOnce(panel,
  'f&&(0,dt.jsx)("p",{className:"quote",children:f}),u&&(0,dt.jsx)("p",{className:"comment",children:u}),',
  '(f||u)&&(0,dt.jsxs)("details",{className:"wb-annotation-content",open:!0,children:[(0,dt.jsx)("summary",{children:"批注内容"}),f&&(0,dt.jsxs)("div",{className:"wb-annotation-field",children:[(0,dt.jsx)("span",{className:"wb-annotation-label",children:"原文摘录"}),(0,dt.jsx)("p",{className:"quote",children:f})]}),u&&(0,dt.jsxs)("div",{className:"wb-annotation-field",children:[(0,dt.jsx)("span",{className:"wb-annotation-label",children:"阅读者备注"}),(0,dt.jsx)("p",{className:"comment",children:u})]})]}),(0,dt.jsx)(WorkbenchReaderAnnotationComment,{key:`${i.library}/${i.attachmentKey}/${t.annotation.key}`,annotation:t.annotation,route:i,notify:r,onSaved:()=>s()}),');
panel = replaceOnce(panel,
  '),!c&&(0,dt.jsx)("div",{className:"popover-actions",children:(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>void wbOpenTargetWithFeedback(`${xC(i.library,i.attachmentKey)}?annotation=${t.annotation.key}`).catch(()=>{}),children:[(0,dt.jsx)(Nt,{name:"external",size:14}),n.showInZotero]})})]})}function xne',
  '),!c&&askOpen&&(0,dt.jsx)(I0,{placeholder:n.askPlaceholder,sendLabel:n.send,onClose:()=>setAskOpen(!1),onSend:question=>wbAskAnnotation(question,t.annotation,i).then(()=>{r("已发送");setAskOpen(!1)}).catch(error=>r(Aa(error),"error"))}),!c&&trashPreview&&(0,dt.jsxs)("section",{className:"wb-trash-preview",role:"alertdialog","aria-label":"确认将批注移入回收站",children:[(0,dt.jsx)("strong",{children:"尝试移入 Zotero 回收站？"}),(0,dt.jsx)("p",{children:[trashPreview.annotation?.title," · ",trashPreview.annotation?.pageLabel||trashPreview.annotation?.page?`第 ${trashPreview.annotation?.pageLabel||trashPreview.annotation?.page} 页`:"页码未知"]}),(f||u)&&(0,dt.jsxs)("details",{open:!0,children:[(0,dt.jsx)("summary",{children:"核对批注原文与备注"}),f&&(0,dt.jsx)("blockquote",{children:f}),u&&(0,dt.jsx)("p",{children:["备注：",u]})]}),(0,dt.jsx)("p",{className:"wb-trash-note",children:"这会请求 Zotero 将批注移入回收站；本地接口若不支持则会拒绝。仅在后端回读确认后报告成功，不调用永久删除接口。恢复能力尚未验证。"}),(0,dt.jsxs)("div",{className:"wb-trash-actions",children:[(0,dt.jsx)("button",{type:"button",className:"btn ghost sm",disabled:trashBusy,onClick:()=>setTrashPreview(null),children:"取消"}),(0,dt.jsx)("button",{type:"button",className:"btn danger sm",disabled:trashBusy,onClick:()=>{setTrashBusy(!0);wbConfirmAnnotationTrash(trashPreview).then(()=>{r("已回读确认移入 Zotero 回收站；恢复能力尚未测试。");setTrashPreview(null);s()}).catch(error=>{r(Aa(error),"error");setTrashPreview(null)}).finally(()=>setTrashBusy(!1))},children:trashBusy?"处理中…":"确认尝试移入回收站"})]})]}),!c&&(0,dt.jsxs)("div",{className:"popover-actions wb-annotation-actions",children:[(0,dt.jsx)("button",{type:"button",className:"btn outline sm",onClick:()=>wbAddAnnotationContext(t.annotation,i).then(()=>r("已加入当前对话上下文")).catch(error=>r(Aa(error),"error")),children:"加入上下文"}),(0,dt.jsx)("button",{type:"button",className:"btn primary sm","aria-expanded":askOpen,onClick:()=>setAskOpen(!1),children:askOpen?"收起提问":"提问"}),(0,dt.jsx)("button",{type:"button",className:"btn danger sm",disabled:trashBusy,onClick:()=>{setTrashBusy(!0);wbPrepareAnnotationTrash(t.annotation,i).then(setTrashPreview).catch(error=>r(Aa(error),"error")).finally(()=>setTrashBusy(!1))},children:"移入回收站…"}),(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>{void wbOpenTargetWithFeedback(`${xC(i.library,i.attachmentKey)}?annotation=${t.annotation.key}`).catch(()=>{});},children:[(0,dt.jsx)(Nt,{name:"external",size:14}),n.showInZotero]})]})]})}function xne');
panel = replaceBetweenOnce(panel, ',!c&&trashPreview&&', ',!c&&(0,dt.jsxs)("div",{className:"popover-actions wb-annotation-actions"', '');
panel = replaceOnce(panel,
  'onClick:()=>{setTrashBusy(!0);wbPrepareAnnotationTrash(t.annotation,i).then(setTrashPreview).catch(error=>r(Aa(error),"error")).finally(()=>setTrashBusy(!1))},children:"移入回收站…"',
  'onClick:()=>{setTrashBusy(!0);wbRemoveReaderAnnotationOnce(t.annotation,i).then(()=>{r("已移除；可在右侧逐条撤销。");s()}).catch(error=>r(Aa(error),"error")).finally(()=>setTrashBusy(!1))},children:"移除高亮"');
// PDF sidebar: selection and batch actions are scoped to this reader instance.
// The original annotation body remains a button, so its click still navigates.
panel = replaceOnce(panel,
  'function xne({route:t,state:e,s:n,notify:i,onBack:s}){let[r,a]=(0,gn.useState)(null),[o,l]=(0,gn.useState)(null),[c,f]=(0,gn.useState)([0,1]),[u,h]=(0,gn.useState)(null),[d,m]=(0,gn.useState)(0),[p,b]=(0,gn.useState)("fit"),[g,w]=(0,gn.useState)(new Set([0])),[x,v]=(0,gn.useState)(0),[k,S]=(0,gn.useState)("1"),[_,q]=(0,gn.useState)(!1),[A,T]=(0,gn.useState)(null),[I,P]=(0,gn.useState)(!1),[O,G]=(0,gn.useState)(null),[J,W]=(0,gn.useState)(t.highlightId??null),ne=(0,gn.useRef)(null),ee=al(rr.annotations(t.library,t.attachmentKey)),',
  'function xne({route:t,state:e,s:n,notify:i,onBack:s}){let[r,a]=(0,gn.useState)(null),[o,l]=(0,gn.useState)(null),[c,f]=(0,gn.useState)([0,1]),[u,h]=(0,gn.useState)(null),[d,m]=(0,gn.useState)(0),[p,b]=(0,gn.useState)("fit"),[g,w]=(0,gn.useState)(new Set([0])),[x,v]=(0,gn.useState)(0),[k,S]=(0,gn.useState)("1"),[_,q]=(0,gn.useState)(!1),[A,T]=(0,gn.useState)(null),[I,P]=(0,gn.useState)(!1),[O,G]=(0,gn.useState)(null),[J,W]=(0,gn.useState)(t.highlightId??null),[readerSelection,setReaderSelection]=(0,gn.useState)(()=>new Set()),[readerTrashOutcomes,setReaderTrashOutcomes]=(0,gn.useState)([]),[readerTrashBusy,setReaderTrashBusy]=(0,gn.useState)(!1),[readerUndoBusy,setReaderUndoBusy]=(0,gn.useState)(new Set()),ne=(0,gn.useRef)(null),ee=al(rr.annotations(t.library,t.attachmentKey)),');
panel = replaceOnce(panel,
  '},[r]);let Ie=o?Math.max(...o.map(ie=>ie.width)):612,',
  '},[r]),(0,gn.useEffect)(()=>{setReaderSelection(new Set()),setReaderTrashOutcomes([])},[t.library,t.itemKey,t.attachmentKey]),(0,gn.useEffect)(()=>{let receive=event=>{let outcome=event.detail;if(!outcome?.annotationKey)return;setReaderTrashOutcomes(current=>[...current.filter(item=>item.annotationKey!==outcome.annotationKey||item.operationId!==outcome.operationId),outcome]);if(outcome.status==="verified")setReaderSelection(current=>wbReaderAnnotationSelectionToggle(current,outcome.annotationKey,!1))};return window.addEventListener("workbench-reader-trash-result",receive),()=>window.removeEventListener("workbench-reader-trash-result",receive)},[]);let Ie=o?Math.max(...o.map(ie=>ie.width)):612,');
panel = replaceOnce(panel,
  ',Ye=O&&(O.mark.kind==="annotation"||e.highlights.some(ie=>ie.id===O.mark.highlight.id))?O.mark.kind==="highlight"?{...O,mark:{kind:"highlight",highlight:e.highlights.find(ie=>ie.id===O.mark.highlight.id)}}:O:null;return(0,dt.jsxs)',
  ',Ye=O&&(O.mark.kind==="annotation"||e.highlights.some(ie=>ie.id===O.mark.highlight.id))?O.mark.kind==="highlight"?{...O,mark:{kind:"highlight",highlight:e.highlights.find(ie=>ie.id===O.mark.highlight.id)}}:O:null,readerSelectable=wbSelectableReaderAnnotations(le),readerSelected=wbSelectedReaderAnnotations(le,readerSelection),readerSelectedHighlights=wbSelectedReaderHighlights(le,readerSelection),readerRoute={...t,title:je};return(0,dt.jsxs)');
panel = replaceOnce(panel,
  '(0,dt.jsx)("div",{className:"sidebar-head",children:n.annotations})',
  '(0,dt.jsxs)("div",{className:"wb-reader-sidebar-tools",children:[(0,dt.jsx)("div",{className:"sidebar-head",children:n.annotations}),(0,dt.jsxs)("div",{className:"wb-reader-batch-actions",children:[(0,dt.jsx)("button",{type:"button",className:"btn ghost sm",disabled:!readerSelectable.length,onClick:()=>setReaderSelection(new Set(readerSelectable.map(row=>String(row.annotation.key)))),children:"全选当前 PDF"}),(0,dt.jsx)("button",{type:"button",className:"btn ghost sm",disabled:!readerSelection.size,onClick:()=>setReaderSelection(new Set()),children:"清空"}),(0,dt.jsx)("button",{type:"button",className:"btn ghost sm",disabled:!readerSelected.length,onClick:()=>wbCopyReaderAnnotations(readerSelected,readerRoute).then(result=>i(`已复制 ${result.count} 条批注，含文献与物理页。`)).catch(error=>i(Aa(error),"error")),children:"复制选中"}),(0,dt.jsx)("button",{type:"button",className:"btn ghost sm",disabled:!readerSelected.length,onClick:()=>wbAddAnnotationContexts(readerSelected,readerRoute).then(result=>i(`已将 ${result.count} 条批注加入当前对话材料。`)).catch(error=>i(Aa(error),"error")),children:"加入上下文"}),(0,dt.jsx)("button",{type:"button",className:"btn danger sm",disabled:readerTrashBusy||!readerSelectedHighlights.length,onClick:()=>{let blocked=new Set(readerTrashOutcomes.filter(item=>item.blocked||item.status==="outcome-unknown").map(item=>item.annotationKey)),candidates=readerSelectedHighlights.filter(annotation=>!blocked.has(annotation.key));if(!candidates.length){i("所选高亮已阻断或结果未知；已保留勾选，不会再次提交。","error");return}setReaderTrashBusy(!0),wbTrashReaderAnnotationsBatch(candidates,readerRoute).then(results=>{let verified=results.filter(item=>item.status==="verified"),failed=results.length-verified.length;if(verified.length)setReaderSelection(current=>{let next=new Set(current);for(let item of verified)next.delete(item.annotationKey);return next});i(`已处理 ${results.length} 条：${verified.length} 条移除已核实，${failed} 条保留并显示逐条状态。`,failed?"error":void 0)}).catch(error=>i(Aa(error),"error")).finally(()=>setReaderTrashBusy(!1))},children:readerTrashBusy?"处理中…":`移除选中高亮 (${readerSelectedHighlights.length})`})]}),(0,dt.jsx)("p",{className:"wb-reader-selection-count",children:`已选 ${readerSelected.length} 条批注；移除只处理其中的 Zotero 高亮。`})]})');
panel = replaceOnce(panel,
  'return(0,dt.jsx)("li",{children:(0,dt.jsxs)("button",{type:"button",className:`annotation${ie.kind==="highlight"?" agent":""}${J===ke?" focused":""}`,onClick:()=>{W(ke),ie.kind==="highlight"?E0({...t,highlightId:ke,pageIndex:Ue,nonce:Date.now()}):F(Ue,Wbe(ie.annotation.rects,o?.[Ue],Ee))},children:[',
  'return(0,dt.jsx)("li",{className:"wb-reader-annotation-row",children:[ie.kind==="annotation"&&(0,dt.jsx)("input",{type:"checkbox",className:"wb-reader-annotation-check",checked:readerSelection.has(ke),onClick:event=>event.stopPropagation(),onChange:event=>setReaderSelection(current=>wbReaderAnnotationSelectionToggle(current,ke,event.target.checked)),"aria-label":`选择第 ${Ue+1} 页的批注`}),(0,dt.jsxs)("button",{type:"button",className:`annotation${ie.kind==="highlight"?" agent":""}${J===ke?" focused":""}`,onClick:()=>{W(ke),ie.kind==="highlight"?E0({...t,highlightId:ke,pageIndex:Ue,nonce:Date.now()}):F(Ue,Wbe(ie.annotation.rects,o?.[Ue],Ee))},children:[');
panel = replaceOnce(panel,
  'children:ie.kind==="annotation"?ie.annotation.text||ie.annotation.comment:ie.highlight.quote',
  'children:ie.kind==="annotation"?ie.annotation.text||"（无原文摘录）":ie.highlight.quote');
panel = replaceOnce(panel,
  'ie.kind==="annotation"&&ie.annotation.text&&ie.annotation.comment',
  'ie.kind==="annotation"&&ie.annotation.comment');
panel = replaceOnce(panel,
  '},ke)})})]})]}),e.authorizing&&(0,dt.jsx)("div",{className:"banner",children:n.waitingApproval})',
  ']},ke)})}),readerTrashOutcomes.length>0&&(0,dt.jsxs)("section",{className:"wb-reader-trash-outcomes","aria-label":"批注移除结果",style:{maxHeight:"35vh",overflowY:"auto"},children:[(0,dt.jsx)("strong",{children:"本次阅读器操作"}),...readerTrashOutcomes.map(outcome=>(0,dt.jsxs)("article",{className:`wb-reader-trash-result wb-reader-trash-result--${outcome.status}`,key:outcome.operationId||outcome.annotationKey,children:[(0,dt.jsx)("span",{className:"wb-reader-trash-identity",children:[outcome.annotationKey,outcome.page?` · PDF 第 ${outcome.page} 页`:""]}),(0,dt.jsx)("span",{className:"wb-reader-trash-status",children:outcome.undoStatus==="verified"?"已恢复原批注":outcome.undoStatus==="outcome-unknown"?"恢复结果未知":outcome.status==="verified"?"移除已核实":outcome.status==="outcome-unknown"?"移除结果未知":outcome.status==="not-removable"?"已保留":outcome.error||"未完成；已保留"}),outcome.status==="verified"&&outcome.restoreEntryAvailable&&outcome.undoStatus!=="verified"&&outcome.undoStatus!=="outcome-unknown"&&(0,dt.jsx)("button",{type:"button",className:"btn outline sm",disabled:readerUndoBusy.has(outcome.operationId),onClick:()=>{if(readerUndoBusy.has(outcome.operationId))return;setReaderUndoBusy(current=>new Set([...current,outcome.operationId]));wbUndoReaderAnnotationRemoval(outcome.operationId).then(result=>{setReaderTrashOutcomes(current=>current.map(item=>item.operationId===outcome.operationId?{...item,undoStatus:"verified"}:item));i(`已按原 key ${result.annotationKey} 恢复批注。`)}).catch(error=>{let restoreId=en.widgetState?.annotationRestoreOperationIds?.[outcome.operationId],message=Aa(error),unknown=!!restoreId||/结果尚不确定|不要重复确认|结果未知/.test(String(error?.message||error));setReaderTrashOutcomes(current=>current.map(item=>item.operationId===outcome.operationId?{...item,undoStatus:unknown?"outcome-unknown":"failed",undoError:String(error?.message||error),restoreOperationId:restoreId}:item));i(message,"error")}).finally(()=>setReaderUndoBusy(current=>{let next=new Set(current);next.delete(outcome.operationId);return next}))},children:readerUndoBusy.has(outcome.operationId)?"处理中…":"撤销"}),outcome.status==="outcome-unknown"&&outcome.operationId&&(0,dt.jsx)("button",{type:"button",className:"btn outline sm",onClick:()=>window.dispatchEvent(new CustomEvent("workbench-show-restore",{detail:{operationId:outcome.operationId}})),children:"核对操作"}),outcome.undoStatus==="outcome-unknown"&&outcome.operationId&&(0,dt.jsx)("button",{type:"button",className:"btn outline sm",onClick:()=>window.dispatchEvent(new CustomEvent("workbench-show-restore",{detail:{operationId:outcome.operationId}})),children:"核对恢复"})]})) ]})]})]}) ,e.authorizing&&(0,dt.jsx)("div",{className:"banner",children:n.waitingApproval})');
panel = replaceOnce(panel,
  ']},ke)})}),readerTrashOutcomes.length>0',
  ',ie.kind==="annotation"&&(0,dt.jsx)(WorkbenchReaderAnnotationComment,{key:`${readerRoute.library}/${readerRoute.attachmentKey}/${ke}`,annotation:ie.annotation,route:readerRoute,notify:i})]},ke)})}),readerTrashOutcomes.length>0');
// Verify the assembled PDF against its real fingerprint before giving it to PDF.js.
panel = replaceOnce(panel, 'let c=DS({data:o,BinaryDataFactory:cL,', 'let hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",o))).map(b=>b.toString(16).padStart(2,"0")).join("");if(hash!==a.sha256)throw new Error("PDF 在读取中发生变化，请重新打开。");let c=DS({data:o,BinaryDataFactory:cL,');
panel = replaceOnce(panel, 'function wne(t,e,n){let i=`${t}/${e}`', 'function wne(t,e,n){let i=`${t}/${e}/${Co.state?.libraries.find(v=>v.id===t)?.version??0}`');
panel = replaceOnce(panel, '},[t.library,t.attachmentKey]),(0,gn.useLayoutEffect)', '},[t.library,t.attachmentKey,e.libraries.find(v=>v.id===t.library)?.version]),(0,gn.useLayoutEffect)');
panel = replaceOnce(panel, 'limit:Math.min(mC.pageSize*l,500)', 'limit:Math.min(mC.pageSize*l,100000)');
panel = replaceOnce(panel, 'l*mC.pageSize<500', 'l*mC.pageSize<100000');
// Keep link failures visible rather than reporting an action that did not happen.
panel = replaceOnce(panel, 'await Gs.openLink({url:t}).catch(()=>{})', 'await Gs.openLink({url:t})');
panel = replaceOnce(panel, '\n  </head>', `<style>${panelWorkspaceCss}\n${panelExtensionCss}\n${researchViewCss}</style>\n  </head>`);
checkPanelInlineScripts(panel);
await writeFile(resolve(root, 'dist/ui/panel.html'), panel);
await cp(resolve(vendor, 'dist/THIRD_PARTY_NOTICES.txt'), resolve(root, 'dist/THIRD_PARTY_NOTICES.txt'));
await cp(resolve(vendor, 'dist/pdfjs'), resolve(root, 'dist/pdfjs'), { recursive: true });
console.log('Built pinned React/PDF.js panel, MCP runtime and maintained Workbench extensions.');
