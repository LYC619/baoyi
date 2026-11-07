import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron } from 'playwright'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'

const executable = path.resolve(process.argv[2]), output = path.resolve('output/optimization-2026-10-29')
const profile = fs.mkdtempSync(path.join(output, 'icons-')), db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS)
for (const [key, value] of Object.entries({ onboarded: true, hanime_builtin_hosts: false })) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value))
db.close()
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const application = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile, '--disable-gpu'], env })
try {
  const page = await application.firstWindow(); await page.locator('.app__view').waitFor()
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile)
  await application.evaluate(({ app, dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    // Prove the bundled PE decoder works; a Windows icon fallback cannot hide a missing resedit dependency.
    app.getFileIcon = async () => { throw new Error('Shell fallback disabled in PE acceptance') }
  }, executable)
  const added = await page.evaluate(() => window.baoyi.software.addManual())
  assert.equal(added.length, 1)
  const item = await page.evaluate(id => window.baoyi.software.get(id), added[0].id)
  assert.ok(item?.icon_path && fs.existsSync(item.icon_path))
  const bytes = fs.readFileSync(item.icon_path)
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  assert.ok(width >= 256 && height >= 256)
  const rendered = await page.evaluate(async name => {
    const image = new Image(); image.src = 'baoyi://icon/' + name; await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight }
  }, path.basename(item.icon_path))
  assert.deepEqual(rendered, { width, height })
  const result = { status: 'passed', executable, profile, pngBytes: bytes.length, width, height, checks: ['packaged-resedit-extracts-PE-icon-without-shell-fallback', 'native-baoyi-icon-protocol-renders-png'] }
  fs.writeFileSync(path.join(output, 'packaged-icons.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await application.close() }
