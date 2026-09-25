const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-snapshot-check-'))
const script = path.join(__dirname, 'snapshot-live-db.cjs')
const source = path.join(root, 'source.sqlite')
const output = path.join(root, 'snapshot.sqlite')

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, APPDATA: root, BAOYI_DB: path.join(root, 'missing.sqlite') }
  })
}

function jobCount(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare('SELECT count(*) AS n FROM video_download_jobs').get().n }
  finally { db.close() }
}

try {
  const db = new DatabaseSync(source)
  db.exec('CREATE TABLE video_organize_journal (id TEXT, status TEXT, data TEXT); CREATE TABLE resource (id TEXT, path TEXT); CREATE TABLE video_download_jobs (id TEXT);')
  db.prepare('INSERT INTO video_download_jobs (id) VALUES (?)').run('fixture')
  db.close()

  const same = run(['--source', source, '--output', source])
  assert.notEqual(same.status, 0, 'same-file source and output must be rejected')
  assert.ok(fs.existsSync(source), 'rejecting the same file must not delete the source')
  assert.equal(jobCount(source), 1)

  const alias = path.join(root, 'same-file-alias.sqlite')
  fs.linkSync(source, alias)
  const linked = run(['--source', source, '--output', alias])
  assert.notEqual(linked.status, 0, 'a hard-linked output must be rejected')
  assert.ok(fs.existsSync(alias), 'rejecting a hard link must not unlink it')

  const ambiguous = run([source])
  assert.notEqual(ambiguous.status, 0, 'a positional path must not be accepted as the output')
  assert.ok(fs.existsSync(source), 'a positional source path must not be deleted')

  fs.writeFileSync(output, 'previous snapshot')
  const success = run(['--source', source, '--output', output])
  assert.equal(success.status, 0, success.stderr)
  const report = JSON.parse(success.stdout)
  assert.equal(report.target, output)
  assert.equal(report.jobs, 1)
  assert.equal(report.nefer, null)
  assert.equal(report.neferPath, null)
  assert.equal(jobCount(output), 1)
  assert.equal(jobCount(source), 1, 'creating the snapshot must not alter the source')
  console.log('Snapshot source safety: 4 passed, 0 failed')
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('baoyi-snapshot-check-'))
  fs.rmSync(root, { recursive: true, force: true })
}
