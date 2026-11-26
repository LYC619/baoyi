"""Real SQLite/WAL and filesystem coverage for embedded assistant backups."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / 'output/archive-assistant-2026-11-05/backup-tests'
SCRATCH.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(SCRATCH)
spec = importlib.util.spec_from_file_location('assistant_state', ROOT / 'resources/hermes/state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='baoyi-backup-')
        self.root = Path(self.scratch.name) / 'archive-assistant'
        self.root.mkdir()

    def tearDown(self):
        self.scratch.cleanup()

    def test_wal_memories_and_skills_roundtrip_without_credentials(self):
        home = self.root / 'public'
        home.mkdir()
        db = sqlite3.connect(home / 'state.db')
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('CREATE TABLE sessions(id TEXT, title TEXT); CREATE TABLE messages(id INTEGER, content TEXT);')
            db.execute('INSERT INTO sessions VALUES (?, ?)', ('fixture', '青松桥归档'))
            db.execute('INSERT INTO messages VALUES (?, ?)', (1, '原始工具结果：白鹭 42'))
            db.commit()
            (home / 'memories').mkdir()
            (home / 'memories' / 'USER.md').write_text('保留所有不同版本', encoding='utf8')
            (home / 'skills' / '归档方法').mkdir(parents=True)
            (home / 'skills' / '归档方法' / 'SKILL.md').write_text('核验原文件再整理', encoding='utf8')
            (home / 'config.yaml').write_text('api_key: fixture-secret', encoding='utf8')
            value = state.export(self.root)
        finally:
            db.close()
        restored = Path(state.stage(self.root, value)['stage'])
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(value['archive']))) as bundle:
            self.assertNotIn('public/config.yaml', bundle.namelist())
        db = sqlite3.connect(restored / 'public/state.db')
        try:
            self.assertEqual(db.execute('SELECT content FROM messages').fetchone()[0], '原始工具结果：白鹭 42')
        finally:
            db.close()
        self.assertEqual((restored / 'public/memories/USER.md').read_text(encoding='utf8'), '保留所有不同版本')
        self.assertTrue((restored / 'public/skills/归档方法/SKILL.md').exists())
        # Windows must be able to rename/delete the restored folder immediately.
        restored.rename(restored.with_name('restored-closed'))

    def test_invalid_archive_paths_and_database_leave_no_partial_restore(self):
        for name, contents in [('public/../escape.txt', b'no'), ('public/state.db', b'corrupt'), ('public/skills/a:stream', b'no')]:
            with self.subTest(name=name):
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, 'w') as bundle:
                    bundle.writestr(name, contents)
                value = {'format':'baoyi-hermes-state','version':1,'archive':base64.b64encode(buffer.getvalue()).decode()}
                with self.assertRaises(Exception):
                    state.stage(self.root, value)
                self.assertEqual(list(self.root.parent.glob('archive-assistant-restore-*')), [])

    def test_empty_state_can_restore(self):
        restored = Path(state.stage(self.root, state.export(self.root))['stage'])
        self.assertEqual(list(restored.iterdir()), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
