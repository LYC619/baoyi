const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const directory = path.resolve(process.argv[2] || path.join(root, 'release', pkg.version, 'win-unpacked'))
const archive = path.join(directory, 'resources/app.asar')
const packed = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packed.version, pkg.version)
assert.equal(packed.name, pkg.name)
assert.ok(fs.existsSync(path.join(directory, pkg.productName + '.exe')))
assert.ok(!fs.existsSync(path.join(directory, 'portable.txt')))
assert.ok(!fs.existsSync(path.join(directory, 'data')))
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'))
assert.ok(entries.every(name => !/\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(name)))
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), file)
    return entry.isDirectory() ? files(file) : [file]
  })
}
let compiledFiles = 0
for (const folder of ['dist', 'dist-electron']) {
  for (const file of files(path.join(root, folder))) {
    const name = path.relative(root, file)
    assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(file), name)
    compiledFiles++
  }
}
for (const [source, target] of [
  ['resources/save-manifest.json', 'save-manifest.json'],
  ['node_modules/mediainfo.js/dist/MediaInfoModule.wasm', 'MediaInfoModule.wasm']
]) assert.deepEqual(fs.readFileSync(path.join(directory, 'resources', target)), fs.readFileSync(path.join(root, source)))
assert.ok(fs.statSync(path.join(directory, 'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node')).size > 0)
console.log(JSON.stringify({ version: pkg.version, directory, compiledFiles, asarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), nativeDatabase: true, mediaInfoWasm: true, dataMode: 'appdata' }, null, 2))
