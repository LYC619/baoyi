/**
 * SQL-only metadata backup/restore. No Electron, settings writes, file operations
 * or schema migration. Requires the application's UTF-8 database, initialized
 * with initSchema(db, KINDS) and the video job store. Input is parsed JSON.
 *
 * Integration contract: before restore, the parent must make a COMPLETE database
 * backup (including current save_backups), obtain explicit preview confirmation,
 * and stop/restart the app so old in-memory jobs cannot write stale data back.
 * save_backups and recovery journals are replaced as metadata; their disk copies
 * and all library source files are untouched. Historical orphan records are valid.
 */
import { Buffer } from 'node:buffer'
import { SCHEMA_KEY, SCHEMA_VERSION, type SqlDb } from './schema.ts'
import { normalizeImagePreferences } from '../../src/utils/image-preferences.ts'
import { parseCatalogue } from '../kinds/video/discovery/catalogue.ts'
import {
  LIBRARY_BACKUP_COLUMNS, LIBRARY_BACKUP_FORMAT, LIBRARY_BACKUP_LIMITS, LIBRARY_BACKUP_TABLE_NAMES, LIBRARY_BACKUP_VERSION,
  type LibraryBackup, type LibraryBackupSummary, type LibraryBackupTableName, type LibraryBackupTables,
  type LibraryBackupValue
} from '../../src/types/library-backup.ts'

type Row = Record<string, LibraryBackupValue>
type ObjectRow = Record<string, unknown>
type ColumnRule = 'text' | 'text?' | 'integer' | 'integer?' | 'real'
type Budget = { textBytes: number; jsonNodes: number }
const rules: Readonly<Record<LibraryBackupTableName, Readonly<Record<string, ColumnRule>>>> = LIBRARY_BACKUP_COLUMNS
const limits = LIBRARY_BACKUP_LIMITS
const kinds = ['software', 'game', 'video', 'image'] as const
const journalTables = ['resource', 'video_meta', 'episode', 'video_sources', 'video_assets', 'video_episode_assets', 'video_directories'] as const
const arrayColumns: Partial<Record<LibraryBackupTableName, readonly string[]>> = {
  resource: ['tags', 'alternatives'], software_meta: ['launchers'], game_meta: ['save_paths', 'linked_files'],
  video_meta: ['audio_tracks', 'subtitle_tracks', 'parts', 'linked_files', 'hanime_tags', 'user_edited'],
  episode: ['tags'], task_records: ['events'], organize_plans: ['steps'], pending_software: ['tags', 'launchers', 'new_tags'],
  identify_logs: ['events'], identification_reports: ['entries']
}
const watchStates = ['unwatched', 'watching', 'watched', 'dropped'] as const
// Mirror the real CHECK constraints as well, because SQLite permits callers to
// disable CHECK enforcement. These also validate historical journal patches.
const enumColumns: Partial<Record<LibraryBackupTableName, Record<string, readonly string[]>>> = {
  resource: { kind: kinds }, categories: { kind: kinds }, tags: { kind: kinds },
  image_meta: { item_type: ['photo','comic'], publication: ['unknown','ongoing','completed'] },
  image_download_jobs: { status: ['queued','running','paused','success','failed','cancelled','interrupted'] },
  game_meta: { play_status: ['unplayed', 'playing', 'completed', 'shelved'] },
  video_meta: { video_type: ['movie', 'series'], watch_status: watchStates },
  episode: { watch_status: watchStates }, video_sources: { scope: ['work', 'episode'] },
  video_assets: { role: ['video', 'subtitle', 'poster', 'attachment'], state: ['unchecked', 'present', 'missing', 'offline'] },
  task_records: { status: ['running', 'success', 'failed', 'cancelled', 'interrupted'] },
  video_organize_journal: { kind: ['organize', 'relocate'] }
}
let savepointSerial = 0

function tableSql(table: LibraryBackupTableName): string { return `main."${table}"` }
function columnNames(table: LibraryBackupTableName): string[] { return Object.keys(LIBRARY_BACKUP_COLUMNS[table]) }

function invalid(message: string): never { throw new Error(`Library backup: ${message}`) }

function object(value: unknown, at: string): ObjectRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${at} must be a plain object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${at} must be a plain JSON object`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) invalid(`${at} has a non-JSON property`)
  }
  return value as ObjectRow
}

function keys(value: unknown, required: readonly string[], at: string, optional: readonly string[] = []): ObjectRow {
  const result = object(value, at)
  const allowed = new Set([...required, ...optional])
  if (Object.keys(result).some(key => !allowed.has(key))) invalid(`${at} has an unknown field or SQL column`)
  if (required.some(key => !Object.hasOwn(result, key))) invalid(`${at} is missing an expected field or column`)
  return result
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${at} must be a JSON array`)
  // No holes, getters, symbols, or properties which JSON.stringify would discard.
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(`${at} has sparse rows or non-JSON properties`)
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid(`${at} has sparse rows or accessors`)
  }
  return value
}

function integer(value: unknown, at: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${at} must be a safe integer`)
}
function string(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string') invalid(`${at} must be text`)
}
function boolean(value: unknown, at: string): void {
  if (typeof value !== 'boolean') invalid(`${at} must be boolean`)
}
function finiteNumber(value: unknown, at: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${at} must be a finite number`)
}
function strings(value: unknown, at: string): void { for (const item of array(value, at)) string(item, at) }
function oneOf(value: unknown, allowed: readonly string[], at: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(`${at} has an invalid value`)
}

function scalar(value: unknown, rule: ColumnRule, at: string, budget?: Budget): asserts value is LibraryBackupValue {
  if (value === null && rule.endsWith('?')) return
  if (rule.startsWith('text')) {
    string(value, at)
    // Unpaired UTF-16 surrogates would be replaced while binding UTF-8 text.
    if (/[\uD800-\uDFFF]/u.test(value)) invalid(`${at} contains an invalid Unicode surrogate`)
    if (value.length > limits.max_string_bytes) invalid(`${at} exceeds the string byte limit`)
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > limits.max_string_bytes) invalid(`${at} exceeds the string byte limit`)
    if (budget && (budget.textBytes += bytes) > limits.max_total_string_bytes) invalid('total text exceeds the byte limit')
  } else if (rule.startsWith('integer')) integer(value, at)
  else if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${at} must be a finite number`)
}

function walkJson(value: unknown, budget: Budget, depth = 0): void {
  if (depth > limits.max_json_depth) invalid('nested JSON exceeds the depth limit')
  if (++budget.jsonNodes > limits.max_json_nodes) invalid('nested JSON exceeds the node limit')
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('nested JSON contains a nonfinite number')
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) walkJson(child, budget, depth + 1)
  }
}

function json(text: LibraryBackupValue, container: 'array' | 'object', at: string, budget: Budget): unknown {
  let value: unknown
  try { value = JSON.parse(text as string) }
  catch { invalid(`${at} contains malformed JSON`) }
  walkJson(value, budget)
  return container === 'array' ? array(value, at) : object(value, at)
}

function primaryKey(table: LibraryBackupTableName): readonly string[] {
  if (table === 'video_discovery_marks') return ['source_id', 'entry_id']
  if (table === 'video_episode_assets') return ['episode_id', 'asset_id']
  if (table === 'video_scan_state' || table === 'video_scan_ignores') return ['path']
  if (table === 'scan_units') return ['dir']
  if (table === 'skip_list') return ['exe_path']
  return Object.hasOwn(rules[table], 'id') ? ['id'] : ['resource_id']
}

function validateRow(table: LibraryBackupTableName, input: unknown, at: string, budget: Budget, partial = false, embedded = false): Row {
  const columns = columnNames(table)
  if (table === 'episode' && !partial) input = { published_at: 0, studio: '', tags: '[]', poster_source: '', thumbnail_path: '', thumbnail_source: '', original_title: '', description: '', original_description: '', poster_path: '', source_url: '', notes: '', ...object(input, at) }
  if (table === 'video_meta' && !partial) input = { thumbnail_path: '', thumbnail_source: '', ...object(input, at) }
  if (table === 'video_directories' && !partial) input = { missing: '[]', ...object(input, at) }
  const row = keys(input, partial ? [] : columns, at, partial ? columns : [])
  const result: Row = {}
  for (const column of Object.keys(row)) {
    const value = row[column], label = `${at}.${column}`
    scalar(value, rules[table][column], label, embedded ? undefined : budget)
    if (primaryKey(table).includes(column) && value === '') invalid(`${label} is an empty primary key`)
    result[column] = value
    const allowed = enumColumns[table]?.[column]
    if (allowed) oneOf(value, allowed, label)
    if (table === 'image_reader_state' && column === 'is_read' && value !== 0 && value !== 1) invalid(`${label} must be 0 or 1`)
    if (table === 'image_reader_state' && column === 'preferences' && value !== '') {
      const preferences = keys(json(value, 'object', label, budget), ['mode', 'direction', 'fit'], label, ['coverSingle', 'zoom'])
      try { normalizeImagePreferences(preferences) } catch { invalid(`${label} contains invalid reader preferences`) }
    }
    if (table === 'image_bookmarks' && column === 'scroll_offset' && ((value as number) < 0 || (value as number) > 1)) invalid(`${label} must be between 0 and 1`)
    if (value !== null && arrayColumns[table]?.includes(column)) {
      const parsed = json(value, 'array', label, budget)
      if (['tags', 'new_tags', 'hanime_tags', 'user_edited'].includes(column)) strings(parsed, label)
      if (table === 'task_records' && column === 'events') for (const input of parsed as unknown[]) {
        const event = keys(input, ['at', 'level', 'message'], `${label}[]`)
        integer(event.at, `${label}[].at`); string(event.message, `${label}[].message`)
        oneOf(event.level, ['info', 'success', 'warn', 'error'], `${label}[].level`)
      }
    }
  }
  if (!partial) {
    if (table === 'identify_logs' || table === 'identification_reports') {
      if (result.resource_kind !== null) oneOf(result.resource_kind, kinds, `${at}.resource_kind`)
    }
    if (table === 'video_discovery_sources') {
      const source = parseCatalogue(json(result.payload, 'object', at + '.payload', budget))
      if (source.id !== result.id) invalid(at + ' source id disagrees with its payload')
    }
    if (table === 'video_discovery_marks') {
      const mark = keys(json(result.payload, 'object', at + '.payload', budget), ['favorite', 'watched', 'notes', 'userRating'], at + '.payload')
      boolean(mark.favorite, at + '.favorite'); boolean(mark.watched, at + '.watched'); string(mark.notes, at + '.notes')
      finiteNumber(mark.userRating, at + '.userRating')
      if ((mark.userRating as number) < 0 || (mark.userRating as number) > 5 || (mark.notes as string).length > 4000) invalid(at + ' invalid personal rating or notes')
    }
    if (table === 'video_download_jobs') validateJob(result, budget, at)
    if (table === 'video_organize_journal') validateJournal(result, budget, at)
  }
  return result
}

function sourceRef(input: unknown, at: string): void {
  const ref = keys(input, ['provider', 'externalId', 'scope', 'pageUrl', 'evidence'], at)
  for (const key of ['provider', 'externalId', 'pageUrl']) string(ref[key], `${at}.${key}`)
  oneOf(ref.scope, ['work', 'episode'], `${at}.scope`)
  oneOf(ref.evidence, ['confirmed', 'playlist', 'bundle', 'nfo', 'legacy'], `${at}.evidence`)
}

function validateJob(row: Row, budget: Budget, at: string): void {
  const textFields = ['id', 'resourceId', 'bundleId', 'title', 'category', 'videoCode', 'root', 'directory',
    'sourceLabel', 'status', 'message', 'description', 'posterUrl', 'posterPath']
  const job = keys(json(row.payload, 'object', `${at}.payload`, budget),
    [...textFields, 'strictQuality', 'register', 'createdAt', 'updatedAt', 'sources', 'items', 'warnings'], `${at}.payload`, ['retryStage', 'directoryChange', 'episodeMetadata', 'discovery'])
  if (Object.hasOwn(job, 'discovery')) {
    const discovery = keys(job.discovery, ['sourceId', 'entry'], at + '.discovery')
    const source = parseCatalogue({ schemaVersion: 1, id: discovery.sourceId, name: 'snapshot', entries: [discovery.entry] })
    if (!array(job.sources, at + '.sources').some(value => { const ref = object(value, at + '.source'); return ref.provider === 'catalogue:' + source.id && ref.externalId === source.entries[0].id })) invalid(at + ' discovery source does not match the job')
  }
  for (const field of textFields) string(job[field], `${at}.payload.${field}`)
  for (const field of ['createdAt', 'updatedAt']) integer(job[field], `${at}.payload.${field}`)
  for (const field of ['strictQuality', 'register']) boolean(job[field], `${at}.payload.${field}`)
  oneOf(job.status, ['queued', 'running', 'success', 'partial', 'failed', 'cancelled', 'interrupted'], `${at}.status`)
  if (job.id !== row.id || job.status !== row.status || job.updatedAt !== row.updated_at) invalid(`${at} row and job payload disagree`)
  if (Object.hasOwn(job, 'retryStage')) oneOf(job.retryStage, ['remaining', 'metadata', 'registration'], `${at}.retryStage`)
  if (Object.hasOwn(job, 'episodeMetadata')) boolean(job.episodeMetadata, `${at}.episodeMetadata`)
  if (Object.hasOwn(job, 'directoryChange')) {
    const change = keys(job.directoryChange, ['from', 'to'], `${at}.directoryChange`, ['identity', 'applied'])
    string(change.from, `${at}.directoryChange.from`); string(change.to, `${at}.directoryChange.to`)
    if (Object.hasOwn(change, 'applied')) boolean(change.applied, `${at}.directoryChange.applied`)
    if (Object.hasOwn(change, 'identity')) {
      const identity = keys(change.identity, ['dev', 'ino'], `${at}.directoryChange.identity`)
      finiteNumber(identity.dev, `${at}.directoryChange.identity.dev`); finiteNumber(identity.ino, `${at}.directoryChange.identity.ino`)
    }
  }
  strings(job.warnings, `${at}.warnings`)
  for (const source of array(job.sources, `${at}.sources`)) sourceRef(source, `${at}.sources`)
  const itemCodes = new Set<string>()
  for (const input of array(job.items, `${at}.items`)) {
    const item = keys(input, ['videoCode', 'title', 'order', 'path', 'sourceLabel', 'transfer', 'metadata', 'registration',
      'receivedBytes', 'totalBytes', 'error', 'warnings'], `${at}.items`, ['publishedAt', 'releaseDate', 'durationSec', 'artist', 'originalTitle', 'description', 'posterUrl', 'posterPath', 'thumbnailUrl', 'thumbnailPath', 'tags'])
    for (const field of ['publishedAt', 'releaseDate', 'durationSec']) if (Object.hasOwn(item, field)) integer(item[field], `${at}.items.${field}`)
    if (Object.hasOwn(item, 'artist')) string(item.artist, `${at}.items.artist`)
    for (const field of ['originalTitle', 'description', 'posterUrl', 'posterPath', 'thumbnailUrl', 'thumbnailPath']) if (Object.hasOwn(item, field)) string(item[field], `${at}.items.${field}`)
    for (const field of ['videoCode', 'title', 'path', 'sourceLabel', 'error']) string(item[field], `${at}.items.${field}`)
    for (const field of ['order', 'receivedBytes', 'totalBytes']) integer(item[field], `${at}.items.${field}`)
    for (const field of ['transfer', 'metadata', 'registration']) oneOf(item[field], ['pending', 'running', 'complete', 'failed', 'skipped'], `${at}.items.${field}`)
    strings(item.warnings, `${at}.items.warnings`)
    if (Object.hasOwn(item, 'tags')) strings(item.tags, `${at}.items.tags`)
    if (itemCodes.has(item.videoCode as string)) invalid(`${at} has duplicate job items`)
    itemCodes.add(item.videoCode as string)
  }
}

function journalFile(input: unknown, at: string, result: boolean): void {
  const base = ['id', 'resourceIds', 'assetIds', 'episodeIds', 'source', 'destination', 'relativePath', 'size', 'state', 'action']
  const file = keys(input, result ? [...base, 'status', 'error', 'attempts', 'sha256', 'originalRetained'] : base,
    at, result ? ['stage', 'stageIdentity', 'targetIdentity', 'sourceIdentity', 'sourceRemoved'] : [])
  for (const field of ['id', 'source', 'destination', 'relativePath']) string(file[field], `${at}.${field}`)
  for (const field of ['resourceIds', 'assetIds', 'episodeIds']) strings(file[field], `${at}.${field}`)
  integer(file.size, `${at}.size`)
  oneOf(file.state, ['unchecked', 'present', 'missing', 'offline'], `${at}.state`)
  oneOf(file.action, ['copy', 'move', 'keep', 'verify', 'none'], `${at}.action`)
  if (!result) return
  oneOf(file.status, ['pending', 'copying', 'copied', 'switched', 'unchanged', 'failed', 'rolled-back', 'retained'], `${at}.status`)
  string(file.error, `${at}.error`); string(file.sha256, `${at}.sha256`); integer(file.attempts, `${at}.attempts`)
  boolean(file.originalRetained, `${at}.originalRetained`)
  if (file.action !== 'move' && file.originalRetained !== true) invalid(`${at}.originalRetained must be true for copies`)
  if (Object.hasOwn(file, 'sourceRemoved')) boolean(file.sourceRemoved, `${at}.sourceRemoved`)
  if (Object.hasOwn(file, 'stage')) string(file.stage, `${at}.stage`)
  for (const field of ['stageIdentity', 'targetIdentity', 'sourceIdentity']) if (Object.hasOwn(file, field)) {
    const identity = keys(file[field], ['dev', 'ino', 'size', 'mtimeMs'], `${at}.${field}`)
    // fs.Stats may expose a large inode or fractional mtime as a JS number;
    // journal text is retained verbatim, with no integer conversion here.
    for (const key of Object.keys(identity)) finiteNumber(identity[key], `${at}.${field}.${key}`)
  }
}

function journalWork(input: unknown, at: string): void {
  const work = keys(input, ['resourceId', 'name', 'path', 'notes', 'archived', 'watchStatus', 'positionSec', 'directory', 'fileIds'], at)
  for (const field of ['resourceId', 'name', 'path', 'notes']) string(work[field], `${at}.${field}`)
  boolean(work.archived, `${at}.archived`); integer(work.positionSec, `${at}.positionSec`)
  oneOf(work.watchStatus, watchStates, `${at}.watchStatus`); strings(work.fileIds, `${at}.fileIds`)
  if (work.directory !== null) {
    const directory = keys(work.directory, ['resourceId', 'bundleId', 'root', 'relativePath', 'path', 'metadataState'], `${at}.directory`)
    for (const field of Object.keys(directory)) string(directory[field], `${at}.directory.${field}`)
  }
}

function journalPreview(input: unknown, kind: string, at: string): void {
  const common = ['kind', 'request', 'fingerprint', 'targetDirectory', 'root', 'bundleId', 'files', 'collisions', 'warnings']
  const preview = keys(input, [...common, ...(kind === 'organize'
    ? ['works', 'survivor', 'episodes', 'canMerge', 'canOrganize']
    : ['resourceId', 'name', 'sourceDirectory', 'directories', 'canApply'])], at)
  if (preview.kind !== kind) invalid(`${at}.kind does not match its journal`)
  for (const field of ['fingerprint', 'targetDirectory', 'root', 'bundleId']) string(preview[field], `${at}.${field}`)
  strings(preview.warnings, `${at}.warnings`)
  for (const file of array(preview.files, `${at}.files`)) journalFile(file, `${at}.files[]`, false)
  for (const input of array(preview.collisions, `${at}.collisions`)) {
    const collision = keys(input, ['code', 'scope', 'message'], `${at}.collisions[]`, ['fileId', 'path', 'resourceIds'])
    for (const field of ['code', 'message', 'fileId', 'path']) if (Object.hasOwn(collision, field)) string(collision[field], `${at}.collisions[].${field}`)
    oneOf(collision.scope, ['logical', 'physical', 'file'], `${at}.collisions[].scope`)
    if (Object.hasOwn(collision, 'resourceIds')) strings(collision.resourceIds, `${at}.collisions[].resourceIds`)
  }
  if (kind === 'organize') {
    const request = keys(preview.request, ['resourceIds', 'survivorId'], `${at}.request`, ['targetDirectory', 'root', 'fileNames', 'collectionTitle', 'episodeNumbers', 'transfer'])
    if (Object.hasOwn(request, 'transfer')) oneOf(request.transfer, ['copy','move'], `${at}.request.transfer`)
    if (Object.hasOwn(request, 'collectionTitle')) string(request.collectionTitle, `${at}.request.collectionTitle`)
    if (Object.hasOwn(request, 'episodeNumbers')) for (const value of Object.values(object(request.episodeNumbers, `${at}.request.episodeNumbers`))) {
      const number = keys(value, ['season', 'episode'], `${at}.request.episodeNumbers[]`)
      integer(number.season, `${at}.request.episodeNumbers[].season`); integer(number.episode, `${at}.request.episodeNumbers[].episode`)
    }
    strings(request.resourceIds, `${at}.request.resourceIds`)
    string(request.survivorId, `${at}.request.survivorId`)
    for (const field of ['targetDirectory', 'root']) if (Object.hasOwn(request, field)) string(request[field], `${at}.request.${field}`)
    if (Object.hasOwn(request, 'fileNames')) for (const name of Object.values(object(request.fileNames, `${at}.request.fileNames`))) string(name, `${at}.request.fileNames[]`)
    for (const field of ['canMerge', 'canOrganize']) boolean(preview[field], `${at}.${field}`)
    for (const work of array(preview.works, `${at}.works`)) journalWork(work, `${at}.works[]`)
    journalWork(preview.survivor, `${at}.survivor`)
    for (const input of array(preview.episodes, `${at}.episodes`)) {
      const episode = keys(input, ['id', 'resourceId', 'title', 'season', 'episode', 'generated', 'fileIds'], `${at}.episodes[]`)
      for (const field of ['id', 'resourceId', 'title']) string(episode[field], `${at}.episodes[].${field}`)
      for (const field of ['season', 'episode']) integer(episode[field], `${at}.episodes[].${field}`)
      boolean(episode.generated, `${at}.episodes[].generated`); strings(episode.fileIds, `${at}.episodes[].fileIds`)
    }
  } else {
    const request = keys(preview.request, ['resourceId', 'directory', 'mode'], `${at}.request`, ['root'])
    for (const field of ['resourceId', 'directory', 'root']) if (Object.hasOwn(request, field)) string(request[field], `${at}.request.${field}`)
    oneOf(request.mode, ['rebind', 'copy'], `${at}.request.mode`)
    for (const field of ['resourceId', 'name', 'sourceDirectory']) string(preview[field], `${at}.${field}`)
    strings(preview.directories, `${at}.directories`); boolean(preview.canApply, `${at}.canApply`)
  }
}

function validateJournal(row: Row, budget: Budget, at: string): void {
  const journal = keys(json(row.data, 'object', `${at}.data`, budget), ['version', 'id', 'kind', 'mode', 'status', 'survivorId',
    'sourceIds', 'createdAt', 'updatedAt', 'targetDirectory', 'preview', 'snapshot', 'files', 'warnings', 'conflicts',
    'changes', 'logicalApplied', 'bound', 'manifest'], `${at}.data`)
  if (journal.version !== 1) invalid(`${at} has an unsupported journal version`)
  for (const field of ['id', 'kind', 'mode', 'status', 'survivorId', 'targetDirectory']) string(journal[field], `${at}.${field}`)
  for (const field of ['createdAt', 'updatedAt']) integer(journal[field], `${at}.${field}`)
  for (const field of ['sourceIds', 'warnings', 'conflicts']) strings(journal[field], `${at}.${field}`)
  for (const field of ['logicalApplied', 'bound']) boolean(journal[field], `${at}.${field}`)
  oneOf(journal.kind, ['organize', 'relocate'], `${at}.kind`)
  oneOf(journal.mode, journal.kind === 'organize' ? ['logical', 'physical'] : ['rebind', 'copy'], `${at}.mode`)
  oneOf(journal.status, ['running', 'applied', 'partial', 'rolled-back', 'rollback-partial'], `${at}.status`)
  if (journal.id !== row.id || journal.survivorId !== row.resource_id || journal.kind !== row.kind || journal.status !== row.status
    || journal.createdAt !== row.created_at || journal.updatedAt !== row.updated_at) invalid(`${at} row and journal payload disagree`)
  journalPreview(journal.preview, journal.kind as string, `${at}.preview`)
  for (const file of array(journal.files, `${at}.files`)) journalFile(file, `${at}.files[]`, true)
  const manifest = keys(journal.manifest, ['before', 'beforeHash', 'afterHash'], `${at}.manifest`, ['pendingHash'])
  if (manifest.before !== null) string(manifest.before, `${at}.manifest.before`)
  for (const key of ['beforeHash', 'afterHash', 'pendingHash']) if (Object.hasOwn(manifest, key)) string(manifest[key], `${at}.manifest.${key}`)
  const snapshot = keys(journal.snapshot, journalTables, `${at}.snapshot`)
  for (const table of journalTables) {
    const seen = new Set<string>()
    for (const entry of array(snapshot[table], `${at}.snapshot.${table}`)) {
      const saved = validateRow(table, entry, `${at}.snapshot.${table}`, budget, false, true)
      const key = JSON.stringify(primaryKey(table).map(c => saved[c]))
      if (seen.has(key)) invalid(`${at}.snapshot.${table} has duplicate rows`)
      seen.add(key)
    }
  }
  for (const entry of array(journal.changes, `${at}.changes`)) {
    const change = keys(entry, ['table', 'key', 'before', 'after'], `${at}.changes`, ['undone', 'pathMap', 'originId'])
    if (typeof change.table !== 'string' || !(journalTables as readonly string[]).includes(change.table)) invalid(`${at} has an unknown journal SQL table`)
    const table = change.table as typeof journalTables[number]
    keys(change.key, primaryKey(table), `${at}.changes.key`)
    validateRow(table, change.key, `${at}.changes.key`, budget, true, true)
    if (change.before !== null) validateRow(table, change.before, `${at}.changes.before`, budget, true, true)
    validateRow(table, change.after, `${at}.changes.after`, budget, change.before !== null, true)
    if (Object.hasOwn(change, 'undone')) boolean(change.undone, `${at}.changes.undone`)
    if (Object.hasOwn(change, 'originId')) string(change.originId, `${at}.changes.originId`)
    if (Object.hasOwn(change, 'pathMap')) {
      const map = keys(change.pathMap, ['field', 'from', 'to'], `${at}.changes.pathMap`)
      if (typeof map.field !== 'string' || !Object.hasOwn(rules[table], map.field)) invalid(`${at} has an unknown journal SQL column`)
      string(map.from, `${at}.changes.pathMap.from`); string(map.to, `${at}.changes.pathMap.to`)
    }
  }
}

function validateInput(input: unknown): LibraryBackup {
  const header = keys(input, ['format', 'version', 'schema_version', 'exported_at', 'tables'], 'backup')
  if (header.format !== LIBRARY_BACKUP_FORMAT) invalid('unsupported format')
  if (header.version !== LIBRARY_BACKUP_VERSION) invalid('unsupported format version')
  integer(header.schema_version, 'schema_version')
  if (header.schema_version < 1 || header.schema_version > SCHEMA_VERSION) invalid('unsupported schema version')
  integer(header.exported_at, 'exported_at')
  if (header.exported_at < 0) invalid('exported_at must not be negative')
  const legacyImages = header.schema_version < 11 ? { image_groups: [], image_meta: [], image_chapters: [], image_pages: [], image_progress: [], image_download_jobs: [] } : {}
  const legacyReader = header.schema_version < 12 ? { image_reader_state: [], image_bookmarks: [] } : {}
  const legacyCollections = header.schema_version < 13 ? {image_collections:[],image_collection_members:[]} : {}
  const source = keys({ video_scan_state: [], video_scan_ignores: [], video_detached_owners: [], video_discovery_sources: [], video_discovery_marks: [], ...legacyImages, ...legacyReader, ...legacyCollections, ...object(header.tables, 'tables') }, LIBRARY_BACKUP_TABLE_NAMES, 'tables')
  let totalRows = 0
  // Bound every table before traversing any rows or issuing metadata writes.
  for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
    if (!Array.isArray(source[table])) invalid(`tables.${table} must be an array`)
    const length = (source[table] as unknown[]).length
    if (length > limits.max_rows_per_table) invalid(`${table} exceeds the row limit`)
    if ((totalRows += length) > limits.max_total_rows) invalid('total rows exceed the row limit')
  }
  const budget: Budget = { textBytes: 0, jsonNodes: 0 }, tables = {} as LibraryBackupTables
  for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
    const result: Row[] = [], seen = new Set<string>()
    for (const [index, inputRow] of array(source[table], `tables.${table}`).entries()) {
      const row = validateRow(table, inputRow, `${table}[${index}]`, budget)
      const key = JSON.stringify(primaryKey(table).map(column => row[column]))
      if (seen.has(key)) invalid(`${table} contains duplicate rows`)
      seen.add(key); result.push(row)
    }
    ;(tables[table] as Row[]) = result
  }
  return { format: LIBRARY_BACKUP_FORMAT, version: LIBRARY_BACKUP_VERSION, schema_version: header.schema_version,
    exported_at: header.exported_at, tables }
}

function inspectSchema(db: SqlDb): number {
  const encoding = db.prepare('PRAGMA main.encoding').get() as { encoding: string }
  if (encoding.encoding !== 'UTF-8') invalid('unsupported SQLite text encoding; UTF-8 is required')
  const schema = db.prepare('SELECT value FROM main.settings WHERE key = ?').get(SCHEMA_KEY) as { value?: unknown } | undefined
  if (typeof schema?.value !== 'string' || !/^[1-9]\d*$/.test(schema.value)) invalid('current schema version is missing or invalid')
  const version = Number(schema.value)
  if (!Number.isSafeInteger(version) || version > SCHEMA_VERSION) invalid('current schema version is newer than supported')
  for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
    const entry = db.prepare('SELECT type FROM main.sqlite_master WHERE name = ?').get(table) as { type: string } | undefined
    if (entry?.type !== 'table') invalid(`current schema is missing table ${table}; initialize the schema and job store first`)
    const columns = db.prepare(`PRAGMA main.table_xinfo("${table}")`).all() as Array<{ name: string; type: string; notnull: number; pk: number; hidden: number }>
    if (columns.length !== columnNames(table).length) invalid(`current schema columns differ for ${table}`)
    for (const column of columns) {
      const rule = rules[table][column.name]
      if (!rule || column.hidden || column.type.toLowerCase() !== rule.replace('?', '')
        || (!column.notnull && !column.pk) !== rule.endsWith('?')) invalid(`current schema column definition differs for ${table}`)
    }
    const pk = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name)
    if (JSON.stringify(pk) !== JSON.stringify(primaryKey(table))) invalid(`current schema primary key differs for ${table}`)
  }
  return version
}

function checkIntegrity(db: SqlDb): void {
  if (db.prepare('PRAGMA main.foreign_key_check').get()) invalid('foreign key check failed')
  for (const [table, kind] of [
    ['software_meta', 'software'], ['game_meta', 'game'], ['video_meta', 'video'], ['episode', 'video'],
    ['video_sources', 'video'], ['video_directories', 'video'], ['video_assets', 'video'],
    ['image_meta', 'image'], ['image_chapters', 'image'], ['image_pages', 'image'], ['image_progress', 'image'], ['image_reader_state', 'image'], ['image_bookmarks', 'image']
  ] as const) {
    if (db.prepare(`SELECT 1 FROM ${tableSql(table)} m JOIN main.resource r ON r.id = m.resource_id WHERE r.kind <> ? LIMIT 1`).get(kind)) invalid(`${table} has an incompatible resource kind`)
  }
  if (db.prepare(`SELECT 1 FROM main.video_sources s LEFT JOIN main.episode e ON e.id = s.episode_id
    WHERE (s.scope = 'work' AND s.episode_id IS NOT NULL) OR (s.scope = 'episode' AND s.episode_id IS NULL)
      OR (s.episode_id IS NOT NULL AND s.resource_id <> e.resource_id) LIMIT 1`).get()) invalid('video_sources has inconsistent episode ownership or scope')
  if (db.prepare(`SELECT 1 FROM main.video_episode_assets l JOIN main.episode e ON e.id = l.episode_id
    JOIN main.video_assets a ON a.id = l.asset_id WHERE e.resource_id <> a.resource_id LIMIT 1`).get()) invalid('video_episode_assets has inconsistent resource ownership')
  // SQLite UNIQUE considers two NULL episode IDs distinct; work identities do not.
  if (db.prepare(`SELECT 1 FROM main.video_sources GROUP BY provider, external_id, scope, resource_id, episode_id HAVING COUNT(*) > 1 LIMIT 1`).get()) invalid('video_sources contains duplicate source identities')
  if (db.prepare('SELECT 1 FROM image_pages p JOIN image_chapters c ON c.id=p.chapter_id WHERE c.resource_id<>p.resource_id LIMIT 1').get()) invalid('image_pages has inconsistent chapter ownership')
  if (db.prepare('SELECT 1 FROM image_progress v JOIN image_pages p ON p.id=v.page_id WHERE v.resource_id<>p.resource_id LIMIT 1').get()) invalid('image_progress has inconsistent page ownership')
  if (db.prepare('SELECT 1 FROM image_bookmarks b JOIN image_pages p ON p.id=b.page_id WHERE b.resource_id<>p.resource_id LIMIT 1').get()) invalid('image_bookmarks has inconsistent page ownership')
}

function checkWriteScope(db: SqlDb): void {
  const covered = new Set<string>(LIBRARY_BACKUP_TABLE_NAMES)
  const triggers = db.prepare(`SELECT tbl_name FROM main.sqlite_master WHERE type = 'trigger'
    UNION ALL SELECT tbl_name FROM temp.sqlite_master WHERE type = 'trigger'`).all() as Array<{ tbl_name: string }>
  if (triggers.some(trigger => covered.has(trigger.tbl_name.toLowerCase()))) invalid('current schema has a trigger on a covered table; replacement cannot guarantee its scope')
  const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  const foreignKeys = db.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?, ?)')
  for (const table of tables) {
    if (covered.has(table.name)) continue
    const references = foreignKeys.all(table.name, 'main') as Array<{ parent: string }>
    if (references.some(ref => covered.has(ref.parent.toLowerCase()))) invalid('current schema has an uncovered table referencing library metadata')
  }
}

function boundExport(db: SqlDb): void {
  let count = 0, bytes = 0
  for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${tableSql(table)}`).get() as { n: number }
    if (row.n > limits.max_rows_per_table || (count += row.n) > limits.max_total_rows) invalid('export exceeds the row limit')
  }
  // Bound storage before .all() materializes it, including ill-typed SQLite BLOBs.
  for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
    const wrongTypes = columnNames(table).map(c => {
      const rule = rules[table][c]
      const allowed = rule.startsWith('text') ? ["'text'"] : rule.startsWith('integer') ? ["'integer'"] : ["'integer'", "'real'"]
      if (rule.endsWith('?')) allowed.push("'null'")
      return `typeof("${c}") NOT IN (${allowed.join(', ')})`
    })
    if (db.prepare(`SELECT 1 FROM ${tableSql(table)} WHERE ${wrongTypes.join(' OR ')} LIMIT 1`).get()) invalid(`${table} contains an invalid SQLite value type`)
    const lengths = columnNames(table).map(c => `CASE WHEN typeof("${c}") IN ('text', 'blob') THEN length(CAST("${c}" AS BLOB)) ELSE 0 END`)
    const size = db.prepare(`SELECT COALESCE(SUM(${lengths.join(' + ')}), 0) AS bytes,
      COALESCE(MAX(${lengths.length === 1 ? lengths[0] : `MAX(${lengths.join(', ')})`}), 0) AS largest FROM ${tableSql(table)}`).get() as { bytes: number; largest: number }
    if (size.largest > limits.max_string_bytes || (bytes += size.bytes) > limits.max_total_string_bytes) invalid('export exceeds the text byte limit')
  }
}

function inSavepoint<T>(db: SqlDb, commit: boolean, run: () => T): T {
  const name = `baoyi_library_backup_${++savepointSerial}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = run()
    if (!commit) db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
    db.exec(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    try { db.exec(`ROLLBACK TO SAVEPOINT ${name}`) }
    finally { db.exec(`RELEASE SAVEPOINT ${name}`) }
    throw error
  }
}

/** Reads a consistent snapshot. SQL row order retains recovery-journal chronology. */
export function buildLibraryBackup(db: SqlDb): LibraryBackup {
  return inSavepoint(db, true, () => {
    const schema_version = inspectSchema(db)
    boundExport(db)
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const tables = {} as LibraryBackupTables
    for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
      // Node 22's SQLite TEXT reader truncates embedded NUL; read validated TEXT
      // as bytes on both drivers. Fatal decoding rejects malformed stored UTF-8,
      // and ignoreBOM preserves an actual leading U+FEFF in user metadata.
      const columns = columnNames(table).map(c => rules[table][c].startsWith('text') ? `CAST("${c}" AS BLOB) AS "${c}"` : `"${c}"`).join(', ')
      ;(tables[table] as Row[]) = db.prepare(`SELECT ${columns} FROM ${tableSql(table)} ORDER BY rowid`).all().map(raw => {
        const row = { ...raw as ObjectRow }
        for (const column of columnNames(table)) if (rules[table][column].startsWith('text') && row[column] !== null) {
          if (!(row[column] instanceof Uint8Array)) invalid(`${table}.${column} was not returned as SQLite text bytes`)
          try { row[column] = decoder.decode(row[column]) }
          catch { invalid(`${table}.${column} contains malformed UTF-8 text`) }
        }
        return row as Row
      })
    }
    const backup = validateInput({ format: LIBRARY_BACKUP_FORMAT, version: LIBRARY_BACKUP_VERSION,
      schema_version, exported_at: Date.now(), tables })
    checkIntegrity(db)
    return backup
  })
}

function summarize(backup: LibraryBackup): LibraryBackupSummary {
  const table_counts = {} as LibraryBackupSummary['table_counts']
  const resources: LibraryBackupSummary['resources'] = { software: 0, game: 0, video: 0, image: 0 }
  for (const table of LIBRARY_BACKUP_TABLE_NAMES) table_counts[table] = backup.tables[table].length
  for (const row of backup.tables.resource) resources[row.kind as keyof typeof resources]++
  return { format: backup.format, version: backup.version, schema_version: backup.schema_version,
    exported_at: backup.exported_at, table_counts, total_rows: Object.values(table_counts).reduce((sum, n) => sum + n, 0),
    resources, interrupted: {
      task_records: backup.tables.task_records.filter(r => r.status === 'running').length,
      video_download_jobs: backup.tables.video_download_jobs.filter(r => r.status === 'running' || r.status === 'queued').length
    } }
}

function interruptedRow(table: LibraryBackupTableName, row: Row): Row {
  if (table === 'image_download_jobs' && (row.status === 'running' || row.status === 'queued')) {
    const job = JSON.parse(row.payload as string)
    return { ...row, status: 'interrupted', payload: JSON.stringify({ ...job, status: 'interrupted' }) }
  }
  if (table === 'task_records' && row.status === 'running') return { ...row, status: 'interrupted' }
  if (table === 'video_download_jobs' && (row.status === 'running' || row.status === 'queued')) {
    const job = JSON.parse(row.payload as string) as { status: string; items: Array<Record<string, unknown>> }
    job.status = 'interrupted'
    for (const item of job.items) for (const stage of ['transfer', 'metadata', 'registration']) {
      if (item[stage] === 'running') item[stage] = 'pending'
    }
    return { ...row, status: 'interrupted', payload: JSON.stringify(job) }
  }
  // Organize journals have no automatic scheduler. Keep their recovery data and
  // supported running/partial states verbatim for explicit manual retry/rollback.
  return row
}

function replace(db: SqlDb, input: unknown, commit: boolean): LibraryBackupSummary {
  const backup = validateInput(input)
  return inSavepoint(db, commit, () => {
    if (backup.schema_version > inspectSchema(db)) invalid('backup schema is newer than the target schema')
    checkWriteScope(db)
    for (const table of [...LIBRARY_BACKUP_TABLE_NAMES].reverse()) db.exec(`DELETE FROM ${tableSql(table)}`)
    for (const table of LIBRARY_BACKUP_TABLE_NAMES) {
      const columns = columnNames(table)
      // Override any schema-level IGNORE/REPLACE policy: a corrupt row must
      // abort the snapshot, never silently disappear or replace another row.
      const statement = db.prepare(`INSERT OR ABORT INTO ${tableSql(table)} (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      for (const row of backup.tables[table] as Row[]) {
        const restored = interruptedRow(table, row)
        const { changes } = statement.run(...columns.map(column => restored[column]))
        if (changes !== 1 && changes !== 1n) invalid(`${table} did not insert exactly one row`)
      }
    }
    checkIntegrity(db)
    return summarize(backup)
  })
}

/** A writable-connection dry run: the entire replacement is always rolled back. */
export function previewLibraryBackup(db: SqlDb, input: unknown): LibraryBackupSummary { return replace(db, input, false) }

/** Atomic metadata replacement; never deletes or restores files on disk. */
export function restoreLibraryBackup(db: SqlDb, input: unknown): LibraryBackupSummary { return replace(db, input, true) }
