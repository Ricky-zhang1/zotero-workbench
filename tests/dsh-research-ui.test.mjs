import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDetail, normalizeItemSummary } from '../integrations/dsh/web/lib/normalize.js';

test('DSH detail normalization retains Zotero metadata and complete attachment identifiers', () => {
  const item = {
    key: 'AB12CD34',
    data: {
      itemType: 'journalArticle',
      title: 'Metadata preservation',
      date: '2024-02',
      issue: '2',
      pages: '10-24',
      ISSN: '1234-5678',
      url: 'https://example.org/article',
      extra: 'JCR Q2',
      collections: ['COLL1234'],
      tags: [{ tag: 'CSSCI' }],
    },
  };
  const detail = normalizeDetail({
    item,
    attachments: [{
      key: 'PDF12345', title: 'Full text', filename: 'paper.pdf',
      contentType: 'application/pdf', linkMode: 'imported_file',
      parent: 'AB12CD34', path: '/storage/paper.pdf', size: 2048,
    }],
    notes: [{ key: 'NOTE1234', title: 'Reading note', html: '<p>Keep this note.</p>' }],
    annotations: [{ key: 'ANN12345', pageIndex: 4, text: 'Exact quote' }],
    journalLevels: [
      { id: 'jcr2', label: 'JCR Q2' },
      { id: 'cssci', label: 'CSSCI' },
    ],
    collectionNames: { COLL1234: 'Reading list' },
  }, []);

  assert.equal(detail.fields.ISSN, '1234-5678');
  assert.equal(detail.fields.url, 'https://example.org/article');
  assert.equal(detail.fields.issue, '2');
  assert.equal(detail.fields.pages, '10-24');
  assert.equal(detail.fields.extra, 'JCR Q2');
  assert.deepEqual(detail.journalLevels.map(({ label }) => label), ['JCR Q2', 'CSSCI']);
  assert.deepEqual(detail.attachments[0], {
    key: 'PDF12345', title: 'Full text', filename: 'paper.pdf',
    contentType: 'application/pdf', linkMode: 'imported_file', isPdf: true,
    path: '/storage/paper.pdf', parent: 'AB12CD34', size: 2048,
  });
  assert.equal(detail.notes[0].text, 'Keep this note.');
  assert.equal(detail.annotations[0].key, 'ANN12345');
  assert.deepEqual(detail.collectionNames, ['Reading list']);
});

test('DSH summary normalization preserves local journal levels for passive badges', () => {
  const summary = normalizeItemSummary({
    key: 'AB12CD34',
    title: 'Ranked article',
    journalLevels: [{ id: 'pku', label: '北大核心' }],
  });
  assert.deepEqual(summary.journalLevels, [{ id: 'pku', label: '北大核心' }]);
});

test('DSH research adapter maps all four browser calls to the host POST contract', async () => {
  globalThis.window ||= {};
  const { researchRequestEnvelope } = await import('../integrations/dsh/web/lib/workspace-app.js');
  const args = { library: 'user', keys: ['AB12CD34'] };

  assert.deepEqual(researchRequestEnvelope('research_materials', args), { action: 'materials', args });
  assert.deepEqual(researchRequestEnvelope('start_research_job', args), { action: 'start', args });
  assert.deepEqual(researchRequestEnvelope('research_job', { id: 'job-1' }), { action: 'status', id: 'job-1' });
  assert.deepEqual(researchRequestEnvelope('cancel_research_job', { id: 'job-1' }), { action: 'cancel', id: 'job-1' });
  assert.throws(() => researchRequestEnvelope('unknown', args), /不支持的研究操作/);
});
