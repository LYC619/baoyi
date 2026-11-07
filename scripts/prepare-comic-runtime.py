"""Acquire only hash-locked libraries in a separate target; never pip into Hermes."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'output/comic-runtime'


def seal():
    files = []
    for file in sorted(OUT.rglob('*')):
        if not file.is_file() or file.name=='runtime-stamp.json' or '__pycache__' in file.parts or file.suffix=='.pyc':
            continue
        files.append((file.relative_to(OUT).as_posix(),hashlib.sha256(file.read_bytes()).hexdigest()))
    stamp={'format':'baoyi-comic-runtime','version':1,'sourceVersion':'jmcomic==2.7.11','files':files,
           'treeSha256':hashlib.sha256(''.join(f'{name}\0{digest}\n' for name,digest in files).encode()).hexdigest()}
    (OUT/'runtime-stamp.json').write_text(json.dumps(stamp,ensure_ascii=False,indent=2),encoding='utf-8')
    return stamp


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--seal-only',action='store_true');args=parser.parse_args()
    if not args.seal_only:
        subprocess.run([str(ROOT/'output/archive-assistant-2026-11-05/downloads/uv/uv.exe'),'pip','install',
            '--python',str(ROOT/'output/hermes-runtime/python/python.exe'),'--target',str(OUT/'site-packages'),
            '--require-hashes','--no-deps','--no-compile-bytecode','-r',str(ROOT/'resources/comic/requirements.lock'),
            '--cache-dir',str(ROOT/'output/p1-p2-comic-2026-11-06/uv-cache')],check=True)
    libraries=[]
    for dist in importlib.metadata.distributions(path=[str(OUT/'site-packages')]):
        libraries.append({'name':dist.metadata['Name'],'version':dist.version,
            'license':dist.metadata.get('License-Expression') or dist.metadata.get('License',''),
            'licenseFiles':[str(f) for f in dist.files or [] if any(term in str(f).lower() for term in ('license','copying','notice'))]})
    (OUT/'dependencies.json').write_text(json.dumps(sorted(libraries,key=lambda r:r['name'].lower()),ensure_ascii=False,indent=2),encoding='utf-8')
    shutil.copyfile(ROOT/'resources/comic/requirements.lock',OUT/'requirements.lock')
    license_file=next((OUT/'site-packages').glob('jmcomic-*.dist-info/licenses/LICENSE'))
    shutil.copyfile(license_file,ROOT/'docs/third-party/jmcomic-license.txt')
    stamp=seal();print(json.dumps({'files':len(stamp['files']),'treeSha256':stamp['treeSha256'],'dependencies':len(libraries)}))


if __name__=='__main__':main()
