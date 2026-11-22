<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  Image,
  ImageOff,
  Loader2,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'
import AppIcon from '@/components/ui/AppIcon.vue'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import SoftwareNotesTab from '@/components/software/SoftwareNotesTab.vue'
import SoftwareFilesTab from '@/components/software/SoftwareFilesTab.vue'
import ResourceBacklinksPanel from '@/components/workspace/ResourceBacklinksPanel.vue'
import { useAI } from '@/composables/useAI'
import { confirmDialog } from '@/composables/useDialog'
import { useResourceDetail } from '@/composables/useResourceDetail'
import { useToast } from '@/composables/useToast'
import { useCategoriesStore } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'
import { previewSoftwareCategoryChanges, categoryMoveConfirmation } from '@/utils/softwareCategory'
import { isMobilePackage } from '@/utils/software-package'
import type { MasteryLevel, SoftwareItem } from '@/types'
import {
  MASTERY_META,
  MASTERY_ORDER,
  activityOf,
  displayName,
  errorMessage,
  formatDate,
} from '@/utils'

const props = defineProps<{ id: string }>()
const router = useRouter()
const route = useRoute()
const detailTabs = [
  { id: 'overview', label: '简介' },
  { id: 'notes', label: '使用心得' },
  { id: 'files', label: '文件与启动' },
]
const activeTab = ref(detailTabs.some((tab) => tab.id === route.query.tab) ? String(route.query.tab) : 'overview')
watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } })
})
watch(
  () => route.query.tab,
  (tab) => {
    activeTab.value = detailTabs.some((t) => t.id === tab) ? String(tab) : 'overview'
  }
)

const store = useSoftwareStore()
const categories = useCategoriesStore()
const { success, error, toast } = useToast()
const ai = useAI()

const item = ref<SoftwareItem | null>(null)
const loading = ref(true)

async function load(): Promise<void> {
  loading.value = true
  try {
    item.value = await window.baoyi.software.get(props.id)
  } catch (err) {
    error(`读取条目失败：${errorMessage(err)}`)
    item.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)

const name = computed(() => (item.value ? displayName(item.value) : ''))
const activity = computed(() =>
  item.value
    ? activityOf(item.value)
    : ({ at: 0, source: 'none', label: '—', hint: '' } as ReturnType<typeof activityOf>)
)

const categoryOptions = computed(() => {
  const names = categories.list.map((c) => c.name)
  const current = item.value?.category
  if (current && !names.includes(current)) names.unshift(current)
  return names
})

const categoryBusy = ref(false)
const typeBusy = ref(false)
function typeUpdated(updated: SoftwareItem): void {
  if (item.value?.id === updated.id) item.value = updated
}
function parseList(raw: string): string[] {
  return raw
    .split(/[,，、\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
}

const { save, commitTags, toggleArchive, reveal, copyPath } = useResourceDetail({
  item,
  reveal: (id) => window.baoyi.software.revealInFolder(id),
  parseTags: parseList,
  archivedMessage: (archived) => (archived ? '已归档，主列表不再默认展示' : '已取消归档'),
  async update(current, patch) {
    let holdsCategoryLock = false
    try {
      if (patch.category !== undefined && patch.category !== current.category) {
        if (categoryBusy.value) return null
        categoryBusy.value = true
        holdsCategoryLock = true
        const moves = await previewSoftwareCategoryChanges([current.id], patch.category)
        if (moves.length) {
          const ok = await confirmDialog({
            title: '同步整理目录分类',
            message: categoryMoveConfirmation(moves),
            confirmText: '确认迁移',
          })
          if (!ok) return null
          const p = moves[0].preview
          const result = await window.baoyi.organize.relocate(current.id, p.category, p.folder, p.from)
          if (!result.ok) throw new Error(result.message)
          patch = { ...patch, category: p.category }
        }
      }
      return await store.update(current.id, patch)
    } finally {
      if (holdsCategoryLock) categoryBusy.value = false
    }
  },
})

function commitList(field: 'tags' | 'alternatives', raw: string): void {
  if (field === 'tags') commitTags(raw)
  else void save({ alternatives: parseList(raw) })
}

async function launchWith(launcherPath: string): Promise<void> {
  if (!item.value) return
  try {
    const ok = await store.launch(item.value.id, launcherPath)
    if (ok && !isMobilePackage(launcherPath)) {
      item.value.last_used_at = Date.now()
      item.value.use_count += 1
    } else if (!ok) {
      error('启动失败，文件可能已被移动或删除')
    }
  } catch (err) {
    error(`启动失败：${errorMessage(err)}`)
  }
}

async function launch(): Promise<void> {
  if (!item.value) return
  await launchWith(item.value.exe_path)
}

async function setDefaultLauncher(launcherPath: string): Promise<void> {
  if (!item.value || launcherPath === item.value.exe_path) return
  const launchers = item.value.launchers.map((l) => ({
    ...l,
    is_default: l.path === launcherPath,
  }))
  try {
    const updated = await store.update(item.value.id, { launchers, exe_path: launcherPath })
    if (updated) {
      item.value = updated
      success('已切换默认启动端')
    }
  } catch {
    error('切换失败：该程序已登记在另一个条目下')
  }
}

async function removeItem(): Promise<void> {
  if (!item.value) return
  const linked = item.value.link_target !== ''
  const ok = await confirmDialog({
    title: `从软件库移除「${name.value}」？`,
    message: linked
      ? '此条目在整理目录中存有目录链接：链接会一并清理，真实软件文件保留不动。'
      : '仅移除抱一中的库记录，不会删除本地软件文件。',
    confirmText: '移除记录',
    tone: 'danger',
  })
  if (!ok) return
  try {
    const result = await store.remove(item.value.id)
    if (!result.ok) {
      error(result.message)
      return
    }
    success(result.message)
  } catch (err) {
    error(`移除失败：${errorMessage(err)}`)
    return
  }
  void router.push({ name: 'home' })
}

async function reidentify(): Promise<void> {
  if (!item.value) return
  try {
    const result = await ai.complete([item.value.id])
    await load()
    if (result.registered > 0) success('已重新识别')
    else error('未能完成识别，请检查设置中的模型连接')
  } catch (err) {
    error(`识别失败：${errorMessage(err)}`)
  }
}

function openOfficial(): void {
  if (item.value?.official_url) void window.baoyi.app.openUrl(item.value.official_url).catch((err) => error(errorMessage(err)))
}

function setMastery(level: MasteryLevel): void {
  void save({ mastery_level: level })
}

async function setCategory(e: Event): Promise<void> {
  const select = e.target as HTMLSelectElement
  await save({ category: select.value })
  select.value = item.value?.category ?? ''
}

const iconBusy = ref(false)
async function pickIcon(): Promise<void> {
  if (!item.value || iconBusy.value) return
  iconBusy.value = true
  try {
    const r = await window.baoyi.software.pickIcon(item.value.id)
    if (!r) return
    if (!r.ok) {
      error(r.message)
      return
    }
    if (r.item) item.value = r.item
    void store.load()
    success(r.message)
  } catch (err) {
    error(`更换图标失败：${errorMessage(err)}`)
  } finally {
    iconBusy.value = false
  }
}

async function refetchIcon(): Promise<void> {
  if (!item.value || iconBusy.value) return
  iconBusy.value = true
  try {
    const updated = await window.baoyi.software.clearIcon(item.value.id)
    if (updated) item.value = updated
    void store.load()
    toast(updated?.icon_path ? '已重新提取程序图标' : '程序内未包含可用图标，已使用文字占位')
  } catch (err) {
    error(`重新提取失败：${errorMessage(err)}`)
  } finally {
    iconBusy.value = false
  }
}

const locationDir = computed(() => {
  if (!item.value) return ''
  return item.value.source_dir || item.value.exe_path.replace(/\\[^\\]*$/, '')
})

const linkBusy = ref(false)
async function toEntity(): Promise<void> {
  if (!item.value) return
  const ok = await confirmDialog({
    title: '将真实文件搬入整理目录？',
    message: `${item.value.link_target}\n→ ${locationDir.value}\n\n搬移完成后原目录将腾空，此条目变为实体目录。`,
    confirmText: '确认搬移',
  })
  if (!ok) return
  linkBusy.value = true
  try {
    const r = await window.baoyi.organize.materialize(item.value.id)
    await load()
    r.ok ? success(r.message) : error(r.message)
  } catch (err) {
    error(`转换失败：${errorMessage(err)}`)
  } finally {
    linkBusy.value = false
  }
}

async function dropLink(): Promise<void> {
  if (!item.value) return
  const ok = await confirmDialog({
    title: '移除整理目录链接？',
    message: '仅移除整理目录中的链接，真实文件保持不动，条目路径退回原安装目录。',
    confirmText: '移除链接',
  })
  if (!ok) return
  linkBusy.value = true
  try {
    const r = await window.baoyi.organize.unlink(item.value.id)
    await load()
    r.ok ? success(r.message) : error(r.message)
  } catch (err) {
    error(`移除失败：${errorMessage(err)}`)
  } finally {
    linkBusy.value = false
  }
}
</script>

<template>
  <div class="detail">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item" class="detail__state">
      <p>这条记录不存在或已被移除。</p>
      <button type="button" class="btn btn--ghost" @click="router.push({ name: 'home' })">返回软件库</button>
    </div>

    <template v-else>
      <header class="head">
        <button type="button" class="btn btn--subtle" @click="router.push({ name: 'home' })">
          <ArrowLeft :size="16" />
          返回
        </button>

        <div class="head__actions">
          <button type="button" class="btn btn--primary" @click="launch">
            <FolderOpen v-if="isMobilePackage(item.exe_path)" :size="14" />
            <Play v-else :size="14" fill="currentColor" />
            {{ isMobilePackage(item.exe_path) ? '定位安装包' : '启动' }}
          </button>
          <button type="button" class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="!item.official_url"
            :title="item.official_url || '暂无官网'"
            @click="openOfficial"
          >
            <ExternalLink :size="14" />
            官网
          </button>
          <button type="button" class="btn btn--ghost" :disabled="ai.running.value" @click="reidentify">
            <Sparkles :size="14" />
            重新识别
          </button>
          <button type="button" class="btn btn--ghost" @click="toggleArchive">
            <component :is="item.is_archived ? ArchiveRestore : Archive" :size="14" />
            {{ item.is_archived ? '取消归档' : '归档' }}
          </button>
          <button type="button" class="btn btn--danger" @click="removeItem">
            <Trash2 :size="14" />
            移除
          </button>
        </div>
      </header>

      <div class="body detail-body">
        <section class="hero panel">
          <div class="hero__icon">
            <AppIcon :item="item" :size="64" />
            <div class="hero__iconActs">
              <button
                type="button"
                class="hero__iconBtn"
                :disabled="iconBusy"
                :title="item.icon_path ? '更换图标' : '选择图标图片'"
                @click="pickIcon"
              >
                <Loader2 v-if="iconBusy" :size="13" class="spin" />
                <Image v-else :size="13" />
              </button>
              <button
                v-if="item.icon_path"
                type="button"
                class="hero__iconBtn"
                :disabled="iconBusy"
                title="重新从程序文件提取默认图标"
                @click="refetchIcon"
              >
                <ImageOff :size="13" />
              </button>
            </div>
          </div>

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
              <select class="select" :value="item.category" :disabled="categoryBusy" @change="setCategory">
                <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
              </select>

              <div class="mastery-pick">
                <button
                  v-for="lv in MASTERY_ORDER"
                  :key="lv"
                  type="button"
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

        <DetailTabs v-model="activeTab" :tabs="detailTabs" prefix="software" label="软件详情" />

        <div
          id="software-panel-overview"
          v-show="activeTab === 'overview'"
          role="tabpanel"
          aria-labelledby="software-tab-overview"
          tabindex="0"
          class="detail-panel detail-panel--overview"
        >
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
                  :label="{ done: '已识别', pending: '待识别', failed: '未完成' }[item.ai_status]"
                  :tone="item.ai_status === 'done' ? 'success' : item.ai_status === 'failed' ? 'warning' : 'muted'"
                />
              </dd>
            </dl>
            <p v-if="activity.source === 'external'" class="sec-note sec-note--foot">
              尚未通过抱一启动过该软件；此处时间取自软件目录下配置文件的最近修改时间，用于辅助区分近期常用与长期闲置。
            </p>
          </section>
          <section v-if="item.official_url" class="panel">
            <h2 class="sec-title">官网</h2>
            <a :href="item.official_url" target="_blank" rel="noopener noreferrer" class="mono truncate link">
              {{ item.official_url }}
            </a>
          </section>
        </div>

        <SoftwareNotesTab
          v-show="activeTab === 'notes'"
          :item="item"
          @save="save"
          @commit-alternatives="(raw) => commitList('alternatives', raw)"
        />

        <ResourceBacklinksPanel
          v-show="activeTab === 'overview' || activeTab === 'notes'"
          :resource-id="item.id"
        />

        <SoftwareFilesTab
          v-show="activeTab === 'files'"
          :item="item"
          :location-dir="locationDir"
          :category-busy="categoryBusy"
          :link-busy="linkBusy"
          :type-busy="typeBusy"
          @launch-with="launchWith"
          @set-default="setDefaultLauncher"
          @copy-path="copyPath"
          @update:type-busy="(v) => (typeBusy = v)"
          @type-updated="typeUpdated"
          @to-entity="toEntity"
          @drop-link="dropLink"
        />
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
  padding: 20px 24px 32px;
}
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
}
.detail-body > .hero,
.detail-body > .detail-tabs {
  width: 100%;
}
:deep(.detail-panel) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  width: 100%;
  align-items: start;
}
:deep(.detail-panel--overview > .panel:first-child) {
  grid-column: 1 / -1;
}
:deep(.detail-panel--files) {
  grid-template-columns: minmax(0, 1fr);
}
@media (max-width: 800px) {
  :deep(.detail-panel) {
    grid-template-columns: minmax(0, 1fr);
  }
}
.hero {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  padding: 20px;
}
.hero__icon {
  position: relative;
  flex: none;
  border-radius: 14px;
  overflow: hidden;
}
.hero__iconActs {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 0;
  background: rgb(0 0 0 / 0.62);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity var(--t-fast) ease;
}
.hero__icon:hover .hero__iconActs,
.hero__iconActs:focus-within {
  opacity: 1;
}
.hero__iconBtn {
  display: flex;
  align-items: center;
  color: rgb(255 255 255 / 0.86);
}
.hero__iconBtn:hover {
  color: #fff;
}
.hero__iconBtn:disabled {
  opacity: 0.5;
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
.hero__summary:hover {
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
  transition: background var(--t-fast) ease, color var(--t-fast) ease, border-color var(--t-fast) ease;
}
.chip:hover {
  color: var(--text-main);
}
.chip.on {
  background: var(--active-surface);
  border-color: transparent;
  color: var(--accent);
}
.sec-title {
  font-size: var(--fs-tag);
  font-weight: 500;
  letter-spacing: 0.5px;
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
.sec-note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-faint);
  margin: -4px 0 10px;
}
.sec-note--foot {
  margin: 10px 0 0;
}
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
.link {
  display: block;
  color: var(--accent-2);
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
