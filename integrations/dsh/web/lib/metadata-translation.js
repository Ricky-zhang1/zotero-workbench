import * as plainTextHelpers from './plain-text.js';
import { metadataRequiresTranslation } from './metadata-translation-heuristic.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'verification_required']);
const COMMON_ACRONYMS = ['AI', 'API', 'CSSCI', 'DOI', 'EU', 'GDP', 'ID', 'LLM', 'NLP', 'OECD', 'PISA', 'SCI', 'SSCI', 'STEM', 'TALIS', 'UK', 'USA', 'US'];
const zoteroPlainText = plainTextHelpers.zoteroPlainText;

function fieldRequiresTranslation(value) {
  const source = zoteroPlainText(value);
  const withoutAcronyms = source.replace(new RegExp(`(?<![A-Za-z])(?:${COMMON_ACRONYMS.join('|')})(?![A-Za-z])`, 'gi'), ' ');
  return metadataRequiresTranslation(withoutAcronyms);
}

export function metadataTranslationSignature(detail) {
  return JSON.stringify({
    title: zoteroPlainText(detail?.title),
    abstract: zoteroPlainText(detail?.abstractNote),
    language: String(detail?.language || '').trim(),
  });
}

export function metadataNeedsTranslation(detail) {
  return fieldRequiresTranslation(detail?.title) || fieldRequiresTranslation(detail?.abstractNote);
}

export function canTranslateMetadataItemType(itemType) {
  return !['attachment', 'note', 'annotation'].includes(String(itemType || '').trim().toLowerCase());
}

function validateField(field, expectedOriginal, name) {
  if (!field || typeof field !== 'object' || Array.isArray(field) ||
      typeof field.available !== 'boolean' || typeof field.translated !== 'boolean' ||
      typeof field.original !== 'string' || typeof field.translation !== 'string') {
    throw new Error(`标题与摘要翻译的${name}字段格式无效。`);
  }
  if (field.original !== expectedOriginal) throw new Error(`文献${name}在翻译期间发生变化；已隐藏旧译文，请重新翻译。`);
  const available = expectedOriginal.length > 0;
  if (field.available !== available || (!available && (field.translation !== '' || field.translated)) ||
      (available && !field.translation.trim()) || (!field.translated && field.translation !== field.original)) {
    throw new Error(`文献${name}翻译不完整；未显示部分结果。`);
  }
  return field;
}

export function validateMetadataTranslationResult(result, detail, { library = 'user', key = detail?.key } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      result.format !== 'zotero-workbench/metadata-translation' || result.version !== 1 ||
      result.targetLanguage !== 'zh-CN' || result.library !== library || result.itemKey !== key ||
      typeof result.sourceFingerprint !== 'string' || !result.sourceFingerprint ||
      result.language !== String(detail?.language || '').trim() ||
      result.provenance?.translationVersion !== 'zotero-workbench-zh-v1' ||
      result.provenance?.generatedReadOnly !== true || result.coverage?.complete !== true ||
      result.coverage?.fields !== 2 || !Number.isInteger(result.coverage?.translated) ||
      result.coverage.translated < 0 || result.coverage.translated > 2) {
    throw new Error('标题与摘要翻译结果未通过来源核对；未显示译文。');
  }
  const title = validateField(result.title, zoteroPlainText(detail?.title), '标题');
  const abstract = validateField(result.abstract, zoteroPlainText(detail?.abstractNote), '摘要');
  const translatedFields = Number(title.translated) + Number(abstract.translated);
  if (translatedFields !== result.coverage.translated)
    throw new Error('标题与摘要翻译覆盖记录不一致；未显示译文。');
  return result;
}

export async function requestMetadataTranslation(call, detail, {
  library = 'user', key = detail?.key, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  pollInterval = 800, onStatus = () => {},
} = {}) {
  const started = await call('start_research_job', { kind: 'translate_metadata', library, key });
  if (!started?.id) throw new Error('翻译服务未返回任务编号。');
  let snapshot = started;
  onStatus(snapshot);
  while (!TERMINAL_STATUSES.has(snapshot?.status)) {
    await wait(pollInterval);
    snapshot = await call('research_job', { id: started.id });
    onStatus(snapshot);
  }
  if (snapshot.status !== 'completed' || !snapshot.result) {
    throw new Error(snapshot.error || (snapshot.status === 'verification_required'
      ? '翻译结果仍在核验，请稍后重试。'
      : snapshot.status === 'cancelled' ? '翻译已取消。' : '标题与摘要翻译失败，可重试。'));
  }
  return validateMetadataTranslationResult(snapshot.result, detail, { library, key });
}
