import { homedir } from 'node:os';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const RESEARCH_TEST_ITEM = 'TEST0001';
export const ANNOTATION_TEST_KEY = 'TEST0001';
export const ANNOTATION_TEST_ATTACHMENT = 'PDFTEST1';
const PRIVATE_STATE_ROOT = resolve(homedir(), '.local/share/zotero-workbench');
const ZOTERO_ITEM_KEY = /^[A-Z0-9]{8}$/;
const JOB_ID = /^[a-f0-9]{24}$/;
const SOURCE_ID = /^[a-f0-9]{16}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export function parseFixtureTheme(argv) {
  let theme = 'light';
  let found = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--theme') continue;
    if (found) throw new Error('--theme 不能重复。');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--theme 需要 light 或 dark。');
    if (value !== 'light' && value !== 'dark') throw new Error('--theme 只接受 light 或 dark。');
    theme = value;
    found = true;
    index += 1;
  }
  return theme;
}

export function parseResearchTestOptions(argv) {
  let itemKey = null;
  let stateDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--research-test-item' && flag !== '--research-state-dir') continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个参数。`);
    if (flag === '--research-test-item') {
      if (itemKey !== null) throw new Error('--research-test-item 不能重复。');
      itemKey = value;
    } else {
      if (stateDir !== null) throw new Error('--research-state-dir 不能重复。');
      stateDir = value;
    }
    index += 1;
  }

  if (itemKey === null && stateDir === null) return null;
  if (itemKey === null) throw new Error('--research-state-dir 必须与显式 --research-test-item 一起提供。');
  if (!ZOTERO_ITEM_KEY.test(itemKey)) throw new Error('--research-test-item 必须是 8 位大写字母或数字 Zotero key。');
  if (stateDir === null || !isAbsolute(stateDir))
    throw new Error('--research-test-item 必须同时提供绝对路径 --research-state-dir。');
  const resolvedStateDir = resolve(stateDir);
  const stateRelativePath = relative(PRIVATE_STATE_ROOT, resolvedStateDir);
  if (!stateRelativePath || stateRelativePath === '..' || stateRelativePath.startsWith(`..${sep}`) || isAbsolute(stateRelativePath))
    throw new Error(`--research-state-dir 必须位于本机私有目录 ${PRIVATE_STATE_ROOT} 内，并使用独立子目录。`);
  return { itemKey, stateDir: resolvedStateDir };
}

export function parseAnnotationTestOptions(argv) {
  let annotationKey = null;
  let attachmentKey = null;
  let stateDir = null;
  const flags = new Map([
    ['--annotation-test-key', 'annotationKey'],
    ['--annotation-test-attachment', 'attachmentKey'],
    ['--annotation-test-state-dir', 'stateDir'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const field = flags.get(argv[index]);
    if (!field) continue;
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个参数。`);
    if (field === 'annotationKey') {
      if (annotationKey !== null) throw new Error('--annotation-test-key 不能重复。');
      annotationKey = value;
    } else if (field === 'attachmentKey') {
      if (attachmentKey !== null) throw new Error('--annotation-test-attachment 不能重复。');
      attachmentKey = value;
    } else {
      if (stateDir !== null) throw new Error('--annotation-test-state-dir 不能重复。');
      stateDir = value;
    }
    index += 1;
  }

  if (annotationKey === null && attachmentKey === null && stateDir === null) return null;
  if (annotationKey === null || attachmentKey === null || stateDir === null)
    throw new Error('--annotation-test-key、--annotation-test-attachment 与 --annotation-test-state-dir 必须一起提供。');
  if (!ZOTERO_ITEM_KEY.test(annotationKey)) throw new Error('--annotation-test-key 必须是 8 位大写字母或数字 Zotero key。');
  if (!ZOTERO_ITEM_KEY.test(attachmentKey)) throw new Error('--annotation-test-attachment 必须是 8 位大写字母或数字 Zotero key。');
  if (!isAbsolute(stateDir)) throw new Error('--annotation-test-state-dir 必须是绝对路径。');
  const resolvedStateDir = resolve(stateDir);
  const stateRelativePath = relative(PRIVATE_STATE_ROOT, resolvedStateDir);
  if (!stateRelativePath || stateRelativePath === '..' || stateRelativePath.startsWith(`..${sep}`) || isAbsolute(stateRelativePath))
    throw new Error(`--annotation-test-state-dir 必须位于本机私有目录 ${PRIVATE_STATE_ROOT} 内，并使用独立子目录。`);
  return { annotationKey, attachmentKey, stateDir: resolvedStateDir };
}

async function preparePrivateStateDir(policy, label) {
  if (!policy) return;
  const stateRelativePath = relative(PRIVATE_STATE_ROOT, policy.stateDir);
  if (!stateRelativePath || stateRelativePath === '..' || stateRelativePath.startsWith(`..${sep}`) || isAbsolute(stateRelativePath))
    throw new Error(`${label}必须位于本机私有目录 ${PRIVATE_STATE_ROOT} 内。`);

  let current = resolve(homedir());
  const homeStat = await lstat(current);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink())
    throw new Error('研究测试缓存必须位于本机用户目录中。');

  for (const segment of ['.local', 'share', 'zotero-workbench', ...stateRelativePath.split(sep)]) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('研究测试缓存路径不能经过符号链接或非目录。');
  }
  const state = await lstat(policy.stateDir);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error('研究测试缓存必须是本机私有普通目录，不能使用符号链接。');
  await chmod(policy.stateDir, 0o700);
}

export async function prepareResearchTestStateDir(policy) {
  return preparePrivateStateDir(policy, '研究测试缓存');
}

export async function prepareAnnotationTestStateDir(policy) {
  return preparePrivateStateDir(policy, '批注备注测试缓存');
}

export function createAnnotationTestGate(policy) {
  const expectedReadKeys = ['annotationKey', 'attachmentKey', 'library'];
  const expectedUpdateKeys = ['annotationKey', 'attachmentKey', 'comment', 'editToken', 'expectedComment', 'expectedVersion', 'library'];

  function assertIdentity(args = {}, expectedKeys) {
    if (!policy) throw new Error('Fixture 默认阻止批注备注读取与写入。');
    const keys = Object.keys(args).sort();
    if (keys.join(',') !== [...expectedKeys].sort().join(','))
      throw new Error('批注备注参数必须严格符合 fixture 身份与版本保护字段。');
    if (args.library !== 'user' || args.annotationKey !== policy.annotationKey || args.attachmentKey !== policy.attachmentKey)
      throw new Error(`Fixture 只允许个人文库 ${policy.annotationKey}/${policy.attachmentKey}。`);
  }

  function assertRead(args = {}) {
    assertIdentity(args, expectedReadKeys);
  }

  function assertUpdate(args = {}) {
    assertIdentity(args, expectedUpdateKeys);
    if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0)
      throw new Error('批注备注更新必须提供有效 expectedVersion。');
    if (typeof args.expectedComment !== 'string' || args.expectedComment.length > 20_000 ||
        typeof args.comment !== 'string' || args.comment.length > 20_000)
      throw new Error('批注备注更新必须提供有效的旧、新 comment 文本。');
    if (typeof args.editToken !== 'string' || !/^[a-f0-9]{48}$/.test(args.editToken))
      throw new Error('批注备注更新必须携带有效的短期 editToken。');
  }

  return { assertRead, assertUpdate };
}

export function createResearchTestGate(policy) {
  const startedJobIds = new Set();

  function assertStart(args = {}) {
    if (!policy) throw new Error('Fixture 默认阻止 AI 研究任务。');
    const library = args.library ?? 'user';
    if (library !== 'user') throw new Error(`Fixture 只允许个人文库测试项 ${policy.itemKey}。`);

    if (args.kind === 'fold' || args.kind === 'translate') {
      if (args.key !== policy.itemKey || args.keys !== undefined ||
          args.sourceIds !== undefined || args.sourceVersions !== undefined)
        throw new Error(`Fixture 只允许 ${policy.itemKey} 的 ${args.kind} 任务。`);
      return;
    }

    if (args.kind === 'translate_metadata') {
      if (args.key !== policy.itemKey || args.keys !== undefined ||
          args.sourceIds !== undefined || args.sourceVersions !== undefined ||
          Object.keys(args).some(key => !['kind', 'library', 'key'].includes(key)))
        throw new Error(`Fixture 只允许 ${policy.itemKey} 的元数据翻译任务。`);
      return;
    }

    if (args.kind === 'translate_annotations') {
      const ids = args.sourceIds;
      const versions = args.sourceVersions;
      if (args.key !== undefined || !Array.isArray(args.keys) || args.keys.length !== 1 ||
          args.keys[0] !== policy.itemKey || !Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
          ids.some(id => typeof id !== 'string' || !SOURCE_ID.test(id)) || new Set(ids).size !== ids.length ||
          !versions || typeof versions !== 'object' || Array.isArray(versions) ||
          Object.keys(versions).length !== ids.length || ids.some(id => typeof versions[id] !== 'string' || !FINGERPRINT.test(versions[id])))
        throw new Error(`Fixture 只允许 ${policy.itemKey} 的 1–20 条已标注来源翻译；来源归属仍由后端重读核验。`);
      return;
    }

    throw new Error('Fixture 只允许 fold、translate、translate_metadata 或 translate_annotations 研究测试任务。');
  }

  function rememberStart(result) {
    const id = result?.structuredContent?.id;
    if (result?.isError !== true && typeof id === 'string' && JOB_ID.test(id)) {
      startedJobIds.add(id);
      return id;
    }
    return null;
  }

  function assertCancel(args = {}) {
    if (!policy || typeof args.id !== 'string' || !startedJobIds.has(args.id))
      throw new Error('Fixture 只允许取消本宿主此次启动并记录的研究任务。');
  }

  return { assertStart, rememberStart, assertCancel, startedJobIds };
}
