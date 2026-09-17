/**
 * Isolated real SQLite regression suite; never opens an application profile.
 * node --experimental-strip-types --no-warnings scripts/verify-library-backup.ts
 * For the production driver, use Electron in ELECTRON_RUN_AS_NODE=1 mode with
 * the same flags and --better-sqlite3. Wait for the process and capture stdout.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_VERSION, type SqlDb } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createVideoJobStore, VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { applyVideoOrganize, listVideoOrganizeJournal, previewVideoOrganize } from '../electron/kinds/video/organize.ts'
import type { VideoDownloadJob } from '../src/types/video-workflow.ts'
import { LIBRARY_BACKUP_LIMITS, type LibraryBackup } from '../src/types/library-backup.ts'
import { buildLibraryBackup, previewLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'

const expectedTables = [
  'resource', 'software_meta', 'game_meta', 'video_meta', 'episode', 'video_sources',
  'video_directories', 'video_assets', 'video_episode_assets', 'video_download_jobs',
  'task_records', 'video_organize_journal', 'video_scan_state', 'video_scan_ignores', 'video_detached_owners', 'categories', 'tags', 'organize_plans',
  'save_backups', 'scan_units', 'pending_software', 'skip_list', 'identify_logs', 'identification_reports'
] as const
type FixtureRow = Record<string, string | number | null>
type FixtureDb = SqlDb & { close(): void }
const useBetterSqlite = process.argv.includes('--better-sqlite3')
const openFixture: () => FixtureDb = useBetterSqlite
  ? () => new (createRequire(import.meta.url)('better-sqlite3'))(':memory:')
  : () => new DatabaseSync(':memory:')
const stamp = 1_780_000_000_000
let passed = 0
let failed = 0

function fresh(): FixtureDb {
  const db = openFixture()
  db.exec('PRAGMA foreign_keys = ON')
  initSchema(db, KINDS)
  // The real job store creates this table separately from initSchema.
  db.exec(VIDEO_JOBS_SQL)
  return db
}

async function test(name: string, run: (source: FixtureDb, target: FixtureDb) => void | Promise<void>) {
  const source = fresh(), target = fresh()
  try { await run(source, target); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
  finally { source.close(); target.close() }
}

function rows(db: SqlDb, table: string): FixtureRow[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row => ({ ...row as FixtureRow }))
}

function insert(db: SqlDb, table: string, row: FixtureRow): void {
  const columns = Object.keys(row)
  db.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c]))
}

function databaseState(db: SqlDb): string {
  const objects = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as Array<{ type: string; name: string }>
  return JSON.stringify({
    objects,
    data: objects.filter(o => o.type === 'table').map(o => [o.name, db.prepare(`SELECT rowid, * FROM "${o.name}" ORDER BY rowid`).all()])
  })
}

function rejectUnchanged(db: SqlDb, input: unknown, reason?: RegExp): void {
  const before = databaseState(db)
  for (const run of [previewLibraryBackup, restoreLibraryBackup]) {
    if (reason) assert.throws(() => run(db, input), reason)
    else assert.throws(() => run(db, input))
    assert.equal(databaseState(db), before, `${run.name} must roll back every covered table, setting and sequence`)
  }
}

function traced(db: SqlDb): { db: SqlDb; statements: string[] } {
  const statements: string[] = []
  return { statements, db: {
    exec(sql) { statements.push(sql); db.exec(sql) },
    prepare(sql) { statements.push(sql); return db.prepare(sql) }
  } }
}

function jobFixture(status: VideoDownloadJob['status'] = 'success'): VideoDownloadJob {
  return {
    id: 'download-71', resourceId: 'series-51', bundleId: 'bundle-51', title: '手动片名',
    category: '自建分类', videoCode: '0071', root: 'Z:\\library-backup-fixture',
    directory: 'Z:\\library-backup-fixture\\series', sourceLabel: '2160p', strictQuality: true,
    register: true, status, createdAt: stamp, updatedAt: stamp + 20, message: '保留完整任务资料',
    description: '原始简介', posterUrl: 'https://example.invalid/poster.jpg', posterPath: '',
    sources: [{ provider: 'fixture', externalId: '0071', scope: 'episode', pageUrl: 'https://example.invalid/0071', evidence: 'confirmed' }],
    items: [{ videoCode: '0071', title: '第一集', order: 1, path: 'Z:\\library-backup-fixture\\series\\4k.mp4',
      sourceLabel: '2160p', transfer: 'complete', metadata: 'complete', registration: 'complete',
      receivedBytes: 98765, totalBytes: 98765, error: '', warnings: ['原始提示'] }],
    warnings: ['任务提示'], retryStage: 'metadata'
  }
}

function seed(db: SqlDb): void {
  for (const [id, kind, file] of [
    ['software-17', 'software', 'tool.exe'], ['game-23', 'game', 'game.exe'],
    ['movie-42', 'video', 'movie.mkv'], ['series-51', 'video', 'series']
  ]) {
    insert(db, 'resource', { id, kind, created_at: stamp, updated_at: stamp + 1,
      path: `Z:\\library-backup-fixture\\${file}`, file_name: file, icon_path: null,
      file_size: 87654, source_dir: 'Z:\\library-backup-fixture', name_zh: '手动片名-' + id,
      name_en: 'Manual title', summary: '摘要', description: '用户说明', category: '自建分类',
      tags: '["私有标签","中文"]', official_url: 'https://example.invalid', ai_status: 'done',
      why_choose: '选择依据', use_cases: '用途', notes: '不能丢失的手动笔记', alternatives: '[]',
      mastery_level: 'familiar', last_used_at: stamp - 100, use_count: 19, is_archived: 0, external_active_at: stamp - 200 })
  }
  insert(db, 'software_meta', { resource_id: 'software-17', file_description: '工具描述', company: '作者',
    version: '2.7', launchers: '[{"path":"tool.exe","label":"手动启动项"}]', is_portable: null, move_risk: 'unknown', link_target: '' })
  insert(db, 'game_meta', { resource_id: 'game-23', play_status: 'playing', total_playtime_sec: 12345,
    last_played_at: stamp - 50, save_paths: '[{"path":"Z:\\\\fixture-save","verified_at":1780000000000}]',
    linked_files: '[{"path":"guide.pdf","label":"攻略","type":"guide"}]', cover_path: 'cover.png',
    background_path: 'background.png', cover_source: 'manual', cover_source_url: '', cover_status: 'ready',
    cover_detail: '用户指定', identity_name: '游戏名', identity_query: 'game', identity_confirmed: 1 })
  for (const [resource_id, video_type, watch_status, position_sec] of [
    ['movie-42', 'movie', 'watched', 713], ['series-51', 'series', 'watching', 0]
  ] as const) {
    insert(db, 'video_meta', { resource_id, video_type, watch_status, position_sec, duration_sec: 7200,
      last_watched_at: stamp - 10, poster_path: 'poster.jpg', poster_source: 'https://example.invalid/poster.jpg',
      thumbnail_path: 'preview.png', thumbnail_source: 'https://example.invalid/preview.png',
      collection_name: '手动合集', fanart_path: '', year: 2024, end_year: 2025, rating: 8.75,
      resolution: '2160p', video_codec: 'HEVC', source: 'BluRay', release_group: 'fixture',
      audio_tracks: '[{"language":"zh","codec":"AAC"}]', subtitle_tracks: '[{"language":"zh"}]',
      parts: '[]', linked_files: '[{"path":"notes.txt","label":"资料"}]', tmdb_id: '0088', imdb_id: 'tt0012',
      douban_id: '0011', douban_rating: 9.1, hanime_id: '', original_description: '完整原始简介',
      hanime_tags: '["站方标签"]', user_edited: '["name_zh","category","collection_name","description"]' })
  }
  insert(db, 'episode', { id: 'episode-61', resource_id: 'series-51', season: 2, episode: 3,
    published_at: Date.UTC(2026, 7, 28), studio: 'Fixture Studio',
    title: '手动集名', display_label: '特别篇 三', path: 'Z:\\library-backup-fixture\\series\\4k.mp4',
    tags: '["独立单集标签"]', poster_source: 'https://example.invalid/episode-cover.png', thumbnail_path: 'episode-preview.png', thumbnail_source: 'https://example.invalid/episode-preview.png',
    file_size: 98765, duration_sec: 1800, watch_status: 'watching', position_sec: 321,
    watched_at: stamp - 5, air_date: stamp - 50000 })
  insert(db, 'video_scan_state', { path: 'Z:\\library-backup-fixture\\movie.mkv', fingerprint: 'known-file-stamp', resource_id: 'movie-42', updated_at: stamp })
  insert(db, 'video_scan_ignores', { path: 'Z:\\library-backup-fixture\\removed.mp4', resource_id: 'series-51', source_key: '', created_at: stamp })
  insert(db, 'video_detached_owners', { resource_id: 'movie-42' })
  insert(db, 'episode', { id: 'episode-62', resource_id: 'series-51', season: 2, episode: 4,
    title: '缺失的一集', path: '', watch_status: 'unwatched' })
  for (const [id, quality, path, role] of [
    ['asset-1080', '1080p', '1080.mp4', 'video'], ['asset-2160', '2160p', '4k.mp4', 'video'],
    ['asset-subtitle', 'zh', 'zh.srt', 'subtitle']
  ]) {
    insert(db, 'video_assets', { id, resource_id: 'series-51', path: `Z:\\library-backup-fixture\\series\\${path}`,
      role, quality, file_size: 98765, state: 'offline', checked_at: stamp, created_at: stamp - 1 })
    insert(db, 'video_episode_assets', { episode_id: 'episode-61', asset_id: id })
  }
  for (const [id, provider, external_id, episode_id, scope] of [
    ['source-work', 'tmdb', '00051', null, 'work'], ['source-ep', 'fixture', '0071', 'episode-61', 'episode'],
    ['source-mirror', 'mirror', '0071-alt', 'episode-61', 'episode']
  ]) insert(db, 'video_sources', { id, resource_id: 'series-51', episode_id, provider, external_id, scope,
    page_url: 'https://example.invalid/watch', evidence: 'confirmed', confirmed: 1, created_at: stamp, updated_at: stamp + 2 })
  insert(db, 'video_directories', { resource_id: 'series-51', bundle_id: 'bundle-51', root: 'Z:\\library-backup-fixture',
    relative_path: 'series', directory_path: 'Z:\\library-backup-fixture\\series', metadata_state: 'complete', created_at: stamp, updated_at: stamp + 2 })
  const job = jobFixture()
  insert(db, 'video_download_jobs', { id: job.id, status: job.status, updated_at: job.updatedAt, payload: JSON.stringify(job) })
  insert(db, 'task_records', { id: 'task-81', kind: 'video-scan', title: '完整任务记录', status: 'failed',
    started_at: stamp, finished_at: stamp + 42, processed: 7, total: 11, percent: 64,
    current: '当前路径', message: '任务消息', error: '详细错误', events: '[{"at":1780000000001,"level":"warn","message":"保留事件"}]' })
  insert(db, 'categories', { id: 'custom-category', kind: 'video', name: '自建分类', description: '自定义说明', icon: 'Film', sort_order: -2 })
  insert(db, 'tags', { id: 9001, kind: 'video', name: '私有标签', source: 'confirmed', created_at: stamp })
  insert(db, 'organize_plans', { id: 'plan-91', created_at: stamp, root: 'Z:\\fixture-before', undone_at: 0,
    steps: '[{"id":"software-17","action":"move","from":"Z:\\\\before","to":"Z:\\\\after","ok":true}]' })
  insert(db, 'save_backups', { id: 'save-orphan', resource_id: 'removed-game', save_path: 'Z:\\fixture-save',
    backup_dir: 'Z:\\fixture-copy', size_bytes: 4321, file_count: 7, created_at: stamp })
  insert(db, 'scan_units', { dir: 'Z:\\fixture-unit', root: 'Z:\\fixture', exe_count: 4, loose_only: 0,
    status: 'done', note: '识别说明', registered: 2, created_at: stamp, updated_at: stamp + 3 })
  insert(db, 'pending_software', { id: 'pending-92', created_at: stamp, scan_unit_id: 'Z:\\fixture-unit',
    exe_path: 'Z:\\fixture-pending.exe', file_name: 'pending.exe', name_zh: '待确认', tags: '["待确认标签"]',
    new_category: 1, new_tags: '["新标签"]', launchers: '[]', is_portable: null, move_risk: 'unknown' })
  insert(db, 'skip_list', { exe_path: 'Z:\\fixture-skip.exe', label: '明确跳过', source_dir: 'Z:\\fixture', created_at: stamp })
  insert(db, 'identify_logs', { id: 'log-93', dir: 'Z:\\removed-unit', label: '识别日志', kind: 'manual',
    resource_kind: 'game', status: 'success', summary: '完整日志', registered: 2, rounds: 3, duration_ms: 42,
    tokens: 123, stop_reason: 'done', events: '[{"type":"message","text":"原始事件"}]', created_at: stamp })
  insert(db, 'identification_reports', { id: 'report-94', created_at: stamp, resource_kind: 'game', processed: 5,
    registered: 2, skipped: 1, failed: 2, duration_ms: 77, tokens: 123, searches: 4, entries: '[{"dir":"Z:\\\\fixture","status":"success"}]' })
  const snapshot = Object.fromEntries(['resource', 'video_meta', 'episode', 'video_sources', 'video_assets', 'video_episode_assets', 'video_directories'].map(t => [t, rows(db, t)]))
  const journal = { version: 1, id: 'journal-95', kind: 'organize', mode: 'logical', status: 'applied',
    survivorId: 'removed-work', sourceIds: ['removed-work'], createdAt: stamp, updatedAt: stamp + 10,
    targetDirectory: '', preview: { kind: 'organize', request: { resourceIds: ['removed-work'], survivorId: 'removed-work' },
      fingerprint: 'fixture', works: [], survivor: { resourceId: 'removed-work', name: '历史作品', path: '', notes: '', archived: false,
        watchStatus: 'watched', positionSec: 0, directory: null, fileIds: [] }, targetDirectory: '', root: '',
      bundleId: '', episodes: [], files: [], collisions: [], warnings: [], canMerge: true, canOrganize: false },
    snapshot, files: [], warnings: ['保留的警告'], conflicts: [], changes: [{ table: 'video_meta',
      key: { resource_id: 'series-51' }, before: { watch_status: 'unwatched' }, after: { watch_status: 'watching' } }],
    logicalApplied: true, bound: false, manifest: { before: null, beforeHash: '', afterHash: '' } }
  insert(db, 'video_organize_journal', { id: journal.id, resource_id: journal.survivorId, kind: journal.kind,
    status: journal.status, created_at: journal.createdAt, updated_at: journal.updatedAt, data: JSON.stringify(journal) })
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('api_key', 'source-secret-NEVER-EXPORT')
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('software_scan_dirs', '["source-private-setting"]')
}

await test('export covers exactly the real metadata tables without settings or credentials', source => {
  seed(source)
  const before = databaseState(source)
  const backup = buildLibraryBackup(source)
  assert.equal(backup.format, 'baoyi-library-metadata')
  assert.equal(backup.version, 1)
  assert.equal(backup.schema_version, SCHEMA_VERSION)
  assert.ok(Number.isSafeInteger(backup.exported_at))
  assert.deepEqual(Object.keys(backup.tables).sort(), [...expectedTables].sort())
  assert.deepEqual(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('settings', 'sqlite_sequence') ORDER BY name").all()
    .map(r => (r as { name: string }).name), [...expectedTables].sort(), 'the current schema must have no uncovered metadata table')
  for (const table of expectedTables) assert.deepEqual(backup.tables[table], rows(source, table), table)
  assert.ok(!JSON.stringify(backup).includes('source-secret-NEVER-EXPORT'))
  assert.ok(!JSON.stringify(backup).includes('source-private-setting'))
  assert.equal(databaseState(source), before)
})

await test('round trip preserves every column, IDs, watch/manual metadata, versions and orphan recovery records', (source, target) => {
  seed(source)
  const backup = JSON.parse(JSON.stringify(buildLibraryBackup(source)))
  const schemaBefore = target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()
  const previewBefore = databaseState(target)
  const summary = previewLibraryBackup(target, backup)
  assert.equal(databaseState(target), previewBefore, 'preview must leave data, rowids, settings and sequences unchanged')
  assert.equal(summary.total_rows, expectedTables.reduce((n, table) => n + backup.tables[table].length, 0))
  assert.deepEqual(summary.resources, { software: 1, game: 1, video: 2 })
  for (const table of expectedTables) assert.equal(summary.table_counts[table], backup.tables[table].length)
  assert.deepEqual(restoreLibraryBackup(target, backup), summary)
  for (const table of expectedTables) assert.deepEqual(rows(target, table), rows(source, table), table)
  assert.deepEqual(target.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(), schemaBefore, 'existing indexes and views stay intact')
  assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(), [])
})

await test('restore replaces metadata but preserves target settings and current schema version', (source, target) => {
  seed(source)
  seed(target)
  target.prepare('UPDATE resource SET notes = ?').run('旧资料')
  insert(target, 'save_backups', { id: 'newer-save-copy', resource_id: 'removed-game', save_path: 'Z:\\save', backup_dir: 'Z:\\retained-copy', created_at: stamp + 100 })
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run('target-secret-MUST-STAY', 'api_key')
  target.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark')
  const settings = rows(target, 'settings')
  restoreLibraryBackup(target, buildLibraryBackup(source))
  assert.deepEqual(rows(target, 'settings'), settings)
  assert.equal(rows(target, 'save_backups').length, 1, 'record replacement is intentional; parent must first make a complete DB backup')
  assert.deepEqual(rows(target, 'resource'), rows(source, 'resource'))
})

const invalidPayloads: Array<[string, (backup: LibraryBackup) => unknown]> = [
  ['null envelope', () => null], ['array envelope', () => []],
  ['JSON text requires caller parsing', b => JSON.stringify(b)],
  ['unknown format', b => ({ ...b, format: 'different-format' })],
  ['new format version', b => ({ ...b, version: 2 })],
  ['new schema version', b => ({ ...b, schema_version: SCHEMA_VERSION + 1 })],
  ['invalid schema version type', b => ({ ...b, schema_version: String(SCHEMA_VERSION) })],
  ['invalid schema version range', b => ({ ...b, schema_version: -1 })],
  ['missing export time', b => { const { exported_at: _omit, ...rest } = b; return rest }],
  ['invalid export time', b => ({ ...b, exported_at: Infinity })],
  ['unknown envelope key', b => ({ ...b, sql: 'DROP TABLE resource' })],
  ['settings table', b => ({ ...b, tables: { ...b.tables, settings: [] } })],
  ['view name', b => ({ ...b, tables: { ...b.tables, software: [] } })],
  ['injected SQL table name', b => ({ ...b, tables: { ...b.tables, 'resource; DELETE FROM settings; --': [] } })],
  ['unknown column', b => { Object.assign(b.tables.resource[0], { api_key: 'not-metadata' }); return b }],
  ['injected SQL column name', b => { Object.assign(b.tables.resource[0], { 'notes) VALUES (1); --': 'x' }); return b }],
  ['missing defaulted column', b => { delete (b.tables.resource[0] as Partial<typeof b.tables.resource[number]>).notes; return b }],
  ['null primary key', b => { Object.assign(b.tables.resource[0], { id: null }); return b }],
  ['null required value', b => { Object.assign(b.tables.resource[0], { path: null }); return b }],
  ['wrong text type', b => { Object.assign(b.tables.resource[0], { notes: 7 }); return b }],
  ['numeric string must not be coerced', b => { Object.assign(b.tables.resource[0], { use_count: '7' }); return b }],
  ['boolean must not become integer', b => { Object.assign(b.tables.resource[0], { is_archived: true }); return b }],
  ['nonfinite number', b => { b.tables.video_meta[0].rating = NaN; return b }],
  ['unsafe integer', b => { b.tables.resource[0].file_size = Number.MAX_SAFE_INTEGER + 1; return b }],
  ['fractional integer', b => { b.tables.episode[0].position_sec = 1.5; return b }],
  ['bigint', b => { Object.assign(b.tables.resource[0], { use_count: 1n }); return b }],
  ['blob', b => { Object.assign(b.tables.resource[0], { notes: new Uint8Array([1]) }); return b }],
  ['object cell', b => { Object.assign(b.tables.resource[0], { notes: { nested: true } }); return b }],
  ['malformed JSON array column', b => { b.tables.video_meta[0].user_edited = '['; return b }],
  ['wrong JSON container', b => { b.tables.resource[0].tags = '{}'; return b }],
  ['invalid resource kind', b => { b.tables.resource[0].kind = 'unknown-kind'; return b }],
  ['sparse table rows', b => { delete b.tables.resource[0]; return b }],
  ['extra table array property', b => { Object.assign(b.tables.resource, { ignored: true }); return b }],
  ['non-JSON row prototype', b => { Object.setPrototypeOf(b.tables.resource[0], { hidden: true }); return b }],
  ['non-enumerable row key', b => { Object.defineProperty(b.tables.resource[0], 'hidden', { value: true }); return b }],
  ['accessor value', b => { Object.defineProperty(b.tables.resource[0], 'notes', { get: () => 'hidden getter', enumerable: true }); return b }]
]
for (const [name, corrupt] of invalidPayloads) await test(`rejects ${name} before metadata writes`, (source, target) => {
  seed(source); seed(target)
  const input = corrupt(buildLibraryBackup(source)), observed = traced(target)
  rejectUnchanged(observed.db, input)
  assert.ok(!observed.statements.some(sql => /^\s*(DELETE|INSERT|UPDATE)\b/i.test(sql)), 'structurally invalid input must fail before any metadata write')
})

await test('every original table is required even when empty; additive scan tables default separately', (source, target) => {
  const backup = buildLibraryBackup(source)
  for (const table of expectedTables) {
    if (['video_scan_state','video_scan_ignores','video_detached_owners'].includes(table)) continue
    const incomplete = structuredClone(backup)
    delete (incomplete.tables as Partial<LibraryBackup['tables']>)[table]
    const observed = traced(target)
    rejectUnchanged(observed.db, incomplete)
    assert.ok(!observed.statements.some(sql => /^DELETE/i.test(sql)), `missing ${table} must be caught before deletion`)
  }
})

for (const [name, corrupt] of [
  ['duplicate primary key', (b: LibraryBackup) => b.tables.resource.push({ ...b.tables.resource[0] })],
  ['duplicate resource path', (b: LibraryBackup) => b.tables.resource.push({ ...b.tables.resource[0], id: 'same-path-new-id' })],
  ['duplicate episode identity', (b: LibraryBackup) => b.tables.episode.push({ ...b.tables.episode[0], id: 'same-episode-new-id' })],
  ['duplicate tag name', (b: LibraryBackup) => b.tables.tags.push({ ...b.tables.tags[0], id: 9002 })],
  ['duplicate composite link', (b: LibraryBackup) => b.tables.video_episode_assets.push({ ...b.tables.video_episode_assets[0] })],
  ['invalid SQLite CHECK value', (b: LibraryBackup) => { b.tables.video_meta[0].watch_status = 'invalid-watch-state' }],
  ['orphan FK', (b: LibraryBackup) => { b.tables.episode[0].resource_id = 'missing-parent' }]
] as const) await test(`preview and restore reject ${name} atomically`, (source, target) => {
  seed(source); seed(target)
  const backup = buildLibraryBackup(source); corrupt(backup)
  rejectUnchanged(target, backup)
})

await test('FK validation also works when the caller disables FK enforcement', (source, target) => {
  seed(source); seed(target)
  const backup = buildLibraryBackup(source)
  backup.tables.video_episode_assets[0].asset_id = 'absent-asset'
  target.exec('PRAGMA foreign_keys = OFF')
  rejectUnchanged(target, backup, /foreign key/i)
  assert.equal((target.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 0)
})

await test('cross-resource episode/source/asset ownership is checked beyond SQLite FKs', (source, target) => {
  seed(source); seed(target)
  for (const corrupt of [
    (b: LibraryBackup) => { b.tables.video_sources[1].resource_id = 'movie-42' },
    (b: LibraryBackup) => { b.tables.video_assets[0].resource_id = 'movie-42' },
    (b: LibraryBackup) => { b.tables.game_meta[0].resource_id = 'software-17' },
    (b: LibraryBackup) => { b.tables.video_sources[0].scope = 'episode' },
    (b: LibraryBackup) => { b.tables.video_sources.push({ ...b.tables.video_sources[0], id: 'duplicate-null-work-source' }) }
  ]) {
    const backup = buildLibraryBackup(source); corrupt(backup); rejectUnchanged(target, backup)
  }
})

await test('current schema must be initialized, known and complete', (source, target) => {
  seed(source)
  const backup = buildLibraryBackup(source)
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 1), '_schema')
  rejectUnchanged(target, backup, /schema/i)
  assert.throws(() => buildLibraryBackup(target), /schema/i)
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), '_schema')
  target.exec('DROP TABLE video_download_jobs')
  assert.throws(() => buildLibraryBackup(target), /video_download_jobs/)
  rejectUnchanged(target, backup, /video_download_jobs/)
})

await test('unknown real columns fail closed instead of silently losing metadata', (source, target) => {
  const backup = buildLibraryBackup(source)
  target.exec('ALTER TABLE resource ADD COLUMN unknown_future_metadata TEXT')
  assert.throws(() => buildLibraryBackup(target), /column|schema/i)
  rejectUnchanged(target, backup, /column|schema/i)
})

await test('older schema marker requires complete rows and never changes the target marker', (source, target) => {
  seed(source)
  const backup = buildLibraryBackup(source)
  backup.schema_version = SCHEMA_VERSION - 1
  restoreLibraryBackup(target, backup)
  assert.equal((target.prepare('SELECT value FROM settings WHERE key = ?').get('_schema') as { value: string }).value, String(SCHEMA_VERSION))
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION - 1), '_schema')
  rejectUnchanged(target, buildLibraryBackup(source), /schema/i)
})

await test('older backups without episode artwork, tags or scan state still restore with defaults', (source, target) => {
  seed(source)
  const backup = buildLibraryBackup(source)
  for (const name of ['video_scan_state','video_scan_ignores','video_detached_owners']) delete (backup.tables as any)[name]
  for (const row of backup.tables.video_meta) for (const column of ['thumbnail_path','thumbnail_source']) delete (row as any)[column]
  for (const row of backup.tables.episode) for (const column of ['published_at','studio','tags','poster_source','thumbnail_path','thumbnail_source']) delete (row as any)[column]
  restoreLibraryBackup(target, backup)
  assert.equal((target.prepare('SELECT tags,thumbnail_path FROM episode WHERE id=?').get('episode-61') as any).tags, '[]')
  assert.equal((target.prepare('SELECT thumbnail_path FROM episode WHERE id=?').get('episode-61') as any).thumbnail_path, '')
  assert.equal((target.prepare('SELECT published_at,studio FROM episode WHERE id=?').get('episode-61') as any).published_at, 0)
  assert.equal((target.prepare('SELECT studio FROM episode WHERE id=?').get('episode-61') as any).studio, '')
  for (const table of ['video_scan_state','video_scan_ignores','video_detached_owners']) assert.equal(rows(target,table).length,0)
})

await test('export refuses corrupt SQL values, JSON and FK state', source => {
  seed(source)
  for (const sql of [
    "UPDATE resource SET file_size = 'not an integer' WHERE id = 'software-17'",
    "UPDATE video_meta SET user_edited = '{broken' WHERE resource_id = 'movie-42'"
  ]) {
    source.exec('SAVEPOINT corrupt_export_fixture')
    source.exec(sql)
    assert.throws(() => buildLibraryBackup(source))
    source.exec('ROLLBACK TO corrupt_export_fixture; RELEASE corrupt_export_fixture')
  }
  source.exec('PRAGMA foreign_keys = OFF')
  source.prepare('UPDATE episode SET resource_id = ? WHERE id = ?').run('missing', 'episode-61')
  assert.throws(() => buildLibraryBackup(source), /foreign key/i)
})

await test('row, string and nested-JSON bounds fail before replacement', (source, target) => {
  seed(source); seed(target)
  for (const corrupt of [
    (b: LibraryBackup) => { b.tables.resource = Array(LIBRARY_BACKUP_LIMITS.max_rows_per_table + 1).fill(b.tables.resource[0]) },
    (b: LibraryBackup) => { b.tables.resource[0].notes = '界'.repeat(Math.floor(LIBRARY_BACKUP_LIMITS.max_string_bytes / 3) + 1) },
    (b: LibraryBackup) => { b.tables.resource[0].tags = '['.repeat(LIBRARY_BACKUP_LIMITS.max_json_depth + 2) + '0' + ']'.repeat(LIBRARY_BACKUP_LIMITS.max_json_depth + 2) },
    (b: LibraryBackup) => {
      for (const table of expectedTables.slice(0, 6)) (b.tables[table] as unknown[]) = Array(100_000).fill(null)
    }
  ]) {
    const backup = buildLibraryBackup(source); corrupt(backup)
    const observed = traced(target)
    rejectUnchanged(observed.db, backup, /limit|exceed|too large|depth/i)
    assert.ok(!observed.statements.some(sql => /^DELETE/i.test(sql)))
  }
})

await test('running and queued jobs are interrupted with synchronized payloads and manual retry stages', (source, target) => {
  seed(source)
  const backup = buildLibraryBackup(source)
  const active = jobFixture('running')
  active.items[0].transfer = 'running'; active.items[0].metadata = 'running'; active.items[0].registration = 'running'
  const queued = { ...jobFixture('queued'), id: 'download-queued' }
  backup.tables.video_download_jobs = [active, queued].map(j => ({ id: j.id, status: j.status, updated_at: j.updatedAt, payload: JSON.stringify(j) }))
  backup.tables.task_records.push({ ...backup.tables.task_records[0], id: 'task-running', status: 'running', finished_at: 0 })
  const original = JSON.stringify(backup), before = databaseState(target)
  const preview = previewLibraryBackup(target, backup)
  assert.deepEqual(preview.interrupted, { task_records: 1, video_download_jobs: 2 })
  assert.equal(databaseState(target), before)
  assert.equal(JSON.stringify(backup), original)
  assert.deepEqual(restoreLibraryBackup(target, backup), preview)
  assert.equal(JSON.stringify(backup), original, 'restore must not mutate the caller backup')
  const tasks = rows(target, 'task_records')
  assert.deepEqual(tasks[0], backup.tables.task_records[0], 'finished history keeps every column')
  assert.deepEqual(tasks[1], { ...backup.tables.task_records[1], status: 'interrupted' })
  for (const row of rows(target, 'video_download_jobs')) {
    const payload = JSON.parse(String(row.payload)) as VideoDownloadJob
    assert.equal(row.status, 'interrupted'); assert.equal(payload.status, 'interrupted')
    assert.equal(payload.id, row.id); assert.equal(payload.updatedAt, row.updated_at)
    assert.ok(payload.items.every(i => ![i.transfer, i.metadata, i.registration].includes('running')))
    assert.equal(payload.items[0].receivedBytes, 98765)
    assert.equal(payload.sourceLabel, '2160p'); assert.equal(payload.description, '原始简介')
  }
})

await test('complete job JSON is validated, including row/payload agreement and stage types', (source, target) => {
  seed(source); seed(target)
  for (const corrupt of [
    () => '{bad', () => '[]', () => '{}',
    (j: VideoDownloadJob) => JSON.stringify({ ...j, id: 'different-id' }),
    (j: VideoDownloadJob) => JSON.stringify({ ...j, status: 'running' }),
    (j: VideoDownloadJob) => JSON.stringify({ ...j, updatedAt: j.updatedAt + 1 }),
    (j: VideoDownloadJob) => JSON.stringify({ ...j, items: null }),
    (j: VideoDownloadJob) => JSON.stringify({ ...j, items: [{ ...j.items[0], transfer: 'unknown-stage' }] }),
    (j: VideoDownloadJob) => JSON.stringify({ ...j, strictQuality: 'true' })
  ]) {
    const backup = buildLibraryBackup(source)
    backup.tables.video_download_jobs[0].payload = corrupt(jobFixture())
    rejectUnchanged(target, backup)
  }
})

await test('empty job identity cannot be restored and silently skipped by the real job store', (source, target) => {
  seed(source)
  const backup = buildLibraryBackup(source)
  const job = jobFixture()
  job.id = ''
  backup.tables.video_download_jobs[0] = { id: '', status: job.status, updated_at: job.updatedAt, payload: JSON.stringify(job) }
  rejectUnchanged(target, backup, /key|identity|empty/i)
})

await test('journal JSON validates version, identity and all embedded SQL identifiers', (source, target) => {
  seed(source); seed(target)
  for (const corrupt of [
    () => '{bad', () => '{}',
    (j: any) => JSON.stringify({ ...j, version: 2 }),
    (j: any) => JSON.stringify({ ...j, id: 'different-id' }),
    (j: any) => JSON.stringify({ ...j, snapshot: {} }),
    (j: any) => JSON.stringify({ ...j, changes: [{ ...j.changes[0], table: 'settings' }] }),
    (j: any) => JSON.stringify({ ...j, changes: [{ ...j.changes[0], table: 'video_meta; DROP TABLE settings; --' }] }),
    (j: any) => JSON.stringify({ ...j, changes: [{ ...j.changes[0], key: { 'resource_id OR 1=1': 'series-51' } }] }),
    (j: any) => JSON.stringify({ ...j, changes: [{ ...j.changes[0], after: { unknown_column: 'x' } }] })
  ]) {
    const backup = buildLibraryBackup(source)
    backup.tables.video_organize_journal[0].data = corrupt(JSON.parse(backup.tables.video_organize_journal[0].data))
    rejectUnchanged(target, backup)
  }
})

await test('all persistent task event and CHECK-enum values are validated even with CHECK enforcement disabled', (source, target) => {
  seed(source); seed(target)
  target.exec('PRAGMA ignore_check_constraints = ON')
  for (const corrupt of [
    (b: LibraryBackup) => { b.tables.video_meta[0].watch_status = 'invalid' },
    (b: LibraryBackup) => { b.tables.game_meta[0].play_status = 'invalid' },
    (b: LibraryBackup) => { b.tables.video_assets[0].role = 'invalid' },
    (b: LibraryBackup) => { b.tables.task_records[0].status = 'invalid' },
    (b: LibraryBackup) => { b.tables.task_records[0].events = '[{"at":"yesterday","level":"warn","message":"x"}]' },
    (b: LibraryBackup) => { b.tables.task_records[0].events = '[null]' }
  ]) {
    const backup = buildLibraryBackup(source); corrupt(backup); rejectUnchanged(target, backup)
  }
})

for (const policy of ['IGNORE', 'REPLACE']) await test(`schema conflict policy ${policy} cannot silently drop duplicate rows`, (source, target) => {
  seed(source)
  const ddl = (target.prepare("SELECT sql FROM sqlite_master WHERE name = 'resource'").get() as { sql: string }).sql
  assert.ok(ddl.includes('path TEXT NOT NULL UNIQUE'))
  target.exec('DROP TABLE resource')
  target.exec(ddl.replace('path TEXT NOT NULL UNIQUE', `path TEXT NOT NULL UNIQUE ON CONFLICT ${policy}`))
  const backup = buildLibraryBackup(source)
  backup.tables.software_meta = []
  backup.tables.resource.push({ ...backup.tables.resource[0], id: 'conflicting-path' })
  rejectUnchanged(target, backup)
})

await test('malformed journal recovery structures cannot reach preview confirmation', (source, target) => {
  seed(source); seed(target)
  for (const corrupt of [
    (j: any) => { j.preview = {} },
    (j: any) => { j.preview.request.resourceIds = 'not-an-array' },
    (j: any) => { j.preview.survivor.archived = 'false' },
    (j: any) => { j.files = [null] },
    (j: any) => { j.files = [{ source: 'a', destination: 'b' }] },
    (j: any) => { j.changes[0].after.watch_status = 'invalid' }
  ]) {
    const backup = buildLibraryBackup(source), journal = JSON.parse(backup.tables.video_organize_journal[0].data)
    corrupt(journal); backup.tables.video_organize_journal[0].data = JSON.stringify(journal)
    rejectUnchanged(target, backup)
  }
})

await test('covered-table triggers cannot alter settings or silently skip rows', (source, target) => {
  seed(source); seed(target)
  const backup = buildLibraryBackup(source)
  target.exec("CREATE TRIGGER library_backup_fixture_settings AFTER INSERT ON resource BEGIN UPDATE settings SET value = 'changed' WHERE key = 'api_key'; END")
  rejectUnchanged(target, backup, /trigger|schema/i)
  target.exec('DROP TRIGGER library_backup_fixture_settings')
  target.exec('CREATE TEMP TRIGGER library_backup_fixture_ignore BEFORE INSERT ON main.resource BEGIN SELECT RAISE(IGNORE); END')
  rejectUnchanged(target, backup, /trigger|schema/i)
})

await test('an unlisted table referencing metadata cannot be cascaded away', (source, target) => {
  seed(source); seed(target)
  target.exec('CREATE TABLE library_backup_fixture_external (id TEXT PRIMARY KEY, resource_id TEXT REFERENCES ReSoUrCe(id) ON DELETE CASCADE)')
  target.prepare('INSERT INTO library_backup_fixture_external VALUES (?, ?)').run('external', 'software-17')
  rejectUnchanged(target, buildLibraryBackup(source), /schema|outside|uncovered/i)
})

await test('parameterized Unicode, NUL and SQL-looking text round trip without conversion', (source, target) => {
  seed(source)
  const notes = "\ufeff中文 📚 '); DELETE FROM settings; --\u0000尾部"
  source.prepare('UPDATE resource SET notes = ? WHERE id = ?').run(notes, 'software-17')
  const backup = buildLibraryBackup(source)
  assert.equal(backup.tables.resource[0].notes, notes)
  restoreLibraryBackup(target, backup)
  // Node 22's TEXT reader truncates at NUL although SQLite stores all bytes.
  // Verify storage directly; the backup reader must also preserve all bytes.
  assert.equal((target.prepare('SELECT hex(notes) AS hex FROM resource WHERE id = ?').get('software-17') as { hex: string }).hex,
    Buffer.from(notes, 'utf8').toString('hex').toUpperCase())
  assert.equal(buildLibraryBackup(target).tables.resource[0].notes, notes)
  const invalidUnicode = buildLibraryBackup(source)
  invalidUnicode.tables.resource[0].notes = '\ud800'
  rejectUnchanged(target, invalidUnicode, /Unicode|surrogate|text/i)
})

await test('export rejects malformed UTF-8 stored as SQLite TEXT instead of substituting replacement characters', source => {
  seed(source)
  source.exec("UPDATE resource SET notes = CAST(X'C080' AS TEXT) WHERE id = 'software-17'")
  assert.throws(() => buildLibraryBackup(source), /UTF|Unicode|text/i)
})

await test('unsupported database text encoding is rejected consistently before any replacement', source => {
  const otherEncoding = openFixture()
  try {
    otherEncoding.exec("PRAGMA encoding = 'UTF-16le'")
    initSchema(otherEncoding, KINDS); otherEncoding.exec(VIDEO_JOBS_SQL)
    assert.throws(() => buildLibraryBackup(otherEncoding), /encoding/i)
    rejectUnchanged(otherEncoding, buildLibraryBackup(source), /encoding/i)
  } finally { otherEncoding.close() }
})

await test('export does not interrupt the real persisted job store', source => {
  seed(source)
  const job = jobFixture('running')
  job.items[0].transfer = 'running'
  const store = createVideoJobStore(source)
  store.save(job)
  const before = databaseState(source), backup = buildLibraryBackup(source)
  assert.equal(databaseState(source), before)
  assert.equal(backup.tables.video_download_jobs[0].status, 'running')
  assert.equal(backup.tables.video_download_jobs[0].payload, JSON.stringify(job))
  assert.deepEqual(store.list()[0], job)
})

await test('aggregate text and parsed-JSON node budgets reject oversized snapshots', (source, target) => {
  seed(source)
  const textHeavy = buildLibraryBackup(source)
  const notes = 'x'.repeat(6 * 1024 * 1024)
  for (let i = 0; i < 11; i++) textHeavy.tables.resource.push({ ...textHeavy.tables.resource[0], id: `large-${i}`, path: `large-path-${i}`, notes })
  rejectUnchanged(target, textHeavy, /limit/i)
  const nodesHeavy = buildLibraryBackup(source)
  nodesHeavy.tables.resource[0].alternatives = '[' + '0,'.repeat(LIBRARY_BACKUP_LIMITS.max_json_nodes) + '0]'
  rejectUnchanged(target, nodesHeavy, /node limit/i)
})

await test('export bounds rows and oversized stored values before materializing tables', (source, target) => {
  source.exec(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n < ${LIBRARY_BACKUP_LIMITS.max_rows_per_table + 1})
    INSERT INTO resource(id, path, file_name, created_at, updated_at) SELECT 'large-' || n, 'large-path-' || n, 'fixture', 1, 1 FROM fixture`)
  const observedRows = traced(source)
  assert.throws(() => buildLibraryBackup(observedRows.db), /row limit/i)
  assert.ok(!observedRows.statements.some(sql => /ORDER BY rowid/i.test(sql)))
  seed(target)
  target.prepare('UPDATE resource SET notes = ? WHERE id = ?').run('x'.repeat(LIBRARY_BACKUP_LIMITS.max_string_bytes + 1), 'software-17')
  const observedText = traced(target)
  assert.throws(() => buildLibraryBackup(observedText.db), /byte limit/i)
  assert.ok(!observedText.statements.some(sql => /ORDER BY rowid/i.test(sql)))
})

await test('journals generated by the real organize service retain complete physical recovery data', async (source, target) => {
  const tempRoot = path.resolve(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(tempRoot, 'baoyi-library-backup-'))
  try {
    const input = path.join(directory, 'input'), output = path.join(directory, 'managed')
    fs.mkdirSync(input)
    for (const id of ['generated-a', 'generated-b']) {
      const file = path.join(input, `${id}.mkv`)
      fs.writeFileSync(file, id)
      insert(source, 'resource', { id, kind: 'video', path: file, file_name: `${id}.mkv`, created_at: stamp, updated_at: stamp, name_zh: id, notes: '手动笔记' })
      insert(source, 'video_meta', { resource_id: id, watch_status: 'watched', position_sec: 99, user_edited: '["notes"]' })
      insert(source, 'video_assets', { id: `${id}-asset`, resource_id: id, path: file, role: 'video', state: 'present', file_size: Buffer.byteLength(id), created_at: stamp })
    }
    const preview = previewVideoOrganize(source, { resourceIds: ['generated-a', 'generated-b'], survivorId: 'generated-a', targetDirectory: output, root: directory })
    assert.equal(preview.canOrganize, true, JSON.stringify(preview.collisions))
    const journal = await applyVideoOrganize(source, { preview, mode: 'physical' })
    assert.equal(journal.status, 'applied')
    const backup = buildLibraryBackup(source)
    previewLibraryBackup(target, backup)
    restoreLibraryBackup(target, backup)
    assert.deepEqual(rows(target, 'video_organize_journal'), rows(source, 'video_organize_journal'))
    assert.deepEqual(listVideoOrganizeJournal(target), listVideoOrganizeJournal(source))
    for (const table of expectedTables) assert.deepEqual(rows(target, table), rows(source, table), table)
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), tempRoot)
    assert.ok(path.basename(directory).startsWith('baoyi-library-backup-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

await test('unrelated tables and retained legacy snapshots are neither exported nor replaced', (source, target) => {
  seed(source); seed(target)
  for (const db of [source, target]) db.exec("CREATE TABLE software_legacy_v4 (id TEXT, notes TEXT); INSERT INTO software_legacy_v4 VALUES ('legacy', 'retain')")
  target.exec("CREATE TABLE library_backup_fixture_unrelated (value TEXT); INSERT INTO library_backup_fixture_unrelated VALUES ('keep')")
  const backup = buildLibraryBackup(source)
  assert.ok(!Object.hasOwn(backup.tables, 'software_legacy_v4'))
  restoreLibraryBackup(target, backup)
  assert.deepEqual(rows(target, 'software_legacy_v4'), [{ id: 'legacy', notes: 'retain' }])
  assert.deepEqual(rows(target, 'library_backup_fixture_unrelated'), [{ value: 'keep' }])
})

await test('actual source files and old/new save-backup disk copies are untouched', (source, target) => {
  const tempRoot = path.resolve(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(tempRoot, 'baoyi-library-backup-'))
  try {
    const media = path.join(directory, 'movie.mkv'), oldSave = path.join(directory, 'old-save.dat'), newSave = path.join(directory, 'new-save.dat')
    for (const file of [media, oldSave, newSave]) fs.writeFileSync(file, Buffer.from([0, 1, 2, 255]))
    seed(source); seed(target)
    source.prepare('UPDATE resource SET path = ? WHERE id = ?').run(media, 'movie-42')
    source.prepare('UPDATE save_backups SET backup_dir = ?').run(oldSave)
    target.prepare('UPDATE save_backups SET backup_dir = ?').run(newSave)
    const original = [media, oldSave, newSave].map(file => fs.readFileSync(file))
    const backup = buildLibraryBackup(source)
    previewLibraryBackup(target, backup); restoreLibraryBackup(target, backup)
    assert.deepEqual([media, oldSave, newSave].map(file => fs.readFileSync(file)), original)
    assert.deepEqual(fs.readdirSync(directory).sort(), ['movie.mkv', 'new-save.dat', 'old-save.dat'])
  } finally {
    // Delete only the unique fixture directory created above, under the resolved
    // temp directory; never derive a cleanup target from backup metadata.
    assert.equal(path.dirname(path.resolve(directory)), tempRoot)
    assert.ok(path.basename(directory).startsWith('baoyi-library-backup-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

await test('one savepoint composes with a caller transaction and rolls back after a mid-write failure', (source, target) => {
  seed(source); seed(target)
  const backup = buildLibraryBackup(source)
  target.exec('BEGIN')
  target.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('outer-work', 'keep until caller rollback')
  const before = databaseState(target), observed = traced(target)
  previewLibraryBackup(observed.db, backup)
  assert.equal(observed.statements.filter(sql => /^SAVEPOINT /i.test(sql)).length, 1)
  assert.equal(databaseState(target), before)
  restoreLibraryBackup(target, backup)
  target.exec('ROLLBACK')
  assert.equal(target.prepare('SELECT value FROM settings WHERE key = ?').get('outer-work'), undefined)
  const invalidFk = structuredClone(backup)
  invalidFk.tables.video_episode_assets[0].asset_id = 'late-missing-asset'
  const late = traced(target)
  rejectUnchanged(late.db, invalidFk, /foreign key/i)
  assert.ok(late.statements.some(sql => /^INSERT OR ABORT INTO main\."video_assets"/i.test(sql)), 'real FK failure must occur after earlier metadata has been written')
})

console.log(`Library backup regression (${useBetterSqlite ? 'better-sqlite3' : 'node:sqlite'}): ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
