import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StdioClient } from './mcp-client.mjs';
import { Script } from 'node:vm';
test('production server exposes native MCP entrypoint and full PDF resources', async t => {
  const client = new StdioClient(); t.after(() => client.close());
  const init = await client.ready(); assert.equal(init.serverInfo.name, 'zotero-workbench');
  const { tools } = await client.request('tools/list');
  const opener = tools.find(t => t.name === 'open_workbench');
  assert.deepEqual(opener._meta['openai/ui'].entrypoints, [{type:'global'},{type:'thread'}]);
  assert.equal(opener._meta.ui.resourceUri, 'ui://zotero/panel.html');
  const priorAgentTools = [
    'list_collections','search_library','get_item','open_item','show_items','read_fulltext','find_in_pdf','highlight',
    'collect_evidence','research_query','review_evidence','prepare_library_action','commit_library_action',
    'export_selection','inspect_item','render_reading_card','library_maintenance','workbench_status','cite','export_bib',
    'lookup_journal_levels'
  ];
  for (const name of priorAgentTools) assert.ok(tools.some(tool => tool.name === name), `existing tool ${name} must remain`);
  for (const name of ['research_materials','start_research_job','research_job','cancel_research_job'])
    assert.ok(tools.some(tool => tool.name === name), `research tool ${name} must be exposed`);
  for (const name of ['research_materials','start_research_job','research_job','cancel_research_job']) {
    const tool = tools.find(candidate => candidate.name === name);
    assert.equal(tool._meta.ui.visibility.join(','), 'model,app', `${name} must be available to the agent and panel`);
    assert.equal(tool.annotations.destructiveHint, false, `${name} must not write to Zotero`);
  }
  const collaborationNames = ['collaboration_session','collaboration_sources','collaboration_draft','collaboration_feedback','collaboration_read'];
  for (const name of collaborationNames) assert.ok(tools.some(tool => tool.name === name), `${name} must be exposed`);
  const collabSession = tools.find(tool => tool.name === 'collaboration_session');
  assert.ok(Object.hasOwn(collabSession.inputSchema.properties, 'draftId'), 'history retrieval is explicit by draftId');
  assert.ok(Object.hasOwn(collabSession.inputSchema.properties, 'id'));
  const collabSources = tools.find(tool => tool.name === 'collaboration_sources');
  assert.ok(Object.hasOwn(collabSources.inputSchema.properties, 'expectedRevision'));
  const collabDraft = tools.find(tool => tool.name === 'collaboration_draft');
  assert.ok(Object.hasOwn(collabDraft.inputSchema.properties, 'paragraphs'));
  const blockSchema = collabDraft.inputSchema.properties.paragraphs.items;
  assert.ok(blockSchema.properties.claims, 'claims are nested in paragraphs');
  const collabFeedback = tools.find(tool => tool.name === 'collaboration_feedback');
  assert.equal(collabFeedback._meta.ui.visibility.join(','), 'app', 'feedback recording and listing stay app-only');
  assert.ok(Object.hasOwn(collabFeedback.inputSchema.properties, 'claimId'));
  assert.ok(Object.hasOwn(tools.find(tool => tool.name === 'collaboration_read').inputSchema.properties, 'cursor'));
  assert.equal(tools.find(tool => tool.name === 'research_materials').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'research_job').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'start_research_job').annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'cancel_research_job').annotations.readOnlyHint, false);
  const maintenance=tools.find(t=>t.name==='library_maintenance');
  assert.equal(maintenance.annotations.readOnlyHint,true);
  assert.ok(maintenance.inputSchema.properties.view.enum.includes('duplicates'));
  const journalLevels = tools.find(t=>t.name==='lookup_journal_levels');
  assert.equal(journalLevels.annotations.readOnlyHint,true,'journal rank lookup must stay read-only');
  for (const name of ['create_reader_highlight','save_reader_highlights']) {
    const tool = tools.find(t=>t.name===name); assert.ok(tool,name);
    assert.equal(tool._meta.ui.visibility.join(','),'app',name+' must stay app-only');
  }
  for (const name of [
    'prepare_reader_annotation_trash','trash_reader_annotation','last_reader_annotation_trash',
    'prepare_reader_annotation_restore','restore_reader_annotation','reconcile_reader_annotation_operation'
  ]) {
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `${name} must be exposed`);
    assert.equal(tool._meta.ui.visibility.join(','), 'app', `${name} must stay app-only`);
  }
  const trashPreview = tools.find(candidate => candidate.name === 'prepare_reader_annotation_trash');
  assert.equal(trashPreview.annotations.readOnlyHint, true);
  assert.equal(trashPreview.annotations.destructiveHint, false);
  assert.deepEqual(Object.keys(trashPreview.inputSchema.properties).sort(), ['annotationKey','attachmentKey','library']);
  const trashCommit = tools.find(candidate => candidate.name === 'trash_reader_annotation');
  assert.equal(trashCommit.annotations.readOnlyHint, false);
  assert.equal(trashCommit.annotations.destructiveHint, true);
  assert.deepEqual(Object.keys(trashCommit.inputSchema.properties).sort(), ['confirmWrite','previewToken']);
  assert.ok(tools.some(candidate => candidate.name === 'review_operation'), 'annotation-trash status must reuse the existing read-only operation lookup');
  for (const name of ['last_reader_annotation_trash','prepare_reader_annotation_restore','reconcile_reader_annotation_operation']) {
    const tool=tools.find(candidate=>candidate.name===name);
    assert.equal(tool.annotations.readOnlyHint,true,`${name} must remain read-only`);
    assert.equal(tool.annotations.destructiveHint,false,`${name} must not write`);
  }
  const restorePreview=tools.find(candidate=>candidate.name==='prepare_reader_annotation_restore');
  assert.deepEqual(Object.keys(restorePreview.inputSchema.properties),['operationId']);
  const reconcile=tools.find(candidate=>candidate.name==='reconcile_reader_annotation_operation');
  assert.deepEqual(Object.keys(reconcile.inputSchema.properties),['operationId']);
  const restoreCommit=tools.find(candidate=>candidate.name==='restore_reader_annotation');
  assert.equal(restoreCommit.annotations.readOnlyHint,false);
  assert.equal(restoreCommit.annotations.destructiveHint,false,'restore is a user-confirmed recovery write, not permanent deletion');
  assert.deepEqual(Object.keys(restoreCommit.inputSchema.properties).sort(),['confirmWrite','previewToken']);
  const result = await client.read('ui://zotero/panel.html');
  assert.equal(result.contents[0].mimeType,'text/html;profile=mcp-app');
  const html = result.contents[0].text;
  assert.ok(html.includes('WorkbenchRoot')); assert.ok(html.includes('PDF.js'));
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Script(script));
  const state = await client.call('workbench_state', {state:{stack:[{kind:'library',library:'user',query:{}}],seenSeq:2}});
  assert.equal(state.structuredContent.state.seenSeq,2);
  assert.equal((await client.call('workbench_state')).structuredContent.state.seenSeq,2);
});
test('unreviewed highlight cannot use upstream direct-save route', async t => {
  const client = new StdioClient(); t.after(() => client.close()); await client.ready();
  const result = await client.call('save_highlights', {});
  assert.equal(result.isError, true); assert.match(result.content[0].text, /zotero-lattics/);

  const audit = await client.call('review_evidence', {judgment:{},locators:['{}'],dryRun:false,confirmWrite:false});
  assert.equal(audit.isError,true); assert.match(audit.content[0].text,/明确确认/);
});
