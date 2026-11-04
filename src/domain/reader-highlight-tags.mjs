import { HIGHLIGHT_TYPES } from '../ui/highlight-presets.js';

export const READER_HIGHLIGHT_TYPE_TAGS = Object.freeze(HIGHLIGHT_TYPES
  .map(type => type.tag)
  .filter(tag => typeof tag === 'string'));

function positionPageIndex(item) {
  try {
    const position = JSON.parse(item?.annotationPosition || '{}');
    return Number.isInteger(position.pageIndex) && position.pageIndex >= 0 ? position.pageIndex : null;
  } catch {
    return null;
  }
}

/**
 * Attach a requested preset tag to the matching Zotero annotation payload.
 * The quote, comment, color, and all other fields remain byte-for-byte values
 * from the upstream writer payload.
 */
export function applyReaderHighlightTags(library, objects, highlights) {
  if (!Array.isArray(objects) || !Array.isArray(highlights)) throw new TypeError('批注写入内容格式无效。');
  const remaining = highlights.filter(highlight => Array.isArray(highlight?.tags) && highlight.tags.length)
    .map(highlight => ({ ...highlight }));
  const output = objects.map(object => {
    if (object?.itemType !== 'annotation') return object;
    const index = remaining.findIndex(highlight => highlight.library === library
      && highlight.attachmentKey === object.parentItem
      && highlight.quote === object.annotationText
      && highlight.pageIndex === positionPageIndex(object)
      && highlight.tags.every(tag => READER_HIGHLIGHT_TYPE_TAGS.includes(tag)));
    if (index < 0) return object;
    const [highlight] = remaining.splice(index, 1);
    return { ...object, tags: highlight.tags.map(tag => ({ tag })) };
  });
  if (remaining.length) throw new Error('未能将预设类型标签对应到待写入的高亮；已中止写入。');
  return output;
}
