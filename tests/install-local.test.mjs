import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installerSource = join(projectRoot, 'scripts/install-local.py');

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function fixture(t, { marketplaceName = 'local plugins', initialLegacy = true, psBody } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'zotero installer with spaces-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'Home With Spaces');
  const source = join(temp, 'Maintained Source');
  const bin = join(temp, 'bin');
  const scripts = join(source, 'scripts');
  const agentPlugins = join(home, '.agents/plugins');
  await Promise.all([
    mkdir(scripts, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(agentPlugins, { recursive: true })
  ]);

  await writeFile(join(scripts, 'install-local.py'), await readFile(installerSource));
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'zotero-workbench', version: '0.14.0' }));
  await writeFile(join(source, 'mcp.json'), JSON.stringify({ mcpServers: {
    'zotero-workbench': { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/src/server.mjs'], env: {} }
  } }));
  const legacyPath = join(source, '.mcp.json');
  const legacyBefore = initialLegacy ? Buffer.from('{"before":"legacy"}\n') : null;
  if (legacyBefore) await writeFile(legacyPath, legacyBefore);

  const marketplacePath = join(agentPlugins, 'marketplace.json');
  const marketplaceBefore = Buffer.from(JSON.stringify({ name: marketplaceName, plugins: [] }, null, 2) + '\n');
  await writeFile(marketplacePath, marketplaceBefore);

  const nodePath = join(bin, 'node-stub');
  const codexPath = join(bin, 'codex-stub');
  const codexMarker = join(temp, 'codex-called');
  const psPath = join(bin, 'ps-stub');
  await writeFile(nodePath, '#!/bin/sh\nprintf "24\\n"\n');
  await writeFile(codexPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shQuote(codexMarker)}\nexit 0\n`);
  await writeFile(psPath, psBody ?? '#!/bin/sh\nexit 0\n');
  await Promise.all([nodePath, codexPath, psPath].map(path => chmod(path, 0o755)));

  const cacheRoot = join(home, '.codex/plugins/cache', marketplaceName, 'zotero-workbench');
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
  };
  function runInstaller(extraArgs = []) {
    return spawnSync(process.env.PYTHON ?? 'python3', [
      join(scripts, 'install-local.py'), '--marketplace-file', marketplacePath,
      '--node', nodePath, '--codex', codexPath, '--ps', psPath, ...extraArgs
    ], { encoding: 'utf8', env });
  }
  async function exists(path) {
    try { await access(path); return true; } catch { return false; }
  }
  return { home, source, temp, marketplacePath, marketplaceBefore, legacyPath, legacyBefore,
    codexMarker, cacheRoot, runInstaller, exists };
}

test('dry-run detects a live plugin process by exact cache path even when the cache is gone', async t => {
  const f = await fixture(t);
  const body = `#!/bin/sh\nprintf '%s\\n' '4321 node ${f.cacheRoot}/0.13.1/src/server.mjs'\n`;
  await writeFile(join(f.temp, 'bin/ps-stub'), body);
  const result = f.runInstaller(['--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.blocked, true);
  assert.equal(report.runningServers[0].pid, '4321');
  assert.equal(report.runningServers[0].version, '0.13.1');
  assert.match(report.runningServers[0].cachePath, /Home With Spaces/);
  assert.deepEqual(await readFile(f.marketplacePath), f.marketplaceBefore);
  assert.deepEqual(await readFile(f.legacyPath), f.legacyBefore);
  assert.equal(await f.exists(f.codexMarker), false);

  const installAttempt = f.runInstaller();
  assert.equal(installAttempt.status, 2);
  const installReport = JSON.parse(installAttempt.stdout.trim());
  assert.equal(installReport.blocked, true);
  assert.deepEqual(await readFile(f.marketplacePath), f.marketplaceBefore);
  assert.deepEqual(await readFile(f.legacyPath), f.legacyBefore);
  assert.equal(await f.exists(join(f.home, '.codex/backups')), false);
  assert.equal(await f.exists(f.codexMarker), false);
});

test('a live process for the target cache version also blocks a same-version replacement', async t => {
  const f = await fixture(t);
  await writeFile(join(f.temp, 'bin/ps-stub'),
    `#!/bin/sh\nprintf '%s\\n' '4324 node ${f.cacheRoot}/0.14.0/src/server.mjs'\n`);
  const result = f.runInstaller(['--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.blocked, true);
  assert.equal(report.runningServers[0].version, '0.14.0');
});

test('a process from a similarly named but different marketplace does not block', async t => {
  const f = await fixture(t, { marketplaceName: 'local', psBody: '#!/bin/sh\n' });
  await writeFile(join(f.temp, 'bin/ps-stub'),
    `#!/bin/sh\nprintf '%s\\n' '4322 node ${join(f.home, '.codex/plugins/cache/local-archive/zotero-workbench/0.13.1/src/server.mjs')}'\n`);
  const result = f.runInstaller(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.blocked, false);
  assert.deepEqual(report.runningServers, []);
  assert.deepEqual(await readFile(f.marketplacePath), f.marketplaceBefore);
  assert.deepEqual(await readFile(f.legacyPath), f.legacyBefore);
});

test('when no matching cache process is active, installation reaches the Codex CLI', async t => {
  const f = await fixture(t, { psBody: '#!/bin/sh\n' });
  const result = f.runInstaller();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.install_exit, 0);
  assert.equal(await f.exists(f.codexMarker), true);
  assert.notDeepEqual(await readFile(f.marketplacePath), f.marketplaceBefore);
  assert.notDeepEqual(await readFile(f.legacyPath), f.legacyBefore);
});

test('ps failure fails closed before any configuration or backup write', async t => {
  const f = await fixture(t, { psBody: '#!/bin/sh\necho "permission denied" >&2\nexit 1\n' });
  const result = f.runInstaller();
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.blocked, true);
  assert.match(report.reason, /Cannot check running Zotero Workbench processes with ps/);
  assert.match(report.reason, /permission denied/);
  assert.deepEqual(await readFile(f.marketplacePath), f.marketplaceBefore);
  assert.deepEqual(await readFile(f.legacyPath), f.legacyBefore);
  assert.equal(await f.exists(f.codexMarker), false);
  assert.equal(await f.exists(join(f.home, '.codex/backups')), false);
});

test('second process check rolls back only installer writes when a session appears during preparation', async t => {
  for (const initialLegacy of [true, false]) {
    const f = await fixture(t, { initialLegacy, psBody: '#!/bin/sh\n' });
    const countPath = join(f.temp, 'ps-count');
    const oldServer = `4323 node ${f.cacheRoot}/0.13.2/src/server.mjs`;
    const body = `#!/bin/sh\ncount=0\n[ -f ${shQuote(countPath)} ] && count=$(cat ${shQuote(countPath)})\ncount=$((count+1))\nprintf '%s' "$count" > ${shQuote(countPath)}\nif [ "$count" -eq 1 ]; then exit 0; fi\nprintf '%s\\n' ${shQuote(oldServer)}\n`;
    await writeFile(join(f.temp, 'bin/ps-stub'), body);

    const result = f.runInstaller();
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.blocked, true);
    assert.equal(report.runningServers[0].pid, '4323');
    assert.deepEqual(report.configurationRestored, { marketplace: true, mcp: true });
    assert.deepEqual(await readFile(f.marketplacePath), f.marketplaceBefore);
    if (initialLegacy) assert.deepEqual(await readFile(f.legacyPath), f.legacyBefore);
    else assert.equal(await f.exists(f.legacyPath), false);
    assert.equal(await f.exists(f.codexMarker), false);
  }
});
