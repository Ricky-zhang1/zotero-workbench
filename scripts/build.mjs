import { CARD_TEMPLATE, ANNOTATION_TEMPLATE } from '../src/domain/workspace.mjs';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
await mkdir(resolve(root, 'dist/ui'), { recursive: true });
const researchViewSource = await readFile(resolve(root, 'src/ui/research-view.js'), 'utf8');
const researchViewInlineBody = researchViewSource.replace(/^export const mountResearchWorkbench\s*=/m, 'const mountResearchWorkbench =');
if (researchViewInlineBody === researchViewSource || /^export\s/m.test(researchViewInlineBody))
  throw new Error('Research view entry point changed; refusing to assemble the Codex panel.');
const researchViewInline = `var mountResearchWorkbench=(function(){\n${researchViewInlineBody}\nreturn mountResearchWorkbench;\n})();`;
const researchViewCss = await readFile(resolve(root, 'src/ui/research-view.css'), 'utf8');
const panelWorkspaceCss = await readFile(resolve(root, 'src/ui/panel-workspace.css'), 'utf8');
const panelExtensionCss = await readFile(resolve(root, 'src/ui/panel-extension.css'), 'utf8');
await mkdir(resolve(root, 'integrations/dsh/web/lib'), { recursive: true });
await writeFile(resolve(root, 'integrations/dsh/web/lib/research-view.js'), researchViewSource);
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
// Mount the maintained feature component inside the same React tree as the upstream reader.
panel = replaceOnce(panel,
  'var Sne=si(ds(),1);(0,kne.createRoot)(document.getElementById("root")).render((0,Sne.jsx)(vne,{}));WJ();',
  `var wbTemplateDefaults=${JSON.stringify({metadata:CARD_TEMPLATE,annotation:ANNOTATION_TEMPLATE})};${await readFile(resolve(root, 'src/ui/panel-workspace.js'), 'utf8')}\n${await readFile(resolve(root, 'src/ui/panel-actions.js'), 'utf8')}\n${researchViewInline}\n${(await readFile(resolve(root, 'src/ui/panel-extension.js'), 'utf8')).replace('__WORKBENCH_VERSION__', version)}\nvar Sne=si(ds(),1);(0,kne.createRoot)(document.getElementById("root")).render((0,Sne.jsx)(WorkbenchRoot,{}));WJ();`);
panel = replaceOnce(panel,
  'function XJ({library:t,list:e,s:n,notify:i,footer:s}){let[r,a]=(0,Ks.useState)([]),',
  'function XJ({library:t,list:e,s:n,notify:i,footer:s}){let[r,a]=(0,Ks.useState)([]);(0,Ks.useEffect)(()=>{wbSetSelection(t,r);return()=>wbSetSelection(t,[])},[t,r.join(",")]);let ');
panel = replaceOnce(panel,
  'function n0e({item:t,selected:e,onToggle:n,onOpen:i,onOpenPdf:s,s:r}){',
  'function n0e({item:t,selected:e,onToggle:n,onOpen:i,onOpenPdf:s,onOpenDoubleClick:d,s:r}){');
panel = replaceOnce(panel,
  'className:"item-main",onClick:o=>o.metaKey||o.ctrlKey||o.shiftKey?n(o):i(),children:',
  'className:"item-main",onClick:o=>o.metaKey||o.ctrlKey||o.shiftKey?n(o):i(),onDoubleClick:o=>{o.preventDefault(),d()},children:');
panel = replaceOnce(panel,
  'onOpenPdf:()=>m(p)},p.key)',
  'onOpenPdf:()=>m(p),onOpenDoubleClick:()=>{wbCancelItemOpen();p.pdf?m(p):xf({kind:"item",library:t,key:p.key})}},p.key)');
panel = replaceOnce(panel, 'd=p=>xf({kind:"item",library:t,key:p.key}),m=p=>', 'd=p=>{if(wbShouldInspect())a([p.key]);else wbQueueItemOpen(()=>xf({kind:"item",library:t,key:p.key}))},m=p=>');
// List summaries may carry journalLevels parsed from both Zotero extra and tags.
panel = replaceOnce(panel,
  'children:[(0,Ge.jsx)("span",{className:"type",children:r.itemTypes[t.itemType]??t.itemType}),a&&(0,Ge.jsx)("span",{className:"ellipsis",children:a})]',
  'children:[(0,Ge.jsx)("span",{className:"type",children:r.itemTypes[t.itemType]??t.itemType}),a&&(0,Ge.jsx)("span",{className:"ellipsis",children:a}),...wbRankChips(t)]');
panel = replaceOnce(panel,
  '(0,ft.jsx)("p",{className:"muted",children:[c.venue,c.year].filter(Boolean).join(" \\xB7 ")}),(0,ft.jsxs)("div",{className:"actions"',
  '(0,ft.jsx)("p",{className:"muted",children:[c.venue,c.year].filter(Boolean).join(" \\xB7 ")}),wbRankBlock(c,"wb-detail-ranks"),(0,ft.jsxs)("div",{className:"actions"');
// Saving a model-created highlight must enter the existing audited workflow.
// Reader popover: let the user highlight their own selection and save it directly.
panel = replaceOnce(panel,
  'en.call("save_highlights",{ids:[t.highlight.id]}).then(()=>r(n.saved)).catch(h=>r(Aa(h),"error")).finally(()=>o(!1))',
  't.highlight.origin==="user"?en.call("save_reader_highlights",{ids:[t.highlight.id]}).then(()=>r(n.saved)).catch(h=>r(Aa(h),"error")).finally(()=>o(!1)):wbRequestHighlightReview(t.highlight)');
panel = replaceOnce(panel, 'a?n.saving:n.saveToZotero', 'a?n.saving:t.highlight.origin==="user"?"保存到 Zotero":n.saveToZotero');
panel = replaceOnce(panel,
  '(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>P(!0),children:[(0,dt.jsx)(Nt,{name:"message",size:14}),n.ask]})',
  '(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>{wbSaveReaderHighlight(A.quote).then(()=>{i(n.saved),T(null)}).catch(ie=>i(Aa(ie),"error"))},children:[(0,dt.jsx)(Nt,{name:"highlighter",size:14}),"高亮并保存"]}),(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>P(!0),children:[(0,dt.jsx)(Nt,{name:"message",size:14}),n.ask]})');
panel = replaceOnce(panel, 'saveToZotero:"Save to Zotero"', 'saveToZotero:"Review before saving"');
panel = replaceOnce(panel, 'saveToZotero:"\\u4FDD\\u5B58\\u5230 Zotero"', 'saveToZotero:"核查后保存"');
// Give saved-annotation popovers a collapsible quote/comment block and the same
// context and ask actions already available for text selected in the PDF.
panel = replaceOnce(panel,
  'function Kbe({mark:t,anchor:e,s:n,route:i,onClose:s,notify:r}){let[a,o]=(0,gn.useState)(!1),l=(0,gn.useRef)(null);',
  'function Kbe({mark:t,anchor:e,s:n,route:i,onClose:s,notify:r}){let[a,o]=(0,gn.useState)(!1),l=(0,gn.useRef)(null),[askOpen,setAskOpen]=(0,gn.useState)(!1),[trashPreview,setTrashPreview]=(0,gn.useState)(null),[trashBusy,setTrashBusy]=(0,gn.useState)(!1);');
panel = replaceOnce(panel,
  'f&&(0,dt.jsx)("p",{className:"quote",children:f}),u&&(0,dt.jsx)("p",{className:"comment",children:u}),',
  '(f||u)&&(0,dt.jsxs)("details",{className:"wb-annotation-content",open:!0,children:[(0,dt.jsx)("summary",{children:"批注内容"}),f&&(0,dt.jsx)("p",{className:"quote",children:f}),u&&(0,dt.jsx)("p",{className:"comment",children:u})]}),');
panel = replaceOnce(panel,
  '),!c&&(0,dt.jsx)("div",{className:"popover-actions",children:(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>void en.openLink(`${xC(i.library,i.attachmentKey)}?annotation=${t.annotation.key}`),children:[(0,dt.jsx)(Nt,{name:"external",size:14}),n.showInZotero]})})]})}function xne',
  '),!c&&askOpen&&(0,dt.jsx)(I0,{placeholder:n.askPlaceholder,sendLabel:n.send,onClose:()=>setAskOpen(!1),onSend:question=>wbAskAnnotation(question,t.annotation,i).then(()=>{r("已发送");setAskOpen(!1)}).catch(error=>r(Aa(error),"error"))}),!c&&trashPreview&&(0,dt.jsxs)("section",{className:"wb-trash-preview",role:"alertdialog","aria-label":"确认将批注移入回收站",children:[(0,dt.jsx)("strong",{children:"尝试移入 Zotero 回收站？"}),(0,dt.jsx)("p",{children:[trashPreview.annotation?.title," · ",trashPreview.annotation?.pageLabel||trashPreview.annotation?.page?`第 ${trashPreview.annotation?.pageLabel||trashPreview.annotation?.page} 页`:"页码未知"]}),(f||u)&&(0,dt.jsxs)("details",{open:!0,children:[(0,dt.jsx)("summary",{children:"核对批注原文与备注"}),f&&(0,dt.jsx)("blockquote",{children:f}),u&&(0,dt.jsx)("p",{children:["备注：",u]})]}),(0,dt.jsx)("p",{className:"wb-trash-note",children:"这会请求 Zotero 将批注移入回收站；本地接口若不支持则会拒绝。仅在后端回读确认后报告成功，不调用永久删除接口。恢复能力尚未验证。"}),(0,dt.jsxs)("div",{className:"wb-trash-actions",children:[(0,dt.jsx)("button",{type:"button",className:"btn ghost sm",disabled:trashBusy,onClick:()=>setTrashPreview(null),children:"取消"}),(0,dt.jsx)("button",{type:"button",className:"btn danger sm",disabled:trashBusy,onClick:()=>{setTrashBusy(!0);wbConfirmAnnotationTrash(trashPreview).then(()=>{r("已回读确认移入 Zotero 回收站；恢复能力尚未测试。");setTrashPreview(null);s()}).catch(error=>{r(Aa(error),"error");setTrashPreview(null)}).finally(()=>setTrashBusy(!1))},children:trashBusy?"处理中…":"确认尝试移入回收站"})]})]}),!c&&(0,dt.jsxs)("div",{className:"popover-actions wb-annotation-actions",children:[(0,dt.jsx)("button",{type:"button",className:"btn outline sm",onClick:()=>wbAddAnnotationContext(t.annotation,i).then(()=>r("已加入当前对话上下文")).catch(error=>r(Aa(error),"error")),children:"加入上下文"}),(0,dt.jsx)("button",{type:"button",className:"btn primary sm","aria-expanded":askOpen,onClick:()=>setAskOpen(!askOpen),children:askOpen?"收起提问":"提问"}),(0,dt.jsx)("button",{type:"button",className:"btn danger sm",disabled:trashBusy,onClick:()=>{setTrashBusy(!0);wbPrepareAnnotationTrash(t.annotation,i).then(setTrashPreview).catch(error=>r(Aa(error),"error")).finally(()=>setTrashBusy(!1))},children:"移入回收站…"}),(0,dt.jsxs)("button",{type:"button",className:"btn ghost sm",onClick:()=>void en.openLink(`${xC(i.library,i.attachmentKey)}?annotation=${t.annotation.key}`),children:[(0,dt.jsx)(Nt,{name:"external",size:14}),n.showInZotero]})]})]})}function xne');
panel = replaceOnce(panel,
  'wbConfirmAnnotationTrash(trashPreview).then(()=>{r("已回读确认移入 Zotero 回收站；恢复能力尚未测试。");setTrashPreview(null);s()})',
  'wbConfirmAnnotationTrash(trashPreview).then(result=>wbRememberTrashedAnnotation(result).then(()=>{r(result.restoreEntryAvailable?"已回读确认这条高亮已标记为删除；可按原 key 单独恢复，并须通过回读确认。":"高亮已标记为删除；请保留操作编号并在工作台核对恢复状态。");setTrashPreview(null);s()}))');
panel = replaceOnce(panel,
  '这会请求 Zotero 将批注移入回收站；本地接口若不支持则会拒绝。仅在后端回读确认后报告成功，不调用永久删除接口。恢复能力尚未验证。',
  '确认后，Zotero 会将这条高亮标记为已删除并从活动文库隐藏。工作台可按原 key 提供恢复操作入口；恢复只有在精确回读确认后才算完成。该批注不一定出现在 Zotero 顶层回收站。本操作不会调用永久 DELETE；连接中断时请在工作台核对上次操作，不要重复确认。');
panel = replaceOnce(panel, '"aria-label":"确认将批注移入回收站"', '"aria-label":"确认移除高亮"');
panel = replaceOnce(panel, 'children:"尝试移入 Zotero 回收站？"', 'children:"从阅读器移除这条高亮？"');
panel = replaceOnce(panel, ':"确认尝试移入回收站"', ':"确认移除高亮"');
panel = replaceOnce(panel, 'children:"移入回收站…"', 'children:"移除高亮…"');
// Verify the assembled PDF against its real fingerprint before giving it to PDF.js.
panel = replaceOnce(panel, 'let c=DS({data:o,BinaryDataFactory:cL,', 'let hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",o))).map(b=>b.toString(16).padStart(2,"0")).join("");if(hash!==a.sha256)throw new Error("PDF 在读取中发生变化，请重新打开。");let c=DS({data:o,BinaryDataFactory:cL,');
panel = replaceOnce(panel, 'function wne(t,e,n){let i=`${t}/${e}`', 'function wne(t,e,n){let i=`${t}/${e}/${Co.state?.libraries.find(v=>v.id===t)?.version??0}`');
panel = replaceOnce(panel, '},[t.library,t.attachmentKey]),(0,gn.useLayoutEffect)', '},[t.library,t.attachmentKey,e.libraries.find(v=>v.id===t.library)?.version]),(0,gn.useLayoutEffect)');
panel = replaceOnce(panel, 'limit:Math.min(mC.pageSize*l,500)', 'limit:Math.min(mC.pageSize*l,100000)');
panel = replaceOnce(panel, 'l*mC.pageSize<500', 'l*mC.pageSize<100000');
// Keep link failures visible rather than reporting an action that did not happen.
panel = replaceOnce(panel, 'await Gs.openLink({url:t}).catch(()=>{})', 'await Gs.openLink({url:t})');
panel = replaceOnce(panel, '\n  </head>', `<style>${panelWorkspaceCss}\n${panelExtensionCss}\n${researchViewCss}</style>\n  </head>`);
await writeFile(resolve(root, 'dist/ui/panel.html'), panel);
await cp(resolve(vendor, 'dist/THIRD_PARTY_NOTICES.txt'), resolve(root, 'dist/THIRD_PARTY_NOTICES.txt'));
await cp(resolve(vendor, 'dist/pdfjs'), resolve(root, 'dist/pdfjs'), { recursive: true });
console.log('Built pinned React/PDF.js panel, MCP runtime and maintained Workbench extensions.');
