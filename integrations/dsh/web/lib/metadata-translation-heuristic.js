/** Text-only predicate for Zotero title/abstract translation; safe to inline with Function#toString. */
export function metadataRequiresTranslation(text) {
  const value = String(text ?? '');
  const letters = [...value.matchAll(/\p{L}/gu)].length;
  const han = [...value.matchAll(/\p{Script=Han}/gu)].length;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return true;
  const visible = [...value].filter(character => !/\s/u.test(character)).length;
  if (letters <= 2 && visible > letters * 4) return false;
  return letters > 0 && !(han && han / letters >= 0.5);
}
