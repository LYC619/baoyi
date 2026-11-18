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
import {migrateLegacyGameNotes,validateGameNote} from '../kinds/game/notes.ts'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import {comicJob,backupComicJob} from '../kinds/image/comic-job.ts'
import { SCHEMA_KEY, SCHEMA_VERSION, type SqlDb } from './schema.ts'
import { normalizeImagePreferences } from '../../src/utils/image-preferences.ts'
import { validateProjectEntries } from '../kinds/project/library.ts'
import { validateProjectContext } from '../kinds/project/context.ts'
import {insightFromRow,validateInsightContent,validateCoverage} from '../workspace/document-insights.ts'
import { launchProfileFromRow,validateLaunchInput } from '../kinds/project/launch-profiles.ts'
import { validateSkillDraft } from '../workspace/skill-profiles.ts'
import { validatePersonal } from '../workspace/personal.ts'
import { WorkspaceLinks } from '../workspace/links.ts'
import { DOCUMENT_TYPES, DEFAULT_DOCUMENT_CATEGORIES, PERSONAL_KINDS, type PersonalInput, type LinkOwner } from '../../src/types/workspace.ts'
import { date as workspaceDate, location as workspaceLocation,anchor as workspaceAnchor } from '../workspace/validation.ts'
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
const kinds = ['software', 'game', 'video', 'image', 'project', 'document'] as const
const journalTables = ['resource', 'video_meta', 'episode', 'video_sources', 'video_assets', 'video_episode_assets', 'video_directories'] as const
const arrayColumns: Partial<Record<LibraryBackupTableName, readonly string[]>> = {
  resource: ['tags', 'alternatives'], project_meta:['entries'], project_events:['evidence'], software_meta: ['launchers'], game_meta: ['save_paths', 'linked_files'],
  document_meta:['edited_fields'],
  video_meta: ['audio_tracks', 'subtitle_tracks', 'parts', 'linked_files', 'hanime_tags', 'user_edited'],
  episode: ['tags'], task_records: ['events'], organize_plans: ['steps'], pending_software: ['tags', 'launchers', 'new_tags'],
  identify_logs: ['events'], identification_reports: ['entries']
}
const watchStates = ['unwatched', 'watching', 'watched', 'dropped'] as const
// Mirror the real CHECK constraints as well, because SQLite permits callers to
// disable CHECK enforcement. These also validate historical journal patches.
const enumColumns: Partial<Record<LibraryBackupTableName, Record<string, readonly string[]>>> = {
  resource: { kind: kinds }, categories: { kind: kinds }, tags: { kind: kinds },
  project_meta: { origin:['unknown','self','third-party','mixed'], status:['active','maintaining','paused','archived'] },
  document_meta: { document_type: DOCUMENT_TYPES, read_state: ['unread','reading','read'], submodule: ['archive','reading'] },
  document_categories: {behavior:['reading','contract','certificate','other'], submodule: ['archive','reading']},
  document_custom_groups: { submodule: ['archive','reading'] },
  workspace_sessions: {module:['document','personal']},
  workspace_changes: {entity:['personal','document','link'],state:['proposed','applied','undone']},
  archive_actions:{kind:[...kinds,'personal'],state:['applied','undone'],scope:['public','all']},
  archive_runs:{status:['starting','running','completed','interrupted','failed'],scope:['public','all']},
  document_annotations: { kind: ['bookmark','excerpt'] },
  project_events: { source: ['manual','git','directory'], status: ['draft','published','dismissed'] },
  project_summaries:{kind:['day','week','version']},
  document_file_operations:{state:['prepared','copied','committed','done','attention']},
  personal_records: { kind: PERSONAL_KINDS },
  resource_links: { owner_type: ['project','event','skill','experience','asset'], kind: kinds },
  image_groups: { item_type: ['photo','comic','misc'] },
  image_meta: { item_type: ['photo','comic','misc'], publication: ['unknown','ongoing','completed'] },
  image_download_jobs: { status: ['queued','running','paused','success','failed','cancelled','interrupted'] },
  game_meta: { play_status: ['unplayed', 'playing', 'completed', 'shelved'] },
  video_meta: { media_kind:['video','audio','other'], video_type: ['movie', 'series'], watch_status: watchStates },
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
  if(table==='archive_runs')return ['session_id']
  if (table === 'project_event_generation') return ['event_id']
  if (table === 'video_discovery_marks') return ['source_id', 'entry_id']
  if (table === 'video_episode_assets') return ['episode_id', 'asset_id']
  if (table === 'video_scan_state' || table === 'video_scan_ignores') return ['path']
  if (table === 'scan_units') return ['dir']
  if (table === 'skip_list') return ['exe_path']
  return Object.hasOwn(rules[table], 'id') ? ['id'] : ['resource_id']
}

function validateRow(table: LibraryBackupTableName, input: unknown, at: string, budget: Budget, partial = false, embedded = false): Row {
  const columns = columnNames(table)
  if(table==='game_notes'&&!partial){const note=object(input,at);try{validateGameNote(note as any)}catch{invalid('invalid game note')}}
  if (table === 'episode' && !partial) input = { published_at: 0, studio: '', tags: '[]', poster_source: '', thumbnail_path: '', thumbnail_source: '', original_title: '', description: '', original_description: '', poster_path: '', source_url: '', notes: '', ...object(input, at) }
  if (table === 'video_meta' && !partial) input = { media_kind:'video', thumbnail_path: '', thumbnail_source: '', ...object(input, at) }
  if (table === 'video_directories' && !partial) input = { missing: '[]', ...object(input, at) }
  const row = keys(input, partial ? [] : columns, at, partial ? columns : [])
  const result: Row = {}
  for (const column of Object.keys(row)) {
    const value = row[column], label = `${at}.${column}`
    scalar(value, rules[table][column], label, embedded ? undefined : budget)
    if (primaryKey(table).includes(column) && value === '') invalid(`${label} is an empty primary key`)
    result[column] = value
    const allowed = enumColumns[table]?.[column]
    if (allowed && value !== null) oneOf(value, allowed, label)
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
    if(table==='image_meta'){
      const authors=json(result.authors,'array',at+'.authors',budget) as unknown[]
      strings(authors,at+'.authors')
      if(authors.length>50||authors.some(author=>!(author as string).trim()||(author as string).length>300)||new Set(authors).size!==authors.length)invalid(at+' invalid authors')
    }
    if(table==='document_insights'){
      for(const key of ['conclusions','suggested_tags','evidence','limitations'])json(result[key],'array',at+'.'+key,budget)
      json(result.coverage,'object',at+'.coverage',budget)
      const item=insightFromRow(result)
      const {coreValue,keyConclusions,suggestedCategoryId,suggestedTags,evidence,limitations}=item
      validateInsightContent({coreValue,keyConclusions,suggestedCategoryId,suggestedTags,evidence,limitations});validateCoverage(item.coverage)
      if(![0,1].includes(Number(result.active))||![0,1].includes(Number(result.user_edited))||Number(result.revision)<1||!item.id||!result.request_id||!/^[a-f0-9]{64}$/.test(item.sourceFingerprint))invalid(at+' invalid insight version')
    }
    if(table==='archive_actions'){
      if(result.before_json!=='null')json(result.before_json,'object',at+'.before_json',budget)
      json(result.after_json,'object',at+'.after_json',budget)
    }
    if (table === 'document_meta' || table === 'document_annotations') {
      if(table==='document_annotations'&&result.anchor)workspaceAnchor(json(result.anchor,'object',at+'.anchor',budget) as any)
      workspaceLocation({ page: result.page as number, offset: result.scroll_offset as number })
      if (table === 'document_meta') {
        if (![0,1].includes(result.type_locked as number)) invalid(at+' invalid category protection')
        if (![0,1].includes(result.favorite as number)) invalid(at+' invalid favorite state')
        workspaceDate(result.issued_on); workspaceDate(result.expires_on)
        if ((result.page_count as number) < 0) invalid(at + ' invalid page count')
      }
    }
    if (table === 'skill_proposal') validateSkillDraft(JSON.parse(result.draft_json as string))
    if (table === 'skill_record') { workspaceDate(result.occurred_on); const value=JSON.parse(result.value_json as string); if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))invalid(at+' invalid metric value'); if(![0,1].includes(result.undone as number)) invalid(at+' invalid undo state') }
    if (table === 'personal_records') {
      const data = json(result.data, 'object', at + '.data', budget)
      validatePersonal({ id: result.id, kind: result.kind, name: result.name, body: result.body, data } as PersonalInput)
    }
    if (table === 'resource_links' && result.location) workspaceLocation(json(result.location, 'object', at + '.location', budget) as any)
    if (table === 'project_context') {
      if(result.baseline)json(result.baseline,'object',at+'.baseline',budget)
      const contextRules=json(result.rules,'array',at+'.rules',budget)
      validateProjectContext({current:result.current_text,next:result.next_text,prompt:result.prompt_text,rules:contextRules,version:result.version,revision:result.revision,updatedAt:result.updated_at} as any)
    }
    if(table==='project_launch_profiles'){
      json(result.args_json,'array',at+'.args_json',budget)
      const {projectId,trusted,trustStamp,createdAt,updatedAt,...profile}=launchProfileFromRow(result)
      validateLaunchInput(profile)
      if(![0,1].includes(result.trusted as number)||![0,1].includes(result.enabled as number)||trustStamp&&!/^[a-f0-9]{64}$/.test(trustStamp))invalid(at+' invalid launch trust')
      void projectId;void trusted;void createdAt;void updatedAt
    }
    if (table === 'project_events') {
      if (![0, 1].includes(result.milestone as number) || ![0, 1].includes(result.revised as number)) invalid(at + ' invalid event state')
      strings(JSON.parse(result.evidence as string), at + '.evidence')
    }
    if (table === 'project_event_generation') {
      if (![0, 1].includes(result.undone as number)) invalid(at + ' invalid undo state')
      const original = json(result.original, 'object', at + '.original', budget) as Record<string, unknown>
      if (original.id !== result.event_id || original.projectId !== result.resource_id) invalid(at + ' invalid generation source')
    }
    if (table === 'project_automation' && ![0, 1].includes(result.enabled as number)) invalid(at + ' invalid auto recording state')
    if(table==='project_summaries'){
      if(![0,1].includes(result.revised as number)||![0,1].includes(result.undone as number))invalid(at+' invalid summary state')
      if(result.kind!=='version'&&!workspaceDate(result.group_key))invalid(at+' invalid summary date')
      const original=keys(json(result.original,'object',at+'.original',budget),['title','body'],at+'.original');string(original.title,at+'.title');string(original.body,at+'.body')
      const sources=json(result.sources,'array',at+'.sources',budget)
      for(const value of sources as unknown[]){const source=object(value,at+'.source');if(source.projectId!==result.resource_id)invalid(at+' summary source project mismatch');string(source.id,at+'.source.id');string(source.title,at+'.source.title');string(source.body,at+'.source.body');strings(source.evidence,at+'.source.evidence')}
    }
    if (table === 'identify_logs' || table === 'identification_reports') {
      if (result.resource_kind !== null) oneOf(result.resource_kind, kinds, `${at}.resource_kind`)
    }
    if(table==='image_download_jobs'){
      const value=json(result.payload,'object',at+'.payload',budget) as Record<string,unknown>
      if(value.version===2){
        const job=comicJob(value)
        if(job.id!==result.id||job.status!==result.status||job.updatedAt!==result.updated_at)invalid(at+' row and job disagree')
      }
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
    if (table === 'project_sessions') validateProjectSession(result,budget,at)
    if (table === 'workspace_sessions') validateWorkspaceSession(result,budget,at)
    if(table==='document_recycle'){
      const r=keys(json(result.payload,'object',at+'.payload',budget),['id','documentId','name','root','createdAt','expiresAt','state','files','snapshot','error'],at+'.recycle',['restoring'])
      for(const key of ['id','documentId','name','root','error'])string(r[key],at+'.'+key)
      if(!/^[a-f0-9-]{36}$/i.test(String(r.id))||r.id!==result.id||r.documentId!==result.resource_id||r.state!==result.state||r.createdAt!==result.created_at||r.expiresAt!==result.expires_at)invalid(at+' recycle ownership disagrees')
      oneOf(r.state,['indexed','recycled','attention','restored','purged'],at+'.state');integer(r.createdAt,at+'.createdAt');integer(r.expiresAt,at+'.expiresAt')
      if(r.restoring!==undefined)boolean(r.restoring,at+'.restoring')
      if(!Array.isArray(r.files)||r.files.length>100)invalid(at+' recycle files invalid')
      const snapshot=object(r.snapshot,at+'.snapshot');if(snapshot.id!==r.documentId)invalid(at+' recycle snapshot disagrees')
      for(const [i,value] of r.files.entries()){
        const file=keys(value,['source','stored','stamp','storedIdentity','state','restoredTo'],at+'.file')
        for(const key of ['source','stored','storedIdentity','restoredTo'])string(file[key],at+'.'+key)
        oneOf(file.state,['pending','stored','restored','purged'],at+'.file.state')
        const stamp=keys(file.stamp,['identity','digest','size'],at+'.stamp');string(stamp.identity,at+'.identity');string(stamp.digest,at+'.digest');integer(stamp.size,at+'.size')
        if(stamp.size<0||!/^[a-f0-9]{64}$/.test(stamp.digest))invalid(at+' recycle stamp invalid')
        const paths=/^[A-Za-z]:[\\/]/.test(String(r.root))?path.win32:path
        if(!paths.isAbsolute(String(r.root))||!paths.isAbsolute(String(file.source))||paths.dirname(String(file.stored))!==r.root||file.stored!==paths.join(String(r.root),r.id+'-'+i+paths.extname(String(file.source))))invalid(at+' recycle path invalid')
      }
    }
    if(table==='document_file_operations'){
      const op=keys(json(result.payload,'object',at+'.payload',budget),['id','documentId','source','destination','mode','stamp','createdAt','state','destinationIdentity','error'],at+'.operation',['projectId','undone','undoPending','undoSourceIdentity','undoDestinationIdentity'])
      for(const key of ['id','documentId','source','destination','destinationIdentity','error'])string(op[key],at+'.'+key)
      for(const key of ['projectId','undoSourceIdentity','undoDestinationIdentity'])if(Object.hasOwn(op,key))string(op[key],at+'.'+key)
      for(const key of ['undone','undoPending'])if(Object.hasOwn(op,key))boolean(op[key],at+'.'+key)
      if(op.undoPending && (op.mode!=='move'||!op.undoSourceIdentity||!op.undoDestinationIdentity||op.undone))invalid(at+' invalid pending undo')
      oneOf(op.mode,['link','copy','move'],at+'.mode');oneOf(op.state,['prepared','copied','committed','done','attention'],at+'.state');integer(op.createdAt,at+'.createdAt')
      if(op.id!==result.id||op.documentId!==result.resource_id||op.state!==result.state||op.createdAt!==result.created_at)invalid(at+' operation ownership disagrees')
      const stamp=keys(op.stamp,['identity','digest','size'],at+'.stamp');string(stamp.identity,at+'.identity');string(stamp.digest,at+'.digest');integer(stamp.size,at+'.size')
      if(stamp.size<0||!/^[a-f0-9]{64}$/.test(stamp.digest))invalid(at+' invalid file stamp')
    }
    if (table === 'workspace_changes') validateWorkspaceChange(result,budget,at)
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

function validateWorkspaceSession(row:Row,budget:Budget,at:string):void {
  const session=keys(json(row.payload,'object',at+'.payload',budget),['id','module','title','context','createdAt','updatedAt','status','messages','tokens','error'],at,['contextCheckpoint'])
  if(session.module!==row.module||session.createdAt!==row.created_at)invalid(at+' row and session disagree')
  integer(session.createdAt,at+'.createdAt')
  const context=keys(session.context,[],at+'.context',['documentIds','selection'])
  if(context.documentIds)strings(context.documentIds,at+'.documentIds')
  if(context.selection){const selection=keys(context.selection,['documentId','quote','location'],at+'.selection');string(selection.documentId,at+'.documentId');string(selection.quote,at+'.quote');workspaceLocation(selection.location as any)}
  const {module,context:_context,createdAt,...common}=session
  validateProjectSession({...row,resource_id:String(module),payload:JSON.stringify({...common,projectId:module})},budget,at)
}
function validateWorkspaceChange(row:Row,budget:Budget,at:string):void {
  const snapshots=[json(row.after_json,'object',at+'.after',budget)]
  if(row.before_json!=='null')snapshots.push(json(row.before_json,'object',at+'.before',budget))
  for(const input of snapshots){const snapshot=object(input,at+'.snapshot');if(snapshot.id!==row.target_id)invalid(at+' invalid change target')
    if(row.entity==='personal')validatePersonal(snapshot as unknown as PersonalInput)
    else if(row.entity==='document'){
      keys(snapshot,['id','name','type','author','counterpart','issuedOn','expiresOn','notes','tags','readState','typeLocked','editedFields'],at+'.document');strings(snapshot.editedFields,at+'.editedFields')
      for(const key of ['id','name','type','author','counterpart','notes'])string(snapshot[key],at+'.'+key)
      workspaceDate(snapshot.issuedOn);workspaceDate(snapshot.expiresOn);strings(snapshot.tags,at+'.tags');boolean(snapshot.typeLocked,at+'.typeLocked');oneOf(snapshot.readState,['unread','reading','read'],at+'.readState')
    }else {keys(snapshot,['id','ownerType','ownerId','resourceId','annotationId'],at+'.link');oneOf(snapshot.ownerType,['project','event','skill','experience','asset'],at+'.ownerType');string(snapshot.ownerId,at+'.ownerId');if(snapshot.resourceId!==null)string(snapshot.resourceId,at+'.resourceId');if(snapshot.annotationId!==null)string(snapshot.annotationId,at+'.annotationId')}
  }
}
function validateProjectSession(row:Row,budget:Budget,at:string):void {
  const session=keys(json(row.payload,'object',at+'.payload',budget),['id','projectId','title','updatedAt','status','messages','tokens','error'],at,['workflow','summary','contextCheckpoint'])
  if(session.summary){const summary=keys(session.summary,['kind','key'],at+'.summary');oneOf(summary.kind,['day','week','version'],at+'.summary.kind');string(summary.key,at+'.summary.key');if(summary.kind!=='version'&&!workspaceDate(summary.key))invalid(at+' invalid summary date')}
  if(session.workflow){
    const workflow=keys(session.workflow,['kind','state','head','readComplete','next'],at+'.workflow',['after'])
    oneOf(workflow.kind,['timeline'],at+'.workflow.kind');oneOf(workflow.state,['running','paused','complete'],at+'.workflow.state')
    string(workflow.head,at+'.workflow.head');boolean(workflow.readComplete,at+'.workflow.readComplete')
    if(workflow.after)string(workflow.after,at+'.workflow.after')
    if(workflow.next!==null){const next=keys(workflow.next,['head','offset'],at+'.workflow.next',['since','until','after']);string(next.head,at+'.next.head');integer(next.offset,at+'.next.offset');if(next.since)workspaceDate(next.since);if(next.until)workspaceDate(next.until);if(next.after)string(next.after,at+'.next.after')}
  }
  for(const field of ['id','projectId','title','error'])string(session[field],at+'.'+field)
  if(session.id!==row.id||session.projectId!==row.resource_id||session.title!==row.title||session.updatedAt!==row.updated_at)invalid(at+' row and session disagree')
  integer(session.updatedAt,at+'.updatedAt');integer(session.tokens,at+'.tokens')
  oneOf(session.status,['idle','running','interrupted','failed'],at+'.status')
  const messages=array(session.messages,at+'.messages');if(messages.length>100000)invalid(at+' too many messages')
  if(Object.hasOwn(session,'contextCheckpoint')){
    const checkpoint=keys(session.contextCheckpoint,['version','through','lastMessageId','digest','summary'],at+'.checkpoint')
    if(checkpoint.version!==1)invalid(at+' invalid checkpoint version');integer(checkpoint.through,at+'.checkpoint.through')
    for(const key of ['lastMessageId','digest','summary'])string(checkpoint[key],at+'.checkpoint.'+key)
    if(checkpoint.through<0||checkpoint.through>messages.length||!(/^[a-f0-9]{64}$/).test(checkpoint.digest as string)||(checkpoint.summary as string).length>10000)invalid(at+' invalid checkpoint')
    if(checkpoint.lastMessageId!==(checkpoint.through?object(messages[checkpoint.through-1],at+'.message').id:''))invalid(at+' checkpoint source disagrees')
  }
  const ids=new Set<string>()
  for(const input of messages){
    const message=keys(input,['id','role','text','createdAt','events'],at+'.message',['proposal'])
    string(message.id,at+'.message.id');string(message.text,at+'.message.text');integer(message.createdAt,at+'.createdAt');oneOf(message.role,['user','assistant'],at+'.role')
    if(ids.has(message.id as string))invalid(at+' repeated message id');ids.add(message.id as string)
    for(const value of array(message.events,at+'.events')){const event=keys(value,['label','detail'],at+'.event',['error']);string(event.label,at+'.label');string(event.detail,at+'.detail');if(event.error!==undefined)boolean(event.error,at+'.error')}
    if(message.proposal){
      const proposal=keys(message.proposal,['patch','before','stamp','applied'],at+'.proposal');string(proposal.stamp,at+'.stamp');boolean(proposal.applied,at+'.applied')
      for(const field of ['patch','before']){
        const patch=keys(proposal[field],[],at+'.'+field,['name','summary','category','source','state','group','tags','notes'])
        for(const [key,value] of Object.entries(patch))if(key==='tags')strings(value,at+'.tags');else string(value,at+'.'+key)
      }
    }
  }
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
      'receivedBytes', 'totalBytes', 'error', 'warnings'], `${at}.items`, ['publishedAt', 'releaseDate', 'durationSec', 'artist', 'originalTitle', 'description', 'posterUrl', 'posterPath', 'thumbnailUrl', 'thumbnailPath', 'tags', 'bytesPerSecond', 'transferMessage', 'missing'])
    if(Object.hasOwn(item,'bytesPerSecond'))integer(item.bytesPerSecond,`${at}.items.bytesPerSecond`)
    if(Object.hasOwn(item,'transferMessage'))string(item.transferMessage,`${at}.items.transferMessage`)
    if(Object.hasOwn(item,'missing'))strings(item.missing,`${at}.items.missing`)
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
  const header = keys(input, ['format', 'version', 'schema_version', 'exported_at', 'tables'], 'backup',['assistant'])
  if (header.format !== LIBRARY_BACKUP_FORMAT) invalid('unsupported format')
  if (header.version !== LIBRARY_BACKUP_VERSION) invalid('unsupported format version')
  integer(header.schema_version, 'schema_version')
  if (header.schema_version < 1 || header.schema_version > SCHEMA_VERSION) invalid('unsupported schema version')
  integer(header.exported_at, 'exported_at')
  if (header.exported_at < 0) invalid('exported_at must not be negative')
  const legacyImages = header.schema_version < 11 ? { image_groups: [], image_meta: [], image_chapters: [], image_pages: [], image_progress: [], image_download_jobs: [] } : {}
  const legacyReader = header.schema_version < 12 ? { image_reader_state: [], image_bookmarks: [] } : {}
  const legacyCollections = header.schema_version < 13 ? {image_collections:[],image_collection_members:[]} : {}
  const legacyProjects = {...(header.schema_version < 14 ? {project_meta:[]} : {}),...(header.schema_version < 15 ? {project_sessions:[]} : {})}
  const legacyWorkspace = { ...(header.schema_version < 17 ? { document_meta: [], document_annotations: [], project_context: [], project_events: [], personal_records: [], resource_links: [] } : {}), ...(header.schema_version < 18 ? { project_event_generation: [], project_automation: [] } : {}),...(header.schema_version<19?{document_categories:DEFAULT_DOCUMENT_CATEGORIES.map(({order,...c})=>({...c,sort_order:order}))}:{}) }
  const source = keys({ ...(header.schema_version<31?{game_notes:[]}:{}), ...(header.schema_version<29?{document_insights:[]}:{}), ...(header.schema_version<28?{project_launch_profiles:[]}:{}), ...(header.schema_version<27?{archive_actions:[],archive_runs:[]}:{}), ...(header.schema_version<25?{document_custom_groups:[]}:{}), ...(header.schema_version<24?{skill_card:[],skill_metric:[],skill_record:[],skill_proposal:[]}:{}), video_scan_state: [], video_scan_ignores: [], video_detached_owners: [], video_discovery_sources: [], video_discovery_marks: [], ...(header.schema_version<23?{document_recycle:[]}:{}),...(header.schema_version<22?{document_files:[],document_file_operations:[]}:{}),...(header.schema_version<21?{project_summaries:[]}:{}),...(header.schema_version<19?{workspace_sessions:[],workspace_changes:[]}:{}),...legacyImages, ...legacyReader, ...legacyCollections, ...legacyProjects, ...legacyWorkspace, ...object(header.tables, 'tables') }, LIBRARY_BACKUP_TABLE_NAMES, 'tables')
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
      let legacyRow=table==='software_meta' && header.schema_version<16
        ? {category_locked:0,...object(inputRow,`${table}[${index}]`)} : inputRow
      if(table==='game_meta'&&header.schema_version<31)legacyRow={cover_focus:'',...object(legacyRow,`${table}[${index}]`)}
      if(table==='archive_actions'||table==='archive_runs')legacyRow={scope:'all',...object(legacyRow,`${table}[${index}]`)}
      if(table==='project_context'&&header.schema_version<28)legacyRow={prompt_text:'',rules:'[]',version:1,revision:0,updated_at:0,...object(legacyRow,`${table}[${index}]`)}
      if(table==='document_custom_groups'&&!('category_id' in object(legacyRow,`${table}[${index}]`))){const row=object(legacyRow,`${table}[${index}]`);legacyRow={category_id:row.submodule==='archive'?'archive_other':'novel',...row}}
      if(table==='document_categories'&&header.schema_version<25){const row=object(legacyRow,`${table}[${index}]`);const sub=['certificate','contract'].includes(String(row.behavior))||['certificate','contract'].includes(String(row.id))?'archive':'reading';legacyRow={submodule:row.submodule||sub,...row}}
      if(table==='document_meta'&&header.schema_version<25){
        const row=object(legacyRow,`${table}[${index}]`)
        const cat = (source.document_categories as ObjectRow[]).find(c => c.id === (row.category_id || row.document_type))
        const sub = cat?.behavior === 'reading' || ['book','novel','paper','reference'].includes(String(row.document_type)) ? 'reading' : ['contract','certificate'].includes(String(cat?.behavior || row.document_type)) ? 'archive' : null
        legacyRow={submodule:sub,custom_group_id:null,...row}
      }
      if(table==='document_meta'&&header.schema_version<19){const row=object(legacyRow,`${table}[${index}]`);legacyRow={category_id:row.document_type,type_locked:1,edited_fields:JSON.stringify(['name','type','author','counterpart','issuedOn','expiresOn','notes','tags','readState']),...row}}
      if(table==='document_meta'&&header.schema_version<19){
        const row=object(legacyRow,`${table}[${index}]`), mapped = ({contract:'archive_other',reference:'book',other:'reading_other'} as Record<string,string>)[String(row.category_id)]
        if(mapped)legacyRow={...row,category_id:mapped,document_type:mapped}
      }
      if(table==='document_annotations'&&header.schema_version<20)legacyRow={anchor:'',...object(legacyRow,`${table}[${index}]`)}
      if(table==='image_groups'&&header.schema_version<26)legacyRow={item_type:'comic',directory:'',...object(legacyRow,`${table}[${index}]`)}
      if(table==='image_meta'&&header.schema_version<30)legacyRow={authors:'[]',...object(legacyRow,`${table}[${index}]`)}
      if(table==='document_meta')legacyRow={favorite:0,...object(legacyRow,`${table}[${index}]`)}
      const row = validateRow(table, legacyRow, `${table}[${index}]`, budget)
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
  if (db.prepare('SELECT 1 FROM project_event_generation g JOIN project_events e ON e.id=g.event_id WHERE e.resource_id<>g.resource_id LIMIT 1').get()) invalid('project event generation has inconsistent ownership')
  for (const row of db.prepare('SELECT entries,default_entry,pinned FROM project_meta').all() as Array<{entries:string;default_entry:string;pinned:number}>) {
    const entries=validateProjectEntries(JSON.parse(row.entries))
    if(row.default_entry&&!entries.some(e=>e.id===row.default_entry))invalid('project default entry is missing')
    if(row.pinned!==0&&row.pinned!==1)invalid('project pinned must be 0 or 1')
  }
  if (db.prepare('PRAGMA main.foreign_key_check').get()) invalid('foreign key check failed')
  if (db.prepare("SELECT 1 FROM skill_card c JOIN personal_records p ON p.id=c.id WHERE p.kind!='skill' UNION ALL SELECT 1 FROM skill_card c LEFT JOIN skill_card parent ON parent.id=c.parent_id WHERE c.parent_id!='' AND parent.id IS NULL LIMIT 1").get()) invalid('invalid skill card or parent')
  if (db.prepare('SELECT 1 FROM skill_record r JOIN skill_metric m ON m.id=r.metric_id WHERE r.card_id!=m.card_id OR r.version!=m.version LIMIT 1').get()) invalid('skill record metric version mismatch')
  if (db.prepare("SELECT 1 FROM skill_metric WHERE version<1 OR trim(metric_key)='' OR trim(label)='' UNION ALL SELECT 1 FROM skill_card WHERE revision<1 LIMIT 1").get()) invalid('invalid skill definition')
  for(const row of db.prepare('SELECT r.value_json,r.occurred_on,m.value_type FROM skill_record r JOIN skill_metric m ON m.id=r.metric_id').all() as {value_json:string;occurred_on:string;value_type:string}[]){
    const value=JSON.parse(row.value_json)
    if(!row.occurred_on)invalid('skill record date missing')
    if(row.value_type==='number'&&(typeof value!=='number'||!Number.isFinite(value)))invalid('skill record number invalid')
    if(row.value_type!=='number'&&typeof value!=='string')invalid('skill record text invalid')
    if(row.value_type==='date'&&!workspaceDate(value))invalid('skill record date value missing')
  }
  const parents=new Map((db.prepare('SELECT id,parent_id FROM skill_card').all() as {id:string;parent_id:string}[]).map(c=>[c.id,c.parent_id]))
  for(const id of parents.keys()){const seen=new Set<string>();let current=id;while(current){if(seen.has(current))invalid('cyclic skill hierarchy');seen.add(current);current=parents.get(current)||''}}
  for (const [table, kind] of [
    ['software_meta', 'software'], ['project_meta', 'project'], ['project_sessions','project'], ['project_context','project'], ['project_launch_profiles','project'], ['project_events','project'], ['project_summaries','project'],['document_meta','document'], ['document_annotations','document'],['document_files','document'],['document_insights','document'],['document_recycle','document'],['document_file_operations','document'], ['game_meta', 'game'], ['game_notes','game'], ['video_meta', 'video'], ['episode', 'video'],
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
  for (const row of db.prepare('SELECT * FROM resource_links').all() as Array<Record<string, any>>) {
    new WorkspaceLinks(db).owner(row.owner_type as LinkOwner, row.owner_id)
    if (row.owner_resource_id !== (row.owner_type === 'project' ? row.owner_id : null)
      || row.owner_event_id !== (row.owner_type === 'event' ? row.owner_id : null)
      || row.owner_personal_id !== (['skill','experience','asset'].includes(row.owner_type) ? row.owner_id : null)) invalid('resource_links has inconsistent owner')
    if (row.annotation_id && !db.prepare('SELECT 1 FROM document_annotations WHERE id=? AND resource_id=?').get(row.annotation_id, row.resource_id)) invalid('resource_links has inconsistent annotation')
  }
  if (db.prepare("SELECT 1 FROM personal_records m LEFT JOIN personal_records p ON p.id=json_extract(m.data,'$.metricId') WHERE m.kind='measurement' AND (p.id IS NULL OR p.kind!='metric') LIMIT 1").get()) invalid('measurement has an invalid metric')
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
        if(table==='image_download_jobs'){
          const value=JSON.parse(String(row.payload))
          if(value.version===2){const job=backupComicJob(value);row.payload=JSON.stringify(job);row.status=job.status}
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
  const resources: LibraryBackupSummary['resources'] = { software: 0, game: 0, video: 0, image: 0, project:0, document:0 }
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
  if(table==='image_download_jobs'){
    const value=JSON.parse(String(row.payload))
    if(value.version===2){const job=backupComicJob(value);return {...row,status:job.status,payload:JSON.stringify(job)}}
  }
  if(table==='project_launch_profiles')return {...row,trusted:0,trust_stamp:''}
  if(table==='archive_runs'&&['starting','running'].includes(String(row.status)))return {...row,status:'interrupted',error:'从备份恢复，可以继续处理'}
  if(table==='project_sessions'||table==='workspace_sessions') {
    const session=JSON.parse(row.payload as string)
    if(session.status==='running')return {...row,payload:JSON.stringify({...session,...(session.workflow?{workflow:{...session.workflow,state:'paused'}}:{}),status:'interrupted',error:'对话从备份恢复，可继续发送消息。'})}
  }
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
    if(backup.schema_version<31)migrateLegacyGameNotes(db)
    checkIntegrity(db)
    return summarize(backup)
  })
}

/** A writable-connection dry run: the entire replacement is always rolled back. */
export function previewLibraryBackup(db: SqlDb, input: unknown): LibraryBackupSummary { return replace(db, input, false) }

/** Atomic metadata replacement; never deletes or restores files on disk. */
export function restoreLibraryBackup(db: SqlDb, input: unknown): LibraryBackupSummary { return replace(db, input, true) }
