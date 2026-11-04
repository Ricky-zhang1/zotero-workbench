import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_PRESETS,
  HIGHLIGHT_PRESET_WIDGET_STATE_KEY,
  annotationHighlightType,
  getHighlightPresetPreference,
  highlightPresetLabel,
  highlightPresetWriteMetadata,
  normalizeHighlightPreset,
  normalizeHighlightType,
  setHighlightPresetPreference,
} from '../src/ui/highlight-presets.js';

test('named presets show type and color together with the requested Zotero colors', () => {
  const expected = [
    ['research-background', '研究背景', '#ffd400'],
    ['research-method', '研究方法', '#5fb236'],
    ['research-conclusion', '研究结论', '#2ea8e5'],
    ['concept-definition', '概念界定', '#a28ae5'],
    ['other', '其他', '#ff6666'],
    ['default', '默认', '#ffd400'],
  ];

  for (const [id, label, color] of expected) {
    const preset = normalizeHighlightPreset(id);
    assert.equal(preset.typeLabel, label);
    assert.equal(preset.color, color);
    assert.match(highlightPresetLabel(id), new RegExp(`${label} ·`));
  }
  assert.equal(HIGHLIGHT_PRESETS.length, expected.length);
  assert.deepEqual(HIGHLIGHT_COLORS.map(entry => entry.color), [
    '#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa',
  ]);
});

test('type and color can be selected independently', () => {
  const selection = normalizeHighlightPreset({ typeId: 'research-method', colorId: 'purple' });
  assert.equal(selection.typeId, 'research-method');
  assert.equal(selection.typeLabel, '研究方法');
  assert.equal(selection.color, '#a28ae5');
  assert.equal(selection.colorLabel, '紫色');
  assert.equal(selection.label, '研究方法 · 紫色');
  assert.equal(selection.typeTag, '类型:研究方法');
});

test('historical annotations do not get a type inferred from their color', () => {
  assert.deepEqual(annotationHighlightType({ color: '#ffd400', tags: [] }), {
    typeId: null,
    typeLabel: '未分类',
    explicit: false,
  });
  assert.deepEqual(annotationHighlightType({ annotationColor: '#5fb236', tags: [] }), {
    typeId: null,
    typeLabel: '未分类',
    explicit: false,
  });
});

test('only an exact canonical annotation type tag supplies a research type', () => {
  assert.deepEqual(annotationHighlightType({ tags: ['自定义标签', { tag: '类型:研究方法' }] }), {
    typeId: 'research-method',
    typeLabel: '研究方法',
    explicit: true,
  });
  assert.equal(annotationHighlightType({ tags: ['研究方法'] }).typeId, null);
  assert.equal(annotationHighlightType({ tags: ['我的类型:研究方法'] }).typeId, null);
  assert.equal(normalizeHighlightType('#5fb236'), null);
});

test('default leaves type unassigned while an explicit preset exposes its Zotero tag', () => {
  assert.deepEqual(highlightPresetWriteMetadata('default'), {
    color: '#ffd400',
    typeId: null,
    typeTag: null,
    tags: [],
  });
  assert.deepEqual(highlightPresetWriteMetadata('other'), {
    color: '#ff6666',
    typeId: 'other',
    typeTag: '类型:其他',
    tags: ['类型:其他'],
  });
});

test('preference helpers copy and update only the local widget state field', () => {
  const original = { openTab: 'reader', zoom: 1.2 };
  const changed = setHighlightPresetPreference(original, { typeId: 'concept-definition', colorId: 'orange' });
  assert.deepEqual(original, { openTab: 'reader', zoom: 1.2 });
  assert.deepEqual(changed, {
    openTab: 'reader',
    zoom: 1.2,
    [HIGHLIGHT_PRESET_WIDGET_STATE_KEY]: { typeId: 'concept-definition', colorId: 'orange' },
  });
  const restored = getHighlightPresetPreference(changed);
  assert.equal(restored.typeId, 'concept-definition');
  assert.equal(restored.colorId, 'orange');
  assert.equal(restored.color, '#f19837');
  assert.equal(getHighlightPresetPreference({}).id, 'default');
});
