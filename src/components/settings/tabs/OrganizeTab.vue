<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { activeModule } from '@/composables/useModules'
import { ChevronDown, FolderOpen, FolderPlus, FolderTree, Loader2, RotateCcw, Trash2 } from 'lucide-vue-next'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { errorMessage } from '@/utils'
import type { OrganizePlan } from '@/types'

const router = useRouter()

const settings = useSettingsStore()

const store = useSoftwareStore()

const { success, error, toast } = useToast()

/* ------------------------------ 目录整理 ------------------------------ */

const organizeRoot = computed(() => settings.settings.organize_root)

async function pickVideoOrganizeRoot(): Promise<void> {
  try {
    const folder = await window.baoyi.videoOrganize.pickDirectory()
    if (folder) { await settings.patch({ video_organize_root: folder }); success('已保存影视整理根目录') }
  } catch (cause) { error(errorMessage(cause)) }
}

const plans = ref<OrganizePlan[]>([])

const openPlan = ref('')

const undoing = ref('')

async function loadPlans(): Promise<void> {
  plans.value = await window.baoyi.organize.plans()
}

async function pickOrganizeRoot(): Promise<void> {
  const dir = await window.baoyi.organize.pickRoot()
  if (!dir) return
  // 整理目标不该同时是扫描目录：搬进去的软件会在下一轮重扫时又被发现一遍
  if (settings.settings.software_scan_dirs.some((d) => dir.toLowerCase().startsWith(d.toLowerCase()))) {
    toast('这个目录在扫描范围里，整理进去的软件下次扫描会被重复发现。建议换一个')
  }
  await settings.patch({ organize_root: dir })
  success('整理目标目录已保存')
}

async function clearOrganizeRoot(): Promise<void> {
  await settings.patch({ organize_root: '' })
}

/** 一条整理记录里成功了几步 —— 列表上直接显示它，比总步数有意义 */
function planTally(p: OrganizePlan) {
  return {
    moved: p.steps.filter((s) => s.ok && s.type === 'move').length,
    linked: p.steps.filter((s) => s.ok && s.type === 'junction').length,
    failed: p.steps.filter((s) => !s.ok).length
  }
}

async function undoPlan(p: OrganizePlan): Promise<void> {
  const t = planTally(p)
  const ok = window.confirm(
    `撤销这次整理？\n\n移动过的 ${t.moved} 个文件夹会搬回原来的位置，` +
      `建立的 ${t.linked} 个链接会被删除（不影响真实文件）。\n\n确认继续？`
  )
  if (!ok) return

  undoing.value = p.id
  try {
    const r = await window.baoyi.organize.undo(p.id)
    await Promise.all([loadPlans(), store.reload()])
    if (r.failed > 0) {
      error(`撤销完成 ${r.restored} 条，${r.failed} 条失败：${r.notes.slice(0, 2).join('；')}`)
      return
    }
    success(`已还原 ${r.restored} 条`)
  } finally {
    undoing.value = ''
  }
}

onMounted(loadPlans)
</script>

<template>
<template v-if="activeModule === 'video'">
<section class="panel"><h2>影视整理目录</h2><p class="sec-desc">创建合集时选择移动或复制，文件会放入此目录下以合集名命名的文件夹。</p><div class="row"><span class="hint mono">{{ settings.settings.video_organize_root || '尚未设置' }}</span><button class="btn btn--ghost" @click="pickVideoOrganizeRoot"><FolderOpen :size="14" />选择整理根目录</button></div></section>
</template>
<template v-else>
<section class="panel">
  <div class="sec-head">
    <h2>整理目标目录</h2>
    <button class="btn btn--ghost" @click="pickOrganizeRoot">
      <FolderPlus :size="14" />
      {{ organizeRoot ? '换一个' : '选择目录' }}
    </button>
  </div>
  <p class="sec-desc">
    抱一会把软件按分类归置到这个目录下，比如
    <span class="mono">E:\Toolkit\逆向分析\x64dbg\</span>。
    它和扫描目录是<b>分开的</b> —— 扫描是「去哪里找」，这里是「归到哪里去」，
    把整理目标也加进扫描列表只会让下一轮重扫把搬进来的软件再发现一遍。
  </p>

  <div v-if="organizeRoot" class="datadir">
    <span class="datadir__label">目标位置</span>
    <span class="datadir__path mono truncate" :title="organizeRoot">{{ organizeRoot }}</span>
    <button class="btn btn--subtle" title="清除" @click="clearOrganizeRoot">
      <Trash2 :size="14" />
    </button>
  </div>
  <p v-else class="empty-line">还没有设置，整理功能需要先指定一个目标目录。</p>

  <div class="row">
    <button
      class="btn btn--primary"
      :disabled="!organizeRoot"
      @click="router.push({ name: 'organize' })"
    >
      <FolderTree :size="14" />
      开始整理
    </button>
    <span class="hint">会先出一份方案给你逐条过目，不会直接动文件</span>
  </div>

  <p class="sec-desc sec-desc--foot">
    绿色软件会被<b>剪切</b>到目标目录并把文件夹名规范成英文正式名。
    安装版默认只在目标目录里放一个 junction 链接指向原安装位置 ——
    装过的软件在注册表里留着固定路径，搬走就坏了。
    识别时判定为「可安全移动」的安装版也会剪切，但执行前会再查一遍注册表引用，
    发现问题会在方案里标出来由你决定。
  </p>
</section>

<section class="panel">
  <div class="sec-head">
    <h2>整理历史</h2>
    <span class="hint">{{ plans.length }} 次</span>
  </div>
  <p class="sec-desc">
    每次整理都完整记下动过哪些目录，所以任何一次都能原路撤回。
    想撤就趁记录还在 —— 它会跟着「清空识别数据」一起清掉。
  </p>

  <ul v-if="plans.length" class="plans">
    <li v-for="p in plans" :key="p.id">
      <div class="plans__line">
        <button
          class="plans__toggle"
          @click="openPlan = openPlan === p.id ? '' : p.id"
        >
          <ChevronDown :size="13" :class="['chev', { 'chev--open': openPlan === p.id }]" />
          <span>{{ new Date(p.created_at).toLocaleString('sv') }}</span>
        </button>
        <span class="plans__sum">
          移动 {{ planTally(p).moved }}　链接 {{ planTally(p).linked }}
          <span v-if="planTally(p).failed > 0" class="bad">
            　失败 {{ planTally(p).failed }}
          </span>
        </span>
        <TagBadge v-if="p.undone_at > 0" label="已撤销" tone="muted" />
        <button
          v-else
          class="btn btn--subtle"
          :disabled="undoing === p.id"
          @click="undoPlan(p)"
        >
          <Loader2 v-if="undoing === p.id" :size="13" class="spin" />
          <RotateCcw v-else :size="13" />
          撤销
        </button>
      </div>

      <ul v-if="openPlan === p.id" class="steps">
        <li v-for="(s, i) in p.steps" :key="i" :class="{ bad: !s.ok }">
          <span class="steps__type">{{ s.type === 'move' ? '移动' : '链接' }}</span>
          <span class="steps__name truncate" :title="s.name">{{ s.name }}</span>
          <span class="steps__path mono truncate" :title="`${s.from} → ${s.to}`">
            {{ s.from }} → {{ s.to }}
          </span>
          <span v-if="s.note" class="steps__note">{{ s.note }}</span>
        </li>
      </ul>
    </li>
  </ul>
  <p v-else class="empty-line">还没有整理过。</p>
</section>
</template>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
.chev {
  flex: none;
  color: var(--text-faint);
  transition: transform var(--t-fast) ease;
}

.chev--open {
  transform: rotate(180deg);
}

/* ------------------------------ 整理历史 ------------------------------ */
.plans {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plans li {
  padding: 9px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.plans__line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plans__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
  transition: color var(--t-fast) ease;
}

.plans__toggle:hover {
  color: var(--text-main);
}

.plans__sum {
  margin-left: auto;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}

.plans__sum .bad {
  color: var(--danger);
}

/* 明细是「出了问题才会展开看」的东西，所以压小、压淡，一行一步 */
.steps {
  list-style: none;
  margin: 9px 0 0;
  padding: 9px 0 0;
  border-top: 1px solid var(--divider);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.steps li {
  display: grid;
  grid-template-columns: 36px minmax(0, 130px) minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 0;
  border: none;
  background: none;
  font-size: 11px;
}

.steps__type {
  color: var(--text-faint);
}

.steps__name {
  color: var(--text-sub);
}

.steps__path {
  color: var(--text-faint);
}

.steps li.bad .steps__name {
  color: var(--danger);
}

.steps__note {
  grid-column: 2 / -1;
  color: var(--warning);
  line-height: 1.6;
}
</style>
