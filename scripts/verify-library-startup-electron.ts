import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
const output = path.resolve('output/image-optimization/startup-safety'); fs.mkdirSync(output, { recursive: true })
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
for (const mode of ['blocked-snapshot-directory', 'corrupt-database', 'future-schema']) {
  const profile = fs.mkdtempSync(path.join(output, mode + '-')), file = path.join(profile, 'baoyi.db'), result = path.join(profile, 'error-dialog.json'), entry = path.join(profile, 'rehearsal.cjs')
  if (mode === 'corrupt-database') fs.writeFileSync(file, 'corrupt database sentinel')
  else {
    const db = new DatabaseSync(file); initSchema(db, KINDS)
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(mode === 'future-schema' ? '99' : '11', SCHEMA_KEY); db.close()
    if (mode === 'blocked-snapshot-directory') fs.writeFileSync(path.join(profile, 'library-snapshots'), 'blocking file sentinel')
  }
  const before = fs.readFileSync(file)
  // Only replace the native error-dialog boundary; execute the actual bundled startup code.
  fs.writeFileSync(entry, `const {app,dialog,BrowserWindow}=require('electron');const fs=require('node:fs');app.getVersion=()=>${JSON.stringify(JSON.parse(fs.readFileSync('package.json', 'utf8')).version)};dialog.showErrorBox=(title,content)=>fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({title,content,windows:BrowserWindow.getAllWindows().length}));require(${JSON.stringify(path.resolve('dist-electron/main.js'))});`)
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [entry, '--user-data-dir=' + profile, '--disable-gpu'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stderr.on('data', chunk => { log = (log + chunk).slice(-12000) }); child.stdout.on('data', chunk => { log = (log + chunk).slice(-12000) })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(mode + ' startup did not stop')) }, 20000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', code => { clearTimeout(timer); resolve(code) })
  })
  fs.writeFileSync(path.join(profile, 'process.log'), log)
  assert.equal(code, 1, mode + ' must stop startup')
  const message = JSON.parse(fs.readFileSync(result, 'utf8'))
  assert.equal(message.windows, 0); assert.match(message.title, /安全启动/); assert.ok(message.content.includes(profile))
  assert.deepEqual(fs.readFileSync(file), before, mode + ' must leave the original database untouched')
  console.log('PASS real Electron startup failure: ' + mode)
}
