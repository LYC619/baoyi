<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  Play,
  Sparkles,
  Trash2
} from 'lucide-vue-next'
import AppIcon from '@/components/AppIcon.vue'
import EditableField from '@/components/EditableField.vue'
import TagBadge from '@/components/TagBadge.vue'
import { useAI } from '@/composables/useAI'
import { useToast } from '@/composables/useToast'
import { useCategoriesStore } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'
import type { MasteryLevel, SoftwareItem } from '@/types'
import { MASTERY_META, MASTERY_ORDER, activityOf, displayName, formatBytes, formatDate } from '@/utils'

const props = defineProps<{ id: string }>()

const router = useRouter()
const store = useSoftwareStore()
const categories = useCategoriesStore()
const { success, error, toast } = useToast()
const ai = useAI()

const item = ref<SoftwareItem | null>(null)
const loading = ref(true)

async function load(): Promise<void> {
  loading.value = true
  item.value = await window.baoyi.software.get(props.id)
  loading.value = false
}

onMounted(load)
watch(() => props.id, load)

const name = computed(() => (item.value ? displayName(item.value) : ''))

/** 上次活跃：抱一记的启动时间，或退回从软件目录推出来的外部活跃时间 */
const activity = computed(() =>
  item.value
    ? activityOf(item.value)
    : ({ at: 0, source: 'none', label: '—', hint: '' } as ReturnType<typeof activityOf>)
)

/** 分类下拉里要能显示 AI 给出的、但用户分类表里还没有的分类名 */
const categoryOptions = computed(() => {
  const names = categories.list.map((c) => c.name)
  const current = item.value?.category
  if (current && !names.includes(current)) names.unshift(current)
  return names
})

async function save(patch: Partial<SoftwareItem>): Promise<void> {
  if (!item.value) return
  const updated = await store.update(item.value.id, patch)
  if (updated) item.value = updated
}

function commitList(field: 'tags' | 'alternatives', raw: string): void {
  const list = raw
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  void save(field === 'tags' ? { tags: list } : { alternatives: list })
}

async function launch(): Promise<void> {
  if (!item.value) return
  const ok = await store.launch(item.value.id)
  if (ok) {
    item.value.last_used_at = Date.now()
    item.value.use_count += 1
  } else {
    error('启动失败，文件可能已被移动或删除')
  }
}

/** 从启动端列表里点某一个启动，不改默认端 */
async function launchWith(launcherPath: string): Promise<void> {
  if (!item.value) return
  const ok = await store.launch(item.value.id, launcherPath)
  if (ok) {
    item.value.last_used_at = Date.now()
    item.value.use_count += 1
  } else {
    error('启动失败，文件可能已被移动或删除')
  }
}

/** 默认启动端同时也是这条记录的唯一键，所以要和 exe_path 一起改 */
async function setDefaultLauncher(launcherPath: string): Promise<void> {
  if (!item.value || launcherPath === item.value.exe_path) return
  const launchers = item.value.launchers.map((l) => ({
    ...l,
    is_default: l.path === launcherPath
  }))
  try {
    await save({ launchers, exe_path: launcherPath })
    success('已切换默认启动端')
  } catch {
    error('切换失败：这个程序已经被登记在另一个条目下了')
  }
}

async function toggleArchive(): Promise<void> {
  if (!item.value) return
  const next = !item.value.is_archived
  await save({ is_archived: next })
  success(next ? '已归档，卡片墙不再显示' : '已取消归档')
}

async function removeItem(): Promise<void> {
  if (!item.value) return
  const ok = window.confirm(`确认从抱一移除「${name.value}」？\n只删除记录，不会删除实际文件。`)
  if (!ok) return
  await store.remove(item.value.id)
  success('已移除记录')
  void router.push({ name: 'home' })
}

async function reidentify(): Promise<void> {
  if (!item.value) return
  const result = await ai.complete([item.value.id])
  await load()
  if (result.registered > 0) success('已重新识别')
  else error('识别失败，检查设置里的 API 配置')
}

function openOfficial(): void {
  if (item.value?.official_url) window.open(item.value.official_url, '_blank')
}

function reveal(): void {
  if (item.value) void window.baoyi.software.revealInFolder(item.value.id)
}

function setMastery(level: MasteryLevel): void {
  void save({ mastery_level: level })
}

function setCategory(e: Event): void {
  void save({ category: (e.target as HTMLSelectElement).value })
}

function copyPath(target: string): void {
  void navigator.clipboard.writeText(target)
  toast('路径已复制')
}
</script>

<template>
  <div class="detail">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item" class="detail__state">
      <p>这条记录不存在或已被移除。</p>
      <button class="btn btn--ghost" @click="router.push({ name: 'home' })">返回卡片墙</button>
    </div>

    <template v-else>
      <header class="head">
        <button class="btn btn--subtle" @click="router.back()">
          <ArrowLeft :size="16" />
          返回
        </button>

        <div class="head__actions">
          <button class="btn btn--primary" @click="launch">
            <Play :size="14" fill="currentColor" />
            启动
          </button>
          <button class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button
            class="btn btn--ghost"
            :disabled="!item.official_url"
            :title="item.official_url || '暂无官网'"
            @click="openOfficial"
          >
            <ExternalLink :size="14" />
            官网
          </button>
          <button class="btn btn--ghost" :disabled="ai.running.value" @click="reidentify">
            <Sparkles :size="14" />
            重新识别
          </button>
          <button class="btn btn--ghost" @click="toggleArchive">
            <component :is="item.is_archived ? ArchiveRestore : Archive" :size="14" />
            {{ item.is_archived ? '取消归档' : '归档' }}
          </button>
          <button class="btn btn--danger" @click="removeItem">
            <Trash2 :size="14" />
            移除
          </button>
        </div>
      </header>

      <div class="body">
        <!-- ------------------------------ 主列 ------------------------------ -->
        <div class="col col--main">
          <section class="hero panel">
            <AppIcon :item="item" :size="64" />
            <div class="hero__text">
              <div class="hero__names">
                <input
                  class="hero__name"
                  :value="item.name_zh"
                  placeholder="中文名称"
                  spellcheck="false"
                  @blur="save({ name_zh: ($event.target as HTMLInputElement).value })"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <input
                  class="hero__en"
                  :value="item.name_en"
                  placeholder="英文原名"
                  spellcheck="false"
                  @blur="save({ name_en: ($event.target as HTMLInputElement).value })"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
              </div>

              <input
                class="hero__summary"
                :value="item.summary"
                placeholder="一句话说明（20 字以内）"
                spellcheck="false"
                @blur="save({ summary: ($event.target as HTMLInputElement).value })"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />

              <div class="hero__row">
                <select class="select" :value="item.category" @change="setCategory">
                  <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
                </select>

                <div class="mastery-pick">
                  <button
                    v-for="lv in MASTERY_ORDER"
                    :key="lv"
                    class="chip"
                    :class="{ on: item.mastery_level === lv }"
                    @click="setMastery(lv)"
                  >
                    {{ MASTERY_META[lv].label }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-title">功能说明</h2>
            <EditableField
              :model-value="item.description"
              multiline
              placeholder="这个软件是做什么的（50-100 字）"
              @commit="save({ description: $event })"
            />
          </section>

          <section class="panel">
            <h2 class="sec-title">为什么选它</h2>
            <EditableField
              :model-value="item.why_choose"
              multiline
              placeholder="同类里为什么留下这一个"
              @commit="save({ why_choose: $event })"
            />
          </section>

          <section class="panel">
            <h2 class="sec-title">使用场景</h2>
            <EditableField
              :model-value="item.use_cases"
              multiline
              placeholder="什么时候会打开它"
              @commit="save({ use_cases: $event })"
            />
          </section>

          <section class="panel">
            <h2 class="sec-title">个人笔记</h2>
            <EditableField
              :model-value="item.notes"
              multiline
              placeholder="快捷键、配置位置、踩过的坑…"
              @commit="save({ notes: $event })"
            />
          </section>
        </div>

        <!-- ------------------------------ 侧列 ------------------------------ -->
        <div class="col col--side">
          <section class="panel">
            <h2 class="sec-title">标签</h2>
            <div v-if="item.tags.length" class="tag-row">
              <TagBadge v-for="t in item.tags" :key="t" :label="t" />
            </div>
            <EditableField
              :model-value="item.tags.join('、')"
              placeholder="用顿号或逗号分隔"
              @commit="commitList('tags', $event)"
            />
          </section>

          <section class="panel">
            <h2 class="sec-title">淘汰的同类</h2>
            <div v-if="item.alternatives.length" class="tag-row">
              <TagBadge v-for="a in item.alternatives" :key="a" :label="a" tone="muted" />
            </div>
            <EditableField
              :model-value="item.alternatives.join('、')"
              placeholder="被它替代掉的软件"
              @commit="commitList('alternatives', $event)"
            />
          </section>

          <section class="panel">
            <h2 class="sec-title">使用统计</h2>
            <dl class="kv">
              <dt>上次使用</dt>
              <dd :title="activity.hint">
                {{ activity.label }}
                <span class="src" :class="`src--${activity.source}`">
                  {{ { baoyi: '由抱一启动', external: '外部活跃', none: '' }[activity.source] }}
                </span>
              </dd>
              <dt>启动次数</dt>
              <dd>{{ item.use_count }}</dd>
              <dt>收录于</dt>
              <dd>{{ formatDate(item.created_at) }}</dd>
              <dt>识别状态</dt>
              <dd>
                <TagBadge
                  :label="{ done: '已识别', pending: '待识别', failed: '识别失败' }[item.ai_status]"
                  :tone="item.ai_status === 'done' ? 'success' : item.ai_status === 'failed' ? 'warning' : 'muted'"
                />
              </dd>
            </dl>
            <p v-if="activity.source === 'external'" class="sec-note sec-note--foot">
              抱一还没记到过你启动它。这个时间来自软件目录里配置文件的最后修改时间 ——
              是个近似值，只用来区分「装了没碰过」和「最近还在用」。
            </p>
          </section>

          <section class="panel">
            <h2 class="sec-title">
              启动端
              <span v-if="item.launchers.length > 1" class="sec-title__count">
                {{ item.launchers.length }}
              </span>
            </h2>
            <p class="sec-note">
              同一个软件的 32/64 位和附属程序都归在这里。点一行直接启动它，
              点「设为默认」换掉卡片墙上那个按钮启动的目标。
            </p>
            <ul class="launchers">
              <li
                v-for="l in item.launchers"
                :key="l.path"
                :class="{ 'launchers__row--extra': l.kind === 'extra' }"
              >
                <button class="launchers__go" :title="`启动 ${l.path}`" @click="launchWith(l.path)">
                  <Play :size="13" />
                </button>
                <div class="launchers__body">
                  <div class="launchers__line">
                    <span class="launchers__name mono">{{ l.path.split('\\').pop() }}</span>
                    <TagBadge v-if="l.label" :label="l.label" tone="muted" />
                    <TagBadge v-if="l.is_default" label="默认" tone="success" />
                    <TagBadge v-else-if="l.kind === 'extra'" label="附属" tone="muted" />
                  </div>
                  <button class="launchers__path mono" :title="l.path" @click="copyPath(l.path)">
                    {{ l.path }}
                  </button>
                </div>
                <button
                  v-if="!l.is_default"
                  class="launchers__set"
                  @click="setDefaultLauncher(l.path)"
                >
                  设为默认
                </button>
              </li>
            </ul>
          </section>

          <section class="panel">
            <h2 class="sec-title">文件信息</h2>
            <dl class="kv">
              <dt>文件名</dt>
              <dd class="mono">{{ item.file_name }}</dd>
              <dt>开发商</dt>
              <dd>{{ item.company || '—' }}</dd>
              <dt>版本</dt>
              <dd class="mono">{{ item.version || '—' }}</dd>
              <dt>大小</dt>
              <dd>{{ formatBytes(item.file_size) }}</dd>
            </dl>
          </section>

          <section v-if="item.official_url" class="panel">
            <h2 class="sec-title">官网</h2>
            <a :href="item.official_url" target="_blank" class="mono truncate link">
              {{ item.official_url }}
            </a>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.detail__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-sub);
}

.head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 16px;
  padding: 20px 24px 32px;
  align-items: start;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* ------------------------------- 头部卡片 ------------------------------- */
.hero {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  padding: 20px;
}

.hero__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hero__names {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.hero__name,
.hero__en,
.hero__summary {
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  padding: 3px 6px;
  margin-left: -6px;
  transition: border-color var(--t-fast) ease;
}
.hero__name:hover,
.hero__en:hover,
.hero__summary:hover,
.hero__name:focus,
.hero__en:focus,
.hero__summary:focus {
  border-color: var(--divider);
}
.hero__name:focus,
.hero__en:focus,
.hero__summary:focus {
  border-color: var(--accent);
}

.hero__name {
  font-size: 21px;
  font-weight: 500;
  min-width: 120px;
  flex: 1;
}

.hero__en {
  font-size: var(--fs-body);
  color: var(--text-faint);
  width: 180px;
}

.hero__summary {
  font-size: var(--fs-body);
  color: var(--text-sub);
  width: 100%;
}

.hero__row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.select {
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-tag);
  background: var(--bg-main);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

.mastery-pick {
  display: flex;
  gap: 6px;
}

.chip {
  height: 24px;
  padding: 0 10px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease,
    border-color var(--t-fast) ease;
}
.chip:hover {
  color: var(--text-main);
}
.chip.on {
  background: var(--active-surface);
  border-color: transparent;
  color: var(--accent);
}

/* ------------------------------- 区块 ------------------------------- */
.sec-title {
  font-size: var(--fs-tag);
  font-weight: 400;
  letter-spacing: 1px;
  color: var(--text-faint);
  margin-bottom: 10px;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.kv {
  display: grid;
  grid-template-columns: 68px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: var(--fs-body);
}

.kv dt {
  color: var(--text-faint);
  font-size: var(--fs-tag);
}

.kv dd {
  margin: 0;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
}

.path {
  display: block;
  width: 100%;
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-main);
  border: 1px solid var(--divider);
  color: var(--text-faint);
  text-align: left;
  word-break: break-all;
  line-height: 1.6;
  transition: color var(--t-fast) ease;
}
.path:hover {
  color: var(--text-sub);
}

.sec-title__count {
  margin-left: 6px;
  font-family: var(--font-mono);
  letter-spacing: 0;
}

.sec-note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-faint);
  margin: -4px 0 10px;
}

/* 同一段说明放在区块末尾时，上下留白要反过来 */
.sec-note--foot {
  margin: 10px 0 0;
}

/* 时间是抱一亲眼见过的启动，还是从磁盘 mtime 推出来的 */
.src {
  margin-left: 6px;
  font-size: 11px;
}
.src--baoyi {
  color: var(--success);
}
.src--external {
  color: var(--text-faint);
}

.launchers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.launchers li {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.launchers__row--extra {
  opacity: 0.72;
}

.launchers__go {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-sub);
  background: var(--hover-surface);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}
.launchers__go:hover {
  background: var(--active-surface);
  color: var(--accent);
}

.launchers__body {
  flex: 1;
  min-width: 0;
}

.launchers__line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.launchers__name {
  font-size: var(--fs-tag);
  color: var(--text-main);
}

.launchers__path {
  display: block;
  width: 100%;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
  text-align: left;
  word-break: break-all;
  transition: color var(--t-fast) ease;
}
.launchers__path:hover {
  color: var(--text-sub);
}

.launchers__set {
  flex-shrink: 0;
  align-self: center;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  transition: color var(--t-fast) ease;
}
.launchers__set:hover {
  color: var(--accent);
}

.link {
  display: block;
  color: var(--accent-2);
}

@media (max-width: 1080px) {
  .body {
    grid-template-columns: 1fr;
  }
}
</style>
