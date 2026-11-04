import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReaderHighlightTags } from '../src/domain/reader-highlight-tags.mjs';

test('writes only canonical preset tags and preserves the original annotation comment', () => {
  const object = {
    itemType: 'annotation', parentItem: 'PDFKEY01', annotationText: 'Original excerpt.',
    annotationComment: 'Researcher note stays intact.', annotationColor: '#5fb236',
    annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[1, 2, 3, 4]] }), tags: [],
  };
  const [saved] = applyReaderHighlightTags('user', [object], [{
    library: 'user', attachmentKey: 'PDFKEY01', quote: 'Original excerpt.', pageIndex: 2,
    tags: ['类型:研究方法'],
  }]);
  assert.deepEqual(saved.tags, [{ tag: '类型:研究方法' }]);
  assert.equal(saved.annotationComment, 'Researcher note stays intact.');
  assert.equal(saved.annotationColor, '#5fb236');
  assert.equal(object.tags.length, 0, 'the upstream payload is not mutated');
});

test('leaves untyped highlights unchanged and stops before unmatched or noncanonical tags can write', () => {
  const object = {
    itemType: 'annotation', parentItem: 'PDFKEY01', annotationText: 'Excerpt.', annotationComment: 'Existing comment.',
    annotationPosition: JSON.stringify({ pageIndex: 0 }), tags: [],
  };
  assert.deepEqual(applyReaderHighlightTags('user', [object], [{
    library: 'user', attachmentKey: 'PDFKEY01', quote: 'Excerpt.', pageIndex: 0, tags: [],
  }]), [object]);
  assert.throws(() => applyReaderHighlightTags('user', [object], [{
    library: 'user', attachmentKey: 'PDFKEY01', quote: 'Other excerpt.', pageIndex: 0, tags: ['类型:研究方法'],
  }]), /已中止写入/);
  assert.throws(() => applyReaderHighlightTags('user', [object], [{
    library: 'user', attachmentKey: 'PDFKEY01', quote: 'Excerpt.', pageIndex: 0, tags: ['研究方法'],
  }]), /已中止写入/);
});
