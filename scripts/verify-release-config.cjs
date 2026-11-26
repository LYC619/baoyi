const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const yaml = require('js-yaml')

const root = path.resolve(__dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const base = yaml.load(read('electron-builder.yml'))
const portable = yaml.load(read('electron-builder.portable.yml'))
const green = yaml.load(read('electron-builder.green.yml'))

test('package and lockfile identify the same release', () => {
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
})

test('standard build keeps AppData and a versioned output directory', () => {
  assert.equal(base.directories.output, 'release/${version}')
  assert.equal(base.extraFiles, undefined)
})

test('portable build extends the base with a separate versioned directory', () => {
  assert.equal(portable.extends, './electron-builder.yml')
  assert.equal(portable.directories.output, 'release/${version}-portable')
  assert.ok(portable.extraFiles.some(file => file.to === 'portable.txt'))
  for (const file of portable.extraFiles) assert.ok(fs.existsSync(path.join(root, file.from)))
})

test('green ZIP cannot overwrite the standard build', () => {
  assert.equal(green.extends, './electron-builder.portable.yml')
  assert.equal(green.directories.output, 'release/${version}-green')
  assert.equal(green.win.target[0].target, 'zip')
})

test('build commands select one config and use the installed Electron runtime', () => {
  assert.ok(pkg.scripts['dist:portable'].includes('--config electron-builder.portable.yml'))
  assert.ok(pkg.scripts['dist:green'].includes('--config electron-builder.green.yml'))
  for (const name of ['dist', 'dist:dir', 'dist:portable', 'dist:green']) {
    assert.ok(!pkg.scripts[name].includes('--config.extends'), name)
    assert.ok(!/release\/\d/.test(pkg.scripts[name]), name)
    assert.ok(pkg.scripts[name].includes('--config.electronDist=node_modules/electron/dist'), name)
  }
})


test('public export contains the product and site without private working data', async () => {
  const { publicFiles, publicPackage } = await import('./export-public.mjs')
  const files = await publicFiles(root)
  for (const required of ['package.json','README.en.md','src/i18n/en.json','docs/site/en/guide.md','docs/site/zh-CN/guide.md','.github/workflows/pages.yml','scripts/build-site.mjs']) assert.ok(files.includes(required), required)
  for (const file of files) assert.ok(!/^(?:\.user|data|archive|reference|release|output|\.git)\//.test(file), file)
  assert.ok(!files.includes('AGENTS.md'))
  assert.ok(!files.includes('.npmrc'))
  for (const file of ['register-baoyi-project.ts','repair-video-actual-collection.ts','snapshot-live-db.cjs','verify-game-projects-ui.ts','verify-game-covers-packaged.ts']) assert.ok(!files.includes('scripts/'+file), file)
  assert.ok(!files.some(file => /(?:\.env(?:\.|$)|\.(?:db|sqlite|log)$)/i.test(file)))
  const originalScripts = JSON.stringify(pkg.scripts)
  const exported = publicPackage(pkg, files)
  assert.equal(exported.scripts.build, pkg.scripts.build)
  assert.ok(!('inspect' in exported.scripts))
  assert.ok(!('probe-icons' in exported.scripts))
  assert.equal(JSON.stringify(pkg.scripts), originalScripts, 'Source package remains untouched')
})
