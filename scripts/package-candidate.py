#!/usr/bin/env python3
"""Create a deterministic PRIVATE candidate archive; never publishes or installs."""
from pathlib import Path
import hashlib
import json
import zipfile

root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
files={}
for name in ['src','dist','vendor','integrations','skills','assets','tests','scripts']:
    for path in (root/name).rglob('*'):
        rel=path.relative_to(root).as_posix()
        # integrations/dsh is the machine-local DeepSeek Harness plugin: its
        # cordis.patch.yml carries this machine's absolute node/server paths,
        # its Host half expects the repo's dist/pdfjs layout, and its web/
        # reader app is a DSH UI surface (with a vendored pdf.js fallback).
        # The portable counterpart lives in docs/mcp-clients.md, so exclude it
        # whole instead of embedding machine paths or the vendored build.
        if rel=='integrations/dsh' or rel.startswith('integrations/dsh/'):
            continue
        if path.is_file() and not path.is_symlink() and '__pycache__' not in path.parts and path.suffix!='.pyc' and path.name!='.DS_Store':
            files[rel]=path.read_bytes()
for name in ['package.json','plugin.json','.codex-plugin/plugin.json','mcp.json','README.md','LICENSE']:
    files[name]=(root/name).read_bytes()
# The owning source's local compatibility configuration may contain machine paths.
# The candidate always carries a portable counterpart, independently of that file.
files['.mcp.json']=(json.dumps({'mcpServers':{'zotero-workbench':{'command':'node','args':['${CODEX_PLUGIN_ROOT}/src/server.mjs'],
    'env':{'ZOTERO_URL':'http://127.0.0.1:23119','ZOTERO_MCP_URL':'http://127.0.0.1:23120/mcp'}}}},indent=2)+'\n').encode()
for name in ['lattice-adoption.md','product-prompt.md','privacy-and-release.md','distribution.md','interface-map.md']:
    files['docs/'+name]=(root/'docs'/name).read_bytes()
for name,data in files.items():
    if (str(Path.home())+'/').encode() in data:
        raise SystemExit('Machine-specific path in candidate: '+name)
manifest={'name':'zotero-workbench','version':version,'channel':'private-candidate','commercialReleaseApproved':False,
    'sha256':{name:hashlib.sha256(data).hexdigest() for name,data in sorted(files.items())}}
files['CANDIDATE-MANIFEST.json']=(json.dumps(manifest,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
out=root/'releases'/('zotero-workbench-'+version+'-private-candidate.zip')
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
    for name,data in sorted(files.items()):
        info=zipfile.ZipInfo('zotero-workbench/'+name,date_time=(2026,1,1,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
        archive.writestr(info,data)
sha=hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix('.sha256').write_text(sha+'  '+out.name+'\n')
print(json.dumps({'candidate':str(out),'sha256':sha,'files':len(files),'bytes':out.stat().st_size,'published':False}))
