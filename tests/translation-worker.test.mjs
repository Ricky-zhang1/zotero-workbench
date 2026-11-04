import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_TRANSLATION_BLOCK_CHARS, buildTranslationBlocks, requiresTranslation, runTranslationWorker,
  validateTranslationOutput, validateTranslationPayload
} from '../src/domain/translation-worker.mjs';

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

test('Chinese prose and symbol-only blocks can be explicit pass-through while mixed source remains translatable', () => {
  assert.equal(requiresTranslation('制度安排影响地方行动者的选择。'), false);
  assert.equal(requiresTranslation('∑ xᵢ = 0; 2024–2026'), false);
  assert.equal(requiresTranslation('中文解释；however, institutions shape actual outcomes.'), true);
  assert.equal(requiresTranslation('制度的配置が地方の選択を変える。'), true);
  assert.equal(requiresTranslation('조직의 자원 배분은 교사의 선택을 바꾼다.'), true);
  assert.equal(requiresTranslation('Институциональные условия меняют решения местных акторов.'), true);
  assert.equal(requiresTranslation('تؤثر المؤسسات في اختيارات الفاعلين المحليين.'), true);
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
