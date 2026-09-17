/** Real Electron bootstrap and SQLite, with a synthetic checkout and isolated profile. */
const electron = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

if (!electron.app) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const mode of ['default', 'explicit']) {
    const child = require('node:child_process').spawnSync(electron, [__filename, '--storage-mode=' + mode], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 })
    if (child.error) console.error(child.error.message)
    if (child.status !== 0) process.exit(child.status || 1)
  }
  process.exit(0)
}

const { app, nativeImage } = electron
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-poster-native-'))
const profile = path.join(root, 'profile'), project = path.join(root, 'checkout')
fs.mkdirSync(profile)
for (const folder of ['src', 'electron', 'release/win-unpacked/resources']) fs.mkdirSync(path.join(project, folder), { recursive: true })
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'baoyi' }))
const mode = process.argv.find(value => value.startsWith('--storage-mode='))?.split('=')[1]
app.setPath('userData', profile); app.setPath('sessionData', profile); app.setPath('logs', path.join(profile, 'logs'))
// Simulate this executable's installation directory while retaining real Electron APIs.
app.getAppPath = () => path.join(project, 'release/win-unpacked/resources/app.asar')
if (mode === 'explicit') app.commandLine.appendSwitch('user-data-dir', profile)
const repository = path.resolve(__dirname, '..')
const moduleFile = path.join(repository, 'output/video-field-retest-20260913/native-storage-module.cjs')
require('esbuild').buildSync({
  stdin: { contents: [
    "export { getDb, closeDb, postersDir } from './electron/services/database.ts'",
    "export { initSchema } from './electron/services/schema.ts'",
    "export { KINDS } from './electron/kinds/index.ts'",
    "export { setVideoPoster, getVideoItem } from './electron/kinds/video/service.ts'"
  ].join('\n'), resolveDir: repository, loader: 'ts' }, outfile: moduleFile,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3']
})
let api
app.whenReady().then(() => {
  api = require(moduleFile)
  const Database = require('better-sqlite3'), dbFile = path.join(profile, 'baoyi.db')
  // 缓存现在固定在 userData/posters。默认模式下旧版本留在项目 data/posters 的图要被搬回来；
  // 显式 --user-data-dir 从没用过项目目录，图本来就在 userData 里，启动迁移应当跳过。
  const target = path.join(profile, 'posters')
  const old = mode === 'explicit' ? path.join(target, 'old.png') : path.join(project, 'data', 'posters', 'old.png')
  fs.mkdirSync(path.dirname(old), { recursive: true })
  const oldImage = nativeImage.createFromBitmap(Buffer.alloc(80 * 120 * 4, 140), { width: 80, height: 120 }).toPNG()
  fs.writeFileSync(old, oldImage)
  const seed = new Database(dbFile)
  api.initSchema(seed, api.KINDS)
  seed.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh) VALUES ('fixture','video',0,0,?,'fixture.mp4','原生迁移示例')").run(path.join(root, 'fixture.mp4'))
  seed.prepare("INSERT INTO video_meta(resource_id,poster_path) VALUES ('fixture',?)").run(old)
  seed.prepare("INSERT INTO episode(id,resource_id,season,episode,poster_path) VALUES ('episode','fixture',0,1,?)").run(old)
  seed.close()
  const db = api.getDb()
  assert.equal(app.getPath('userData'), profile)
  assert.equal(api.postersDir(), target)
  const migrated = db.prepare("SELECT poster_path FROM video_meta WHERE resource_id='fixture'").get().poster_path
  assert.equal(path.dirname(migrated), target)
  assert.ok(fs.readFileSync(migrated).equals(oldImage))
  assert.equal(db.prepare("SELECT poster_path FROM episode WHERE id='episode'").get().poster_path, migrated)
  assert.equal(fs.existsSync(old), mode === 'explicit', '默认模式下项目目录里的旧副本应在校验后删除')
  assert.equal(fs.existsSync(path.join(project, 'data', 'posters')), false, '搬空后的项目缓存目录应被移除')
  assert.equal(nativeImage.createFromPath(migrated).getSize().width, 80)
  const selected = path.join(root, 'selected.png')
  fs.writeFileSync(selected, nativeImage.createFromBitmap(Buffer.alloc(100 * 150 * 4, 90), { width: 100, height: 150 }).toPNG())
  assert.equal(api.setVideoPoster('fixture', selected).ok, true)
  assert.equal(path.dirname(api.getVideoItem('fixture').poster_path), target)
  assert.ok(fs.existsSync(selected), 'choosing artwork preserves the user original')
  api.closeDb()
  assert.equal(path.dirname(api.getDb().prepare("SELECT poster_path FROM video_meta WHERE resource_id='fixture'").get().poster_path), target)
  api.closeDb()
  console.log('PASS native poster storage: ' + mode + ' profile, startup migration, image decode, manual selection and reopen')
}).catch(cause => { console.error(cause); process.exitCode = 1 }).finally(() => {
  api?.closeDb()
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('baoyi-poster-native-'))
  fs.rmSync(root, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
})
