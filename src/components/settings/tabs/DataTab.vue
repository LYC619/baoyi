<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Download, Eraser, FolderOpen, Loader2, RotateCcw } from 'lucide-vue-next'
import LibrarySafetyPanel from '@/components/settings/LibrarySafetyPanel.vue'
import StorageUsagePanel from '@/components/settings/StorageUsagePanel.vue'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { errorMessage, formatBytes } from '@/utils'
import type { DataStats } from '@/types'

const router = useRouter()

const settings = useSettingsStore()

const store = useSoftwareStore()

const { success, error, toast } = useToast()

const loadUnits = settings.loadScanUnits

const busy = computed(() => settings.scanBusy)

/* ------------------------------ 数据管理 ------------------------------ */

const dataDir = ref('')

const stats = ref<DataStats | null>(null)

const resetting = ref(false)

const backupRefresh = ref(0)

async function loadStats(): Promise<void> {
  stats.value = await window.baoyi.data.stats()
}

function openDataDir(): void {
  void window.baoyi.data.openDir()
}

async function exportJson(): Promise<void> {
  try {
    const file = await window.baoyi.data.exportJson()
    if (file) { success(`已备份到 ${file}`); backupRefresh.value++ }
  } catch (cause) { error(`备份失败：${errorMessage(cause)}`) }
}

const restoringBackup = ref(false)

async function restoreJson(): Promise<void> {
  if (restoringBackup.value) return
  restoringBackup.value = true
  try {
    const result = await window.baoyi.data.restoreJson()
    if (result) success('资料库已恢复，正在重启应用')
  } catch (cause) { error(`恢复失败：${errorMessage(cause)}`) }
  finally { restoringBackup.value = false }
}

async function exportMarkdown(): Promise<void> {
  const file = await window.baoyi.data.exportMarkdown()
  if (file) success(`已导出到 ${file}`)
}

const refreshingIcons = ref(false)

/**
 * 重新提取全部软件图标。
 *
 * 单独一个按钮而不是搭在「重新识别」上：图标和 AI 一点关系都没有，为了换一张图
 * 重跑一遍识别是在烧用户的 token。而不给这个按钮的话，修好的提取逻辑对已经入库的
 * 条目一点效果都没有 —— `extractIcon` 只在识别时被调 —— 现象和「这个 bug 没修」
 * 一模一样。
 *
 * 结果按四档报数（换了 / 手改过跳过 / 提不到 / 总数）。只说「完成了」的话，
 * 「一张都没换」和「全换了」在界面上长得一样，而前者说明这条路根本没跑起来。
 */
async function refreshIcons(): Promise<void> {
  refreshingIcons.value = true
  try {
    const r = await window.baoyi.software.refreshIcons()
    await Promise.all([store.reload(), loadStats()])
    const bits = [`${r.total} 条里换了 ${r.changed} 张`]
    if (r.manual > 0) bits.push(`${r.manual} 条是你手动指的，没动`)
    if (r.failed > 0) bits.push(`${r.failed} 条提不到图标`)
    if (r.changed > 0) success(bits.join('，'))
    else toast(bits.join('，') + ' —— 现在这批已经是能提到的最好结果了')
  } catch (err) {
    error(`重提图标失败：${errorMessage(err)}`)
  } finally {
    refreshingIcons.value = false
  }
}

async function reset(mode: 'library' | 'all'): Promise<void> {
  // 文案必须把「游戏也会清」写出来。0.6 那版只说「软件条目」而代码只清 software，
  // 两边是对上的；现在改成清全部品类，文案不跟着改就成了一句谎话
  const shared =
    `会清掉：全部软件、游戏、影视、图片、资料、项目及内容记录（含摘录与项目日志），待识别目录、整理记录、任务和下载记录、图标缓存、游戏封面与影视海报。\n` +
    `不会删除资源文件，软件、游戏和视频都还在原处。\n` +
    `存档备份也一份不删，备份记录一并留着，不然你就再也找不到那些文件了。`
  const warning =
    mode === 'library'
      ? `清空识别数据，重新开始识别。\n\n${shared}\n\n保留：个人记录及其引用快照、API Key、搜索配置、扫描目录、自定义分类、识别日志。\n已经整理过的文件夹会留在整理后的位置，整理记录清掉之后就无法再自动撤销了。\n\n确认继续？`
      : `恢复出厂：连个人信息、背包、技能、经历、状态和待办，以及 API Key、搜索配置、扫描目录、自定义分类、识别日志、整理记录一起清空，并重新走一遍引导流程。\n\n${shared}\n整理记录清掉之后就无法再自动撤销整理了。\n\n确认继续？`
  if (!window.confirm(warning)) return

  resetting.value = true
  try {
    const { summary } = await window.baoyi.data.reset(mode)
    await settings.load()
    await Promise.all([store.reload(), loadUnits(), loadStats()])

    if (mode === 'all') {
      // 出厂状态下 onboarded 为 false，路由守卫会把用户带回引导页
      await router.push({ name: 'onboarding' })
      window.location.reload()
      return
    }

    // 保留的存档备份只在真有的时候提 —— 一句「保留 0 份备份」只会让人愣一下
    const kept = summary.saveBackupsKept
      ? `；保留 ${summary.saveBackupsKept} 份存档备份`
      : ''
    success(
      `已清空 ${summary.software} 个软件条目、${summary.games} 个游戏条目、` +
        `${summary.videos} 个影视条目（${summary.episodes} 集）、${summary.projects} 个项目、` +
        `${summary.units} 个目录记录、${summary.icons} 个图标、${summary.covers} 张封面、` +
        `${summary.posters} 张海报${kept}`
    )
    window.location.reload()
  } catch (err) {
    // 不给反馈的话，失败看起来和成功一模一样 —— 按钮变回可点，什么都没发生
    error(`重置失败：${errorMessage(err)}`)
  } finally {
    resetting.value = false
  }
}


onMounted(async () => { dataDir.value = await window.baoyi.data.dir(); await loadStats() })
</script>

<template>
<section class="panel">
  <h2 class="sec-head">数据位置</h2>
  <div class="datadir">
    <span class="datadir__label">存放位置</span>
    <button class="datadir__path mono truncate" :title="dataDir" @click="openDataDir">
      {{ dataDir || '读取中…' }}
    </button>
    <button class="btn btn--subtle" title="在资源管理器中打开" @click="openDataDir">
      <FolderOpen :size="14" />
    </button>
  </div>
  <p class="sec-desc">
    数据库是该目录下的 <span class="mono">baoyi.db</span>，图标缓存在
    <span class="mono">icons/</span>。同目录里 <span class="mono">Cache</span>、
    <span class="mono">GPUCache</span> 保存网页和渲染缓存，可在下方查看分类占用。
    所有数据都存在本机，不上传、不同步。
  </p>

  <div class="row">
    <button class="btn btn--ghost" @click="exportJson">
      <Download :size="14" />
      备份全部资料（JSON）
    </button>
    <button class="btn btn--ghost" :disabled="restoringBackup || resetting" @click="restoreJson">
      <FolderOpen :size="14" />
      {{ restoringBackup ? '正在恢复…' : '从备份恢复' }}
    </button>
    <button class="btn btn--ghost" @click="exportMarkdown">
      <Download :size="14" />
      导出软件清单（Markdown）
    </button>
  </div>
  <p class="hint hint--block">
    JSON 备份全部品类的资料、观看记录和任务记录，不包含资源文件或 API 配置。
    恢复前会预览并自动备份当前数据库，确认后重启应用。Markdown 为软件清单。
  </p>
</section>

<StorageUsagePanel :refresh-key="backupRefresh" />
<LibrarySafetyPanel :refresh-key="backupRefresh" @storage-changed="backupRefresh++" />


<section class="panel">
  <h2 class="sec-head">统计</h2>
  <ul v-if="stats" class="tally">
    <li><b>{{ stats.software }}</b><span>软件条目</span></li>
    <li><b>{{ stats.games }}</b><span>游戏条目</span></li>
    <li><b>{{ stats.videos }}</b><span>影视条目</span></li>
    <li><b>{{ formatBytes(stats.dbBytes) }}</b><span>数据库</span></li>
    <li><b>{{ stats.icons }}</b><span>图标缓存</span></li>
    <li><b>{{ formatBytes(stats.iconBytes) }}</b><span>图标占用</span></li>
    <li><b>{{ stats.covers }}</b><span>游戏封面</span></li>
    <li><b>{{ formatBytes(stats.coverBytes) }}</b><span>封面占用</span></li>
    <li><b>{{ stats.posters }}</b><span>影视海报</span></li>
    <li><b>{{ formatBytes(stats.posterBytes) }}</b><span>海报占用</span></li>
  </ul>
  <p v-if="stats" class="hint hint--block">
    另有 {{ stats.episodes }} 条季集记录、{{ stats.units }} 条目录记录、{{ stats.logs }}
    条识别日志。图标是缓存，重新识别就能再取；封面和海报是资产 ——
    封面是你亲手指的图，海报多半是刮来的但也可能是你选的，
    两者都只在清空条目时才跟着走。
  </p>
</section>

<section class="panel">
  <h2 class="sec-head">重新提取软件图标</h2>
  <p class="sec-desc">
    直接从 exe 的图标资源里取最大那一张（256×256 居多）。
    <b>你亲手换过的图标不会被动。</b>
    这个按钮不联网、不花 token，和「重新识别」是两件事。
  </p>
  <div class="row">
    <button class="btn btn--ghost" :disabled="busy || refreshingIcons" @click="refreshIcons">
      <Loader2 v-if="refreshingIcons" :size="14" class="spin" />
      <Image v-else :size="14" />
      {{ refreshingIcons ? '正在重提' : '重新提取' }}
    </button>
    <span class="hint">
      Windows 有时会对明明带图标的程序回一张通用的空白图，这个按钮绕开它
    </span>
  </div>
</section>

<section class="panel panel--danger">
  <h2 class="sec-head">重置</h2>
  <p class="sec-desc">
    两个操作都<b>只清抱一自己的记录，不会删除磁盘上的任何实际软件文件</b>。
    反复调识别效果时用第一个，它保留 API Key、扫描目录和识别日志，
    省得每次重填，也方便和改之前那一轮对照。
  </p>

  <div class="row">
    <button class="btn btn--ghost" :disabled="busy || resetting" @click="reset('library')">
      <Eraser :size="14" />
      清空识别数据
    </button>
    <span class="hint">软件条目 + 待识别目录 + 图标缓存</span>
  </div>

  <div class="row row--gap">
    <button class="btn btn--danger" :disabled="busy || resetting" @click="reset('all')">
      <RotateCcw :size="14" />
      恢复出厂
    </button>
    <span class="hint">连设置、分类、日志一起清，重走引导流程</span>
  </div>
</section>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
.panel--danger {
  border-color: color-mix(in srgb, var(--danger) 22%, var(--divider));
}
</style>
