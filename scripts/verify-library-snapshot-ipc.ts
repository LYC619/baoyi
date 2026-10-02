import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
assert.ok(fs.existsSync('electron/ipc/library-snapshots.ts'), 'snapshot information requires guarded IPC')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-snapshot-ipc-')), db = new DatabaseSync(path.join(root, 'baoyi.db'))
initSchema(db, KINDS)
const events = new Map<string, (...args: any[]) => any>(), contents = { mainFrame: {} }, win = { isDestroyed: () => false, webContents: contents }
const event = { sender: contents, senderFrame: contents.mainFrame }, opened: string[] = []
class TestDatabase extends DatabaseSync { constructor(file: string, options: { readonly: boolean }) { super(file, { readOnly: options.readonly }) } }
const load = createRendererLoader({
  electron: { app: { getPath: () => root, getVersion: () => '0.10.0' }, shell: { openPath: async (file: string) => { opened.push(file); return '' } } },
  'better-sqlite3': { default: TestDatabase }, '../services/database.ts': { getDb: () => db },
  'node:fs': { ...fs, default: fs }, 'node:path': { ...path, default: path }
}, { Buffer, Date })
load('electron/ipc/library-snapshots.ts').registerLibrarySnapshotIpc(() => win, { handle: (name: string, callback: (...args: any[]) => any) => events.set(name, callback) })
try {
  for (const [name, handler] of events) await assert.rejects(async () => handler({ ...event, senderFrame: {} }), /主窗口/, name)
  const before = await events.get('data:snapshot-info')!(event)
  assert.equal(before.version, '0.10.0'); assert.equal(before.schema, 13); assert.equal(before.dataDirectory, root); assert.equal(before.inventory.total, 0)
  const created = await events.get('data:create-snapshot')!(event)
  assert.equal(created.reason, 'manual'); assert.equal(created.state, 'available')
  assert.equal((await events.get('data:snapshot-info')!(event)).inventory.total, 1)
  await events.get('data:open-snapshot-dir')!(event, 'C:/untrusted')
  assert.deepEqual(opened, [path.join(root, 'library-snapshots')])
  console.log('PASS snapshot info/create/open IPC and foreign-frame rejection')
} finally { db.close() }
