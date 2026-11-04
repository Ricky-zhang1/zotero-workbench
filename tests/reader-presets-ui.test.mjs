import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as presets from '../src/ui/highlight-presets.js';
import {
  readerHighlightColorOptions,
  readerHighlightSaveNotice,
  readerHighlightTypeOptions,
  readerHighlightWriteArgs,
} from '../src/ui/reader-highlight-controls.js';

test('reader type choices pair readable type names with their default colors', () => {
  assert.deepEqual(readerHighlightTypeOptions(presets).map(option => [option.id, option.label]), [
    ['research-background', '研究背景 · 黄色'],
    ['research-method', '研究方法 · 绿色'],
    ['research-conclusion', '研究结论 · 蓝色'],
    ['concept-definition', '概念界定 · 紫色'],
    ['other', '其他 · 红色'],
    ['default', '默认 · 黄色'],
  ]);
  assert.equal(readerHighlightColorOptions(presets).length, presets.HIGHLIGHT_COLORS.length);
  assert.ok(readerHighlightColorOptions(presets).every(option => option.label.includes(option.color)));
});

test('save arguments keep selected type separate from the chosen color and omit comments', () => {
  const methodPurple = readerHighlightWriteArgs(presets, { typeId: 'research-method', colorId: 'purple' });
  assert.deepEqual(methodPurple, { color: '#a28ae5', tags: ['类型:研究方法'] });
  assert.equal('comment' in methodPurple, false);
  assert.deepEqual(readerHighlightWriteArgs(presets, 'default'), { color: '#ffd400', tags: [] });
});

test('a deduplicated result reports the original explicit type without retyping it', () => {
  const notice = readerHighlightSaveNotice(presets,
    { existing: true, saved: false, tags: ['类型:研究背景'] },
    { typeId: 'research-method', colorId: 'purple' });
  assert.match(notice, /原类型为“研究背景”/);
  assert.match(notice, /没有修改其类型/);
  assert.doesNotMatch(notice, /研究方法/);
  assert.match(readerHighlightSaveNotice(presets,
    { existing: true, saved: false, tags: [] }, 'research-background'), /未分类/);
});

test('unverified writes do not produce a saved success notice', () => {
  assert.equal(readerHighlightSaveNotice(presets,
    { saved: true, verified: false }, 'research-method'), null);
  assert.match(readerHighlightSaveNotice(presets,
    { saved: true, verified: true }, 'research-method'), /研究方法 · 绿色/);
});

test('built panel inlines both namespaces, routes Zotero links through feedback, and parses as JavaScript', async () => {
  const html = await readFile(new URL('../dist/ui/panel.html', import.meta.url), 'utf8');
  assert.match(html, /var wbHighlightPresets=\(function\(\)/);
  assert.match(html, /var wbReaderHighlightUi=\(function\(\)/);
  assert.match(html, /wbReaderHighlightUi\.WorkbenchReaderHighlightControls/);
  assert.match(html, /tags:preset\?\.tags\?\?\[\]/);
  assert.match(html, /wbOpenTargetWithFeedback\(`\$\{xC\(i\.library,i\.attachmentKey\)\}\?annotation=/);
  assert.equal((html.match(/en\.openLink\(/g) || []).length, 1,
    'only the helper external-URL branch should call en.openLink directly');
  assert.ok(html.includes('readerTrashOutcomes.filter(item=>item.blocked||item.status==="outcome-unknown")'));
  assert.ok(!html.includes('readerTrashOutcomes.slice('), 'all operation results remain available');
  assert.ok(html.includes('className:"wb-reader-trash-outcomes","aria-label":"批注移除结果",style:{maxHeight:"35vh",overflowY:"auto"}'));
  assert.ok(html.includes('...readerTrashOutcomes.map(outcome=>'));

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim()).filter(Boolean);
  assert.ok(scripts.length > 0);
  scripts.forEach((source, index) => new vm.Script(source, { filename: `panel-inline-${index}.js` }));
});
