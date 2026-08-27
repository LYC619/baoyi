import { computed, ref } from 'vue'
import { plain } from '@/utils'
import type {
  OrganizeCommand,
  OrganizePreview,
  OrganizeProgress,
  OrganizeResult,
  Unsubscribe
} from '@/types'

/* 模块级单例，理由同 useScan：设置页和预览面板看到的是同一份进度 */
const running = ref(false)
const progress = ref<OrganizeProgress | null>(null)
const lastResult = ref<OrganizeResult | null>(null)
let unsubscribe: Unsubscribe | null = null

export function useOrganize() {
  if (!unsubscribe) {
    unsubscribe = window.baoyi.organize.onProgress((p) => {
      progress.value = p
      if (p.phase === 'done') running.value = false
    })
  }

  const percent = computed(() => {
    const p = progress.value
    if (!p || p.total === 0) return 0
    return Math.min(100, Math.round((p.processed / p.total) * 100))
  })

  const phaseLabel = computed(() => {
    const p = progress.value
    if (!p || p.phase === 'done') return ''
    return `正在整理 ${p.processed}/${p.total}${p.failed > 0 ? `（${p.failed} 个失败）` : ''}`
  })

  function preview(ids?: string[]): Promise<OrganizePreview> {
    return window.baoyi.organize.preview(plain(ids))
  }

  async function run(commands: OrganizeCommand[]): Promise<OrganizeResult> {
    if (running.value) {
      return { plan_id: '', moved: 0, linked: 0, skipped: 0, failed: 0, steps: [] }
    }
    running.value = true
    progress.value = { phase: 'running', current: '', processed: 0, total: commands.length, failed: 0 }
    try {
      // commands 直接来自面板上的 reactive 数组，必须先拍平，见 utils 的 plain()
      const result = await window.baoyi.organize.run(plain(commands))
      lastResult.value = result
      return result
    } finally {
      running.value = false
    }
  }

  return { running, progress, percent, phaseLabel, lastResult, preview, run }
}
