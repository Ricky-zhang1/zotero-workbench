/**
 * Reader highlight type and color choices.
 *
 * Type and color are separate fields: a color never implies a research type.
 * Existing annotation types are recovered only from the explicit Zotero tag
 * `类型:<label>`. UI preference helpers operate on the local widget state only.
 */

export const DEFAULT_HIGHLIGHT_PRESET_ID = 'default';
export const DEFAULT_HIGHLIGHT_TYPE_ID = 'default';
export const DEFAULT_HIGHLIGHT_COLOR_ID = 'yellow';
export const HIGHLIGHT_TYPE_TAG_PREFIX = '类型:';
export const UNCLASSIFIED_HIGHLIGHT_TYPE_LABEL = '未分类';
export const HIGHLIGHT_PRESET_WIDGET_STATE_KEY = 'readerHighlightSelection';

const freezeRows = rows => Object.freeze(rows.map(row => Object.freeze(row)));

export const HIGHLIGHT_TYPES = freezeRows([
  { id: 'research-background', label: '研究背景', tag: `${HIGHLIGHT_TYPE_TAG_PREFIX}研究背景` },
  { id: 'research-method', label: '研究方法', tag: `${HIGHLIGHT_TYPE_TAG_PREFIX}研究方法` },
  { id: 'research-conclusion', label: '研究结论', tag: `${HIGHLIGHT_TYPE_TAG_PREFIX}研究结论` },
  { id: 'concept-definition', label: '概念界定', tag: `${HIGHLIGHT_TYPE_TAG_PREFIX}概念界定` },
  { id: 'other', label: '其他', tag: `${HIGHLIGHT_TYPE_TAG_PREFIX}其他` },
  { id: DEFAULT_HIGHLIGHT_TYPE_ID, label: '默认', tag: null },
]);

export const HIGHLIGHT_COLORS = freezeRows([
  { id: 'yellow', label: '黄色', color: '#ffd400' },
  { id: 'red', label: '红色', color: '#ff6666' },
  { id: 'green', label: '绿色', color: '#5fb236' },
  { id: 'blue', label: '蓝色', color: '#2ea8e5' },
  { id: 'purple', label: '紫色', color: '#a28ae5' },
  { id: 'magenta', label: '洋红色', color: '#e56eee' },
  { id: 'orange', label: '橙色', color: '#f19837' },
  { id: 'gray', label: '灰色', color: '#aaaaaa' },
]);

/** Named presets pair a human-readable type with an independently visible color. */
export const HIGHLIGHT_PRESETS = freezeRows([
  { id: 'research-background', typeId: 'research-background', colorId: 'yellow' },
  { id: 'research-method', typeId: 'research-method', colorId: 'green' },
  { id: 'research-conclusion', typeId: 'research-conclusion', colorId: 'blue' },
  { id: 'concept-definition', typeId: 'concept-definition', colorId: 'purple' },
  { id: 'other', typeId: 'other', colorId: 'red' },
  { id: DEFAULT_HIGHLIGHT_PRESET_ID, typeId: DEFAULT_HIGHLIGHT_TYPE_ID, colorId: DEFAULT_HIGHLIGHT_COLOR_ID },
]);

const typesById = new Map(HIGHLIGHT_TYPES.map(type => [type.id, type]));
const colorsById = new Map(HIGHLIGHT_COLORS.map(color => [color.id, color]));
const colorsByHex = new Map(HIGHLIGHT_COLORS.map(color => [color.color, color]));
const presetsById = new Map(HIGHLIGHT_PRESETS.map(preset => [preset.id, preset]));

/** Resolve an explicit type ID, label, or canonical type tag. Unknown values stay untyped. */
export function normalizeHighlightType(value) {
  const raw = typeof value === 'string'
    ? value.trim()
    : value && typeof value === 'object'
      ? String(value.typeId ?? value.id ?? value.tag ?? '').trim()
      : '';
  if (!raw) return null;
  const type = HIGHLIGHT_TYPES.find(candidate => candidate.id === raw
    || candidate.label === raw
    || (candidate.tag !== null && candidate.tag === raw));
  return type?.id ?? null;
}

/** Resolve a Zotero color ID or canonical hex value. Unknown values use the default color. */
export function normalizeHighlightColor(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return colorsById.get(raw) ?? colorsByHex.get(raw) ?? colorsById.get(DEFAULT_HIGHLIGHT_COLOR_ID);
}

function selection(typeId, color) {
  const type = typesById.get(typeId) ?? typesById.get(DEFAULT_HIGHLIGHT_TYPE_ID);
  const preset = HIGHLIGHT_PRESETS.find(candidate => candidate.typeId === type.id && candidate.colorId === color.id);
  const id = preset?.id ?? `${type.id}:${color.id}`;
  return Object.freeze({
    id,
    presetId: preset?.id ?? null,
    typeId: type.id,
    typeLabel: type.label,
    typeTag: type.tag,
    explicitType: type.tag !== null,
    colorId: color.id,
    color: color.color,
    colorLabel: color.label,
    label: `${type.label} · ${color.label}`,
  });
}

/**
 * Normalize a saved preset ID or an explicit `{ typeId, colorId }` selection.
 * The two dimensions remain independent, so a researcher can pair any type
 * with any Zotero color.
 */
export function normalizeHighlightPreset(value) {
  if (typeof value === 'string') {
    const preset = presetsById.get(value);
    if (preset) return selection(preset.typeId, colorsById.get(preset.colorId));
  }
  if (value && typeof value === 'object') {
    const presetId = typeof value.presetId === 'string' ? value.presetId : value.id;
    const preset = presetsById.get(presetId);
    if (preset) return selection(preset.typeId, colorsById.get(preset.colorId));
    const typeId = normalizeHighlightType(value.typeId) ?? DEFAULT_HIGHLIGHT_TYPE_ID;
    const color = normalizeHighlightColor(value.colorId ?? value.color);
    return selection(typeId, color);
  }
  const fallback = presetsById.get(DEFAULT_HIGHLIGHT_PRESET_ID);
  return selection(fallback.typeId, colorsById.get(fallback.colorId));
}

/** Label for a selectable option; both the type and the color are shown. */
export function highlightPresetLabel(value) {
  return normalizeHighlightPreset(value).label;
}

/** Return a type only when its exact canonical Zotero annotation tag is present. */
export function highlightTypeFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const entry of tags) {
    const tag = typeof entry === 'string' ? entry.trim()
      : entry && typeof entry.tag === 'string' ? entry.tag.trim()
        : '';
    const type = HIGHLIGHT_TYPES.find(candidate => candidate.tag !== null && candidate.tag === tag);
    if (type) return type.id;
  }
  return null;
}

/**
 * Read the research type from a Zotero annotation. Color is deliberately not
 * consulted; untagged historical annotations remain unclassified.
 */
export function annotationHighlightType(annotation) {
  const typeId = highlightTypeFromTags(annotation?.tags);
  const type = typeId ? typesById.get(typeId) : null;
  return Object.freeze({
    typeId,
    typeLabel: type?.label ?? UNCLASSIFIED_HIGHLIGHT_TYPE_LABEL,
    explicit: type !== null,
  });
}

/** Build the values a writer needs; a default selection has no type tag. */
export function highlightPresetWriteMetadata(value) {
  const normalized = normalizeHighlightPreset(value);
  return Object.freeze({
    color: normalized.color,
    typeId: normalized.explicitType ? normalized.typeId : null,
    typeTag: normalized.typeTag,
    tags: normalized.typeTag ? Object.freeze([normalized.typeTag]) : Object.freeze([]),
  });
}

/** Read the preference from local widget state, falling back to the default. */
export function getHighlightPresetPreference(widgetState) {
  return normalizeHighlightPreset(widgetState?.[HIGHLIGHT_PRESET_WIDGET_STATE_KEY]);
}

/** Return a copied widget state with only the local reader preference updated. */
export function setHighlightPresetPreference(widgetState, value) {
  const current = widgetState && typeof widgetState === 'object' && !Array.isArray(widgetState)
    ? widgetState
    : {};
  const normalized = normalizeHighlightPreset(value);
  return {
    ...current,
    [HIGHLIGHT_PRESET_WIDGET_STATE_KEY]: {
      typeId: normalized.typeId,
      colorId: normalized.colorId,
    },
  };
}
