import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openZoteroLink, parseZoteroLink } from '../src/domain/native-links.mjs';
import { StdioClient } from './mcp-client.mjs';

test('accepts toolbar, popover, and page-jump Zotero links for personal and group libraries', () => {
  assert.deepEqual(parseZoteroLink('zotero://select/library/items/ABCDEFGH'), {
    kind: 'select', itemKey: 'ABCDEFGH', url: 'zotero://select/library/items/ABCDEFGH',
  });
  assert.deepEqual(parseZoteroLink('zotero://select/groups/1234/items/ABCDEFGH'), {
    kind: 'select', itemKey: 'ABCDEFGH', url: 'zotero://select/groups/1234/items/ABCDEFGH',
  });
  assert.deepEqual(parseZoteroLink('zotero://open-pdf/library/items/PDFKEY01?page=12&annotation=ANNOKEY1'), {
    kind: 'open-pdf', attachmentKey: 'PDFKEY01', page: 12, annotationKey: 'ANNOKEY1',
    url: 'zotero://open-pdf/library/items/PDFKEY01?page=12&annotation=ANNOKEY1',
  });
  assert.deepEqual(parseZoteroLink('zotero://open-pdf/library/items/PDFKEY01'), {
    kind: 'open-pdf', attachmentKey: 'PDFKEY01', page: null, annotationKey: null,
    url: 'zotero://open-pdf/library/items/PDFKEY01',
  });
  assert.deepEqual(parseZoteroLink('zotero://open-pdf/library/items/PDFKEY01?annotation=ANNOKEY1'), {
    kind: 'open-pdf', attachmentKey: 'PDFKEY01', page: null, annotationKey: 'ANNOKEY1',
    url: 'zotero://open-pdf/library/items/PDFKEY01?annotation=ANNOKEY1',
  });
  assert.deepEqual(parseZoteroLink('zotero://open-pdf/groups/1234/items/PDFKEY01?page=8'), {
    kind: 'open-pdf', attachmentKey: 'PDFKEY01', page: 8, annotationKey: null,
    url: 'zotero://open-pdf/groups/1234/items/PDFKEY01?page=8',
  });
  assert.deepEqual(parseZoteroLink('zotero://open-pdf/groups/1234/items/PDFKEY01?annotation=ANNOKEY1&page=1'), {
    kind: 'open-pdf', attachmentKey: 'PDFKEY01', page: 1, annotationKey: 'ANNOKEY1',
    url: 'zotero://open-pdf/groups/1234/items/PDFKEY01?page=1&annotation=ANNOKEY1',
  }, 'query parameters are normalized to page then annotation');
});

test('rejects arbitrary protocols, query parameters, and malformed Zotero paths', () => {
  for (const value of [
    'https://example.com',
    'file:///etc/passwd',
    'zotero://evil/select/library/items/ABCDEFGH',
    'zotero://select/library/items/ABCDEFGH?x=1',
    'zotero://select/library/items/%41BCDEFGH',
    'zotero://select/groups/0123/items/ABCDEFGH',
    'zotero://select/groups/1/items/ABCDEFGH;open',
    'zotero://open-pdf/library/items/PDFKEY01?page=0&annotation=ANNOKEY1',
    'zotero://open-pdf/library/items/PDFKEY01?page=1&annotation=ANNOKEY1&x=1',
    'zotero://open-pdf/library/items/PDFKEY01?page=01',
    'zotero://open-pdf/library/items/PDFKEY01?page=100001',
    'zotero://open-pdf/library/items/PDFKEY01?page=1&page=2',
    'zotero://open-pdf/library/items/PDFKEY01?annotation=ANNOKEY1&annotation=ANNOKEY2',
    'zotero://open-pdf/library/items/PDFKEY01?page=1&other=2',
    'zotero://open-pdf/library/items/PDFKEY01?',
    'zotero://open-pdf/library/items/PDFKEY01?annotation=ANNOKEY',
  ]) assert.throws(() => parseZoteroLink(value), /无效|超出范围|不支持|仅支持/);
});

test('executes one fixed OS opener argument without a shell and reports acceptance only', async () => {
  const calls = [];
  const result = await openZoteroLink('zotero://open-pdf/groups/1234/items/PDFKEY01?annotation=ANNOKEY1&page=2', {
    platform: 'darwin',
    execFileImpl: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [[
    '/usr/bin/open',
    ['zotero://open-pdf/groups/1234/items/PDFKEY01?page=2&annotation=ANNOKEY1'],
    { shell: false, windowsHide: true, timeout: 5000 },
  ]]);
  assert.equal(result.accepted, true);
  assert.equal(result.transport, 'operating-system');
  assert.match(result.message, /不证明 Zotero 已显示/);
});

test('rejects unsupported platforms without invoking an opener', async () => {
  let called = false;
  await assert.rejects(openZoteroLink('zotero://select/library/items/ABCDEFGH', {
    platform: 'win32', execFileImpl: async () => { called = true; },
  }), /不支持安全打开/);
  assert.equal(called, false);
});

test('registers an app-only deep-link tool and rejects invalid input', async t => {
  const client = new StdioClient();
  t.after(() => client.close());
  await client.ready();
  const { tools } = await client.request('tools/list');
  const tool = tools.find(candidate => candidate.name === 'open_in_zotero');
  assert.ok(tool);
  assert.deepEqual(tool._meta.ui.visibility, ['app']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['url']);
  assert.equal(tool.inputSchema.additionalProperties, false, 'strict object schema survives backend registration');
  const highlight = tools.find(candidate => candidate.name === 'create_reader_highlight');
  assert.deepEqual(highlight.inputSchema.properties.tags.items.enum, [
    '类型:研究背景', '类型:研究方法', '类型:研究结论', '类型:概念界定', '类型:其他',
  ]);
  const invalid = await client.call('open_in_zotero', { url: 'https://example.com' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Zotero 回链格式无效|仅支持/);
  const invalidTags = await client.call('create_reader_highlight', { key: 'ABCDEFGH', quote: 'Excerpt.', tags: ['custom'] });
  assert.equal(invalidTags.isError, true, 'unrecognized preset tags are rejected before contacting Zotero');
});
