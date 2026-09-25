/**
 * 实测第四轮（2026-09-22）：统一移动补洞。内存库 + 临时目录，不碰用户资料库、不联网。
 *   1. 目标路径超过 240 字时自动截短文件名（用户那部作品的真实文件名 232 字）；
 *   2. 视频本体搬不过去（缺失 / 目录本身装不下）时整部作品标「不动」，不再搬两个配置文件就把目录绑过去；
 *   3. 「配置搬了、视频留在原地」的作品：日志随目录改名对齐，再统一移动一次会顺着日志把视频收进新目录；
 *   4. 绑定了目录但视频在外面：已就位的收文件，要改名的改名后再收；
 *   5. 有没收尾的整理日志、目标又不是当前目录的：标「不动」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { getVideo, updateVideo } from '../electron/kinds/video/db.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { applyVideoLayout, previewVideoLayout } from '../electron/kinds/video/layout.ts'
import { getVideoWorkLibrary } from '../electron/kinds/video/library.ts'
import { readVideoBundle, safeWorkFolderName } from '../electron/kinds/video/bundle.ts'
import { rebaseMovedVideoDirectory } from '../electron/kinds/video/local-files.ts'
import { persistVideoWorkBundle } from '../electron/kinds/video/local-sync.ts'
import { applyVideoOrganize, listVideoOrganizeJournal, pendingVideoOrganize, previewVideoOrganize } from '../electron/kinds/video/organize.ts'

// 用户 9-21 那部作品的真实文件名（不含扩展名 223 字，mp4 全名 232 字）和作品名；目录名会截到 90 字以内，拼起来仍超过 240
const LONG_STEM = '[Gerrry] 【Nefer_奈芙尔】_作战失败！高傲的蛇系美人沦为丘丘人部落的产奶母牛..._The battle failed! The proud snake-like beauty was reduced to a dairy cow for the Hilichurl tribe..._ [中文字幕]'
const LONG_TITLE = '[Gerrry] 【Nefer/奈芙爾】"作戰失敗！高傲的蛇系美人淪為丘丘人部落的產奶母牛...*The battle failed! The proud snake-like beauty was reduced to a dairy cow for the Hilichurl tribe..." [中文字幕]'
const SHORT_TITLE = '【奈芙爾】作戰失敗！高傲的蛇系美人淪為丘丘人部落的產奶母牛 [中文字幕]'

let passed = 0, failed = 0
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-round4-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); initSchema(db, KINDS)
  const file = (name: string, contents = 'synthetic media ' + name) => { const value = path.join(root, name); fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, contents); return value }
  const source = (code: string) => ({ provider: 'hanime', externalId: code, scope: 'episode' as const, pageUrl: 'https://hanime1.me/watch?v=' + code, evidence: 'confirmed' as const })
  const loose = (title: string, code: string, name: string, attachments: Array<{ path: string; role: 'attachment' | 'poster' | 'subtitle' }> = []) =>
    registerVideoContent(db, { title, items: [{ title, number: 1, order: 1, sources: [source(code)], files: [{ path: file(name), quality: '720p' }], attachments }] }).resourceId
  const records = path.join(root, 'records')
  const close = () => { db.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('baoyi-round4-')); fs.rmSync(root, { recursive: true, force: true }) }
  return { root, db, file, source, loose, records, close }
}
async function test(name: string, run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  if (filter && !name.includes(filter)) return
  const f = fixture()
  try { await run(f); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); passed++; console.log('PASS ' + name) }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.stack : error)) }
  finally { f.close() }
}
const videosOf = (f: ReturnType<typeof fixture>, id: string) => getVideoWorkLibrary(f.db, id).assets.filter(asset => asset.role === 'video')

await test('路径过长：目标文件名自动截短，232 字的视频能搬进截到 90 字的作品目录', async f => {
  const libraryRoot = path.join(f.root, 'lib'); fs.mkdirSync(libraryRoot)
  const id = f.loose(LONG_TITLE, '154773', '0913/154773/' + LONG_STEM + '_720P.mp4')
  const source = videosOf(f, id)[0].path
  f.file('0913/154773/.nomedia', '')
  updateVideo(f.db, id, { collection_name: '3D' })
  const preview = previewVideoLayout(f.db, [id], libraryRoot)
  const entry = preview.entries[0]
  assert.equal(entry.action, 'move-files', entry.reason)
  assert.ok(path.basename(entry.to).length <= 90 && (entry.to + path.sep + path.basename(source)).length > 240, '前提：目录截短后连上原文件名仍超过 240')
  const result = await applyVideoLayout(f.db, [id], libraryRoot, f.records)
  assert.equal(result.outcomes[0].ok, true, result.outcomes[0].message)
  const video = videosOf(f, id)[0]
  assert.ok(video.path.startsWith(entry.to + path.sep), video.path)
  assert.ok(video.path.length <= 240, '截短后不超过 240：' + video.path.length)
  assert.match(path.basename(video.path), /-[0-9a-f]{8}\.mp4$/)
  assert.ok(fs.existsSync(video.path)); assert.ok(!fs.existsSync(source), '移动后原件已删')
  assert.ok(!fs.existsSync(path.join(f.root, '0913', '154773')), '搬空的原目录顺手删掉')
  assert.equal(listVideoOrganizeJournal(f.db, id)[0].status, 'applied')
  assert.ok(readVideoBundle(entry.to), '清单写在新目录')
  assert.equal(getVideoWorkLibrary(f.db, id).directory?.path, entry.to)
  assert.equal(getVideo(f.db, id)?.video_type, 'movie', '单部电影只是搬文件，不会被改成剧集')
})

await test('视频本体搬不过去（文件缺失 / 目录本身装不下）：整部作品标「不动」，不会只搬配置就绑目录', async f => {
  const libraryRoot = path.join(f.root, 'lib'); fs.mkdirSync(libraryRoot)
  // 视频文件不见了、只有附件还在
  const missing = f.loose('文件不在了', '9001', 'A/文件不在了.mp4', [{ path: f.file('A/文件不在了.nfo', '<movie/>'), role: 'attachment' }])
  fs.rmSync(videosOf(f, missing)[0].path)
  // 只有附件不见了
  const attachment = f.loose('附件不在了', '9002', 'B/附件不在了.mp4', [{ path: f.file('B/附件不在了.nfo', '<movie/>'), role: 'attachment' }])
  fs.rmSync(path.join(f.root, 'B', '附件不在了.nfo'))
  // 整理根目录本身就深得装不下作品目录
  const deep = path.join(f.root, 'd'.repeat(120)); fs.mkdirSync(deep)
  const tooDeep = f.loose(LONG_TITLE, '9003', 'C/' + LONG_STEM + '_720P.mp4')

  const preview = previewVideoLayout(f.db, [missing, attachment], libraryRoot)
  const by = (id: string) => preview.entries.find(entry => entry.resourceId === id)!
  assert.equal(by(missing).action, 'skip'); assert.match(by(missing).reason, /视频文件搬不过去/)
  assert.equal(by(attachment).action, 'move-files', by(attachment).reason); assert.match(by(attachment).reason, /1 个附件有问题，会跳过/)
  const deepPreview = previewVideoLayout(f.db, [tooDeep], deep)
  assert.equal(deepPreview.entries[0].action, 'skip'); assert.match(deepPreview.entries[0].reason, /过长/)

  const result = await applyVideoLayout(f.db, [missing], libraryRoot, f.records)
  assert.equal(result.outcomes[0].ok, false)
  assert.equal(getVideoWorkLibrary(f.db, missing).directory, null, '没有绑定目录')
  assert.equal(listVideoOrganizeJournal(f.db).length, 0, '没有留下整理日志')
  assert.ok(fs.existsSync(path.join(f.root, 'A', '文件不在了.nfo')), '附件没被搬走')
})

await test('日志随目录改名对齐：「配置搬了、视频留在原地」的作品再统一移动一次，视频会顺着原日志收进新目录', async f => {
  const libraryRoot = path.join(f.root, 'lib'); fs.mkdirSync(path.join(libraryRoot, '3D'), { recursive: true })
  const id = f.loose(LONG_TITLE, '154773', '0913/154773/' + LONG_STEM + '_720P.mp4')
  const source = videosOf(f, id)[0].path
  f.file('0913/154773/.nomedia', '')
  updateVideo(f.db, id, { collection_name: '3D' })
  // 1. 复现第三轮留下的状态：目录名截到 90 字、视频「路径过长」没搬成、.nomedia 搬成了、作品绑到长目录、日志停在部分完成。
  //    现在的代码会把文件名截短，所以先把视频挪开让它失败，再把日志改写成当时那种记录（目标是长文件名 + unsafe-path 冲突）
  const longDir = path.join(libraryRoot, '3D', safeWorkFolderName(LONG_TITLE))
  fs.renameSync(source, source + '.away')
  const first = await applyVideoOrganize(f.db, { preview: previewVideoOrganize(f.db, { resourceIds: [id], survivorId: id, targetDirectory: longDir, root: libraryRoot, transfer: 'move' }), mode: 'physical' })
  fs.renameSync(source + '.away', source)
  assert.equal(first.status, 'partial')
  const row = f.db.prepare('SELECT data FROM video_organize_journal WHERE id = ?').get(first.id) as { data: string }
  const legacy = JSON.parse(row.data)
  const video = legacy.files.find((file: any) => file.status === 'failed')
  const longDestination = path.join(longDir, LONG_STEM + '_720P.mp4')
  assert.ok(longDestination.length > 240)
  video.destination = longDestination; video.relativePath = LONG_STEM + '_720P.mp4'; video.error = '目标路径过长，请选择更短的目录或文件名'
  legacy.preview.files.find((file: any) => file.id === video.id).destination = longDestination
  legacy.preview.collisions.push({ code: 'unsafe-path', scope: 'file', message: '目标路径过长，请选择更短的目录或文件名', fileId: video.id, path: longDestination })
  f.db.prepare('UPDATE video_organize_journal SET data = ? WHERE id = ?').run(JSON.stringify(legacy), first.id)
  assert.equal(getVideoWorkLibrary(f.db, id).directory?.path, longDir)
  assert.ok(fs.existsSync(source), '视频还在原地')
  // 2. 用户改短名字后统一移动（第三轮的整目录改名）：目录搬走了，日志还指着已经不存在的长目录
  const shortDir = path.join(libraryRoot, '3D', SHORT_TITLE)
  fs.renameSync(longDir, shortDir)
  rebaseMovedVideoDirectory(f.db, id, longDir, shortDir, libraryRoot)
  persistVideoWorkBundle(f.db, id, shortDir)
  updateVideo(f.db, id, { name_zh: SHORT_TITLE })
  assert.ok(fs.existsSync(source), '整目录改名不碰目录外的视频')
  // 3. 读日志时自动对齐到新目录，「路径过长」的冲突也解除了
  const healed = listVideoOrganizeJournal(f.db, id)[0]
  assert.equal(healed.status, 'partial')
  assert.equal(healed.targetDirectory, shortDir)
  assert.ok(healed.files.every(file => file.destination.startsWith(shortDir + path.sep)), JSON.stringify(healed.files.map(file => file.destination)))
  assert.ok(healed.files.every(file => file.destination.length <= 240), '对齐后重新截短了文件名')
  assert.ok(healed.warnings.some(warning => warning.includes('已按新目录对齐')))
  assert.equal(pendingVideoOrganize(f.db, id)?.id, healed.id)
  // 4. 统一移动：作品已就位但视频在外面 → 顺着这条日志重试，而不是另起一次（另起会被「还有未完成的整理」挡住）
  const preview = previewVideoLayout(f.db, [id], libraryRoot)
  assert.equal(preview.entries[0].action, 'move-files', preview.entries[0].reason)
  assert.equal(preview.entries[0].journal, healed.id)
  assert.match(preview.entries[0].reason, /继续上次未完成的整理（1 个文件未搬）/)
  assert.equal(preview.entries[0].to, shortDir)
  const result = await applyVideoLayout(f.db, [id], libraryRoot, f.records)
  assert.equal(result.outcomes[0].ok, true, result.outcomes[0].message)
  const moved = videosOf(f, id)[0]
  assert.ok(moved.path.startsWith(shortDir + path.sep) && fs.existsSync(moved.path), moved.path)
  assert.ok(moved.path.length <= 240)
  assert.ok(!fs.existsSync(source)); assert.ok(!fs.existsSync(path.join(f.root, '0913', '154773')), '搬空的原目录顺手删掉')
  assert.equal(listVideoOrganizeJournal(f.db, id)[0].status, 'applied')
  assert.equal(pendingVideoOrganize(f.db, id), undefined)
  assert.ok(readVideoBundle(shortDir)?.items.some(item => item.files.some(file => !path.isAbsolute(file.path) && fs.existsSync(path.join(shortDir, file.path)))), '清单里能找到视频')
  assert.ok(previewVideoLayout(f.db, [id], libraryRoot).entries.every(entry => entry.action === 'in-place'), '再跑一遍：已就位')
})

await test('绑定了目录但视频在外面：已就位的把视频收进来，要改名的改完名再收', async f => {
  const libraryRoot = path.join(f.root, 'lib'); fs.mkdirSync(libraryRoot)
  // 已就位：目录在 lib/催眠/女友催眠，视频却在 loose/ 里
  const placedDir = path.join(libraryRoot, '催眠', '女友催眠'); fs.mkdirSync(placedDir, { recursive: true })
  const placed = registerVideoContent(f.db, { title: '女友催眠', directory: placedDir, root: libraryRoot, items: [{ title: '女友催眠', number: 1, order: 1, sources: [f.source('801')], files: [{ path: f.file('loose/女友催眠 1.mp4') }] }] }).resourceId
  updateVideo(f.db, placed, { collection_name: '催眠' })
  // 要改名：目录在 old/呼吸，视频在 loose2/ 里，分组「纯Z爱」
  const oldDir = path.join(f.root, 'old', '呼吸'); fs.mkdirSync(oldDir, { recursive: true })
  const renamed = registerVideoContent(f.db, { title: '呼吸', directory: oldDir, root: path.join(f.root, 'old'), items: [{ title: '呼吸', number: 1, order: 1, sources: [f.source('802')], files: [{ path: f.file('loose2/呼吸 1.mp4') }] }] }).resourceId
  updateVideo(f.db, renamed, { collection_name: '纯Z爱' })
  const preview = previewVideoLayout(f.db, [placed, renamed], libraryRoot)
  const by = (id: string) => preview.entries.find(entry => entry.resourceId === id)!
  assert.equal(by(placed).action, 'move-files', by(placed).reason); assert.match(by(placed).reason, /1 个视频在作品目录外/); assert.equal(by(placed).to, placedDir)
  assert.equal(by(renamed).action, 'move-directory', by(renamed).reason); assert.match(by(renamed).reason, /1 个视频在作品目录外/); assert.equal(by(renamed).to, path.join(libraryRoot, '纯Z爱', '呼吸'))
  const result = await applyVideoLayout(f.db, [placed, renamed], libraryRoot, f.records)
  assert.deepEqual(result.outcomes.map(o => o.ok), [true, true], JSON.stringify(result.outcomes))
  assert.match(result.outcomes[1].message, /已移动整个作品目录.*搬进新目录/)
  assert.ok(videosOf(f, placed).every(asset => asset.path.startsWith(placedDir + path.sep) && fs.existsSync(asset.path)))
  assert.ok(videosOf(f, renamed).every(asset => asset.path.startsWith(by(renamed).to + path.sep) && fs.existsSync(asset.path)))
  assert.ok(!fs.existsSync(oldDir)); assert.ok(!fs.existsSync(path.join(f.root, 'loose'))); assert.ok(!fs.existsSync(path.join(f.root, 'loose2')))
  assert.equal(getVideoWorkLibrary(f.db, renamed).directory?.path, by(renamed).to)
  assert.ok(previewVideoLayout(f.db, [placed, renamed], libraryRoot).entries.every(entry => entry.action === 'in-place'))
})

await test('有没收尾的整理日志、目标又不是当前要去的目录：标「不动」，不再绕过日志直接改名', async f => {
  const libraryRoot = path.join(f.root, 'lib'); fs.mkdirSync(libraryRoot)
  const id = f.loose('监狱战舰', '9001', 'A/监狱战舰 1.mp4')
  const gone = f.file('A/花絮.mp4')
  f.db.prepare("INSERT INTO video_assets (id, resource_id, path, role, quality, file_size, state, checked_at, created_at) VALUES ('extra', ?, ?, 'video', '', 3, 'present', 0, 0)").run(id, gone)
  fs.rmSync(gone)
  const elsewhere = path.join(f.root, 'elsewhere', '监狱战舰'); fs.mkdirSync(path.dirname(elsewhere))
  const plan = previewVideoOrganize(f.db, { resourceIds: [id], survivorId: id, targetDirectory: elsewhere, root: path.join(f.root, 'elsewhere'), transfer: 'move' })
  assert.ok(plan.canOrganize && plan.collisions.some(c => c.code === 'missing'))
  const journal = await applyVideoOrganize(f.db, { preview: plan, mode: 'physical' })
  assert.equal(journal.status, 'partial')
  assert.equal(getVideoWorkLibrary(f.db, id).directory?.path, elsewhere)
  const preview = previewVideoLayout(f.db, [id], libraryRoot)
  assert.equal(preview.entries[0].action, 'skip'); assert.match(preview.entries[0].reason, /未完成的整理记录/)
  assert.ok(fs.existsSync(elsewhere), '目录没被改名')
  assert.equal(listVideoOrganizeJournal(f.db, id)[0].targetDirectory, elsewhere, '日志没被误对齐')
})

console.log(`\n${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
