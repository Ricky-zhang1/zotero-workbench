// Narrow writer adapter for the Zotero Local API. All writes go through the
// session's pinned Zotero writer, which owns authorization and Server-ID checks.

const NOTE_SCHEMA = '<div data-schema-version="9">';

export function normalizeNoteText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

export function escapeNoteText(value) {
  return normalizeNoteText(value)
    .split('\n')
    .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</p>`)
    .join('');
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (entity, code) => {
    const name = code.toLowerCase();
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos' || name === '#39') return "'";
    const point = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    try { return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity; }
    catch { return entity; }
  });
}

export function zoteroNoteHtmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\n$/, '')
    .replace(/\r\n?/g, '\n');
}

export class LibraryLocalWrites {
  constructor(session) { this.session = session; }

  async write({ action, args, expectedVersion }) {
    let key;
    if (action === 'import') {
      const item = await this.session.cleanItem({
        ...args.fields,
        itemType: args.itemType,
        creators: args.creators ?? [],
        tags: (args.tags ?? []).map(tag => typeof tag === 'string' ? { tag } : tag),
        collections: []
      });
      [key] = await this.session.writer.create('user', 'items', [item]);
      this.session.emit({ kind: 'library', library: 'user' });
      return { structuredContent: { success: true, data: { itemKey: key } } };
    }

    if (action === 'note') {
      const text = normalizeNoteText(args.content);
      const note = `${NOTE_SCHEMA}${escapeNoteText(text)}</div>`;
      [key] = await this.session.writer.create('user', 'items', [{
        itemType: 'note', parentItem: args.parentKey, note, tags: [], relations: {}
      }]);
      this.session.emit({ kind: 'library', library: 'user' });
      return { structuredContent: { success: true, data: { noteKey: key, expectedNoteText: text } } };
    }

    if (action === 'metadata') {
      const result = await this.session.writer.patchItem('user', args.itemKey, current => {
        if (current.version !== expectedVersion) throw new Error('条目已被其他操作修改，请刷新后重新预览。');
        return args.fields;
      });
      this.session.emit({ kind: 'library', library: 'user' });
      return { structuredContent: { success: true, data: { itemKey: args.itemKey }, changed: result.changed } };
    }

    throw new Error(`Unsupported local library action: ${action}`);
  }
}
