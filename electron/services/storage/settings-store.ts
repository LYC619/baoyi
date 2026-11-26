import path from 'node:path'
import { protectSetting, revealSetting } from './setting-keys.ts'
import type { AppSettings } from '../../../src/types/index.ts'
import { listScanUnits, removeScanUnitsUnder } from './scan-units.ts'
import type { SqlDb } from './schema.ts'
import { transaction } from '../../workspace/validation.ts'

type Row = Record<string, any>

export const DEFAULT_SETTINGS: AppSettings = {
  music_download_root: '',
  video_player_path: '',
  video_updates_weekly: false,
  video_updates_last_checked: 0,
  ai: {
    api_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-chat',
    enabled: true
  },
  ai_profiles: [],
  ai_profile_id: '',
  search: {
    provider: 'model_builtin',
    api_key: '',
    endpoint: '',
    enabled: false
  },
  // 默认关，因为它要用户自己去 TMDB 注册一个 key。域名留空表示用官方地址，
  // 具体的默认域名写在 kinds/video/tmdb.ts 里 —— 那是它自己的事
  tmdb: {
    api_key: '',
    api_domain: '',
    image_domain: '',
    enabled: false
  },
  software_scan_dirs: [],
  game_scan_dirs: [],
  video_scan_dirs: [],
  video_import_agent: false,
  video_organize_root: '',
  video_download_root: '',
  video_download_quality: '',
  video_download_strict_quality: false,
  video_download_register: true,
  video_download_concurrency: 2,
  video_download_connections: 4,
  organize_root: '',
  save_backup_root: '',
  save_backup_keep: 10,
  // 空串 = 直连。只有走 Chromium 网络栈的请求受它管，见 AppSettings.proxy 的注释
  proxy: '',
  video_online_proxy: 'system://',
  // Hanime 内置 Hosts 默认开：国内系统 DNS 对这几个域名常被污染，不开就基本连不上
  hanime_builtin_hosts: true,
  hanime_hosts_active_ip: '',
  // 默认不藏。默认藏的话，装完看不见自己刮进来的东西，会当成刮削坏了
  hide_hentai: false,
  theme: 'dark',
  language: 'system',
  view_mode: 'grid',
  video_card_size: 150,
  group_by_category: false,
  unused_days: 60,
  title_lang: 'zh',
  onboarded: false
}

/* ------------------------------- 设置 ------------------------------- */

export function getSettings(d: SqlDb): AppSettings {
  const rows = d.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string
    value: string
  }>
  const stored: Row = {}
  for (const r of rows) {
    // 下划线开头的是内部记账（_schema），不属于用户设置，不该透给渲染进程
    if (r.key === '_video_preview_player' && !stored.video_player_path) { try { stored.video_player_path = JSON.parse(r.value) } catch { /* ignore */ } continue }
    if (r.key.startsWith('_')) continue
    let value
    try { value = JSON.parse(r.value) } catch { value = r.value }
    stored[r.key] = revealSetting(d, r.key, value)
  }
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) },
    search: { ...DEFAULT_SETTINGS.search, ...(stored.search ?? {}) },
    // 逐个嵌套对象都要单独铺一层默认值：老库里存的 tmdb 只有三个键时，
    // 展开 stored 会让新加的那个键变成 undefined 而不是取默认
    tmdb: { ...DEFAULT_SETTINGS.tmdb, ...(stored.tmdb ?? {}) }
  }
}

export function patchSettings(d: SqlDb, patch: Partial<AppSettings>): AppSettings {
  if(patch.music_download_root!==undefined&&(typeof patch.music_download_root!=='string'||patch.music_download_root!==''&&!path.isAbsolute(patch.music_download_root)))throw new Error('音乐保存目录必须是绝对路径')
  if(patch.video_player_path!==undefined&&(typeof patch.video_player_path!=='string'||(patch.video_player_path!==''&&(!path.isAbsolute(patch.video_player_path)||!/\.exe$/i.test(patch.video_player_path)))))throw new Error('视频播放器路径必须是本地 .exe 程序路径')
  if(patch.video_updates_weekly!==undefined&&typeof patch.video_updates_weekly!=='boolean')throw new Error('每周检查设置必须为开关值')
  if(patch.video_updates_last_checked!==undefined&&(!Number.isSafeInteger(patch.video_updates_last_checked)||patch.video_updates_last_checked<0))throw new Error('检查时间无效')
  for(const [key,max] of [['video_download_concurrency',4],['video_download_connections',8]] as const){
    const value=patch[key]
    if(value!==undefined && (!Number.isInteger(value) || value<1 || value>max))throw new Error('视频下载并发设置必须是 1–'+max+' 的整数')
  }

  const current = getSettings(d)
  const next: AppSettings = {
    ...current,
    ...patch,
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    search: { ...current.search, ...(patch.search ?? {}) },
    tmdb: { ...current.tmdb, ...(patch.tmdb ?? {}) }
  }
  const stmt = d.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  transaction(d, () => {
    for (const [k, v] of Object.entries(next)) {
      // 跳过已废弃的键：迁移已经把 scan_dirs 改名成 software_scan_dirs，
      // 不能每次保存设置都把旧键再写回去
      if (k === 'scan_dirs') continue
      if (k in patch) stmt.run(k, JSON.stringify(protectSetting(d, k, v)))
    }
  })


  // 目录被移出扫描列表后，它名下的待识别单元也就没意义了（仅软件模块有 scan_units）
  if (patch.software_scan_dirs) {
    const kept = new Set(next.software_scan_dirs)
    const stale = new Set(listScanUnits(d).map((u) => u.root).filter((r) => !kept.has(r)))
    for (const root of stale) removeScanUnitsUnder(d, root)
  }
  return next
}
