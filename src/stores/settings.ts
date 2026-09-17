import { defineStore } from 'pinia'
import { ref } from 'vue'
import { plain } from '@/utils'
import type { AppSettings } from '@/types'

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
  organize_root: '',
  save_backup_root: '',
  save_backup_keep: 10,
  proxy: '',
  hanime_builtin_hosts: true,
  hanime_hosts_active_ip: '',
  hide_hentai: false,
  theme: 'dark',
  view_mode: 'grid',
  group_by_category: false,
  unused_days: 60,
  title_lang: 'zh',
  onboarded: false
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...FALLBACK })
  const loaded = ref(false)

  function applyTheme(): void {
    document.documentElement.dataset.theme = settings.value.theme
  }

  async function load(): Promise<AppSettings> {
    settings.value = await window.baoyi.settings.getAll()
    applyTheme()
    loaded.value = true
    return settings.value
  }

  async function patch(p: Partial<AppSettings>): Promise<AppSettings> {
    settings.value = await window.baoyi.settings.patch(plain(p))
    applyTheme()
    return settings.value
  }

  async function toggleTheme(): Promise<void> {
    await patch({ theme: settings.value.theme === 'dark' ? 'light' : 'dark' })
  }

  return { settings, loaded, load, patch, applyTheme, toggleTheme }
})
