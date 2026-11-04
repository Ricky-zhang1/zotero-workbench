import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_TRANSLATION_BLOCK_CHARS, buildTranslationBlocks, requiresTranslation, runTranslationWorker,
  validateTranslationOutput, validateTranslationPayload
} from '../src/domain/translation-worker.mjs';
import { metadataRequiresTranslation } from '../src/domain/metadata-translation-heuristic.mjs';

 test('fulltext blocks preserve exact contiguous text, whitespace boundaries, and surrogate pairs', () => {
  const source = `${'a'.repeat(3990)} boundary ${'b'.repeat(4020)}`;
  const blocks = buildTranslationBlocks([{ page: 1, text: source }]);
  assert.equal(blocks.map(block => block.original).join(''), source);
  assert.ok(blocks.every(block => block.original.length <= MAX_TRANSLATION_BLOCK_CHARS));
  assert.ok(blocks.some(block => block.original.endsWith(' ')), 'split should prefer a nearby whitespace boundary');

  const paired = `${'x'.repeat(3999)}😀tail`;
  const pairBlocks = buildTranslationBlocks([{ page: 1, text: paired }]);
  assert.equal(pairBlocks.map(block => block.original).join(''), paired);
  assert.equal(pairBlocks[0].original.charCodeAt(pairBlocks[0].original.length - 1) >= 0xd800, false,
    'a surrogate pair must not be split across blocks');
});

test('legacy fulltext and annotation heuristic remains unchanged', () => {
  assert.equal(requiresTranslation('制度安排影响地方行动者的选择。'), false);
  assert.equal(requiresTranslation('AI与教育'), true, 'the metadata-specific rule must not change the legacy threshold');
  assert.equal(requiresTranslation('∑ xᵢ = 0; 2024–2026'), false);
  assert.equal(requiresTranslation('中文解释；however, institutions shape actual outcomes.'), true);
  assert.equal(requiresTranslation('制度的配置が地方の選択を変える。'), true);
  assert.equal(requiresTranslation('조직의 자원 배분은 교사의 선택을 바꾼다.'), true);
  assert.equal(requiresTranslation('Институциональные условия меняют решения местных акторов.'), true);
  assert.equal(requiresTranslation('تؤثر المؤسسات في اختيارات الفاعلين المحليين.'), true);
});

test('metadata heuristic uses visible text rather than Zotero language and preserves Chinese-led short titles', () => {
  const inlineMetadataRequiresTranslation = new Function(`return (${metadataRequiresTranslation.toString()})`)();
  assert.equal(inlineMetadataRequiresTranslation('AI与教育'), false, 'the predicate can be embedded without module imports');
  assert.equal(metadataRequiresTranslation('AI与教育'), false);
  assert.equal(metadataRequiresTranslation('Institutional Change'), true);
  assert.equal(metadataRequiresTranslation('地方制度与教师配置'), false);
  assert.equal(metadataRequiresTranslation('制度安排 shapes local choices and outcomes.'), true);
  assert.equal(metadataRequiresTranslation('制度の配置が地方の選択を変える。'), true);
  assert.equal(metadataRequiresTranslation('조직의 자원 배분은 교사의 선택을 바꾼다.'), true);
  assert.equal(metadataRequiresTranslation('∑ xᵢ = 0; 2024–2026'), false);
});

test('translation output requires exact ID coverage and flags only permitted unchanged blocks', () => {
  const payload = { kind: 'translate', blocks: [
    { id: 'p1-b1', original: 'An English sentence about local institutions.', preserveOriginal: false },
    { id: 'p1-b2', original: '制度安排影响研究结果。', preserveOriginal: true },
    { id: 'p1-b3', original: '∑ xᵢ = 0', preserveOriginal: true },
  ] };
  const rows = validateTranslationOutput(payload, { translations: [
    { id: 'p1-b2', translation: '制度安排影响研究结果。', unchanged: true },
    { id: 'p1-b1', translation: '地方制度影响研究结果。', unchanged: false },
    { id: 'p1-b3', translation: '∑ xᵢ = 0', unchanged: true },
  ] });
  assert.equal(rows[0].id, 'p1-b1');
  assert.equal(rows[1].unchanged, true);
  assert.throws(() => validateTranslationOutput(payload, { translations: [
    { id: 'p1-b1', translation: 'An English sentence about local institutions.' },
    { id: 'p1-b2', translation: '制度安排影响研究结果。', unchanged: true },
    { id: 'p1-b3', translation: '∑ xᵢ = 0', unchanged: true },
  ] }), /外文翻译结果与原文相同/);
  assert.throws(() => validateTranslationOutput(payload, { translations: rows.slice(0, 2) }), /条数不完整/);
});

test('metadata translation uses opaque IDs and permits only explicit untranslated pass-through', () => {
  const payload = { kind: 'translate_metadata', fields: [
    { id: '0123456789abcdef', original: 'An English paper title.', preserveOriginal: false },
    { id: 'fedcba9876543210', original: 'AI与教育', preserveOriginal: true },
  ] };
  assert.deepEqual(validateTranslationPayload(payload), payload.fields);
  const result = validateTranslationOutput(payload, { translations: [
    { id: 'fedcba9876543210', translation: 'AI与教育', unchanged: true },
    { id: '0123456789abcdef', translation: '一篇关于制度的英文论文题目。', unchanged: false },
  ] });
  assert.equal(result[0].id, '0123456789abcdef');
  assert.equal(result[1].unchanged, true);
  assert.throws(() => validateTranslationPayload({ kind: 'translate_metadata', fields: [
    { id: '0123456789abcdef', original: 'Institutional Change', preserveOriginal: true }
  ] }), /翻译条目标识或原文无效/);
  assert.throws(() => validateTranslationOutput(payload, { translations: [
    { id: '0123456789abcdef', translation: 'An English paper title.', unchanged: true },
    { id: 'fedcba9876543210', translation: 'AI与教育', unchanged: true },
  ] }), /外文翻译结果与原文相同/);
});

test('Node translation worker sends metadata fields through the existing Codex adapter', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'metadata-translation-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'mock-codex');
  const capturedPrompt = join(dir, 'prompt.json');
  const oldCodex = process.env.ZOTERO_WORKBENCH_CODEX;
  process.env.ZOTERO_WORKBENCH_CODEX = executable;
  t.after(() => oldCodex === undefined
    ? delete process.env.ZOTERO_WORKBENCH_CODEX
    : (process.env.ZOTERO_WORKBENCH_CODEX = oldCodex));
  await writeFile(executable,
    `#!/bin/sh\nOUTPUT=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '-o' ]; then shift; OUTPUT="$1"; fi\n  shift\ndone\ncat > '${capturedPrompt}'\nprintf '{"translations":[{"id":"0123456789abcdef","translation":"一篇英文论文标题的中文译文。"}]}' > "$OUTPUT"\n`,
    { mode: 0o700 });
  await chmod(executable, 0o700);
  const payload = { kind: 'translate_metadata', fields: [
    { id: '0123456789abcdef', original: 'An English paper title.', preserveOriginal: false }
  ] };
  const result = await runTranslationWorker({
    job: { status: 'running' }, payload, scratch: join(dir, 'work'), model: null
  });
  assert.deepEqual(result.translations, [
    { id: '0123456789abcdef', translation: '一篇英文论文标题的中文译文。', unchanged: false }
  ]);
  const prompt = await readFile(capturedPrompt, 'utf8');
  assert.ok(prompt.includes('An English paper title.'));
  assert.ok(prompt.includes('0123456789abcdef'));
  assert.equal(prompt.includes('PAPER001'), false);
});

test('translation payload bounds fulltext size and annotation batch count without truncation', () => {
  const fulltext = { kind: 'translate', blocks: Array.from({ length: 501 }, (_, index) => ({
    id: `p1-b${index + 1}`, original: 'x', preserveOriginal: true,
  })) };
  assert.throws(() => validateTranslationPayload(fulltext), /条目数超出范围/);
  assert.throws(() => validateTranslationPayload({ kind: 'translate', blocks: [
    { id: 'p1-b1', original: 'x'.repeat(4001), preserveOriginal: false }
  ] }), /超过长度上限/);
  assert.throws(() => validateTranslationPayload({ kind: 'translate_annotations', sources: Array.from({ length: 21 }, (_, index) => ({
    id: index.toString(16).padStart(16, '0'), original: 'English text to translate.'
  })) }), /条目数超出范围/);
  assert.throws(() => validateTranslationPayload({ kind: 'translate_annotations', sources: [
    { id: '0123456789abcdef', original: 'x'.repeat(12001) }
  ] }), /单条外文摘录过长/);
  assert.throws(() => validateTranslationPayload({ kind: 'translate_metadata', fields: [
    { id: '0123456789abcdef', original: 'x'.repeat(MAX_TRANSLATION_BLOCK_CHARS + 1), preserveOriginal: false }
  ] }), /超过长度上限/);
});

test('translation CLI passes the optional model locally and exposes only known safe failure guidance', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'translation-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'codex-failure');
  const capture = join(dir, 'args.txt');
  const script = stderrText => {
    const quoted = `'${stderrText.replaceAll("'", "'\\''")}'`;
    return `#!/bin/sh\nprintf '%s\\n' "$@" > "$MODEL_ARGS_CAPTURE"\nprintf '%s\\n' ${quoted} >&2\nexit 1\n`;
  };
  const oldCodex = process.env.ZOTERO_WORKBENCH_CODEX;
  const oldModel = process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL;
  const oldCapture = process.env.MODEL_ARGS_CAPTURE;
  process.env.ZOTERO_WORKBENCH_CODEX = executable;
  process.env.MODEL_ARGS_CAPTURE = capture;
  t.after(() => {
    if (oldCodex === undefined) delete process.env.ZOTERO_WORKBENCH_CODEX;
    else process.env.ZOTERO_WORKBENCH_CODEX = oldCodex;
    if (oldModel === undefined) delete process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL;
    else process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL = oldModel;
    if (oldCapture === undefined) delete process.env.MODEL_ARGS_CAPTURE;
    else process.env.MODEL_ARGS_CAPTURE = oldCapture;
  });
  const payload = { kind: 'translate', blocks: [{ id: 'p1-b1', original: 'An English paragraph to translate.', preserveOriginal: false }] };
  const job = { status: 'running' };

  process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL = 'gpt-5.4-codex';
  await writeFile(executable, script("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."), { mode: 0o700 });
  await chmod(executable, 0o700);
  await assert.rejects(runTranslationWorker({ job, payload, scratch: join(dir, 'known') }), /Codex ChatGPT 账号不支持/);
  const configuredArgs = (await readFile(capture, 'utf8')).trim().split('\n');
  assert.deepEqual(configuredArgs.slice(0, 4), ['exec', '--model', 'gpt-5.4-codex', '--ephemeral']);

  delete process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL;
  await writeFile(executable, script('secret CLI diagnostic /private/user/path'), { mode: 0o700 });
  await chmod(executable, 0o700);
  await assert.rejects(runTranslationWorker({ job, payload, scratch: join(dir, 'unknown'), model: null }), error => {
    assert.match(error.message, /Codex 模型翻译失败/);
    assert.doesNotMatch(error.message, /secret CLI diagnostic|private\/user\/path/);
    return true;
  });
  const defaultArgs = (await readFile(capture, 'utf8')).trim().split('\n');
  assert.equal(defaultArgs.includes('--model'), false, 'the adapter must not set a model by default');

  await writeFile(join(dir, 'research-settings.json'), JSON.stringify({ model: 'shared-test-model' }));
  await assert.rejects(runTranslationWorker({
    job, payload, scratch: join(dir, 'shared-settings'), stateRoot: dir
  }), /Codex 模型翻译失败/);
  const sharedArgs = (await readFile(capture, 'utf8')).trim().split('\n');
  assert.deepEqual(sharedArgs.slice(0, 4), ['exec', '--model', 'shared-test-model', '--ephemeral']);
});
