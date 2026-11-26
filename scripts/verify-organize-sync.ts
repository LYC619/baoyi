import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { findMainExe, matchLayout, scanOrganizeLayout, type LayoutSoftware, type RecordRef } from '../electron/kinds/software/organize/syncPlan.ts'
import { removeJunction } from '../electron/kinds/software/organize/fsops.ts'

const root = path.resolve('C:/organize-fixture')
const software = (category: string, name = 'Tool', target = ''): LayoutSoftware => ({
  dir: path.join(root, category, name), category, name, is_link: !!target, link_target: target
})
const record = (s: LayoutSoftware, id = 'one'): RecordRef => ({
  id, dir: s.dir, name: s.name, category: s.category, exe_path: path.join(s.dir, 'bin', 'app.exe'), link_target: s.link_target
})
const match = (dirs: LayoutSoftware[], refs: RecordRef[], exists = async () => false) =>
  matchLayout({ root, categories: dirs.map(s => s.category), software: dirs }, refs, exists, async dir => path.join(dir, 'app.exe'))

test('unchanged locations win; category follows folder', async () => {
  const s = software('AI'); const r = { ...record(s), category: 'Old' }
  const p = await match([s], [r])
  assert.equal(p.claimed.length, 1)
  assert.deepEqual(p.recategorized.map(c => c.to), ['AI'])
  assert.equal(p.added.length, 0)
})
test('moving a real directory heals identity AND category', async () => {
  const p = await match([software('AI')], [record(software('Old'))])
  assert.equal(p.healed.length, 1)
  assert.deepEqual(p.recategorized.map(c => c.to), ['AI'])
})
test('an existing original must never be healed to a same-name copy', async () => {
  const p = await match([software('AI')], [record(software('Old'))], async () => true)
  assert.equal(p.healed.length, 0)
  assert.equal(p.missing.length, 0)
  assert.equal(p.added.length, 1)
})
test('duplicate names are ambiguous; do not register false replacements', async () => {
  const p = await match([software('AI'), software('Tools')], [record(software('Old'))])
  assert.equal(p.healed.length, 0)
  assert.equal(p.added.length, 0)
  assert.equal(p.skipped.filter(s => s.reason === 'ambiguous').length, 2)
})
test('missing records with duplicate names are not guessed', async () => {
  const p = await match([software('AI')], [record(software('Old')), record(software('Other'), 'two')])
  assert.equal(p.healed.length, 0)
  assert.equal(p.skipped[0].reason, 'ambiguous')
})
test('moved junction heals and recategorizes', async () => {
  const target = path.resolve('C:/installed/Tool')
  const p = await match([software('AI', 'Tool', target)], [record(software('Old', 'Tool', target))])
  assert.equal(p.healed.length, 1)
  assert.equal(p.recategorized[0]?.to, 'AI')
})
test('extra junction cannot steal a record whose original still exists', async () => {
  const target = path.resolve('C:/installed/Tool')
  const p = await match([software('AI', 'Tool', target)], [record(software('Old', 'Tool', target))], async () => true)
  assert.equal(p.healed.length, 0)
  assert.equal(p.orphans.length, 1)
})
test('two junctions to the same target are not arbitrarily matched', async () => {
  const target = path.resolve('C:/installed/Tool')
  const p = await match([software('AI', 'Tool', target), software('Tools', 'Tool', target)], [record(software('Old', 'Tool', target))])
  assert.equal(p.healed.length, 0)
  assert.equal(p.orphans.length, 2)
})
test('all records sharing a software directory remain claimed', async () => {
  const s = software('AI')
  const p = await match([s], [record(s), { ...record(s, 'two'), exe_path: path.join(s.dir, 'other.exe') }])
  assert.equal(p.claimed.length, 2)
  assert.equal(p.missing.length, 0)
})
test('outside records are never reported missing', async () => {
  const r = { ...record(software('Old')), dir: path.resolve('C:/installed/Other') }
  assert.equal((await match([], [r])).missing.length, 0)
})
test('filesystem layout includes empty categories and real junctions; removal preserves target', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-sync-'))
  try {
    const library = path.join(temp, 'library'), target = path.join(temp, 'installed')
    const app = path.join(library, 'AI', 'Tool'), link = path.join(library, 'AI', 'Linked')
    await fsp.mkdir(app, { recursive: true }); await fsp.mkdir(target)
    await fsp.mkdir(path.join(library, 'Empty')); await fsp.mkdir(path.join(library, '.hidden'))
    await fsp.writeFile(path.join(app, 'Tool.exe'), 'main')
    await fsp.writeFile(path.join(app, 'unins000.exe'), 'uninstaller bigger than main')
    await fsp.writeFile(path.join(target, 'keep.txt'), 'must survive')
    await fsp.symlink(target, link, 'junction')
    const layout = await scanOrganizeLayout(library)
    assert.deepEqual([...layout.categories].sort(), ['AI', 'Empty'])
    assert.equal(layout.software.find(s => s.dir === link)?.is_link, true)
    assert.equal(await findMainExe(app), path.join(app, 'Tool.exe'))
    assert.equal((await removeJunction(app)).ok, false)
    assert.equal((await removeJunction(link)).ok, true)
    assert.equal(await fsp.readFile(path.join(target, 'keep.txt'), 'utf8'), 'must survive')
  } finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temp).startsWith('baoyi-sync-'))
    await fsp.rm(temp, { recursive: true, force: true })
  }
})
test('unreadable root fails explicitly instead of pretending to be empty', async () => {
  await assert.rejects(scanOrganizeLayout(path.join(os.tmpdir(), 'missing-baoyi-root-' + Date.now())))
})
