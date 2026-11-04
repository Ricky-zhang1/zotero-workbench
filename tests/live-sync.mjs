// Live round-trip against the real local Zotero. Creates clearly labeled test data.
// Run with: node tests/live-sync.mjs  (needs local API + Zotero MCP reachable)
import assert from 'node:assert/strict';
import { StdioClient } from './mcp-client.mjs';
const client = new StdioClient();
const text = r => r.content?.map(c=>c.text||'').join('\n') ?? '';
const data = r => { if (r.isError) throw new Error(text(r)); return r.structuredContent ?? JSON.parse(text(r)); };
const PARENT = '3DWU883L';
try {
  await client.ready();
  // 1. Routing: a bogus quote must fail inside quote matching, before any write.
  const bad = await client.call('create_reader_highlight', { key: PARENT, quote: '这句话不存在于任何文献中 0xQQ' }, 60000);
  assert.equal(bad.isError, true); assert.match(text(bad), /不支持写入|Could not find|quote_not_found|找不到/);
  console.log(JSON.stringify({ check: 'highlight-routing', ok: true }));
  // 2. Real selection text from page 1 (copied verbatim from read_fulltext).
  const page1Text = text(await client.call('read_fulltext', { key: PARENT, pages: '1', maxChars: 6000 }, 120000));
  const lines = page1Text.split('\n').map(t => t.trim()).filter(t => t.length > 25 && !t.startsWith('---'));
  const line = lines[Math.min(5, lines.length - 1)];
  assert.ok(line, 'expected readable page-1 text');
  const attempt = await client.call('create_reader_highlight', { key: PARENT, quote: line, comment: '【工作台高亮连通测试 2026-10-28】可在 Zotero 中删除', color: 'gray' }, 120000);
  if (attempt.isError) {
    console.log(JSON.stringify({ check: 'highlight-write', ok: false, message: text(attempt) }));
  } else {
    const saved = data(attempt);
    assert.equal(saved.saved, true); assert.ok(saved.annotationKey);
    console.log(JSON.stringify({ check: 'highlight-write', ok: true, annotationKey: saved.annotationKey, page: saved.page, url: saved.url }));
  }
  // 3. Note round trip through the existing Zotero MCP plugin.
  const preview = data(await client.call('prepare_library_action', { action: 'note', key: PARENT, text: '【工作台笔记连通测试 2026-10-28】验证工作台笔记写入 Zotero；可在 Zotero 中删除。' }, 60000));
  assert.equal(preview.status, 'previewed');
  let noteResult;
  try {
    const committed = data(await client.call('commit_library_action', { previewToken: preview.previewToken, confirmWrite: true }, 180000));
    noteResult = { status: committed.status, key: committed.key, identityVerified: committed.readback?.identityVerified };
  } catch (error) {
    // Identical payload already committed: the journal must block replay (P3).
    if (!/已提交过|review_operation/.test(error.message)) throw error;
    const id = /([a-f0-9]{64})/.exec(error.message)?.[1];
    const op = id ? data(await client.call('review_operation', { operationId: id }, 60000)) : null;
    noteResult = { status: 'journal-blocked-replay', journalStatus: op?.status ?? 'unknown', operationId: id };
  }
  console.log(JSON.stringify({ check: 'note-write', ...noteResult }));
  const after = data(await client.call('inspect_item', { key: PARENT }, 60000));
  console.log(JSON.stringify({ check: 'readback', noteCount: after.noteCount }));
} finally { client.close(); }
