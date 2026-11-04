import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localAuthKeyFile } from '../src/transports/local-auth.mjs';

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'zotero-local-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('uses the configured state root, secures it, and leaves a missing keyfile to ZoteroClient', async t => {
  const parent = await tempRoot(t);
  const stateRoot = join(parent, 'configured');
  const keyFile = await localAuthKeyFile({ env: { ZOTERO_WORKBENCH_STATE_DIR: stateRoot } });

  assert.equal(keyFile, join(await realpath(stateRoot), 'zotero-api-keys.json'));
  assert.equal((await lstat(stateRoot)).mode & 0o777, 0o700);
  await assert.rejects(lstat(keyFile), { code: 'ENOENT' });
});

test('defaults beneath the supplied home directory', async t => {
  const homeDirectory = await tempRoot(t);
  const keyFile = await localAuthKeyFile({ env: {}, homeDirectory });

  const expectedRoot = join(homeDirectory, '.local', 'share', 'zotero-workbench');
  assert.equal(keyFile, join(await realpath(expectedRoot), 'zotero-api-keys.json'));
  assert.equal((await lstat(expectedRoot)).mode & 0o777, 0o700);
});

test('tightens an existing regular keyfile without changing or reading its contents', async t => {
  const stateRoot = await tempRoot(t);
  const keyFile = join(stateRoot, 'zotero-api-keys.json');
  const fixture = '{"fixture-server-id":"fixture-key"}\n';
  await writeFile(keyFile, fixture, { mode: 0o644 });
  await chmod(keyFile, 0o644);

  assert.equal(await localAuthKeyFile({ env: { ZOTERO_WORKBENCH_STATE_DIR: stateRoot } }), await realpath(keyFile));
  if (process.platform !== 'win32') assert.equal((await lstat(keyFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(keyFile, 'utf8'), fixture);
});

test('rejects a symlinked state root', async t => {
  const parent = await tempRoot(t);
  const realRoot = join(parent, 'real');
  const linkRoot = join(parent, 'linked');
  await mkdir(realRoot);
  try {
    await symlink(realRoot, linkRoot, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('symlinks are unavailable');
    throw error;
  }

  await assert.rejects(localAuthKeyFile({ env: { ZOTERO_WORKBENCH_STATE_DIR: linkRoot } }), /state root must be a real directory/);
});

test('rejects symlink and non-regular existing keyfiles', async t => {
  const parent = await tempRoot(t);
  const stateRoot = join(parent, 'state');
  const target = join(parent, 'outside.json');
  await mkdir(stateRoot);
  await writeFile(target, '{"untouched":"fixture"}');
  const keyFile = join(stateRoot, 'zotero-api-keys.json');

  try {
    await symlink(target, keyFile, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('symlinks are unavailable');
    throw error;
  }
  await assert.rejects(localAuthKeyFile({ env: { ZOTERO_WORKBENCH_STATE_DIR: stateRoot } }), /key file must be a regular file/);
  await rm(keyFile);

  await mkdir(keyFile);
  await assert.rejects(localAuthKeyFile({ env: { ZOTERO_WORKBENCH_STATE_DIR: stateRoot } }), /key file must be a regular file/);
});
