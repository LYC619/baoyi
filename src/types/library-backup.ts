/** Version 1 is a complete metadata snapshot, not a settings or file backup. */
export const LIBRARY_BACKUP_FORMAT = 'baoyi-library-metadata' as const
export const LIBRARY_BACKUP_VERSION = 1 as const

/** Bounds apply equally to export, preview and restore; string sizes are UTF-8 bytes. */
export const LIBRARY_BACKUP_LIMITS = Object.freeze({
  max_rows_per_table: 100_000,
  max_total_rows: 500_000,
  max_string_bytes: 8 * 1024 * 1024,
  max_total_string_bytes: 64 * 1024 * 1024,
  max_json_depth: 64,
  max_json_nodes: 1_000_000
})

/**
 * Static allowlist, in parent-before-child insertion order. Views, SQL index
 * definitions, settings, SQLite internals and legacy migration snapshots are
 * never accepted from a backup. Existing database indexes stay in place.
 * `?` means SQL NULL is allowed; primary keys are always required, including
 * the TEXT primary keys for which SQLite itself permits NULL.
 */
export const LIBRARY_BACKUP_COLUMNS = {
  resource: {
    id: 'text', kind: 'text', created_at: 'integer', updated_at: 'integer', path: 'text',
    icon_path: 'text?', file_name: 'text', file_size: 'integer?', source_dir: 'text?',
    name_zh: 'text?', name_en: 'text?', summary: 'text?', description: 'text?', category: 'text?',
    tags: 'text?', official_url: 'text?', ai_status: 'text?', why_choose: 'text?', use_cases: 'text?',
    notes: 'text?', alternatives: 'text?', mastery_level: 'text?', last_used_at: 'integer?',
    use_count: 'integer?', is_archived: 'integer?', external_active_at: 'integer?'
  },
  project_meta: { resource_id:'text', origin:'text', status:'text', group_name:'text', pinned:'integer', version:'text', entries:'text', default_entry:'text', evidence:'text' },
  project_sessions: { id:'text',resource_id:'text',title:'text',created_at:'integer',updated_at:'integer',payload:'text' },
  document_categories: {id:'text',submodule:'text',name:'text',description:'text',behavior:'text',sort_order:'integer'},
  document_custom_groups: {id:'text',submodule:'text',category_id:'text?',name:'text',sort_order:'integer',created_at:'integer',updated_at:'integer'},
  workspace_sessions: {id:'text',module:'text',title:'text',created_at:'integer',updated_at:'integer',payload:'text'},
  workspace_changes: {id:'text',session_id:'text',entity:'text',target_id:'text',before_json:'text',after_json:'text',state:'text',created_at:'integer'},
  archive_actions: {id:'text',session_id:'text',target_id:'text',name:'text',kind:'text',reason:'text',before_json:'text',after_json:'text',state:'text',created_at:'integer',scope:'text'},
  archive_runs: {session_id:'text',status:'text',text:'text',error:'text',started_at:'integer',updated_at:'integer',scope:'text'},
  document_meta: { resource_id:'text',document_type:'text',category_id:'text?',submodule:'text?',custom_group_id:'text?',favorite:'integer',type_locked:'integer',edited_fields:'text',format:'text',author:'text',counterpart:'text',issued_on:'text',expires_on:'text',read_state:'text',page:'integer',page_count:'integer',scroll_offset:'real' },
  document_annotations: { id:'text',resource_id:'text',kind:'text',quote:'text',note:'text',page:'integer',scroll_offset:'real',anchor:'text',created_at:'integer',updated_at:'integer' },
  document_files: {id:'text',resource_id:'text',path:'text',project_id:'text?',created_at:'integer'},
  document_insights: {id:'text',resource_id:'text',revision:'integer',active:'integer',core_value:'text',conclusions:'text',suggested_category:'text?',suggested_tags:'text',evidence:'text',limitations:'text',model:'text',prompt_version:'text',source_fingerprint:'text',source_file_id:'text',coverage:'text',session_id:'text',request_id:'text',generated_at:'integer',updated_at:'integer',user_edited:'integer'},
  document_recycle: {id:'text',resource_id:'text',state:'text',created_at:'integer',expires_at:'integer',payload:'text'},
  document_file_operations: {id:'text',resource_id:'text',state:'text',created_at:'integer',payload:'text'},
  project_context: { resource_id:'text',current_text:'text',next_text:'text',baseline:'text',prompt_text:'text',rules:'text',version:'integer',revision:'integer',updated_at:'integer' },
  project_launch_profiles: {id:'text',resource_id:'text',name:'text',kind:'text',command:'text',args_json:'text',cwd:'text',source:'text',source_ref:'text',port:'integer?',url:'text',trusted:'integer',trust_stamp:'text',revision:'integer',enabled:'integer',created_at:'integer',updated_at:'integer'},
  project_events: { id:'text',resource_id:'text',title:'text',body:'text',occurred_at:'integer',milestone:'integer',version:'text',source:'text',source_key:'text',evidence:'text',status:'text',revised:'integer',created_at:'integer',updated_at:'integer' },
  personal_records: { id:'text',kind:'text',name:'text',body:'text',data:'text',created_at:'integer',updated_at:'integer' },
  skill_card: {id:'text',parent_id:'text',revision:'integer'},
  skill_metric: {id:'text',card_id:'text',metric_key:'text',label:'text',unit:'text',value_type:'text',version:'integer'},
  skill_record: {id:'text',card_id:'text',metric_id:'text',version:'integer',value_json:'text',occurred_on:'text',evidence:'text',request_id:'text',undone:'integer',created_at:'integer'},
  skill_proposal: {id:'text',draft_json:'text',state:'text',card_id:'text',created_at:'integer'},
  resource_links: { id:'text',owner_type:'text',owner_id:'text',owner_resource_id:'text?',owner_event_id:'text?',owner_personal_id:'text?',target_key:'text',resource_id:'text?',annotation_id:'text?',kind:'text',name:'text',path:'text',quote:'text',location:'text',created_at:'integer' },
  project_event_generation: { event_id:'text',resource_id:'text',session_id:'text',original:'text',undone:'integer',created_at:'integer' },
  project_summaries: {id:'text',resource_id:'text',kind:'text',group_key:'text',title:'text',body:'text',sources:'text',source_stamp:'text',session_id:'text',revised:'integer',undone:'integer',original:'text',created_at:'integer',updated_at:'integer'},
  project_automation: { resource_id:'text',enabled:'integer',last_head:'text',observed_head:'text',pending_since:'integer',session_id:'text',last_error:'text' },
  image_groups: { id: 'text', name: 'text', item_type:'text', directory:'text', sort_order: 'integer', hidden: 'integer' },
  image_collections: {id:'text',name:'text',created_at:'integer'},
  image_collection_members: {collection_id:'text',resource_id:'text',position:'integer'},
  image_meta: { resource_id: 'text', item_type: 'text', group_id: 'text?', favorite: 'integer', publication: 'text', cover_page_id: 'text', source: 'text', source_id: 'text',authors:'text' },
  image_chapters: { id: 'text', resource_id: 'text', chapter_key: 'text', title: 'text', ordinal: 'integer', source_id: 'text', customized: 'integer' },
  image_pages: { id: 'text', resource_id: 'text', chapter_id: 'text?', file: 'text', entry: 'text', ordinal: 'integer', size: 'integer', missing: 'integer' },
  image_progress: { resource_id: 'text', page_id: 'text', scroll_offset: 'real', updated_at: 'integer' },
  image_reader_state: { resource_id: 'text', is_read: 'integer', preferences: 'text' },
  image_bookmarks: { id: 'text', resource_id: 'text', page_id: 'text', scroll_offset: 'real', label: 'text', created_at: 'integer' },
  image_download_jobs: { id: 'text', status: 'text', updated_at: 'integer', payload: 'text' },
  software_meta: {
    resource_id: 'text', file_description: 'text?', company: 'text?', version: 'text?',
    launchers: 'text?', is_portable: 'integer?', move_risk: 'text?', link_target: 'text?', category_locked: 'integer'
  },
  game_notes:{id:'text',resource_id:'text',title:'text',body:'text',sort:'integer',created_at:'integer',updated_at:'integer'},
  game_meta: {
    resource_id: 'text', cover_focus:'text', cover_path: 'text?', background_path: 'text?', cover_source: 'text',
    cover_source_url: 'text', cover_status: 'text', cover_detail: 'text', identity_name: 'text',
    identity_query: 'text', identity_confirmed: 'integer', play_status: 'text',
    total_playtime_sec: 'integer', last_played_at: 'integer', save_paths: 'text', linked_files: 'text'
  },
  video_meta: {
    media_kind: 'text',
    thumbnail_path: 'text', thumbnail_source: 'text', resource_id: 'text', video_type: 'text', poster_path: 'text', poster_source: 'text',
    collection_name: 'text', fanart_path: 'text', year: 'integer', end_year: 'integer', rating: 'real',
    watch_status: 'text', position_sec: 'integer', duration_sec: 'integer', last_watched_at: 'integer',
    resolution: 'text', video_codec: 'text', source: 'text', release_group: 'text',
    audio_tracks: 'text', subtitle_tracks: 'text', parts: 'text', linked_files: 'text',
    tmdb_id: 'text', imdb_id: 'text', douban_id: 'text', douban_rating: 'real', hanime_id: 'text',
    original_description: 'text', hanime_tags: 'text', user_edited: 'text'
  },
  episode: {
    published_at: 'integer', studio: 'text',
    tags: 'text', poster_source: 'text', thumbnail_path: 'text', thumbnail_source: 'text',
    id: 'text', resource_id: 'text', season: 'integer', episode: 'integer', title: 'text',
    display_label: 'text', path: 'text', file_size: 'integer', duration_sec: 'integer',
    original_title: 'text', description: 'text', original_description: 'text', poster_path: 'text', source_url: 'text', notes: 'text',
    watch_status: 'text', position_sec: 'integer', watched_at: 'integer', air_date: 'integer'
  },
  video_scan_state: { path: 'text', fingerprint: 'text', resource_id: 'text', updated_at: 'integer' },
  video_scan_ignores: { path: 'text', resource_id: 'text', source_key: 'text', created_at: 'integer' },
  video_detached_owners: { resource_id: 'text' },
  video_sources: {
    id: 'text', resource_id: 'text', episode_id: 'text?', provider: 'text', external_id: 'text',
    scope: 'text', page_url: 'text', evidence: 'text', confirmed: 'integer', created_at: 'integer', updated_at: 'integer'
  },
  video_directories: {
    resource_id: 'text', bundle_id: 'text', root: 'text', relative_path: 'text', directory_path: 'text',
    metadata_state: 'text', missing: 'text', created_at: 'integer', updated_at: 'integer'
  },
  video_assets: {
    id: 'text', resource_id: 'text', path: 'text', role: 'text', quality: 'text', file_size: 'integer',
    state: 'text', checked_at: 'integer', created_at: 'integer'
  },
  video_episode_assets: { episode_id: 'text', asset_id: 'text' },
  video_download_jobs: { id: 'text', status: 'text', updated_at: 'integer', payload: 'text' },
  video_discovery_sources: { id: 'text', updated_at: 'integer', payload: 'text' },
  video_discovery_marks: { source_id: 'text', entry_id: 'text', payload: 'text' },
  task_records: {
    id: 'text', kind: 'text', title: 'text', status: 'text', started_at: 'integer', finished_at: 'integer',
    processed: 'integer', total: 'integer', percent: 'integer', current: 'text', message: 'text', error: 'text', events: 'text'
  },
  video_organize_journal: {
    id: 'text', resource_id: 'text', kind: 'text', status: 'text', created_at: 'integer', updated_at: 'integer', data: 'text'
  },
  categories: { id: 'text', kind: 'text', name: 'text', description: 'text?', icon: 'text?', sort_order: 'integer?' },
  tags: { id: 'integer', kind: 'text', name: 'text', source: 'text?', created_at: 'integer' },
  organize_plans: { id: 'text', created_at: 'integer', root: 'text', undone_at: 'integer?', steps: 'text?' },
  save_backups: {
    id: 'text', resource_id: 'text', save_path: 'text', backup_dir: 'text', size_bytes: 'integer', file_count: 'integer', created_at: 'integer'
  },
  scan_units: {
    dir: 'text', root: 'text', exe_count: 'integer?', loose_only: 'integer?', status: 'text?', note: 'text?',
    registered: 'integer?', created_at: 'integer', updated_at: 'integer'
  },
  pending_software: {
    id: 'text', created_at: 'integer', scan_unit_id: 'text?', exe_path: 'text', icon_path: 'text?',
    file_name: 'text', file_description: 'text?', company: 'text?', version: 'text?', file_size: 'integer?',
    external_active_at: 'integer?', name_zh: 'text?', name_en: 'text?', summary: 'text?', description: 'text?',
    category: 'text?', tags: 'text?', official_url: 'text?', launchers: 'text?', source_dir: 'text?',
    new_category: 'integer?', new_tags: 'text?', is_portable: 'integer?', move_risk: 'text?'
  },
  skip_list: { exe_path: 'text', label: 'text?', source_dir: 'text?', created_at: 'integer' },
  identify_logs: {
    id: 'text', dir: 'text', label: 'text?', kind: 'text?', resource_kind: 'text', status: 'text',
    summary: 'text?', registered: 'integer?', rounds: 'integer?', duration_ms: 'integer?', tokens: 'integer?',
    stop_reason: 'text?', events: 'text?', created_at: 'integer'
  },
  identification_reports: {
    id: 'text', created_at: 'integer', resource_kind: 'text?', processed: 'integer?', registered: 'integer?',
    skipped: 'integer?', failed: 'integer?', duration_ms: 'integer?', tokens: 'integer?', searches: 'integer?', entries: 'text?'
  }
} as const

// Freeze the runtime allowlist too, so callers cannot extend SQL identifiers.
for (const columns of Object.values(LIBRARY_BACKUP_COLUMNS)) Object.freeze(columns)
Object.freeze(LIBRARY_BACKUP_COLUMNS)

export type LibraryBackupTableName = keyof typeof LIBRARY_BACKUP_COLUMNS
export const LIBRARY_BACKUP_TABLE_NAMES: readonly LibraryBackupTableName[] = Object.freeze(
  Object.keys(LIBRARY_BACKUP_COLUMNS) as LibraryBackupTableName[]
)
export type LibraryBackupValue = string | number | null
type ColumnValue<T> = T extends `${string}?`
  ? (T extends `text${string}` ? string : number) | null
  : T extends 'text' ? string : number

/** Exact SQL column names and nullability, derived from the same fixed allowlist. */
export type LibraryBackupRow<T extends LibraryBackupTableName> = {
  -readonly [C in keyof (typeof LIBRARY_BACKUP_COLUMNS)[T]]: ColumnValue<(typeof LIBRARY_BACKUP_COLUMNS)[T][C]>
}
export type LibraryBackupTables = { [T in LibraryBackupTableName]: LibraryBackupRow<T>[] }
export type LibraryBackupResourceKind = 'software' | 'game' | 'video' | 'image' | 'project' | 'document'

export interface LibraryBackup {
  format: typeof LIBRARY_BACKUP_FORMAT
  version: typeof LIBRARY_BACKUP_VERSION
  /** Source schema; older versions are accepted only with the complete V1 shape. */
  schema_version: number
  /** Unix epoch milliseconds. */
  exported_at: number
  tables: LibraryBackupTables
  assistant?: {format:'baoyi-hermes-state';version:1;archive:string}
}

/** Preview and restore return the same summary of the validated incoming data. */
export interface LibraryBackupSummary {
  format: typeof LIBRARY_BACKUP_FORMAT
  version: typeof LIBRARY_BACKUP_VERSION
  schema_version: number
  exported_at: number
  table_counts: Record<LibraryBackupTableName, number>
  total_rows: number
  resources: Record<LibraryBackupResourceKind, number>
  /** Rows changed to a safe manual-retry state during restore, never during export. */
  interrupted: { task_records: number; video_download_jobs: number }
}
