// 本地手工工具：只读源库（含 WAL），生成供打包产物排练的快照；不会进入应用包。
//   node scripts/snapshot-live-db.cjs [--source 源库] [--output 快照输出]
// 源库默认取 BAOYI_DB 或 %APPDATA%\抱一\baoyi.db；输出默认在系统临时目录。
const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let source = process.env.BAOYI_DB || path.join(process.env.APPDATA || '', '抱一', 'baoyi.db')
let target = path.join(os.tmpdir(), 'baoyi-round4-snapshot', 'baoyi.db')
const seen = new Set()
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i]
  const value = process.argv[i + 1]
  if (!['--source', '--output'].includes(option) || !value || value.startsWith('--') || seen.has(option)) {
    throw new Error('用法：node scripts/snapshot-live-db.cjs [--source 源库] [--output 快照输出]')
  }
  seen.add(option)
  if (option === '--source') source = value
  else target = value
}

source = fs.realpathSync(source)
target = path.resolve(target)
const sourceStat = fs.statSync(source)
if (!sourceStat.isFile()) throw new Error('源库不是文件：' + source)
const targetStat = fs.lstatSync(target, { throwIfNoEntry: false })
if (targetStat?.isSymbolicLink()) throw new Error('快照输出不能是符号链接：' + target)
if (targetStat && !targetStat.isFile()) throw new Error('快照输出不是文件：' + target)
if (process.platform === 'win32' ? source.toLowerCase() === target.toLowerCase() : source === target) {
  throw new Error('源库与快照输出不能是同一文件')
}
if (targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
  throw new Error('源库与快照输出不能是同一文件')
}

fs.mkdirSync(path.dirname(target), { recursive: true })
const staging = path.join(path.dirname(target), `.baoyi-snapshot-${randomUUID()}.sqlite`)
try {
  const live = new DatabaseSync(source, { readOnly: true })
  try {
    live.exec(`VACUUM INTO '${staging.replace(/\\/g, '/').replace(/'/g, "''")}'`)
  } finally {
    live.close()
  }
  fs.renameSync(staging, target)
} finally {
  fs.rmSync(staging, { force: true })
}

const copy = new DatabaseSync(target, { readOnly: true })
try {
  const out = {
    target,
    journals: copy.prepare('SELECT count(*) c FROM video_organize_journal').get().c,
    nefer: copy.prepare("SELECT status, json_extract(data, '$.targetDirectory') AS target FROM video_organize_journal WHERE id = '8f07605e-f5db-4864-b50c-85fc885c7b67'").get() ?? null,
    neferPath: copy.prepare("SELECT path FROM resource WHERE id = '944c2c34-766b-4648-8a4e-661cb30776a5'").get()?.path ?? null,
    jobs: copy.prepare('SELECT count(*) c FROM video_download_jobs').get().c
  }
  console.log(JSON.stringify(out, null, 2))
} finally {
  copy.close()
}
