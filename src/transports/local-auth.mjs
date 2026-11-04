import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const KEY_FILE_NAME = 'zotero-api-keys.json';

function refusal(reason) {
  return new Error(`Refusing Zotero local authorization path: ${reason}`);
}

async function setPrivateDirectoryMode(directory) {
  if (constants.O_DIRECTORY && constants.O_NOFOLLOW) {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) throw refusal('state root is not a directory');
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    return;
  }

  // Windows does not expose O_DIRECTORY/O_NOFOLLOW. Check both sides of chmod;
  // POSIX hosts use the descriptor-based path above.
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) throw refusal('state root is not a real directory');
  await chmod(directory, 0o700);
  const after = await lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory()) throw refusal('state root changed while securing it');
}

async function secureExistingKeyFile(filePath) {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw refusal('key file must be a regular file, not a symlink');

  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0);
  const handle = await open(filePath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw refusal('key file changed while opening it');
    // Do not read the contents here. ZoteroClient owns loading and storing keys,
    // and persists only when Zotero explicitly returns remember=true.
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/**
 * Prepare and return this plugin's Zotero Local API keyfile path.
 * This function never reads, creates, migrates, or prints key material.
 */
export async function localAuthKeyFile({ env = process.env, homeDirectory = homedir() } = {}) {
  const configuredRoot = env?.ZOTERO_WORKBENCH_STATE_DIR;
  const requestedRoot = resolve(configuredRoot || join(homeDirectory, '.local', 'share', 'zotero-workbench'));

  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw refusal('state root must be a real directory');

  const stateRoot = await realpath(requestedRoot);
  await setPrivateDirectoryMode(stateRoot);

  const keyFile = join(stateRoot, KEY_FILE_NAME);
  await secureExistingKeyFile(keyFile);
  return keyFile;
}
