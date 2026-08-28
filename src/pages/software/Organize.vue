<script setup lang="ts">
/**
 * 整理预览面板。
 *
 * 整理是这个程序里唯一会改动用户磁盘的操作，所以它不能像别的功能那样「点了就做」。
 * 这一页的全部意义是：在动手之前，把每一条要发生什么摊开给用户看，并且让他
 * 逐条改得了主意。底部那个「执行整理」是全程唯一一个不可逆的按钮。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, ArrowLeft, FolderTree, Leaf, Link2, Loader2 } from 'lucide-vue-next'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useOrganize } from '@/composables/useOrganize'
import { useToast } from '@/composables/useToast'
import { useCategoriesStore } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'
import type { OrganizeAction, OrganizeEntry, OrganizeResult } from '@/types'
import { errorMessage } from '@/utils'

const router = useRouter()
const categories = useCategoriesStore()
const store = useSoftwareStore()
const { success, error, toast } = useToast()
const organize = useOrganize()

const entries = ref<OrganizeEntry[]>([])
const root = ref('')
const loading = ref(true)

const ACTIONS: Array<{ value: OrganizeAction; label: string }> = [
  { value: 'move', label: '剪切移动' },
  { value: 'junction', label: '创建链接' },
  { value: 'skip', label: '跳过' }
]

async function load(): Promise<void> {
  const preview = await organize.preview()
  root.value = preview.root
  entries.value = preview.entries
}

onMounted(async () => {
  try {
    await Promise.all([categories.load(), load()])
  } finally {
    loading.value = false
  }
})

/**
 * 目标完整路径。这里算的只是**给用户看的预览** —— 真正落盘用的路径由主进程
 * 用同一套规则现拼（见 organize/plan.ts 的 targetDir）。页面说的不算。
 */
function targetOf(e: OrganizeEntry): string {
  if (!root.value || e.action === 'skip') return '—'
  const clean = (s: string) => s.replace(/[<>:"/\\|?*]/g, '').trim().replace(/[. ]+$/, '')
  return `${root.value}\\${clean(e.category) || '其他'}\\${clean(e.folder) || 'Unnamed'}`
}

const tally = computed(() => ({
  move: entries.value.filter((e) => e.action === 'move').length,
  junction: entries.value.filter((e) => e.action === 'junction').length,
  skip: entries.value.filter((e) => e.action === 'skip').length,
  warn: entries.value.filter((e) => e.warning && e.action !== 'skip').length
}))

const actionable = computed(() => tally.value.move + tally.value.junction)

function setAction(e: OrganizeEntry, value: string): void {
  e.action = value as OrganizeAction
}

/** 全部改成某一种操作。条目多的时候逐条点太累 */
function setAll(value: OrganizeAction): void {
  for (const e of entries.value) e.action = value
}

/** 把有警告的一律改成跳过 —— 最常用的一次性避险动作 */
function skipWarned(): void {
  // warn 带着「还没被跳过」的过滤，必须在循环改掉 action 之前读
  const n = tally.value.warn
  for (const e of entries.value) if (e.warning) e.action = 'skip'
  toast(`已把 ${n} 条带提示的改为跳过`)
}

async function execute(): Promise<void> {
  if (actionable.value === 0) {
    toast('没有要执行的条目')
    return
  }

  const warned = tally.value.warn
  const lines = [
    `即将处理 ${actionable.value} 条：剪切移动 ${tally.value.move} 条，创建链接 ${tally.value.junction} 条。`,
    '',
    '剪切会真的移动磁盘上的文件夹。链接不动任何文件。',
    warned > 0 ? `其中 ${warned} 条带有提示信息，建议先逐条看过。` : '',
    '',
    '执行后可以在设置 → 目录整理里撤销。确认继续？'
  ].filter(Boolean)
  if (!window.confirm(lines.join('\n'))) return

  let result: OrganizeResult | null = null
  try {
    result = await organize.run(
      entries.value.map((e) => ({
        software_id: e.software_id,
        action: e.action,
        category: e.category,
        folder: e.folder
      }))
    )
  } catch (err) {
    error(`整理执行失败：${errorMessage(err)}`)
  }

  // 就算 run 抛了错也要刷新：主进程可能已经执行完前几条命令，
  // 让预览和卡片墙停在过期状态比弹一次错更糟。store.reload 自己接错，不会再抛
  await Promise.all([load().catch(() => {}), store.reload()])
  if (!result) return

  const parts = [`移动 ${result.moved} 条`, `链接 ${result.linked} 条`]
  if (result.failed > 0) {
    error(`整理完成，但 ${result.failed} 条失败：${parts.join('，')}。到设置里查看明细`)
    return
  }
  success(`整理完成：${parts.join('，')}`)
}
</script>

<template>
  <div class="organize">
    <header class="head">
      <button class="btn btn--subtle" @click="router.back()">
        <ArrowLeft :size="16" />
        返回
      </button>
      <h1>整理预览</h1>
      <span class="head__count">{{ entries.length }}</span>
    </header>

    <div class="body">
      <p v-if="loading" class="state">正在生成方案…（安装版会顺带查一遍注册表引用，稍慢）</p>

      <div v-else-if="!root" class="state">
        <h2>还没有设置整理目标目录</h2>
        <p>整理需要一个归置软件的根目录，比如 E:\Toolkit。它和扫描目录是分开的。</p>
        <button
          class="btn btn--primary"
          @click="router.push({ name: 'settings', query: { tab: 'organize' } })"
        >
          去设置
        </button>
      </div>

      <div v-else-if="entries.length === 0" class="state">
        <h2>没有需要整理的软件</h2>
        <p>已经在整理目录下的条目不会重复出现在这里。</p>
        <button class="btn btn--ghost" @click="router.push({ name: 'home' })">返回卡片墙</button>
      </div>

      <template v-else>
        <section class="panel intro">
          <div class="intro__root">
            <FolderTree :size="15" />
            <span class="mono truncate" :title="root">{{ root }}</span>
          </div>
          <p class="intro__text">
            <b>剪切移动</b>会把软件的整个文件夹搬到目标位置，并把文件夹名规范成英文正式名；
            <b>创建链接</b>只在目标位置放一个 junction 指向原处，磁盘上的文件一步不动。
            绿色软件默认剪切，安装版除非判定为可安全移动，一律只做链接。
            每一条都可以自己改。
          </p>
          <ul class="tally">
            <li><b>{{ tally.move }}</b><span>剪切移动</span></li>
            <li><b>{{ tally.junction }}</b><span>创建链接</span></li>
            <li><b>{{ tally.skip }}</b><span>跳过</span></li>
            <li :class="{ warn: tally.warn > 0 }"><b>{{ tally.warn }}</b><span>带提示</span></li>
          </ul>
          <div class="row">
            <span class="hint">全部改为</span>
            <div class="segmented">
              <button v-for="a in ACTIONS" :key="a.value" @click="setAll(a.value)">
                {{ a.label }}
              </button>
            </div>
            <button v-if="tally.warn > 0" class="btn btn--ghost" @click="skipWarned">
              <AlertTriangle :size="14" />
              带提示的全部跳过
            </button>
          </div>
        </section>

        <section class="panel table">
          <div class="table__head">
            <span>软件</span>
            <span>操作</span>
            <span>目标分类</span>
            <span>目标文件夹名</span>
          </div>

          <article
            v-for="e in entries"
            :key="e.software_id"
            class="line"
            :class="{ 'line--skip': e.action === 'skip' }"
          >
            <div class="line__name">
              <div class="line__title">
                <Leaf v-if="e.is_portable === true" :size="13" class="leaf" title="绿色软件" />
                <Link2 v-if="e.link_target" :size="13" class="linked" title="当前已是链接" />
                <span class="truncate" :title="e.name">{{ e.name }}</span>
                <AlertTriangle
                  v-if="e.warning"
                  :size="13"
                  class="warn-icon"
                  :title="e.warning"
                />
              </div>
              <span class="line__from mono truncate" :title="e.from_dir">{{ e.from_dir }}</span>
              <div class="line__flags">
                <TagBadge
                  :label="e.is_portable === true ? '绿色' : e.is_portable === false ? '安装版' : '未判断'"
                  :tone="e.is_portable === true ? 'success' : 'muted'"
                />
                <TagBadge
                  :label="{ safe: '可安全移动', risky: '有风险', unknown: '风险未知' }[e.move_risk]"
                  :tone="e.move_risk === 'safe' ? 'success' : e.move_risk === 'risky' ? 'warning' : 'muted'"
                />
              </div>
            </div>

            <select
              class="select"
              :value="e.action"
              @change="setAction(e, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="a in ACTIONS" :key="a.value" :value="a.value">{{ a.label }}</option>
            </select>

            <select v-model="e.category" class="select" :disabled="e.action === 'skip'">
              <option v-for="c in categories.list" :key="c.id" :value="c.name">{{ c.name }}</option>
            </select>

            <div class="line__target">
              <input
                v-model="e.folder"
                class="input"
                spellcheck="false"
                :disabled="e.action === 'skip'"
                placeholder="文件夹名"
              />
              <span class="line__to mono truncate" :title="targetOf(e)">{{ targetOf(e) }}</span>
            </div>

            <p v-if="e.warning" class="line__warning">{{ e.warning }}</p>
          </article>
        </section>
      </template>
    </div>

    <footer v-if="!loading && entries.length > 0 && root" class="bar">
      <span class="bar__count">
        将处理 {{ actionable }} / {{ entries.length }} 条
      </span>

      <div v-if="organize.running.value" class="bar__progress">
        <div class="bar__track"><i :style="{ width: `${organize.percent.value}%` }" /></div>
        <span class="hint truncate">
          {{ organize.phaseLabel.value }}　{{ organize.progress.value?.current ?? '' }}
        </span>
      </div>

      <div class="bar__ops">
        <button class="btn btn--subtle" :disabled="organize.running.value" @click="router.back()">
          取消
        </button>
        <button
          class="btn btn--primary"
          :disabled="organize.running.value || actionable === 0"
          @click="execute"
        >
          <Loader2 v-if="organize.running.value" :size="14" class="spin" />
          执行整理
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.organize {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head h1 {
  font-size: var(--fs-title);
  font-weight: 500;
}

.head__count {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.body > * {
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 300px;
  color: var(--text-sub);
  text-align: center;
}

.state h2 {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 400;
}

.state p {
  font-size: var(--fs-body);
  color: var(--text-faint);
}

.intro__root {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  margin-bottom: 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
  color: var(--text-sub);
}

.intro__root span {
  flex: 1;
  min-width: 0;
}

.intro__text {
  font-size: var(--fs-tag);
  line-height: 1.9;
  color: var(--text-faint);
  margin-bottom: 12px;
}

.tally {
  list-style: none;
  display: flex;
  gap: 8px;
  margin: 0 0 12px;
  padding: 0;
}

.tally li {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.tally b {
  font-size: 17px;
  font-weight: 500;
  font-family: var(--font-mono);
}

.tally span {
  font-size: 11px;
  color: var(--text-faint);
}

.tally li.warn b {
  color: var(--warning);
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-btn);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.segmented button {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.segmented button:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

/* ------------------------------ 表格 ------------------------------ */
.table {
  padding: 0;
  overflow: hidden;
}

.table__head,
.line {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) 116px 130px minmax(0, 1.3fr);
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
}

.table__head {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-faint);
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.line {
  border-bottom: 1px solid var(--divider);
}
.line:last-child {
  border-bottom: none;
}

.line--skip {
  opacity: 0.5;
}

.line__name {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.line__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--text-main);
}

.leaf {
  flex: none;
  color: var(--success);
}

.linked {
  flex: none;
  color: var(--accent-2);
}

.warn-icon {
  flex: none;
  color: var(--warning);
  cursor: help;
}

.line__from,
.line__to {
  color: var(--text-faint);
}

.line__flags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.line__target {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.select {
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

.select:disabled,
.input:disabled {
  opacity: 0.45;
}

/* 警告文字横跨整行 —— 它往往有两句话，挤在名字那一列读不了 */
.line__warning {
  grid-column: 1 / -1;
  padding: 7px 9px;
  border-radius: var(--radius-input);
  background: var(--warning-bg);
  color: var(--warning);
  font-size: 11px;
  line-height: 1.7;
}

/* ------------------------------ 底栏 ------------------------------ */
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 24px;
  background: var(--bg-side);
  border-top: 1px solid var(--divider);
}

.bar__count {
  font-size: var(--fs-tag);
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bar__progress {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar__track {
  flex: 1;
  min-width: 80px;
  height: 4px;
  border-radius: 2px;
  background: var(--hover-surface);
  overflow: hidden;
}

.bar__track i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 200ms ease;
}

.bar__ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
