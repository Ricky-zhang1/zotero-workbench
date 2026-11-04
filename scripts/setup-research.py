#!/usr/bin/env python3
"""Install the isolated dependencies for the pinned TextFold engine. No model/OCR downloads."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / '.runtime' / 'textfold'
PYTHON = ENV / 'bin' / 'python'
UPSTREAM = ROOT / 'vendor' / 'textfold' / 'UPSTREAM.json'
LOCK = ROOT / 'vendor' / 'textfold' / 'requirements-lock.txt'
EXPECTED_COMMIT = '5062eacc0b1e2a2528e0906414f5073033051a30'
EXPECTED_VERSION = '0.10.40'

metadata = json.loads(UPSTREAM.read_text(encoding='utf-8'))
if (metadata.get('name') != 'TextFold' or metadata.get('version') != EXPECTED_VERSION or
        metadata.get('commit') != EXPECTED_COMMIT or metadata.get('license') != 'Apache-2.0'):
    raise SystemExit('Pinned TextFold source metadata is missing or does not match the approved release.')
if not LOCK.is_file():
    raise SystemExit('Pinned TextFold dependency lock is missing.')

if not PYTHON.exists():
    subprocess.run([sys.executable, '-m', 'venv', str(ENV)], check=True)

uv = shutil.which('uv')
install = ([uv, 'pip', 'install', '--python', str(PYTHON)] if uv else
           [str(PYTHON), '-m', 'pip', 'install'])
subprocess.run(install + ['-r', str(LOCK)], check=True)

runtime_env = dict(os.environ)
runtime_env['PYTHONPATH'] = str(ROOT / 'vendor' / 'textfold')
verify = (
    "import sys; sys.path.insert(0, sys.argv[1]); "
    "import textfold; assert textfold.__version__ == sys.argv[2], textfold.__version__"
)
subprocess.run([str(PYTHON), '-c', verify, str(ROOT / 'vendor' / 'textfold'), EXPECTED_VERSION],
               check=True, env=runtime_env)
print('TextFold research runtime ready: ' + str(PYTHON))
