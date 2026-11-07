"""Lossless NTFS compression of historical release directories; never deletes or moves files."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[1] / 'release'
output = Path(sys.argv[1]).resolve()
assert os.name == 'nt' and not output.exists(), 'Windows and a new evidence directory required'
output.mkdir(parents=True)
get_size = ctypes.WinDLL('kernel32', use_last_error=True).GetCompressedFileSizeW
get_size.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32)]
get_size.restype = ctypes.c_uint32

def size_on_disk(file):
    high = ctypes.c_uint32()
    ctypes.set_last_error(0)
    low = get_size(str(file), ctypes.byref(high))
    if low == 0xffffffff and ctypes.get_last_error():
        raise ctypes.WinError(ctypes.get_last_error())
    return (high.value << 32) | low

def write(name, data):
    (output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

targets = []
for folder in sorted(root.iterdir()):
    version = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', folder.name)
    if (version and tuple(map(int, version.groups())) < (0, 17, 5)) or folder.name in ['archive', 'online-source-preview', 'video-discovery-preview', 'web-browser-preview']:
        assert folder.is_dir() and folder.resolve().parent == root.resolve()
        targets.append(folder)

def inventory():
    records = {}
    for folder in targets:
        for current, dirs, files in os.walk(folder, followlinks=False):
            for name in dirs + files:
                file = Path(current) / name
                info = file.lstat()
                assert not info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT, 'Refuse links: ' + str(file)
                assert file.resolve().is_relative_to(root.resolve()), str(file)
                if name in files:
                    with file.open('rb') as stream:
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                    records[file.relative_to(root).as_posix()] = {'bytes': info.st_size, 'diskBytes': size_on_disk(file), 'sha256': digest}
    return records

started = time.monotonic()
before = inventory()
write('before.json', before)
print(f'Verified {len(before)} historical files in {len(targets)} directories before compression.', flush=True)
for folder in targets:
    with (output / (folder.name + '.log')).open('wb') as log:
        run = subprocess.run(['compact.exe', '/C', '/S:' + str(folder), '/I', '/Q'], stdout=log, stderr=subprocess.STDOUT, timeout=600)
    assert run.returncode == 0, 'Compression incomplete: ' + str(folder)
    print('Compressed ' + folder.name, flush=True)
after = inventory()
write('after.json', after)
assert before.keys() == after.keys(), 'Historical file set changed'
assert all(before[name]['sha256'] == after[name]['sha256'] and before[name]['bytes'] == after[name]['bytes'] for name in before), 'Content changed'
result = {'status': 'passed', 'method': 'NTFS transparent compression via compact.exe /C; GetCompressedFileSizeW stored-byte accounting',
          'directories': [folder.name for folder in targets], 'filesVerified': len(before),
          'logicalBytes': sum(row['bytes'] for row in before.values()),
          'beforeDiskBytes': sum(row['diskBytes'] for row in before.values()),
          'afterDiskBytes': sum(row['diskBytes'] for row in after.values()),
          'seconds': round(time.monotonic() - started, 2), 'unchangedVersions': ['0.17.5', '0.17.6']}
result['reclaimedDiskBytes'] = result['beforeDiskBytes'] - result['afterDiskBytes']
write('result.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
