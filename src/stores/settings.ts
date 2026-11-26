
import { tr } from "../i18n/index.ts"
import { defineStore } from 'pinia'
import { applyLanguage } from '../i18n/index.ts'
import { computed, ref } from 'vue'
import { plain } from '@/utils'
import type { AppSettings, ScanUnit } from '@/types'
import type { ModuleKey } from '@/composables/useModules'
import { useScan } from '@/composables/useScan'
import { useAI } from '@/composables/useAI'
import { useMediaScan } from '@/composables/useMediaScan'
import { useToast } from '@/composables/useToast'
import { useSoftwareStore } from './software'

const FALLBACK: AppSettings = {
  ai: { api_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', enabled: true },
  ai_profiles: [],
  ai_profile_id: '',
  search: { provider: 'model_builtin', api_key: '', endpoint: '', enabled: false },
  tmdb: { api_key: '', api_domain: '', image_domain: '', enabled: false },
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
  proxy: '',
  video_online_proxy: 'system://',
  hanime_builtin_hosts: true,
  hanime_hosts_active_ip: '',
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

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...FALLBACK })
  const loaded = ref(false)
  const scanUnits = ref<ScanUnit[]>([])
  const scanningKind = ref<ModuleKey | null>(null)
  const scanBusy = computed(() => scanningKind.value !== null || useScan().running.value || useAI().running.value || useMediaScan('game').running.value || useMediaScan('video').running.value)

  async function loadScanUnits(): Promise<void> {
    scanUnits.value = await window.baoyi.scan.units()
  }

  async function retryScanUnit(dir: string): Promise<void> {
    const ok = await window.baoyi.scan.retry(dir)
    if (!ok) { useToast().toast(tr('这个目录已经不在扫描列表里了')); return }
    await Promise.all([loadScanUnits(), useSoftwareStore().refreshCounts()])
    useToast().success(tr('已退回待识别，点「开始识别」重跑'))
  }

  function applyTheme(): void {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = settings.value.theme
    document.querySelector?.('meta[name="color-scheme"]')?.setAttribute('content', settings.value.theme)
  }

  async function load(): Promise<AppSettings> {
    settings.value = await window.baoyi.settings.getAll()
    applyTheme()
    applyLanguage(settings.value.language)
    loaded.value = true
    return settings.value
  }

  async function patch(p: Partial<AppSettings>): Promise<AppSettings> {
    settings.value = await window.baoyi.settings.patch(plain(p))
    applyTheme()
    applyLanguage(settings.value.language)
    return settings.value
  }

  async function toggleTheme(): Promise<void> {
    await patch({ theme: settings.value.theme === 'dark' ? 'light' : 'dark' })
  }

  return { settings, loaded, load, patch, applyTheme, toggleTheme, scanUnits, scanningKind, scanBusy, loadScanUnits, retryScanUnit }
})
