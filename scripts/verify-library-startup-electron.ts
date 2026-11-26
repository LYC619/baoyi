import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_KEY } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { loadPlaywright, electronTestEnv } from './helpers/playwright.ts'
const output = path.resolve('output/image-optimization/startup-safety'); fs.mkdirSync(output, { recursive: true })
const env = electronTestEnv()
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
  assert.equal(message.windows, 0); assert.match(message.title, /安全启动|failed to start safely/); assert.ok(message.content.includes(profile))
  assert.deepEqual(fs.readFileSync(file), before, mode + ' must leave the original database untouched')
  console.log('PASS real Electron startup failure: ' + mode)
}

// Disconnect a local fixture endpoint; never change the user's network or call a real model.
{
  let connections = 0
  const endpoint = net.createServer(socket => { connections++; socket.destroy() })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  const port = (endpoint.address() as net.AddressInfo).port
  const profile = fs.mkdtempSync(path.join(output, 'network-error-'))
  const db = new DatabaseSync(path.join(profile, 'baoyi.db')); initSchema(db, KINDS)
  for (const [key, value] of Object.entries({ onboarded: true, hanime_builtin_hosts: false, video_updates_weekly: false,
    ai: { enabled: true, api_url: `http://127.0.0.1:${port}/v1`, api_key: 'fixture-only', model: 'offline-fixture' } })) {
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value))
  }
  db.close()
  const { _electron } = loadPlaywright()
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [path.resolve('.'), '--user-data-dir=' + profile, '--disable-gpu'], env })
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.locator('.titlebar').waitFor()
    await page.evaluate(() => { location.hash = '/settings?scope=global&tab=ai' })
    await page.getByTitle('拉取模型列表', { exact: true }).click()
    await page.locator('.toast--error').first().waitFor()
    const message = await page.locator('.toast--error').first().innerText()
    assert.ok(connections > 0, 'the panel must attempt a real request to the disconnected endpoint')
    assert.match(message, /fetch|网络|连接|失败/i)
    await page.evaluate(() => { void Promise.reject(new Error('fixture unhandled rejection')) })
    await page.locator('.toast--error').filter({ hasText: 'fixture unhandled rejection' }).waitFor()
    fs.writeFileSync(path.join(profile, 'error-notifications.json'), JSON.stringify({ networkMessage: message, connections, globalRejectionVisible: true }, null, 2))
    console.log('PASS disconnected network panel and global rejected promise show visible errors')
  } finally {
    await app?.close()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
  }
}
