"""Archive-assistant state backup. SQLite snapshots include WAL; credentials are excluded."""
import base64
from contextlib import closing
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tempfile
import uuid
import zipfile

LIMIT = 128 * 1024 * 1024


def valid_name(name):
    parts = PurePosixPath(name).parts
    return ('\\' not in name and ':' not in name and not name.startswith('/') and
            '..' not in parts and len(parts) >= 2 and parts[0] in ('all', 'public') and
            ((len(parts) == 2 and parts[1] == 'state.db') or
             (len(parts) > 2 and parts[1] in ('memories', 'skills'))))


def export(root):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for profile in ('all', 'public'):
            home = root / profile
            state = home / 'state.db'
            if state.exists():
                with tempfile.TemporaryDirectory(prefix='baoyi-state-') as scratch:
                    target = Path(scratch) / 'state.db'
                    with closing(sqlite3.connect(state.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(target)) as destination:
                        source.backup(destination)
                    bundle.write(target, f'{profile}/state.db')
            for folder in ('memories', 'skills'):
                for file in (home / folder).rglob('*'):
                    if file.is_file() and not file.is_symlink():
                        bundle.write(file, file.relative_to(root).as_posix())
    if buffer.tell() > LIMIT:
        raise ValueError('助手历史超过备份大小，请通过数据目录保留完整副本')
    return {'format': 'baoyi-hermes-state', 'version': 1,
            'archive': base64.b64encode(buffer.getvalue()).decode()}


def stage(root, value):
    if not isinstance(value, dict) or value.get('format') != 'baoyi-hermes-state' or value.get('version') != 1:
        raise ValueError('助手备份格式无效')
    data = base64.b64decode(value['archive'], validate=True)
    if len(data) > LIMIT:
        raise ValueError('助手备份过大')
    target = root.parent / ('archive-assistant-restore-' + uuid.uuid4().hex)
    target.mkdir()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as bundle:
            entries = bundle.infolist()
            if len(entries) > 20000 or sum(x.file_size for x in entries) > LIMIT * 4:
                raise ValueError('助手备份解压大小超限')
            names = set()
            for entry in entries:
                key=entry.filename.casefold()
                if not valid_name(entry.filename) or key in names or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError('助手备份包含无效文件路径')
                names.add(key)
                file=target.joinpath(*PurePosixPath(entry.filename).parts)
                file.parent.mkdir(parents=True,exist_ok=True)
                file.write_bytes(bundle.read(entry))
        for state in target.glob('*/state.db'):
            with closing(sqlite3.connect(state.as_uri() + '?mode=ro',uri=True)) as db:
                if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                    raise ValueError('助手会话数据库损坏')
                if not {'sessions','messages'}.issubset({row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}):
                    raise ValueError('助手会话数据库缺少必要表')
        return {'stage':str(target)}
    except Exception:
        shutil.rmtree(target)
        raise


if __name__=='__main__':
    root=Path(sys.argv[2]).resolve()
    try:
        result=export(root) if sys.argv[1]=='export' else stage(root,json.load(sys.stdin))
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        sys.exit(1)
