import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createResearchTestGate,
  parseFixtureTheme,
  parseResearchTestOptions,
  RESEARCH_TEST_ITEM,
} from '../scripts/dev-codex-host-policy.mjs';

test('fixture theme defaults to light and accepts only one explicit light or dark value', () => {
  assert.equal(parseFixtureTheme([]), 'light');
  assert.equal(parseFixtureTheme(['--theme', 'dark']), 'dark');
  assert.equal(parseFixtureTheme(['--theme', 'light']), 'light');
  assert.throws(() => parseFixtureTheme(['--theme']), /需要 light 或 dark/);
  assert.throws(() => parseFixtureTheme(['--theme', 'sepia']), /只接受 light 或 dark/);
  assert.throws(() => parseFixtureTheme(['--theme', 'dark', '--theme', 'light']), /不能重复/);
});

test('research-test flags require one explicit legal Zotero key and a private absolute state directory', () => {
  assert.equal(parseResearchTestOptions(['--port', '4173']), null);
  assert.deepEqual(parseResearchTestOptions([
    '--research-test-item', RESEARCH_TEST_ITEM,
    '--research-state-dir', join(homedir(), '.local/share/zotero-workbench/research-test-archive'),
  ]), {
    itemKey: RESEARCH_TEST_ITEM,
    stateDir: join(homedir(), '.local/share/zotero-workbench/research-test-archive'),
  });
  const customPolicy = parseResearchTestOptions([
    '--research-test-item', 'A1B2C3D4',
    '--research-state-dir', join(homedir(), '.local/share/zotero-workbench/another-test-archive'),
  ]);
  assert.deepEqual(customPolicy, {
    itemKey: 'A1B2C3D4',
    stateDir: join(homedir(), '.local/share/zotero-workbench/another-test-archive'),
  });
  const customGate = createResearchTestGate(customPolicy);
  assert.doesNotThrow(() => customGate.assertStart({ kind: 'fold', library: 'user', key: 'A1B2C3D4' }));
  assert.throws(() => customGate.assertStart({ kind: 'fold', library: 'user', key: RESEARCH_TEST_ITEM }), /只允许/);
  assert.throws(() => parseResearchTestOptions(['--research-test-item', RESEARCH_TEST_ITEM]), /同时提供绝对路径/);
  assert.throws(() => parseResearchTestOptions(['--research-state-dir', '/tmp/archive']), /必须与显式/);
  for (const invalidKey of ['ABCDEFG', 'ABCDEFGH9', 'test0001', 'TEST-001', 'TEST000!']) {
    assert.throws(() => parseResearchTestOptions([
      '--research-test-item', invalidKey,
      '--research-state-dir', join(homedir(), '.local/share/zotero-workbench/research-test-archive'),
    ]), /8 位大写字母或数字/);
  }
  assert.throws(() => parseResearchTestOptions([
    '--research-test-item', RESEARCH_TEST_ITEM, '--research-state-dir', '/tmp/research-test-archive',
  ]), /本机私有目录/);
  assert.throws(() => parseResearchTestOptions([
    '--research-test-item', RESEARCH_TEST_ITEM, '--research-state-dir', 'relative/archive',
  ]), /绝对路径/);
  assert.throws(() => parseResearchTestOptions([
    '--research-test-item', RESEARCH_TEST_ITEM, '--research-test-item', RESEARCH_TEST_ITEM,
    '--research-state-dir', join(homedir(), '.local/share/zotero-workbench/research-test-archive'),
  ]), /不能重复/);
  assert.throws(() => parseResearchTestOptions([
    '--research-test-item', RESEARCH_TEST_ITEM,
    '--research-state-dir', join(homedir(), '.local/share/zotero-workbench/../../outside'),
  ]), /本机私有目录/);
});

test('fixture defaults to denying AI, then permits only fold/translate for the named item', () => {
  const denied = createResearchTestGate(null);
  assert.throws(() => denied.assertStart({ kind: 'fold', key: RESEARCH_TEST_ITEM }), /默认阻止/);

  const gate = createResearchTestGate({ itemKey: RESEARCH_TEST_ITEM, stateDir: '/tmp/archive' });
  for (const kind of ['fold', 'translate'])
    assert.doesNotThrow(() => gate.assertStart({ kind, library: 'user', key: RESEARCH_TEST_ITEM }));
  assert.throws(() => gate.assertStart({ kind: 'draft', library: 'user', key: RESEARCH_TEST_ITEM }), /只允许/);
  assert.throws(() => gate.assertStart({ kind: 'fold', library: 'user', key: 'OTHER001' }), /只允许/);
  assert.throws(() => gate.assertStart({ kind: 'fold', library: 'user', keys: [RESEARCH_TEST_ITEM] }), /只允许/);
  assert.throws(() => gate.assertStart({ kind: 'translate', library: 'g1', key: RESEARCH_TEST_ITEM }), /只允许个人文库/);
  assert.throws(() => gate.assertStart({ kind: 'translate_annotations', library: 'user', keys: [RESEARCH_TEST_ITEM, 'OTHER001'] }), /只允许/);
});

test('annotation translation is capped to the dedicated item and leaves source membership to backend re-read', () => {
  const gate = createResearchTestGate({ itemKey: RESEARCH_TEST_ITEM, stateDir: '/tmp/archive' });
  const sourceIds = ['a'.repeat(16), 'b'.repeat(16)];
  const sourceVersions = Object.fromEntries(sourceIds.map(id => [id, 'c'.repeat(64)]));
  const args = {
    kind: 'translate_annotations', library: 'user', keys: [RESEARCH_TEST_ITEM], sourceIds, sourceVersions,
  };
  assert.doesNotThrow(() => gate.assertStart(args));
  const twentyIds = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(16, '0'));
  assert.doesNotThrow(() => gate.assertStart({
    ...args,
    sourceIds: twentyIds,
    sourceVersions: Object.fromEntries(twentyIds.map(id => [id, 'c'.repeat(64)])),
  }));
  assert.throws(() => gate.assertStart({ ...args, keys: [RESEARCH_TEST_ITEM, 'OTHER001'] }), /只允许/);
  const twentyOneIds = [...twentyIds, 'f'.repeat(16)];
  assert.throws(() => gate.assertStart({
    ...args,
    sourceIds: twentyOneIds,
    sourceVersions: Object.fromEntries(twentyOneIds.map(id => [id, 'c'.repeat(64)])),
  }), /只允许/);
  assert.throws(() => gate.assertStart({ ...args, sourceVersions: { [sourceIds[0]]: 'c'.repeat(64) } }), /只允许/);
});

test('fixture can cancel only a valid research job id received from its own successful start response', () => {
  const gate = createResearchTestGate({ itemKey: RESEARCH_TEST_ITEM, stateDir: '/tmp/archive' });
  const ownId = '1'.repeat(24);
  const otherId = '2'.repeat(24);
  assert.throws(() => gate.assertCancel({ id: ownId }), /只允许取消/);
  assert.equal(gate.rememberStart({ structuredContent: { id: ownId } }), ownId);
  assert.doesNotThrow(() => gate.assertCancel({ id: ownId }));
  assert.throws(() => gate.assertCancel({ id: otherId }), /只允许取消/);
  assert.equal(gate.rememberStart({ isError: true, structuredContent: { id: otherId } }), null);
  assert.throws(() => gate.assertCancel({ id: otherId }), /只允许取消/);
});
