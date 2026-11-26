"""Build a relocatable, pinned Hermes library runtime for the Windows app.

No installer runs on the user's machine. Source and dependencies are acquired
at build time; the packaged app starts the bundled interpreter directly.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'reference/hermes-agent-v0.22.7'
OUT = ROOT / 'output/hermes-runtime'
DOWNLOADS = ROOT / 'output/archive-assistant-2026-11-05/downloads'
SOURCE_SHA = '10880f6df64275dddf50d6319aed16eb0ba6a79542a064e3dbbc00df88855a91'
SOURCE_TAG = '592aa804d6ed135a18d6a01fb0824bfdbb0279d7'
SOURCE_COMMIT = 'b200f5bc60e31588ba2cb60e288029c4a54ba5fa'
SOURCE_ARTIFACT = {'url': 'https://api.github.com/repos/NousResearch/hermes-agent/zipball/v0.22.7', 'sha256': SOURCE_SHA}

def acquire(name, artifact, directory=DOWNLOADS):
    target = directory / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        partial = target.with_suffix(target.suffix + '.partial')
        request = urllib.request.Request(artifact['url'], headers={'User-Agent': 'Baoyi-build'})
        with urllib.request.urlopen(request, timeout=120) as response, partial.open('wb') as output:
            shutil.copyfileobj(response, output)
        partial.replace(target)
    with target.open('rb') as handle:
        actual = hashlib.file_digest(handle, 'sha256').hexdigest()
    if actual != artifact['sha256']:
        raise ValueError(f'{name}: checksum mismatch')
    return target

def unpack(archive, target):
    target.mkdir(parents=True, exist_ok=True)
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                if not (target / item.filename).resolve().is_relative_to(target.resolve()):
                    raise ValueError('Unsafe archive path')
            bundle.extractall(target)
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(target, filter='data')

def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)

def acquire_source():
    archive = acquire('hermes-agent-v0.22.7.zip', SOURCE_ARTIFACT, DOWNLOADS.parent)
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            if entry.is_dir():
                continue
            relative = Path(*Path(entry.filename).parts[1:])
            target = (SOURCE / relative).resolve()
            if not relative.parts or not target.is_relative_to(SOURCE.resolve()):
                raise ValueError('Unsafe source path')
            contents = bundle.read(entry)
            if target.exists():
                if target.read_bytes() != contents:
                    raise ValueError('Reference source was modified: ' + str(relative))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents)

def dependency_inventory():
    script = """import importlib.metadata as m,json
rows=[]
for d in m.distributions():
    rows.append({'name':d.metadata['Name'],'version':d.version,'license':d.metadata.get('License-Expression') or d.metadata.get('License',''),'licenseFiles':[str(f) for f in (d.files or []) if any(x in str(f).lower() for x in ['license','copying','notice'])]})
print(json.dumps(sorted(rows,key=lambda r:r['name'].lower()),ensure_ascii=False,indent=2))
"""
    value=subprocess.check_output([str(OUT/'python/python.exe'), '-X','utf8','-c',script], text=True,encoding='utf8')
    (OUT/'dependencies.json').write_text(value,encoding='utf8')

def seal_runtime():
    """Write a deterministic tree stamp for the exact files copied to the app."""
    manifest = OUT / 'manifest.json'
    files = []
    for file in sorted(OUT.rglob('*'), key=lambda file: file.relative_to(OUT).as_posix()):
        if not file.is_file() or file.name == 'runtime-stamp.json' or '__pycache__' in file.parts or file.suffix == '.pyc':
            continue
        with file.open('rb') as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        files.append((file.relative_to(OUT).as_posix(), digest))
    tree = hashlib.sha256((''.join(f'{name}\0{digest}\n' for name, digest in files)).encode()).hexdigest()
    with manifest.open('rb') as handle:
        manifest_sha = hashlib.file_digest(handle, 'sha256').hexdigest()
    stamp = {
        'format': 'baoyi-hermes-runtime-stamp', 'version': 1,
        'engine': 'Hermes Agent', 'sourceSha256': SOURCE_SHA, 'sourceCommit': SOURCE_COMMIT,
        'manifestSha256': manifest_sha,
        'fileCount': len(files), 'treeSha256': tree,
    }
    (OUT / 'runtime-stamp.json').write_text(json.dumps(stamp, ensure_ascii=False, indent=2) + '\n', encoding='utf8')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--acquire-only', action='store_true')
    parser.add_argument('--seal-only', action='store_true', help='Seal an already prepared runtime without reinstalling')
    args = parser.parse_args()
    acquire_source()
    if args.seal_only:
        manifest_path=OUT/'manifest.json'
        manifest=json.loads(manifest_path.read_text(encoding='utf8'))
        manifest.update(sourceCommit=SOURCE_COMMIT,sourceTag=SOURCE_TAG,source=SOURCE_ARTIFACT['url'])
        manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
        dependency_inventory()
        seal_runtime()
        print('Runtime source verified and tree sealed')
        return
    lock = json.loads((SOURCE / 'pm/lock.json').read_text(encoding='utf8'))['packages']
    artifacts = [(name, lock[name]['artifacts']['win32-x64']) for name in ['python', 'uv']]
    with ThreadPoolExecutor(max_workers=2) as pool:
        archives = list(pool.map(lambda pair: acquire(pair[0] + ('.zip' if pair[0] == 'uv' else '.tar.gz'), pair[1]), artifacts))
    if not (OUT / 'python/python.exe').exists():
        unpack(archives[0], OUT)
    if not (DOWNLOADS / 'uv/uv.exe').exists():
        unpack(archives[1], DOWNLOADS / 'uv')
    python, uv = OUT / 'python/python.exe', DOWNLOADS / 'uv/uv.exe'
    run([python, '--version'])
    if args.acquire_only:
        return
    requirements = OUT / 'requirements.txt'
    run([uv, 'export', '--project', SOURCE, '--frozen', '--no-dev', '--no-emit-project', '--format', 'requirements-txt', '--output-file', requirements], stdout=subprocess.DEVNULL)
    run([uv, 'pip', 'sync', '--python', python, '--require-hashes', '--cache-dir', DOWNLOADS / 'cache', requirements])
    # Preserve the complete Python implementation and runtime assets. Exclude
    # upstream frontends, tests and docs that our Electron app does not execute.
    target = OUT / 'hermes'
    directories = ['agent', 'tools', 'hermes_cli', 'gateway', 'tui_gateway', 'cron', 'acp_adapter', 'plugins', 'providers', 'hermes_platform', 'pm', 'skills', 'locales']
    target.mkdir(parents=True, exist_ok=True)
    for file in SOURCE.glob('*.py'):
        shutil.copy2(file, target / file.name)
    for name in ['LICENSE', 'pyproject.toml', 'uv.lock']:
        shutil.copy2(SOURCE / name, target / name)
    for name in directories:
        if (SOURCE / name).exists():
            shutil.copytree(SOURCE / name, target / name, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    manifest = {'engine': 'Hermes Agent', 'version': 'v0.22.7', 'sourceSha256': SOURCE_SHA, 'sourceCommit':SOURCE_COMMIT,'sourceTag':SOURCE_TAG,'source':SOURCE_ARTIFACT['url'],'python': lock['python']['version'], 'artifacts': dict(artifacts)}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    dependency_inventory()
    seal_runtime()
    print(json.dumps({'runtime': str(OUT), 'status': 'prepared'}), flush=True)

if __name__ == '__main__':
    main()
