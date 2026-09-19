/** 实测第三轮（2026-09-19）：占位集不再抢来源、简繁搜索、统一移动。内存库 + 临时目录，不碰用户资料库、不联网。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { getVideo, listEpisodes, listVideos, updateVideo } from '../electron/kinds/video/db.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { applyVideoCatalogue, placeholderEpisodeIds, pruneStrayPlaceholders } from '../electron/kinds/video/catalogue.ts'
import { resolveVideoOwnership } from '../electron/kinds/video/identity.ts'
import { createVideoWorkflow, type VideoWorkSource } from '../electron/kinds/video/download/workflow.ts'
import { applyVideoLayout, previewVideoLayout } from '../electron/kinds/video/layout.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { readVideoBundle } from '../electron/kinds/video/bundle.ts'
import { simplifyZh } from '../src/utils/zh.ts'

let passed = 0, failed = 0
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-round3-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  const file = (name: string) => { const value = path.join(root, name); fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, 'synthetic media ' + name); return value }
  const source = (code: string) => ({ provider: 'hanime', externalId: code, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' as const })
  const work = (title: string, code: string, name: string, extra: Record<string, unknown> = {}) => registerVideoContent(db, {
    title, ...extra, items: [{ title, number: 1, order: 1, sources: [source(code)], files: [{ path: file(name), quality: '720p' }] }]
  }).resourceId
  const close = () => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('baoyi-round3-')); fs.rmSync(root, { recursive: true, force: true }) }
  return { root, db, file, source, work, close }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  if (filter && !name.includes(filter)) return
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.stack : error)) }
  finally { f.close() }
}

// 一个作者频道式的播放列表：当前集 + 同系列第 2 集 + 两条完全无关的作品
const channel = (code: string): VideoWorkSource => ({ videoCode: code, title: '监狱战舰', description: '', posterUrl: '', tags: [], warnings: [],
  currentEpisode: { videoCode: code, title: '监狱战舰 1', originalTitle: 'Prison Battleship 1', description: '' },
  episodes: [{ videoCode: '9001', title: '监狱战舰 1' }, { videoCode: '9002', title: '监狱战舰 2' }, { videoCode: '9101', title: 'ZIZG-018 洗脑大改造' }, { videoCode: '9102', title: 'ZIZG-012 美少女战士' }] })

await test('占位集：播放列表里不是同系列的条目不再建成占位集、不绑来源', f => {
  const id = f.work('监狱战舰 1', '9001', 'A/监狱战舰 1.mp4')
  applyVideoCatalogue(f.db, id, channel('9001'))
  const rows = listEpisodes(f.db, id)
  assert.deepEqual(rows.map(row => row.title).sort(), ['监狱战舰 1', '监狱战舰 2'], '只有同系列的第 2 集成为占位集')
  const bound = f.db.prepare("SELECT external_id FROM video_sources WHERE resource_id = ?").all(id).map((row: any) => row.external_id).sort()
  assert.deepEqual(bound, ['9001', '9002'])
  assert.equal(resolveVideoOwnership(f.db, { title: 'x', sources: [f.source('9101')] }).state, 'new', '无关条目没被抢走')
})

await test('占位集：同系列占位不算已归属，别的作品下载这一集时占位让出去', async f => {
  const first = f.work('监狱战舰 1', '9001', 'A/监狱战舰 1.mp4')
  applyVideoCatalogue(f.db, first, channel('9001'))
  assert.equal(placeholderEpisodeIds(f.db, '9002').length, 1)
  assert.equal(resolveVideoOwnership(f.db, { title: 'x', sources: [f.source('9002')] }).state, 'new', '占位集不算拥有来源')
  // 用户另建了「第二部」作品，从它这里补齐 9002
  const second = f.work('监狱战舰 第二部', '9002', 'B/监狱战舰 2.mp4')
  assert.equal(placeholderEpisodeIds(f.db, '9002').length, 0, '登记有文件的那一集后，第一部里的占位被让出去了')
  assert.equal(listEpisodes(f.db, first).length, 1)
  assert.equal(listEpisodes(f.db, second).length, 1)
  // 下载草稿：第二部的作品拿到 9002 是 local，不再显示「已在其他作品」
  const flow = createVideoWorkflow({ db: f.db, downloadsDirectory: () => path.join(f.root, 'dl'), resolveWork: async code => ({ ...channel(code), currentEpisode: { videoCode: code, title: '监狱战舰 2', originalTitle: 'Prison Battleship 2', description: '' } }),
    resolveSources: async () => { throw new Error('no network') }, transfer: async () => { throw new Error('no transfer') } })
  const draft = await flow.prepare({ resourceId: second })
  assert.equal(draft.episodes.find(ep => ep.videoCode === '9002')?.state, 'local')
  assert.equal(draft.episodes.find(ep => ep.videoCode === '9001')?.state, 'other-work', '第一部真有文件的那集仍然属于第一部')
})

await test('占位集：有文件或看过的集不算占位，不会被让出去', f => {
  const first = f.work('监狱战舰 1', '9001', 'A/监狱战舰 1.mp4')
  applyVideoCatalogue(f.db, first, channel('9001'))
  const placeholder = listEpisodes(f.db, first).find(row => row.title === '监狱战舰 2')!
  f.db.prepare("UPDATE episode SET watch_status = 'watching', position_sec = 30 WHERE id = ?").run(placeholder.id)
  assert.equal(placeholderEpisodeIds(f.db, '9002').length, 0)
  assert.equal(resolveVideoOwnership(f.db, { title: 'x', sources: [f.source('9002')] }).resourceId, first)
})

await test('占位集：启动清理只删历史遗留的无关占位，同系列的和有文件的都留着', f => {
  const id = f.work('监狱战舰 1', '9001', 'A/监狱战舰 1.mp4')
  // 手工造出旧版本会建出来的那种占位集（负号编号、playlist 证据）
  const insert = (episodeId: string, number: number, title: string, code: string) => {
    f.db.prepare("INSERT INTO episode (id, resource_id, season, episode, title, path, file_size) VALUES (?, ?, 0, ?, ?, '', 0)").run(episodeId, id, number, title)
    f.db.prepare("INSERT INTO video_sources (id, resource_id, episode_id, provider, external_id, scope, page_url, evidence, created_at, updated_at) VALUES (?, ?, ?, 'hanime', ?, 'episode', '', 'playlist', 0, 0)").run('s-' + episodeId, id, episodeId, code)
  }
  insert('p-related', 2, '监狱战舰 2', '9002')
  insert('p-stray-1', -1, 'ZIZG-018 洗脑大改造', '9101')
  insert('p-stray-2', -2, 'ZIZG-012 美少女战士', '9102')
  assert.equal(pruneStrayPlaceholders(f.db), 2)
  assert.deepEqual(listEpisodes(f.db, id).map(row => row.title).sort(), ['监狱战舰 1', '监狱战舰 2'])
  assert.equal(pruneStrayPlaceholders(f.db), 0, '幂等')
})

await test('简繁搜索：简体关键词搜到繁体标题、单集标题和文件名，反过来也行', f => {
  f.work('被幹鬥士 瘋狂性愛！', '9001', 'A/被幹鬥士.mp4')
  f.work('哥布林农场', '9002', 'B/哥布林農場 第1話.mp4')
  const names = (keyword: string) => listVideos(f.db, { keyword }).map(item => item.name_zh).sort()
  assert.deepEqual(names('斗士'), ['被幹鬥士 瘋狂性愛！'])
  assert.deepEqual(names('疯狂性爱'), ['被幹鬥士 瘋狂性愛！'])
  assert.deepEqual(names('鬥士'), ['被幹鬥士 瘋狂性愛！'], '繁体关键词照样能搜')
  assert.deepEqual(names('农场'), ['哥布林农场'])
  assert.deepEqual(names('農場'), ['哥布林农场'], '关键词是繁体、标题是简体')
  assert.deepEqual(names('不存在'), [])
  assert.equal(simplifyZh('後編 體'), '后编 体')
})

await test('统一移动：绑定目录的作品整目录改名进「根 / 分组 / 作品」，散文件的走整理流程；已就位和目标已存在的不动', async f => {
  const libraryRoot = path.join(f.root, 'lib'); fs.mkdirSync(libraryRoot)
  // 1. 绑定了目录的作品（在 old/ 下），分组「催眠」
  const boundDir = path.join(f.root, 'old', '女友催眠 1-2'); fs.mkdirSync(boundDir, { recursive: true })
  const bound = registerVideoContent(f.db, { title: '女友催眠 1-2', directory: boundDir, root: path.join(f.root, 'old'),
    items: [1, 2].map(n => ({ title: '女友催眠 ' + n, number: n, order: n, sources: [f.source('80' + n)], files: [{ path: f.file('old/女友催眠 1-2/女友催眠 ' + n + '.mp4') }] })) }).resourceId
  updateVideo(f.db, bound, { collection_name: '催眠' })
  f.db.prepare("INSERT INTO video_scan_ignores (path, resource_id, source_key, created_at) VALUES (?, ?, '', 0)").run(path.join(boundDir, '花絮.mp4'), bound)
  // 2. 没绑定目录、只有散文件的作品，没分组 → 直接进根目录
  const loose = f.work('质点运动学', '9001', 'loose/1.质点运动学.mp4')
  // 3. 已经在目标位置的
  const placedDir = path.join(libraryRoot, '3D', '已就位'); fs.mkdirSync(placedDir, { recursive: true })
  const placed = registerVideoContent(f.db, { title: '已就位', directory: placedDir, root: libraryRoot, items: [{ title: '已就位', number: 1, order: 1, files: [{ path: f.file('lib/3D/已就位/a.mp4') }] }] }).resourceId
  updateVideo(f.db, placed, { collection_name: '3D' })
  // 4. 目标目录已被别的东西占了
  const blockedDir = path.join(f.root, 'old', '被占'); fs.mkdirSync(blockedDir)
  const blocked = registerVideoContent(f.db, { title: '被占', directory: blockedDir, root: path.join(f.root, 'old'), items: [{ title: '被占', number: 1, order: 1, files: [{ path: f.file('old/被占/b.mp4') }] }] }).resourceId
  fs.mkdirSync(path.join(libraryRoot, '被占'))

  const preview = previewVideoLayout(f.db, [bound, loose, placed, blocked], libraryRoot)
  const by = (id: string) => preview.entries.find(entry => entry.resourceId === id)!
  assert.equal(by(bound).action, 'move-directory'); assert.equal(by(bound).to, path.join(libraryRoot, '催眠', '女友催眠 1-2'))
  assert.equal(by(loose).action, 'move-files'); assert.equal(by(loose).to, path.join(libraryRoot, '质点运动学'))
  assert.equal(by(placed).action, 'in-place')
  assert.equal(by(blocked).action, 'skip'); assert.match(by(blocked).reason, /已存在/)
  assert.equal(preview.movable, 2)

  const result = await applyVideoLayout(f.db, [bound, loose, placed, blocked], libraryRoot, path.join(f.root, 'records'))
  assert.deepEqual(result.outcomes.map(o => [o.resourceId, o.ok]), [[bound, true], [loose, true], [placed, true], [blocked, false]])
  assert.ok(fs.existsSync(result.record))
  // 绑定目录：文件、清单、库里的路径、排除记录全都跟过去了
  const boundLibrary = getVideoWorkLibrary(f.db, bound)
  assert.equal(boundLibrary.directory?.path, by(bound).to)
  assert.equal(boundLibrary.directory?.root, libraryRoot)
  assert.equal(boundLibrary.directory?.relativePath, path.join('催眠', '女友催眠 1-2'))
  assert.ok(!fs.existsSync(boundDir))
  assert.ok(boundLibrary.assets.every(asset => asset.path.startsWith(by(bound).to + path.sep) && fs.existsSync(asset.path)))
  assert.equal(getVideo(f.db, bound)?.path, by(bound).to)
  assert.ok(readVideoBundle(by(bound).to), '清单写在新目录')
  assert.equal((f.db.prepare('SELECT path FROM video_scan_ignores WHERE resource_id = ?').get(bound) as any).path, path.join(by(bound).to, '花絮.mp4'))
  // 散文件：搬进了新目录并绑定，原文件已删
  const looseLibrary = getVideoWorkLibrary(f.db, loose)
  assert.equal(looseLibrary.directory?.path, by(loose).to)
  assert.ok(fs.existsSync(path.join(by(loose).to, '1.质点运动学.mp4')))
  assert.ok(!fs.existsSync(path.join(f.root, 'loose', '1.质点运动学.mp4')))
  assert.ok(!fs.existsSync(path.join(f.root, 'loose')), '搬空的原目录顺手删掉')
  // 再跑一遍：全部已就位
  const again = previewVideoLayout(f.db, [bound, loose, placed], libraryRoot)
  assert.ok(again.entries.every(entry => entry.action === 'in-place'), JSON.stringify(again.entries))
})

await test('统一移动：整理根目录不存在直接拒绝；跨盘的绑定目录标为不动', f => {
  assert.throws(() => previewVideoLayout(f.db, [], path.join(f.root, 'nope')), /不存在/)
  const dir = path.join(f.root, 'w'); fs.mkdirSync(dir)
  const id = registerVideoContent(f.db, { title: 'w', directory: dir, root: f.root, items: [{ title: 'w', number: 1, order: 1, files: [{ path: f.file('w/a.mp4') }] }] }).resourceId
  const otherDrive = path.parse(f.root).root.toLowerCase().startsWith('c') ? 'Z:\\lib' : 'C:\\Windows'
  if (process.platform === 'win32' && fs.existsSync(otherDrive)) {
    const preview = previewVideoLayout(f.db, [id], otherDrive)
    assert.equal(preview.entries[0].action, 'skip'); assert.match(preview.entries[0].reason, /跨磁盘/)
  }
})

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
