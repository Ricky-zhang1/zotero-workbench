#!/usr/bin/env python3
"""Register this source directory in a local Codex marketplace, with private backups.

Does not relocate source, change unrelated plugin settings, or normalize global
configuration. Run from the source folder you intend to maintain.
"""
from pathlib import Path
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--marketplace-file', type=Path, default=Path.home()/'.agents/plugins/marketplace.json')
parser.add_argument('--codex', default=shutil.which('codex'))
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--ps', default=shutil.which('ps'))
parser.add_argument('--dry-run', action='store_true')
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
marketplace = args.marketplace_file.expanduser().resolve()
if not args.node or not args.codex:
    raise SystemExit('Node.js 24+ and Codex CLI are required; use --node / --codex to select installed runtimes.')
major = int(subprocess.check_output([args.node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip())
if major < 24:
    raise SystemExit('Node.js 24+ is required.')
market_before = marketplace.read_bytes()
market = json.loads(market_before)
if not market.get('name') or not isinstance(market.get('plugins'), list):
    raise SystemExit('Choose an existing valid local marketplace file.')
name = json.loads((source/'package.json').read_text())['name']
if name != 'zotero-workbench':
    raise SystemExit('Unexpected plugin identity.')
base = marketplace.parents[2]
relative = './'+os.path.relpath(source, base)
existing = next((p for p in market['plugins'] if p.get('name') == name), None)
if existing:
    owner = existing.get('source', {})
    if owner.get('source') != 'local' or (base/owner.get('path','')).resolve() != source:
        raise SystemExit('This marketplace entry belongs to another source. Run the installer from that owning source.')
else:
    market['plugins'].append({'name':name, 'source':{'source':'local','path':relative},
        'policy':{'installation':'AVAILABLE','authentication':'ON_INSTALL'}, 'category':'Research',
        'description':'Zotero library, PDF reading, citations and human–Agent collaboration.'})
legacy_path = source/'.mcp.json'
legacy_before = legacy_path.read_bytes() if legacy_path.exists() else None
portable = json.loads((source/'mcp.json').read_text())
server = portable['mcpServers'][name]
server.pop('type', None)
server['command'] = args.node
server['args'] = [str(source/'src/server.mjs')]
legacy = {'mcpServers':{name:server}}
market_after = (json.dumps(market,ensure_ascii=False,indent=2)+'\n').encode()
legacy_after = (json.dumps(legacy,ensure_ascii=False,indent=2)+'\n').encode()
selector = name+'@'+market['name']

def running_cached_servers():
    """Find live MCP processes whose versioned cache belongs to this plugin."""
    if not args.ps:
        raise RuntimeError('Cannot check running Zotero Workbench processes: ps was not found.')
    try:
        result = subprocess.run([args.ps, '-axo', 'pid=,command='], text=True,
            capture_output=True, check=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as error:
        detail = getattr(error, 'stderr', None)
        detail = detail.strip() if isinstance(detail, str) and detail.strip() else str(error)
        raise RuntimeError(f'Cannot check running Zotero Workbench processes with ps; refusing install: {detail}') from error
    cache_root = Path.home()/'.codex/plugins/cache'/market['name']/name
    # Match the complete marketplace/plugin cache path, including spaces. Do
    # not require the version directory to exist: a live process can outlast
    # Codex removing its files during an upgrade.
    pattern = re.compile(r'(?:^|\s)["\']?'+re.escape(str(cache_root)+os.sep)+
        r'([^/\s"\']+)'+re.escape(os.sep)+'src'+re.escape(os.sep)+
        r'server\.mjs(?=$|[\s"\'])')
    servers = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        match = pattern.search(fields[1])
        if match:
            version = match.group(1)
            servers.append({'pid': fields[0], 'version': version,
                'cachePath': str(cache_root/version)})
    return servers

def check_for_live_servers():
    try:
        servers = running_cached_servers()
    except RuntimeError as error:
        return {'blocked': True, 'reason': str(error), 'runningServers': []}
    if servers:
        return {'blocked': True,
            'reason': 'Codex still has Zotero Workbench MCP processes using versioned plugin cache. Fully quit Codex and rerun the installer; processes were not stopped.',
            'runningServers': servers}
    return {'blocked': False, 'runningServers': []}

def report_blocked(check):
    print(json.dumps({'source':str(source),'pluginId':selector, **check},ensure_ascii=False))
    raise SystemExit(2)

def restore_if_unchanged(path, before, written):
    """Restore only our own write; preserve a concurrent edit if it differs."""
    current = path.read_bytes() if path.exists() else None
    if current != written:
        return False
    if before is None:
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(before)
    return True

# First check is read-only and happens before backup or configuration writes.
first_check = check_for_live_servers()
if first_check['blocked']:
    report_blocked(first_check)
if args.dry_run:
    print(json.dumps({'source':str(source),'pluginId':selector,
        'marketplaceChanged':market_after!=market_before,'node':args.node,
        'codex':args.codex, **first_check},ensure_ascii=False))
    raise SystemExit(0)
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
backup = Path.home()/'.codex/backups'/('zotero-workbench-'+stamp)
backup.mkdir(parents=True,mode=0o700)
os.chmod(backup,0o700)
for label,data in [('marketplace.json',market_before),('mcp.json',legacy_before)]:
    if data is not None:
        path=backup/label;path.write_bytes(data);os.chmod(path,0o600)
if marketplace.read_bytes()!=market_before or (legacy_path.read_bytes() if legacy_path.exists() else None)!=legacy_before:
    raise SystemExit('Configuration changed while preparing install; no settings changed.')
marketplace.write_bytes(market_after)
legacy_path.write_bytes(legacy_after)
# Recheck immediately before Codex may replace the versioned cache. If a new
# session started during preparation, roll back only values still matching our
# writes and leave any concurrent edits untouched.
second_check = check_for_live_servers()
if second_check['blocked']:
    marketplace_restored = restore_if_unchanged(marketplace, market_before, market_after)
    legacy_restored = restore_if_unchanged(legacy_path, legacy_before, legacy_after)
    second_check['configurationRestored'] = {
        'marketplace': marketplace_restored, 'mcp': legacy_restored}
    report_blocked(second_check)
result = subprocess.run([args.codex,'plugin','add',selector,'--json'],text=True,capture_output=True)
if result.returncode:
    restore_if_unchanged(marketplace, market_before, market_after)
    restore_if_unchanged(legacy_path, legacy_before, legacy_after)
print(json.dumps({'source':str(source),'backup':str(backup),'install_exit':result.returncode,
    'install_stdout':result.stdout,'install_stderr':result.stderr},ensure_ascii=False))
raise SystemExit(result.returncode)
