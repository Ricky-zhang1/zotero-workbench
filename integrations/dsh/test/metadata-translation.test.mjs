import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTranslateMetadataItemType,
  metadataNeedsTranslation,
  metadataTranslationSignature,
  requestMetadataTranslation,
  validateMetadataTranslationResult,
} from '../web/lib/metadata-translation.js';

const detail = {
  key: 'TEST0001', title: 'A Study of Teacher Supply',
  abstractNote: '<p>This paper studies teacher supply.</p>', language: 'en-US',
};

function result(overrides = {}) {
  return {
    format: 'zotero-workbench/metadata-translation', version: 1, targetLanguage: 'zh-CN',
    library: 'user', itemKey: detail.key, language: detail.language, sourceFingerprint: 'a'.repeat(64),
    title: { original: detail.title, translation: '教师供给研究', translated: true, available: true },
    abstract: {
      original: 'This paper studies teacher supply.',
      translation: '本文研究教师供给。', translated: true, available: true,
    },
    coverage: { complete: true, fields: 2, translated: 2 },
    provenance: { translationVersion: 'zotero-workbench-zh-v1', generatedReadOnly: true },
    ...overrides,
  };
}

test('metadata translation UI is limited to ordinary parent items', () => {
  for (const childType of ['attachment', 'note', 'annotation'])
    assert.equal(canTranslateMetadataItemType(childType), false, `${childType} must not get a metadata translation action`);
  for (const itemType of ['journalArticle', 'book', 'document'])
    assert.equal(canTranslateMetadataItemType(itemType), true, `${itemType} remains eligible`);
});

test('metadata translation classification skips Chinese and empty metadata', () => {
  assert.equal(metadataNeedsTranslation({ ...detail, language: 'zh-CN' }), true);
  assert.equal(metadataNeedsTranslation({ ...detail, language: 'en', title: '教师供给研究', abstractNote: '本文考察教师供给。' }), false);
  assert.equal(metadataNeedsTranslation({ ...detail, language: 'zh', title: 'AI 与 CSSCI', abstractNote: '本文使用 AI 分析 CSSCI 期刊。' }), false);
  assert.equal(metadataNeedsTranslation({ ...detail, title: 'English title', abstractNote: `${'本文分析教师供给。'.repeat(200)}` }), true,
    'a long Chinese abstract does not hide a foreign title');
  assert.equal(metadataNeedsTranslation({ ...detail, title: '中文题名', abstractNote: 'This paper studies teacher supply.' }), true,
    'a foreign abstract is classified independently from a Chinese title');
  assert.equal(metadataNeedsTranslation({ ...detail, title: '', abstractNote: '' }), false);
  assert.equal(metadataNeedsTranslation(detail), true);
  assert.equal(metadataTranslationSignature({ ...detail, abstractNote: '<p>This paper studies teacher supply.</p>' }),
    metadataTranslationSignature({ ...detail, abstractNote: 'This paper studies teacher supply.' }));
});

test('metadata translation v1 requires exact item and source, complete fields, and preserves missing abstracts', () => {
  assert.deepEqual(validateMetadataTranslationResult(result(), detail), result());
  assert.throws(() => validateMetadataTranslationResult(result({ itemKey: 'OTHER001' }), detail), /来源核对/);
  assert.throws(() => validateMetadataTranslationResult(result({
    abstract: { ...result().abstract, original: 'A different abstract.' },
  }), detail), /摘要在翻译期间发生变化/);
  assert.throws(() => validateMetadataTranslationResult(result({ coverage: { complete: false, fields: 2, translated: 2 } }), detail), /来源核对/);

  const noAbstractDetail = { ...detail, abstractNote: '' };
  const noAbstractResult = result({
    abstract: { original: '', translation: '', translated: false, available: false },
    coverage: { complete: true, fields: 2, translated: 1 },
  });
  assert.equal(validateMetadataTranslationResult(noAbstractResult, noAbstractDetail), noAbstractResult);
  assert.throws(() => validateMetadataTranslationResult(result({
    abstract: { original: '', translation: '虚构摘要', translated: true, available: true },
    coverage: { complete: true, fields: 2, translated: 2 },
  }), noAbstractDetail), /摘要翻译不完整/);

  const mixedFieldDetail = { ...detail, abstractNote: '本文研究教师供给。' };
  const mixedFieldResult = result({
    abstract: { original: '本文研究教师供给。', translation: '本文研究教师供给。', translated: false, available: true },
    coverage: { complete: true, fields: 2, translated: 1 },
  });
  assert.equal(validateMetadataTranslationResult(mixedFieldResult, mixedFieldDetail), mixedFieldResult);
});

test('metadata request starts only the selected item, polls its job, and validates the completed result', async () => {
  const calls = [];
  const snapshots = [
    { id: 'job-1', status: 'running' },
    { id: 'job-1', status: 'completed', result: result() },
  ];
  const returned = await requestMetadataTranslation(async (name, args) => {
    calls.push([name, args]);
    if (name === 'start_research_job') return { id: 'job-1', status: 'running' };
    return snapshots.shift();
  }, detail, { wait: async () => {} });
  assert.equal(returned.format, 'zotero-workbench/metadata-translation');
  assert.deepEqual(calls, [
    ['start_research_job', { kind: 'translate_metadata', library: 'user', key: detail.key }],
    ['research_job', { id: 'job-1' }],
    ['research_job', { id: 'job-1' }],
  ]);
});

test('metadata request exposes service failure for an explicit retry path', async () => {
  await assert.rejects(requestMetadataTranslation(async name => name === 'start_research_job'
    ? { id: 'job-2', status: 'running' }
    : { id: 'job-2', status: 'failed', error: '模型暂不可用。' }, detail, { wait: async () => {} }), /模型暂不可用/);
});
