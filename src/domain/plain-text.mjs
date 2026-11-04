/**
 * Convert Zotero title/abstract HTML to the plain text used by the UI and by
 * derived-text fingerprints. Keep this deliberately small and dependency-free
 * so the build and backend can call the exact same implementation.
 */
export function zoteroPlainText(value) {
  const source = String(value ?? '');
  const blockTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'blockquote', 'section', 'article', 'tr', 'td', 'th', 'ul', 'ol']);
  const allowedTags = new Set([...blockTags, 'a', 'abbr', 'b', 'cite', 'code', 'dd', 'del', 'dl', 'dt', 'em', 'font', 'i', 'img', 'ins', 'mark', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'script', 'style']);
  function readTagAt(text, start) {
    let cursor = start + 1, closing = false;
    if (text[cursor] === '/') { closing = true; cursor++; }
    const nameStart = cursor;
    if (cursor >= text.length || !/[a-z]/i.test(text[cursor])) return null;
    while (cursor < text.length && /[a-z0-9]/i.test(text[cursor])) cursor++;
    if (cursor === nameStart) return null;
    const name = text.slice(nameStart, cursor).toLowerCase();
    if (!allowedTags.has(name) || (closing && (name === 'br' || name === 'img'))) return null;
    while (cursor < text.length) {
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (text[cursor] === '>') return { end: cursor + 1, name, closing };
      if (!closing && text[cursor] === '/' && text[cursor + 1] === '>') return { end: cursor + 2, name, closing };
      if (closing || cursor >= text.length || !/[a-z_:]/i.test(text[cursor])) return null;
      cursor++;
      while (cursor < text.length && /[a-z0-9_:.-]/i.test(text[cursor])) cursor++;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (text[cursor] !== '=') continue;
      cursor++;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor++] : '';
      const valueStart = cursor;
      if (quote) {
        while (cursor < text.length && text[cursor] !== quote) {
          if (text[cursor] === '<') return null;
          cursor++;
        }
        if (cursor >= text.length) return null;
        cursor++;
      } else {
        while (cursor < text.length && !/[\s<>"'`=]/.test(text[cursor])) cursor++;
      }
      if (cursor === valueStart) return null;
    }
    return null;
  }
  const lowerSource = source.toLowerCase();
  let output = '';
  for (let index = 0; index < source.length;) {
    if (source[index] !== '<') { output += source[index++]; continue; }
    const tag = readTagAt(source, index);
    if (!tag) { output += source[index++]; continue; }
    index = tag.end;
    if ((tag.name === 'script' || tag.name === 'style') && !tag.closing) {
      const closingStart = lowerSource.indexOf(`</${tag.name}`, index);
      if (closingStart < 0) break;
      const closingTag = readTagAt(source, closingStart);
      if (closingTag?.closing && closingTag.name === tag.name) index = closingTag.end;
      continue;
    }
    if (blockTags.has(tag.name)) output += '\n';
  }
  return output
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code) => {
      const point = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code);
      try {
        return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      } catch {
        return entity;
      }
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (entity, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
    })[name.toLowerCase()] ?? entity)
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\t ]*\n[\t ]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .normalize('NFC')
    .trim();
}
