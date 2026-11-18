<script setup lang="ts">
import { computed, onMounted, ref, watch, toRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeModule } from '@/composables/useModules'
import { Eraser, FolderPlus, Loader2, RotateCcw, Trash2 } from 'lucide-vue-next'
import ReportDialog from '@/components/identify/ReportDialog.vue'
import { useAI } from '@/composables/useAI'
import { useScan } from '@/composables/useScan'
import { useMediaScan } from '@/composables/useMediaScan'
import { useVideoImport } from '@/composables/useVideoImport'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { useGameStore } from '@/stores/game'
import { errorMessage, plain, shortenPath } from '@/utils'
import type { IdentifyReport } from '@/types'

const route = useRoute()

const router = useRouter()

const settings = useSettingsStore()

const store = useSoftwareStore()

const game = useGameStore()

const { success, error, toast } = useToast()

const scan = useScan()

const gameScan = useMediaScan('game')

const videoScan = useMediaScan('video')

const videoImport = useVideoImport()

const tasks = useTaskCenter()

const ai = useAI()

/**
 * 主页「重新扫描目录」发现待识别目录后会带着 ?focus=pending 跳过来，
 * 把「还剩多少要识别」顶到眼前。只是一次性的视觉引导：切走 Tab 或开始识别后就撤掉。
 */
const focusPending = ref(route.query.focus === 'pending')

/* ---------------------------- 扫描与识别 ---------------------------- */

const units = toRef(settings, 'scanUnits')

const loadUnits = settings.loadScanUnits

const unitStats = computed(() => {
  const acc = { pending: 0, done: 0, skipped: 0, failed: 0 }
  for (const u of units.value) acc[u.status]++
  return acc
})

/** 只展示需要用户过目的：跳过的和失败的 */
const noteworthy = computed(() =>
  units.value.filter((u) => u.status === 'skipped' || u.status === 'failed').slice(0, 12)
)

/** 当前模块的扫描目录。整理 Tab 只在软件模块显示，那里用的也是 software_scan_dirs */
const dirs = computed(() => {
  const kind = activeModule.value
  if (kind === 'game') return settings.settings.game_scan_dirs
  if (kind === 'video') return settings.settings.video_scan_dirs
  return settings.settings.software_scan_dirs
})

// 设置页的扫描包含配置预检和结果刷新，这两个阶段也不能重复点击。
const scanningKind = toRef(settings, 'scanningKind')

const scanKind = computed(() => scanningKind.value ?? activeModule.value)

const currentMediaScan = computed(() => scanKind.value === 'video' ? videoScan : gameScan)

const mediaScanProgress = computed(() => currentMediaScan.value.progress.value)

const scanStopping = computed(() => scanKind.value === 'software'
  ? scan.running.value && scan.stopping.value
  : currentMediaScan.value.running.value && currentMediaScan.value.stopping.value
)

const scanRunning = computed(() =>
  scanningKind.value !== null || (activeModule.value === 'software' ? scan.running.value : currentMediaScan.value.running.value)
)

const busy = computed(() => settings.scanBusy)

const scanPhaseLabel = computed(() => {
  if (scanStopping.value) return '正在停止，等待当前任务收尾…'
  const kind = scanKind.value
  if (!kind || kind === 'software') return scan.phaseLabel.value
  const moduleName = kind === 'video' ? '影视' : '游戏'
  const p = mediaScanProgress.value
  if (!p) return moduleName + '：正在检查扫描配置…'
  if (p.phase === 'scanning') return moduleName + '：正在扫描 ' + shortenPath(p.current, 40)
  if (p.phase === 'done') return moduleName + '：正在刷新资源库…'
  return moduleName + '：识别 ' + Math.min(p.processed + 1, p.total) + '/' + p.total + '　' + (p.log || shortenPath(p.current, 32))
})

const scanPercent = computed(() => {
  if (scanKind.value === 'software') return scan.percent.value
  const p = mediaScanProgress.value
  if (!p || p.phase === 'scanning' || p.total === 0) return 0
  return Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100)))
})

const canCancelScan = computed(() =>
  scanRunning.value && (scanKind.value === 'software'
    ? scan.running.value && scan.progress.value?.phase !== 'done'
    : currentMediaScan.value.running.value && mediaScanProgress.value?.phase !== 'done')
)

function cancelScan(): void {
  if (!canCancelScan.value || scanStopping.value) return
  try {
    if (scanKind.value === 'software') scan.cancel()
    else currentMediaScan.value.cancel()
    // 停止状态由共享任务维护；跨页面取消也能同步，直到原 IPC 返回才解锁。
  } catch (err) {
    error('停止扫描失败：' + errorMessage(err))
  }
}

async function resetUnits(): Promise<void> {
  const ok = window.confirm(
    '把所有已识别 / 已跳过的目录退回待识别，下次补全会重新跑一遍 AI。\n已有的软件条目不会被删除，你写过的备注也会保留。确认继续？'
  )
  if (!ok) return
  const n = await window.baoyi.scan.reset()
  await Promise.all([loadUnits(), store.refreshCounts()])
  success(`已把 ${n} 个目录退回待识别`)
}

/** 单个目录退回待识别。日志页那个「退回待识别」也走这里 */
const retryUnit = settings.retryScanUnit

async function addDir(): Promise<void> {
  const dir = await scan.pickDirectory()
  if (!dir) return
  if (dirs.value.includes(dir)) {
    toast('这个目录已经在列表里了')
    return
  }
  const key = `${activeModule.value}_scan_dirs` as 'software_scan_dirs' | 'game_scan_dirs' | 'video_scan_dirs'
  await settings.patch({ [key]: [...dirs.value, dir] })
}

async function removeDir(dir: string): Promise<void> {
  const key = `${activeModule.value}_scan_dirs` as 'software_scan_dirs' | 'game_scan_dirs' | 'video_scan_dirs'
  await settings.patch({ [key]: dirs.value.filter((d) => d !== dir) })
  await loadUnits()
}

async function runScan(): Promise<void> {
  if (busy.value) return
  if (dirs.value.length === 0) {
    toast('先添加至少一个扫描目录')
    return
  }

  // 模块和目录在第一处 await 前固定；中途切模块或改目录不能改写本轮的目标。
  const kind = activeModule.value
  scanningKind.value = kind
  let mediaStarted = false
  const recordAttempt = (status: 'failed' | 'cancelled', message: string): void => {
    const id = tasks.start(kind === 'video' ? 'video-scan' : 'game-scan', (kind === 'video' ? '影视' : '游戏') + '扫描预检')
    tasks.finish(id, status, message, status === 'failed' ? message : undefined)
  }
  try {
    // 必须在 renderer 拍平。preload 里的 plain 来不及拦 contextBridge 的克隆异常。
    const scanDirs = plain(dirs.value)
    if (kind === 'video') {
      mediaStarted = true
      await videoImport.begin(scanDirs)
      return
    }
    if (kind === 'software') {
      const r = await scan.run(scanDirs)
      const stopped = scan.stopping.value
      await Promise.all([store.reload(), loadUnits()])

      const parts = ['发现 ' + r.found + ' 个程序']
      if (r.pending > 0) {
        parts.push(r.pending + ' 个目录待识别' + (r.added > 0 ? '（新增 ' + r.added + ' 个）' : ''))
      } else {
        parts.push('没有需要识别的目录')
      }
      if (r.settled > 0) parts.push(r.settled + ' 个已识别过，跳过')
      if (r.loose_files.length > 0) {
        parts.push('另有 ' + r.loose_files.length + ' 个未整理的散落文件（安装包或压缩包），本次未处理')
      }
      const message = (stopped ? '扫描已停止：' : '扫描完成：') + parts.join('，')
      if (stopped) toast(message)
      else success(message)
      return
    }

    if (!settings.settings.ai.enabled || !settings.settings.ai.api_key.trim()) {
      recordAttempt('failed', '游戏识别要用 AI，请先填写 API Key 并启用 AI')
      error('游戏识别要用 AI，请先填写 API Key 并启用 AI')
      openAi()
      return
    }

    const operation = gameScan
    mediaStarted = true
    const r = await operation.run(scanDirs)
    const stopped = operation.stopping.value
    await game.reload()

    if (stopped) {
      toast('扫描已停止：已注册 ' + r.registered + ' 个，已完成的结果已保留')
    } else if (r.candidates === 0) {
      toast('这些目录里没找到游戏（没有可执行文件，或者只是一层收纳目录）')
    } else if (r.failed > 0 && r.registered === 0) {
      error('扫描到 ' + r.candidates + ' 个候选，但没有注册成功，' + r.failed + ' 个识别失败。请检查 AI 配置或识别日志')
    } else if (r.registered === 0) {
      toast('扫描到 ' + r.candidates + ' 个候选，全部跳过；可到识别日志查看原因')
    } else {
      const message = '扫描完成：' + r.candidates + ' 个候选，' + r.registered + ' 已注册，' + r.skipped + ' 已跳过，' + r.failed + ' 失败'
      if (r.failed > 0) toast(message)
      else success(message)
    }
  } catch (err) {
    if (kind !== 'software' && !mediaStarted) recordAttempt('failed', errorMessage(err))
    error('扫描没能完成：' + errorMessage(err))
  } finally {
    scanningKind.value = null
  }
}

async function runAi(): Promise<void> {
  // 和 Home 页的判定保持一致：总开关关着时同样进不去，别空跑一轮
  if (!settings.settings.ai.enabled || !settings.settings.ai.api_key) {
    error('AI 未启用：请先到「AI 配置」填写 API Key 并打开启用开关')
    openAi()
    return
  }
  const result = await ai.complete()
  focusPending.value = false
  // 日志页是切过去才挂载的，那时它自己会拉最新的，这里不用管
  await Promise.all([store.reload(), loadUnits()])
  if (result.processed === 0) {
    toast('没有待识别的目录')
    return
  }
  success(
    `识别完成：${result.registered} 个条目待确认` +
      (result.failed > 0 ? `，${result.failed} 个目录失败` : '') +
      `，消耗 ${result.tokens.toLocaleString()} tokens`
  )
  if (result.registered > 0) {
    void router.push({ name: 'confirm' })
    return
  }
  // 一个都没认出来 —— 这时候用户最需要的正是「为什么」，直接把报告推到面前。
  // 认出来了就先去确认，报告随时能在识别日志页翻到
  if (result.report_id) await showReport(result.report_id)
}

/** 汇总报告弹窗。识别日志页顶部也有一份历史列表，两处用的是同一个组件 */
const runReport = ref<IdentifyReport | null>(null)

async function showReport(id: string): Promise<void> {
  runReport.value = (await window.baoyi.logs.reports()).find((r) => r.id === id) ?? null
}

/* ------------------------------ 忽略名单 ------------------------------ */
const skippedCount = ref(0)

async function loadSkipped(): Promise<void> {
  skippedCount.value = await window.baoyi.pending.skippedCount()
}

async function clearSkipped(): Promise<void> {
  if (!window.confirm(`清空忽略名单（${skippedCount.value} 项）？\n这些程序下次识别会重新出现在确认面板里。`)) return
  const n = await window.baoyi.pending.clearSkipped()
  await loadSkipped()
  success(`已清空 ${n} 项`)
}

watch(
  () => route.query.focus,
  (v) => (focusPending.value = v === 'pending')
)
onMounted(loadUnits)
onMounted(loadSkipped)
function openAi(): void { void router.replace({ name: 'settings', query: { tab: 'ai', module: activeModule.value, scope: 'global' } }) }
</script>

<template>
<section class="panel">
  <div class="sec-head">
    <h2>扫描目录</h2>
    <button class="btn btn--ghost" @click="addDir">
      <FolderPlus :size="14" />
      添加目录
    </button>
  </div>
  <p v-if="activeModule === 'software'" class="sec-desc">
    扫描本身不花钱也不联网：它只是把每个目录整理成一份待识别清单，
    真正的判断交给下一步的 AI 识别。
  </p>
  <p v-else-if="activeModule === 'video'" class="sec-desc">
    影视扫描先读取本地文件名、NFO 和 HanimeViewer 资料，生成预览，确认后才入库；本地扫描不消耗模型或搜索额度。
    资料不足的作品会列入待处理，可选中后使用「Agent 复查所选」。
  </p>
  <p v-else class="sec-desc">
    扫描会查找本地游戏目录，随后交给 AI 识别并入库。
    需要启用 AI；识别与刮削可能联网，并消耗你所配置服务的额度。
  </p>

  <ul v-if="dirs.length" class="dirs">
    <li v-for="d in dirs" :key="d">
      <span class="mono truncate" :title="d">{{ d }}</span>
      <button class="btn btn--subtle" title="移除" @click="removeDir(d)">
        <Trash2 :size="14" />
      </button>
    </li>
  </ul>
  <p v-else class="empty-line">还没有添加任何目录。</p>

  <div class="row">
    <button class="btn btn--primary" :disabled="busy || dirs.length === 0" @click="runScan">
      <Loader2 v-if="scanRunning" :size="14" class="spin" />
      {{ scanRunning ? '扫描中…' : '立即扫描' }}
    </button>
    <button v-if="canCancelScan" class="btn btn--subtle" :disabled="scanStopping" @click="cancelScan">
      {{ scanStopping ? '正在停止…' : '停止扫描' }}
    </button>
    <span v-if="scanRunning" class="hint truncate" role="status">{{ scanPhaseLabel }}</span>
  </div>

  <div v-if="scanRunning" class="bar">
    <i :style="{ width: `${scanPercent}%` }" />
  </div>
</section>

<section v-if="activeModule === 'video'" class="panel">
  <h2 class="sec-head">视频导入与文件整理</h2>
  <p class="sec-desc">扫描结果先进入导入确认窗口，核对后再录入。关掉窗口后，影视墙上会有「导入待确认」入口，这里也能重新打开。需要联网补充资料时，可以启用 Agent。</p>
  <div class="row"><label class="hint"><input type="checkbox" :checked="videoImport.useAgent.value" @change="videoImport.setAgent(($event.target as HTMLInputElement).checked)" /> 导入时启用 Agent</label><button class="btn btn--ghost" @click="videoImport.show()">打开导入确认</button></div>

</section>
<section v-if="activeModule === 'software'" class="panel">
  <h2 class="sec-head">AI 识别</h2>
  <p class="sec-desc">
    把每个待识别目录交给 agent 自主探索：它自己列目录、读 exe 的 PE 信息、
    读目录里的说明文档，判断哪个是主程序，再把 32 位和 64 位合并成同一个条目。
    识别不对时到「识别日志」翻它当时的判断过程。
  </p>

  <p v-if="focusPending && unitStats.pending > 0" class="callout">
    还有 <b>{{ unitStats.pending }}</b> 个目录待识别，点下面的「开始识别」交给 AI。
  </p>

  <ul class="tally">
    <li :class="{ lit: focusPending && unitStats.pending > 0 }">
      <b>{{ unitStats.pending }}</b><span>待识别</span>
    </li>
    <li><b>{{ unitStats.done }}</b><span>已识别</span></li>
    <li><b>{{ unitStats.skipped }}</b><span>已跳过</span></li>
    <li :class="{ bad: unitStats.failed > 0 }">
      <b>{{ unitStats.failed }}</b><span>失败</span>
    </li>
  </ul>

  <div class="row row--gap">
    <button class="btn btn--primary" :disabled="busy" @click="runAi">
      <Loader2 v-if="ai.running.value" :size="14" class="spin" />
      开始识别（{{ store.todo }}）
    </button>
    <button
      v-if="units.length > 0"
      class="btn btn--ghost"
      :disabled="busy"
      @click="resetUnits"
    >
      <RotateCcw :size="14" />
      全部重新识别
    </button>
    <button v-if="ai.running.value" class="btn btn--subtle" @click="ai.cancel()">
      中止
    </button>
  </div>

  <template v-if="ai.running.value">
    <div class="bar">
      <i :style="{ width: `${ai.percent.value}%` }" />
    </div>
    <p class="hint truncate">{{ ai.phaseLabel.value }}</p>
    <p class="agent-line truncate">
      <span class="agent-line__dir mono">{{ ai.progress.value?.current || '—' }}</span>
      <span v-if="ai.activity.value">→ {{ ai.activity.value }}</span>
    </p>
  </template>

  <ul v-if="noteworthy.length" class="notes">
    <li v-for="u in noteworthy" :key="u.dir">
      <div class="notes__line">
        <span class="mono truncate" :title="u.dir">{{ u.dir }}</span>
        <button class="btn btn--subtle" :disabled="busy" @click="retryUnit(u.dir)">
          <RotateCcw :size="13" />
          重试
        </button>
      </div>
      <span class="notes__reason" :class="{ bad: u.status === 'failed' }">
        {{ u.note || (u.status === 'failed' ? '识别失败' : '未说明原因') }}
      </span>
    </li>
  </ul>
</section>

<section v-if="activeModule === 'software' && skippedCount > 0" class="panel">
  <h2 class="sec-head">忽略名单</h2>
  <p class="sec-desc">
    你在确认面板里点过「不注册」的程序会记在这里，下次识别不再冒出来。
    误点了、或者改了主意，清空它就行 —— 下一轮识别会重新问你一遍。
  </p>
  <div class="row">
    <button class="btn btn--ghost" :disabled="busy" @click="clearSkipped">
      <Eraser :size="14" />
      清空名单
    </button>
    <span class="hint">当前 {{ skippedCount }} 项</span>
  </div>
</section>
<Teleport to=".settings"><ReportDialog v-if="runReport" :report="runReport" @close="runReport = null" /></Teleport>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
/* 从主页扫描完跳过来时的一次性引导 */
.callout {
  margin-bottom: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-input);
  background: var(--active-surface);
  color: var(--accent);
  font-size: var(--fs-tag);
  line-height: 1.7;
}

.dirs {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dirs li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.dirs li span {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.bar {
  margin-top: 14px;
  height: 4px;
  border-radius: 2px;
  background: var(--hover-surface);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 200ms ease;
}

/* agent 正在做什么，让识别过程可见而不是干等进度条 */
.agent-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.agent-line__dir {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tally li.bad b {
  color: var(--danger);
}

.tally li.lit {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--active-surface);
}

.tally li.lit b {
  color: var(--accent);
}

.notes {
  list-style: none;
  margin: 16px 0 0;
  padding: 14px 0 0;
  border-top: 1px solid var(--divider);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-tag);
}

.notes li {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.notes__line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.notes__line span {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.notes__reason {
  color: var(--text-faint);
  line-height: 1.6;
}

.notes__reason.bad {
  color: var(--danger);
}
</style>
