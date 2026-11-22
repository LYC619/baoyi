// One-shot maintenance of an explicitly selected, closed profile. Reports stay outside it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { archiveLibrarySnapshots, exportLibrarySnapshot } from '../electron/services/storage/snapshot-archive.ts'
import { readSnapshotInventory } from '../electron/services/storage/library-snapshots.ts'
import { readStorageUsage } from '../electron/services/storage/storage-usage.ts'

const profile = path.resolve(process.argv[2] || ''), output = path.resolve(process.argv[3] || '')
assert.ok(process.argv[2] && process.argv[3], 'Pass profile and a NEW report directory')
assert.ok(fs.existsSync(path.join(profile, 'baoyi.db')))
assert.ok(!fs.lstatSync(profile).isSymbolicLink())
assert.ok(!output.toLowerCase().startsWith(profile.toLowerCase() + path.sep))
assert.ok(!fs.existsSync(output), 'Preserve previous maintenance reports')
const running = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process -Name 抱一,electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'], { encoding: 'utf8', windowsHide: true })
assert.ok(!running.error && (running.status === 0 || running.status === 1), 'Cannot establish process state')
assert.equal((running.stdout || '').trim(), '', 'Close BaoYi and Electron before profile maintenance')
fs.mkdirSync(output, { recursive: true })
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function protectedFiles() {
  const result: Record<string, string> = {}
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Refuse linked protected content')
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) result[path.relative(profile, file)] = hash(file)
    }
  }
  for (const name of fs.readdirSync(profile)) {
    const file = path.join(profile, name)
    if (/^baoyi\.db(?:$|[-.])/.test(name) && fs.lstatSync(file).isFile()) result[name] = hash(file)
    else if (['icons', 'covers', 'posters', 'save-backups', 'recovery', 'artwork-migrations'].includes(name)) walk(file)
  }
  return result
}
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n')
const before = { usage: await readStorageUsage(profile), snapshots: readSnapshotInventory(profile, 1000), protected: protectedFiles() }
write('before.json', before)
assert.deepEqual(before.snapshots.warnings, [])
const archive = await archiveLibrarySnapshots(profile)
write('archive.json', archive)
assert.deepEqual(archive.warnings, [])
const afterInventory = readSnapshotInventory(profile, 1000)
assert.deepEqual(afterInventory.snapshots.map(item => [item.id, item.sha256]), before.snapshots.snapshots.map(item => [item.id, item.sha256]))
const restored = []
for (const item of afterInventory.snapshots) {
  const file = path.join(output, 'verify-' + randomUUID() + '.db')
  const exported = await exportLibrarySnapshot(profile, item.id, file)
  assert.equal(hash(file), item.sha256)
  const db = new DatabaseSync(file, { readOnly: true })
  try { assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok') }
  finally { db.close() }
  restored.push({ id: item.id, sha256: exported.sha256, quickCheck: 'ok' })
  fs.unlinkSync(file)
}
write('restoration.json', restored)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const cache = spawnSync(path.resolve('node_modules/electron/dist/electron.exe'), [path.resolve('scripts/maintain-browser-cache.cjs'), profile, path.join(output, 'cache.json')], {
  encoding: 'utf8', windowsHide: true, timeout: 120000, env
})
write('cache-process.json', { exitCode: cache.status, stdout: cache.stdout, stderr: cache.stderr, error: cache.error?.message })
assert.equal(cache.status, 0, 'Cache maintenance failed; inspect cache-process.json')
const after = { usage: await readStorageUsage(profile), snapshots: readSnapshotInventory(profile, 1000), protected: protectedFiles() }
write('after.json', after)
assert.deepEqual(after.protected, before.protected, 'Database and assets must remain byte-identical')
const result = { status: 'passed', profile, beforeBytes: before.usage.totalBytes, afterBytes: after.usage.totalBytes,
  reclaimedBytes: before.usage.totalBytes - after.usage.totalBytes, archived: archive.archived, recoveryPointsVerified: restored.length,
  protectedFilesUnchanged: Object.keys(after.protected).length, cache: JSON.parse(fs.readFileSync(path.join(output, 'cache.json'), 'utf8')) }
write('result.json', result); console.log(JSON.stringify(result, null, 2))
