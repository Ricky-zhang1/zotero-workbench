import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function upstreamData(result) {
  if (result?.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Zotero MCP 返回错误');
  if (result?.structuredContent?.success !== undefined) return result.structuredContent;
  for (const block of result?.content || []) {
    if (block.type !== 'text') continue;
    try { const data = JSON.parse(block.text); if (data && typeof data === 'object' && 'success' in data) return data; } catch {}
  }
  throw new Error('研究服务返回了无法核验的回执；未确认操作结果。');
}
export function acceptedPreview(result) {
  const data = upstreamData(result);
  if (data.success !== true || data.dryRun !== true || data.created !== false || data.metadata?.semanticAudit !== 'passed' || !data.data?.annotations?.length)
    throw new Error('预检未明确通过原文校验和审计绑定，不能获得写入凭证。');
  return data;
}
// Short-lived previews hold exact audited arguments in memory. The durable journal
// stores only digests, timestamps and annotation identities, never PDF/claim text.
// A reservation is fsynced BEFORE sending a write. Unknown outcomes are never retried.
export class ReviewTransactions {
  constructor(directory, { now = Date.now, ttl = 15 * 60 * 1000, validatePreview = acceptedPreview, summarize = data => {
    if (!data.data?.annotations?.length) throw new Error('Missing annotation receipt');
    return { annotations: data.data.annotations.map(a => ({ annotationKey: a.annotationKey, attachmentKey: a.attachmentKey, pageIndex: a.pageIndex, created: a.created })) };
  } } = {}) {
    this.directory = directory; this.now = now; this.ttl = ttl; this.previews = new Map(); this.validatePreview = validatePreview; this.summarize = summarize;
  }
  prepare(payload, args, result, { validate } = {}) {
    (validate ?? this.validatePreview)(result);
    const token = randomBytes(24).toString('hex'), operationId = digest(payload), expiresAt = this.now() + this.ttl;
    this.previews.set(token, { operationId, expiresAt, args: structuredClone(args) });
    for (const [key, value] of this.previews) if (value.expiresAt <= this.now()) this.previews.delete(key);
    while (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value);
    return { previewToken: token, operationId, expiresAt, status: 'previewed', written: false };
  }
  require(payload, token) {
    const preview = this.previews.get(token);
    if (!preview || preview.expiresAt <= this.now()) throw new Error('请先完成同一材料的 dry-run；预检凭证缺失或已过期。');
    if (preview.operationId !== digest(payload)) throw new Error('材料、论断或目标文库已变化，请重新预检。');
    return preview;
  }
  async status(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid operation ID');
    try { return JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { operationId: id, status: 'not-submitted' }; throw error; }
  }
  async commit(payload, token, confirmed, send, { summarize } = {}) {
    if (!confirmed) throw new Error('真实写入必须明确确认；未提交任何高亮。');
    const preview = this.require(payload, token), id = preview.operationId;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${id}.json`);
    let handle;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = await this.status(id);
      throw new Error(`该操作已提交过（${prior.status}），未重复写入。请用 review_operation 查询 ${id}，并回读 Zotero 批注。`);
    }
    const record = { operationId: id, status: 'outcome-unknown', submittedAt: this.now() };
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    // If any exception follows this point, retain the reservation across restarts.
    let result;
    try { result = await send({ ...preview.args, dryRun: false, confirmWrite: true }); }
    catch (error) { throw new Error(`${error.message}；写入结果可能不明，请查询操作 ${id}，不要自动重试。`); }
    const data = upstreamData(result);
    if (data.success !== true || data.dryRun === true) throw new Error(`写入结果尚未确认，禁止自动重试。操作编号：${id}`);
    record.status = 'acknowledged'; record.acknowledgedAt = this.now();
    Object.assign(record, (summarize ?? this.summarize)(data));
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const out = await open(temp, 'wx', 0o600);
    try { await out.writeFile(JSON.stringify(record)); await out.sync(); } finally { await out.close(); }
    await rename(temp, path);
    this.previews.delete(token);
    return { result, operation: { ...record, readbackRequired: true } };
  }
}

// ---- Library actions: user imports / metadata edits / reading notes ----

import { itemKey } from './library.mjs';
import { LibraryLocalWrites, normalizeNoteText, zoteroNoteHtmlToText } from '../transports/library-local-writes.mjs';

export class LibraryActions {
  // Owns no journal: one shared ReviewTransactions instance (single ledger, P2/P3).
  static summarizeLibraryAction(data) {
    const key = data.data?.itemKey || data.data?.noteKey;
    if (!key) throw new Error('Missing created item identity');
    return { itemKey: key };
  }
  constructor({session, client, localWrites = new LibraryLocalWrites(session), transactions, parseIdentifier, resolveIdentifier}) {
    this.session=session;this.client=client;this.localWrites=localWrites;this.transactions=transactions;this.parseIdentifier=parseIdentifier;this.resolveIdentifier=resolveIdentifier;
    this.plans=new Map();
  }
  async duplicate(doi) {
    if(!doi)return null;
    const wanted=doi.trim().toLowerCase();let start=0;
    while(true){
      const page=await this.session.library.items('user',{q:doi,mode:'everything',limit:100,start});
      for(const row of page.items){
        if(['note','attachment','annotation'].includes(row.itemType))continue;
        const raw=await this.session.library.raw('user',row.key);
        if(String(raw.data.DOI||'').trim().toLowerCase()===wanted)return {key:row.key,title:row.title};
      }
      start+=page.items.length;if(start>=page.total)return null;
      if(!page.items.length)throw new Error('查重分页不完整，未准备导入。');
    }
  }
  async selectTransport(action) {
    const localStatus=this.session.client?.status;
    if(localStatus?.writes==='available'){
      if(typeof this.session.writer?.create!=='function'||typeof this.session.writer?.patchItem!=='function')
        throw new Error('Zotero 本地写入器不可用，未创建预览。');
      return {id:'local-api',endpoint:this.session.client.baseUrl,serverId:localStatus.serverId??null};
    }
    if(localStatus?.writes!=='unsupported')
      throw new Error('Zotero 本地写入能力尚未确认；未创建预览。请刷新连接状态后重试。');
    if(!this.client?.url||typeof this.client.ready!=='function'||typeof this.client.list!=='function'||typeof this.client.call!=='function')
      throw new Error('当前 Zotero 本地 API 只读，且没有可用的旧版写入通道。');
    await this.client.ready();
    const listed=await this.client.list(), names=new Set((listed?.tools??[]).map(tool=>tool.name));
    const required=action==='note'?'write_note':action==='metadata'?'write_metadata':'write_item';
    if(!names.has(required))throw new Error(`当前 Zotero 本地 API 只读；旧版 Zotero MCP 未提供 ${required}，未创建预览。`);
    return {id:'legacy-zotero-mcp',endpoint:this.client.url,serverId:localStatus.serverId??null};
  }
  async prepare({action,identifier,metadata,key,text,fields}) {
    await this.session.ready();let args,summary,existingVersion=null;
    if(action==='import'){
      let source='manual',item=metadata;
      if(identifier){const parsed=this.parseIdentifier(identifier);if(!parsed)throw new Error('请输入有效 DOI 或 arXiv 编号。');const resolved=await this.resolveIdentifier(parsed);item=resolved.item;source=resolved.source;}
      if(!item?.title)throw new Error('缺少文献标题；识别失败时可提供手动元数据。');
      const clean=await this.session.cleanItem(item);
      const duplicate=await this.duplicate(clean.DOI);
      if(duplicate)return {status:'duplicate',duplicate,message:'文库已有同 DOI 条目，未创建新条目。'};
      const {itemType,creators=[],tags=[],collections,...values}=clean;
      args={action:'create',itemType,fields:values,creators,tags:tags.map(t=>typeof t==='string'?t:t.tag)};
      summary={action,source,itemType,title:values.title,date:values.date||'',DOI:values.DOI||'',creators,library:'user',attachmentPolicy:'本次只创建元数据条目，不自动下载 PDF。'};
    }else{
      itemKey(key);const raw=await this.session.library.raw('user',key);existingVersion=raw.version;
      if(['attachment','note','annotation'].includes(raw.data.itemType))throw new Error('请选中普通文献条目。');
      if(action==='note'){
        if(!text?.trim())throw new Error('笔记不能为空。');
        args={action:'note',parentKey:key,content:normalizeNoteText(text)};summary={action,parentKey:key,title:raw.data.title,text:normalizeNoteText(text),library:'user'};
      }else if(action==='metadata'){
        const allowed=['title','date','DOI','url','abstractNote','publicationTitle','volume','issue','pages','language','publisher'];
        if(!fields||!Object.keys(fields).length||Object.keys(fields).some(k=>!allowed.includes(k)))throw new Error('不支持该字段。');
        const cleaned=await this.session.cleanItem({...raw.data,...fields});
        for(const [field,value] of Object.entries(fields))if(value && cleaned[field]!==value)throw new Error(`该条目类型不支持字段 ${field}`);
        args={itemKey:key,fields};summary={action,key,title:raw.data.title,before:Object.fromEntries(Object.keys(fields).map(k=>[k,raw.data[k]||''])),after:fields,library:'user'};
      }else throw new Error('不支持的操作。');
    }
    const transport=await this.selectTransport(action);
    summary={...summary,writeTransport:{id:transport.id,legacy:transport.id==='legacy-zotero-mcp'}};
    const payload={kind:'library-action',action,args,existingVersion,transport:transport.id,endpoint:transport.endpoint,serverId:transport.serverId};
    const preview=this.transactions.prepare(payload,args,null,{validate:()=>{}});
    this.plans.set(preview.previewToken,{payload,args,summary,key,existingVersion,transport});
    for(const token of this.plans.keys())if(!this.transactions.previews.has(token))this.plans.delete(token);
    return {...preview,summary};
  }
  async commit(token,confirmWrite) {
    const plan=this.plans.get(token);if(!plan)throw new Error('操作预览已过期，请重新预览。');
    await this.session.ready();
    const localStatus=this.session.client?.status;
    if((localStatus?.serverId??null)!==plan.payload.serverId)throw new Error('Zotero 实例已变化，请刷新后重新预览。');
    if(plan.transport.id==='local-api'){
      if(localStatus?.writes!=='available'||this.session.client?.baseUrl!==plan.transport.endpoint)
        throw new Error('Zotero 本地写入状态或实例已变化；请重新预览。');
    }else if(localStatus?.writes!=='unsupported'||this.client?.url!==plan.transport.endpoint){
      throw new Error('旧版 Zotero MCP 通道状态已变化；请重新预览。');
    }
    // Check again immediately before reserving the mutation. Writes themselves are never retried.
    if(plan.key){const raw=await this.session.library.raw('user',plan.key);if(raw.version!==plan.existingVersion)throw new Error('条目已被其他操作修改，请刷新后重新预览。');}
    if(plan.summary.action==='import'){
      const duplicate=await this.duplicate(plan.args.fields.DOI);if(duplicate)return {status:'duplicate',duplicate};
    }
    const {result,operation}=await this.transactions.commit(plan.payload,token,confirmWrite,async()=>{
      if(plan.transport.id==='local-api')
        return this.localWrites.write({action:plan.summary.action,args:plan.args,expectedVersion:plan.existingVersion});
      const name=plan.summary.action==='note'?'write_note':plan.summary.action==='metadata'?'write_metadata':'write_item';
      const args=plan.summary.action==='note'?{action:'create',parentKey:plan.args.parentKey,content:plan.args.content}:plan.args;
      return this.client.call(name,args);
    }, { summarize: LibraryActions.summarizeLibraryAction });
    const data=upstreamData(result),key=data.data?.itemKey||data.data?.noteKey;
    let readback={verified:false};
    try{
      const actual=await this.session.library.raw('user',key);
      if(plan.summary.action==='note'){
        const identityVerified=actual.data.itemType==='note'&&actual.data.parentItem===plan.key;
        const expected=data.data?.expectedNoteText??plan.summary.text;
        const contentVerified=typeof expected==='string'&&zoteroNoteHtmlToText(actual.data.note||'')===expected;
        readback={verified:identityVerified&&contentVerified,identityVerified,contentVerified,storedHtml:actual.data.note||'',message:identityVerified&&contentVerified?'笔记正文与保存内容一致。':'笔记已回读，但正文或所属条目尚未核实。'};
      }
      else {
        const fieldsVerified=Object.entries(plan.args.fields).every(([field,value])=>String(actual.data[field]||'')===String(value));
        const normalizeCreator=c=>c.name?{creatorType:c.creatorType||'author',name:c.name}:{creatorType:c.creatorType||'author',firstName:c.firstName||'',lastName:c.lastName||''};
        const creatorsVerified=!plan.args.creators||JSON.stringify(canonical(plan.args.creators.map(normalizeCreator)))===JSON.stringify(canonical((actual.data.creators||[]).map(normalizeCreator)));
        const actualTags=new Set((actual.data.tags||[]).map(t=>t.tag));
        const tagsVerified=!plan.args.tags||plan.args.tags.every(t=>actualTags.has(t));
        readback={verified:fieldsVerified&&creatorsVerified&&tagsVerified,fieldsVerified,creatorsVerified,tagsVerified};
      }
    }catch(error){readback={verified:false,message:error.message};}
    this.plans.delete(token);this.session.emit({kind:'library',library:'user'});
    return {status:readback.verified?'verified':'acknowledged-readback-pending',key,operation,readback};
  }
}
