import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { rebase } from '../electron/kinds/software/organize/plan.ts'

async function fixture() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-organize-service-'))
  const root = path.join(temp, 'library'), real = path.join(temp, 'installed')
  await fsp.mkdir(path.join(root, 'Old'), { recursive: true }); await fsp.mkdir(real)
  await fsp.writeFile(path.join(real, 'app.exe'), 'synthetic - never execute')
  const rows = new Map<string, any>()
  const categories: any[] = []
  function add(id: string, dir: string, target = '') {
    const row = { id, source_dir: dir, exe_path: path.join(dir, 'app.exe'), link_target: target,
      category: 'Old', name_zh: id, name_en: '', file_name: 'app.exe', is_portable: true, move_risk: 'safe', is_archived: false }
    rows.set(id, row); return row
  }
  const db = {
    getSettings: () => ({ organize_root: root }), getSoftware: (_db: unknown, id: string) => rows.get(id) ?? null,
    listSoftware: (_db: unknown, q: any = {}) => [...rows.values()].filter(r => r.is_archived === (q.group === 'archived')),
    deleteSoftware: (_db: unknown, id: string) => rows.delete(id),
    updateSoftware: (_db: unknown, id: string, patch: any) => Object.assign(rows.get(id), patch),
    remapPaths: (_db: unknown, id: string, from: string, to: string, target: string) => {
      const r = rows.get(id); r.source_dir = rebase(r.source_dir, from, to); r.exe_path = rebase(r.exe_path, from, to); r.link_target = target; return r
    },
    listCategories: () => categories, upsertCategory: (_db: unknown, c: any) => categories.push(c),
    insertScanned: (_db: unknown, files: any[]) => files.map((f, i) => add('new-' + i, path.dirname(f.exe_path))),
    getSoftwareByPath: (_db: unknown, exe: string) => [...rows.values()].find(r => r.exe_path === exe),
    saveOrganizePlan: (_db: unknown, r: string, steps: any[]) => { (db as any)._plans = (db as any)._plans || new Map(); const id = 'plan-' + ((db as any)._plans.size + 1); (db as any)._plans.set(id, { id, root: r, steps: structuredClone(steps), created_at: Date.now(), undone_at: 0 }); return id },
    getOrganizePlan: (_db: unknown, id: string) => (db as any)._plans?.get(id) ?? null,
    markPlanUndone: (_db: unknown, id: string) => { const p = (db as any)._plans?.get(id); if (p) p.undone_at = Date.now() }
  }
  const load = createRendererLoader({ 'node:fs/promises': { default: fsp }, 'node:path': { default: path }, 'node:fs': { default: fs }, '../../../services/storage/database': { getDb: () => ({}) }, '../db.ts': db, '../../../services/taxonomy/taxonomy-store.ts': db, '../../../services/storage/settings-store.ts': db, '../../../services/storage/organize-plans.ts': db,
    '../../../services/media/iconExtractor': { extractIcon: async () => '' },
    './refs': { scanRefs: async () => ({}), hasRefs: () => false, describeRefs: () => '' }
  }, { Buffer, process })
  const service = load('electron/kinds/software/organize/index.ts')
  const sync = load('electron/kinds/software/organize/sync.ts')
  async function cleanup() {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temp).startsWith('baoyi-organize-service-'))
    await fsp.rm(temp, { recursive: true, force: true })
  }
  return { temp, root, real, rows, categories, add, service, sync, cleanup }
}
async function check(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  await test(name, async () => { const f = await fixture(); try { await run(f) } finally { await f.cleanup() } })
}

await check('deleting a linked record removes only the junction', async f => {
  const link = path.join(f.root, 'Old', 'Tool'); await fsp.symlink(f.real, link, 'junction'); f.add('one', link, f.real)
  assert.equal((await f.service.deleteSoftwareRecord('one')).link_removed, true)
  assert.equal(fs.existsSync(link), false); assert.equal(fs.existsSync(path.join(f.real, 'app.exe')), true)
})
await check('deleting a real record leaves the software directory untouched', async f => {
  f.add('one', f.real); assert.equal((await f.service.deleteSoftwareRecord('one')).ok, true)
  assert.equal(fs.existsSync(path.join(f.real, 'app.exe')), true)
})
await check('deleting a managed link from a previous organize root still cleans its entry', async f => {
  const link = path.join(f.temp, 'previous-root-link'); await fsp.symlink(f.real, link, 'junction'); f.add('one', link, f.real)
  assert.equal((await f.service.deleteSoftwareRecord('one')).link_removed, true)
  assert.equal(fs.existsSync(link), false); assert.ok(fs.existsSync(path.join(f.real, 'app.exe')))
})
await check('shared junction survives until the last record is removed', async f => {
  const link = path.join(f.root, 'Old', 'Tool'); await fsp.symlink(f.real, link, 'junction')
  f.add('one', link, f.real); f.add('two', link, f.real)
  assert.equal((await f.service.deleteSoftwareRecord('one')).ok, true)
  assert.equal(fs.existsSync(link), true)
  assert.equal((await f.service.deleteSoftwareRecord('two')).link_removed, true)
})
await check('relocation updates category together with paths', async f => {
  const dir = path.join(f.root, 'Old', 'Tool'); await fsp.mkdir(dir); await fsp.writeFile(path.join(dir, 'app.exe'), 'data'); f.add('one', dir)
  assert.equal((await f.service.relocateOrganized('one', 'AI', 'New')).ok, true)
  assert.equal(f.rows.get('one').category, 'AI')
  assert.equal(f.categories.some(c => c.name === 'AI'), true, 'category is available without a directory sync')
  assert.equal(await fsp.readFile(path.join(f.root, 'AI', 'New', 'app.exe'), 'utf8'), 'data')
})
await check('relocation cannot move an unorganized source', async f => {
  f.add('one', f.real)
  assert.equal((await f.service.relocateOrganized('one', 'AI', 'New')).ok, false)
  assert.equal(fs.existsSync(path.join(f.real, 'app.exe')), true)
})
await check('broken junction relocation leaves the original junction intact', async f => {
  const link = path.join(f.root, 'Old', 'Tool'), missing = path.join(f.temp, 'missing')
  await fsp.symlink(missing, link, 'junction'); f.add('one', link, missing)
  assert.equal((await f.service.relocateOrganized('one', 'AI', 'New')).ok, false)
  assert.equal((await fsp.lstat(link)).isSymbolicLink(), true)
})
await check('destination category junction cannot redirect a move outside the library', async f => {
  const dir = path.join(f.root, 'Old', 'Tool'); await fsp.mkdir(dir); f.add('one', dir)
  await fsp.symlink(f.real, path.join(f.root, 'AI'), 'junction')
  assert.equal((await f.service.relocateOrganized('one', 'AI', 'New')).ok, false)
  assert.equal(fs.existsSync(dir), true)
})
await check('orphan cleanup refuses outside and currently owned junctions', async f => {
  const owned = path.join(f.root, 'Old', 'Owned'), outside = path.join(f.temp, 'outside')
  await fsp.symlink(f.real, owned, 'junction'); await fsp.symlink(f.real, outside, 'junction'); f.add('one', owned, f.real)
  const result = await f.sync.removeOrphanLinks([owned, outside])
  assert.equal(result.removed, 0); assert.equal(result.failed, 2)
  assert.equal(fs.existsSync(owned), true); assert.equal(fs.existsSync(outside), true)
})
await check('orphan cleanup removes an unclaimed junction but preserves its files', async f => {
  const orphan = path.join(f.root, 'Old', 'Orphan'); await fsp.symlink(f.real, orphan, 'junction')
  const outcome = await f.sync.removeOrphanLinks([orphan])
  assert.equal(outcome.removed, 1)
  assert.deepEqual(Array.from(outcome.removed_paths ?? []), [orphan], 'only confirmed removals can be dropped from the UI')
  assert.equal(fs.existsSync(path.join(f.real, 'app.exe')), true)
})
await check('materialize refuses a junction whose target no longer matches the record', async f => {
  const other = path.join(f.temp, 'other'); await fsp.mkdir(other)
  const link = path.join(f.root, 'Old', 'Tool'); await fsp.symlink(other, link, 'junction'); f.add('one', link, f.real)
  assert.equal((await f.service.materialize('one')).ok, false)
  assert.equal(fs.existsSync(path.join(f.real, 'app.exe')), true)
  assert.equal((await fsp.lstat(link)).isSymbolicLink(), true)
})
await check('unlink refuses to break a directory shared by multiple records', async f => {
  const link = path.join(f.root, 'Old', 'Tool'); await fsp.symlink(f.real, link, 'junction')
  f.add('one', link, f.real); f.add('two', link, f.real)
  assert.equal((await f.service.unlink('one')).ok, false)
  assert.equal(fs.existsSync(link), true)
})
await check('sync broadens a legacy bin source directory without changing the actual executable path', async f => {
  const parent = path.join(f.root, 'Old', 'Tool'), bin = path.join(parent, 'bin')
  await fsp.mkdir(bin, { recursive: true }); await fsp.writeFile(path.join(bin, 'app.exe'), 'synthetic')
  const row = f.add('one', bin)
  await f.sync.syncOrganizeRoot()
  assert.equal(row.source_dir, parent)
  assert.equal(row.exe_path, path.join(bin, 'app.exe'))
})

await check('targeted organized refresh returns only the requested record', async f => {
  const a = path.join(f.root, 'Old', 'One'), b = path.join(f.root, 'Old', 'Two')
  await fsp.mkdir(a); await fsp.mkdir(b); f.add('one', a); f.add('two', b)
  assert.deepEqual(Array.from((await f.service.listOrganized(['one'])).entries, (e: any) => e.software_id), ['one'])
  assert.equal((await f.service.listOrganized([])).entries.length, 0)
})
await check('reinstalling into a former junction is displayed as real and clears stale link metadata on sync', async f => {
  const dir = path.join(f.root, 'Old', 'Tool')
  await fsp.mkdir(dir); await fsp.writeFile(path.join(dir, 'app.exe'), 'new installation')
  const row = f.add('one', dir, f.real); row.is_portable = false
  assert.equal((await f.service.listOrganized()).entries[0].is_link, false)
  await f.sync.syncOrganizeRoot()
  assert.equal(row.link_target, '')
  assert.equal(row.is_portable, false)
  assert.equal(row.exe_path, path.join(dir, 'app.exe'))
  assert.equal(f.rows.size, 1)
  assert.equal((await f.service.unlink('one')).ok, false)
  assert.equal(await fsp.readFile(path.join(dir, 'app.exe'), 'utf8'), 'new installation')
})
await check('uninstall leaving a directory is reported as missing its main executable', async f => {
  const dir = path.join(f.root, 'Old', 'Tool'); await fsp.mkdir(dir); f.add('one', dir)
  const entry = (await f.service.listOrganized()).entries[0]
  assert.equal(entry.present, true); assert.equal(entry.exe_present, false)
  await fsp.writeFile(path.join(dir, 'app.exe'), 'reinstalled')
  await f.sync.syncOrganizeRoot()
  assert.equal((await f.service.listOrganized()).entries[0].exe_present, true)
  assert.equal(f.rows.size, 1)
})

await check('single-file exe in Downloads moves only that exe into a subfolder and restores on undo', async f => {
  const downloads = path.join(f.temp, 'Downloads')
  await fsp.mkdir(downloads, { recursive: true })
  const exe = path.join(downloads, 'solo-tool.exe'), keep = path.join(downloads, 'keep-document.pdf')
  await fsp.writeFile(exe, 'portable single exe'); await fsp.writeFile(keep, 'unrelated file')
  const row = { id: 'solo', source_dir: downloads, exe_path: exe, link_target: '', category: 'Old', name_zh: '独立小工具', name_en: '', file_name: 'solo-tool.exe', is_portable: true, move_risk: 'safe', is_archived: false }
  f.rows.set('solo', row)
  const preview = await f.service.previewOrganize(['solo'])
  assert.equal(preview.entries.length, 1)
  const ran = await f.service.runOrganize([{ software_id: 'solo', action: 'move', category: 'Old', folder: '独立小工具' }], () => {})
  assert.equal(ran.moved, 1)
  assert.equal(fs.existsSync(keep), true, 'sibling file in Downloads must remain untouched')
  assert.equal(fs.existsSync(exe), false)
  assert.equal(row.exe_path, path.join(f.root, 'Old', '独立小工具', 'solo-tool.exe'))
  assert.equal(fs.existsSync(row.exe_path), true)
  const undone = await f.service.undoOrganize(ran.plan_id)
  assert.equal(undone.restored, 1, undone.notes.join('; '))
  assert.equal(undone.failed, 0)
  assert.equal(fs.existsSync(exe), true)
  assert.equal(row.exe_path, exe)
  assert.equal(row.source_dir, downloads)
})
