<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { errorMessage } from '@/utils'
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import {
  BookOpen,
  Plus,
  FolderSearch,
  List,
  Grid2X2,
  PanelRightClose,
  PanelRightOpen,
  FileText,
  Search,
  SlidersHorizontal,
  ChevronDown,
  ChevronLeft,
  Pencil,
  Trash2,
} from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { workspace } from '@/utils/workspace-api'
import {
  type DocumentItem,
  type DocumentScan,
  type DocumentAnnotation,
  type DocumentSubmodule,
  type DocumentCustomGroup,
} from '@/types/workspace'
import DocumentRemove from '@/components/workspace/DocumentRemove.vue'
import DocumentDetails from '@/components/workspace/DocumentDetails.vue'
import DocumentBulk from '@/components/workspace/DocumentBulk.vue'
import DocumentAssistant from '@/components/workspace/DocumentAssistant.vue'
import DocumentGroupCard from '@/components/workspace/DocumentGroupCard.vue'
import DocumentTagDialog from '@/components/workspace/DocumentTagDialog.vue'
import DocumentRowItem from '@/components/workspace/DocumentRowItem.vue'
import DocumentImportDialog from '@/components/workspace/DocumentImportDialog.vue'
import { useFileDrop } from '@/composables/useFileDrop'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay.vue'
import DocumentSidebar from '@/components/workspace/DocumentSidebar.vue'
import { confirmDialog, promptDialog } from '@/composables/useDialog'
import {
  groupDocuments,
  documentSections,
  tagCounts,
  projectCounts,
} from '@/utils/document-library-view'
import {
  pauseDocumentCovers,
  resumeDocumentCovers,
  invalidateDocumentCovers,
} from '@/composables/useDocumentCovers'
import '@/styles/workspace.css'

const store = useDocumentsStore()
const router = useRouter()
const details = ref(false)
const menu = ref<'' | 'import' | 'display'>('')
const bulk = ref(false)
const checked = ref<string[]>([])
const removing = ref(false)
const busy = ref(false)
const error = ref('')
const main = ref<HTMLElement>()
const searchInput = ref<HTMLInputElement>()

const preview = ref<(DocumentScan & { token: string; categoryId: string }) | null>(null)
const annotations = ref<DocumentAnnotation[]>([])
const backlinks = ref<Awaited<ReturnType<typeof workspace.links.backlinks>>>([])
const insightImportMessage = ref('')
const current = computed(() => store.items.find((i) => i.id === store.selected))
const currentTitle = computed(() => (store.submodule === 'reading' ? tr("阅读") : tr("资料")))

const allSearch = computed(() => store.searchAll && !!store.search.trim())
const moduleRows = computed(() => store.items.filter((i) => allSearch.value || i.submodule === store.submodule))
const sources = computed(() => [...new Set(moduleRows.value.map((i) => i.sourceDir).filter(Boolean))] as string[])
const baseRows = computed(() =>
  moduleRows.value.filter((i) => {
    if (!allSearch.value && store.type && i.type !== store.type) return false
    if (!allSearch.value && store.customGroupId && i.customGroupId !== store.customGroupId) return false
    if (store.favorite && !i.favorite) return false
    if (store.sourceDir && i.sourceDir !== store.sourceDir) return false
    const query = store.search.trim().toLowerCase()
    return !query || [i.name, i.author, i.counterpart, i.notes, ...i.tags].join(' ').toLowerCase().includes(query)
  })
)
const tags = computed(() => tagCounts(baseRows.value))
const rows = computed(() =>
  baseRows.value
    .filter(
      (i) =>
        (!store.tag || i.tags.includes(store.tag)) &&
        (!store.state || (i.submodule === 'reading' && i.readable && i.readState === store.state))
    )
    .sort((a, b) => store.sort === 'name' ? a.name.localeCompare(b.name, 'zh') : store.sort === 'read' ? (b.lastReadAt - a.lastReadAt || b.updatedAt - a.updatedAt) : b.updatedAt - a.updatedAt)
)
const counts = computed(() => projectCounts(store.projectReferences))
const atHome = computed(
  () =>
    !store.type &&
    !store.tag &&
    !store.state &&
    !store.search.trim() &&
    !store.customGroupId &&
    !store.favorite &&
    !store.sourceDir
)
const activeGroupId = ref('')
const categoryTagDialog = ref(false)

const currentCategoryName = computed(() => store.categories.find((c) => c.id === store.type)?.name || '')
const activeGroup = computed(() => store.customGroups.find((g) => g.id === activeGroupId.value))
const activeGroupItems = computed(() => rows.value.filter((i) => i.customGroupId === activeGroupId.value))
const activeGroupCategoryName = computed(() => {
  const catId = activeGroup.value?.categoryId || activeGroupItems.value[0]?.type
  return store.categories.find((c) => c.id === catId)?.name || ''
})

function openGroup(groupId: string) {
  activeGroupId.value = groupId
}

function exitGroup() {
  activeGroupId.value = ''
}

function toggleGroupView(groupId: string) {
  activeGroupId.value = activeGroupId.value === groupId ? '' : groupId
}

async function renameGroup(group: DocumentCustomGroup) {
  const newName = await promptDialog({
    title: tr('重命名分组'),
    defaultValue: group.name,
    placeholder: tr('请输入分组名称'),
    confirmText: tr('保存'),
  })
  if (!newName || !newName.trim() || newName.trim() === group.name) return
  await run(async () => {
    await store.saveCustomGroup({
      id: group.id,
      submodule: group.submodule,
      categoryId: group.categoryId,
      name: newName.trim(),
      sortOrder: group.sortOrder,
    })
    await store.refresh()
  })
}

async function dissolveGroup(group: DocumentCustomGroup) {
  const ok = await confirmDialog({
    title: tr('解散分组「{p0}」', {p0: group.name}),
    message: tr("解散后，组内 {p0} 份资料将保留在原分类中，不会删除本地文件。", {p0: (activeGroupItems.value.length)}),
    confirmText: tr('解散分组'),
    tone: 'danger',
  })
  if (!ok) return
  await run(async () => {
    await store.removeCustomGroup(group.id)
    activeGroupId.value = ''
    await store.refresh()
  })
}

function toggleItemSelection(id: string) {
  checked.value = checked.value.includes(id)
    ? checked.value.filter((x) => x !== id)
    : [...checked.value, id]
}

function toggleGroupSelection(groupItems: DocumentItem[]) {
  const ids = groupItems.map((i) => i.id)
  const allChecked = ids.every((id) => checked.value.includes(id))
  checked.value = allChecked
    ? checked.value.filter((id) => !ids.includes(id))
    : [...new Set([...checked.value, ...ids])]
}

type ShelfEntry =
  | { key: string; isGroup: true; group: DocumentCustomGroup; items: DocumentItem[] }
  | { key: string; isGroup: false; item: DocumentItem }

function getSectionEntries(section: (typeof sections.value)[number]): ShelfEntry[] {
  if (activeGroupId.value) return []
  if (store.groupBy !== 'none' || section.key === 'recent') {
    return section.items.map((item) => ({ key: 'item:' + item.id, isGroup: false, item }))
  }

  const entries: ShelfEntry[] = []
  const groupedMap = new Map<string, DocumentItem[]>()
  const ungrouped: DocumentItem[] = []

  for (const item of section.items) {
    if (item.customGroupId && store.customGroups.some((g) => g.id === item.customGroupId)) {
      if (!groupedMap.has(item.customGroupId)) groupedMap.set(item.customGroupId, [])
      groupedMap.get(item.customGroupId)!.push(item)
    } else {
      ungrouped.push(item)
    }
  }

  for (const [groupId, items] of groupedMap) {
    const group = store.customGroups.find((g) => g.id === groupId)!
    entries.push({ key: 'group:' + groupId, isGroup: true, group, items })
  }

  for (const item of ungrouped) {
    entries.push({ key: 'item:' + item.id, isGroup: false, item })
  }

  if (store.sort === 'name') {
    entries.sort((a, b) => (a.isGroup ? a.group.name : a.item.name).localeCompare(b.isGroup ? b.group.name : b.item.name, 'zh'))
  } else {
    entries.sort((a, b) => {
      const timeA = a.isGroup ? Math.max(...a.items.map((i) => i.updatedAt)) : a.item.updatedAt
      const timeB = b.isGroup ? Math.max(...b.items.map((i) => i.updatedAt)) : b.item.updatedAt
      return timeB - timeA
    })
  }
  return entries
}

const sidebarGroups = computed(() =>
  store.customGroups.filter((g) => {
    if (g.submodule !== store.submodule) return false
    if (store.type && g.categoryId && g.categoryId !== store.type) return false
    return true
  })
)

const sections = computed(() => {
  const recent =
    store.submodule === 'reading' && atHome.value && !activeGroupId.value
      ? groupDocuments(rows.value, store.sort).recent
      : []
  const used = new Set(recent.map((i) => i.id))
  const names = new Map(store.customGroups.map((g) => [g.id, g.name]))
  return [
    ...(recent.length ? [{ key: 'recent', title: tr('最近在读'), items: recent }] : []),
    ...documentSections(rows.value.filter((i) => !used.has(i.id)), store.groupBy, names, ''),
  ]
})

function sectionKey(key: string) {
  return store.groupBy + ':' + key
}
function dismissMenu(event: MouseEvent) {
  if (!(event.target as Element).closest('.toolbar-menu')) menu.value = ''
}
watch(rows, (value) => {
  const visible = new Set(value.map((i) => i.id))
  checked.value = checked.value.filter((id) => visible.has(id))
})

const detailTrigger = ref<HTMLButtonElement>()
const assistant = ref<InstanceType<typeof DocumentAssistant>>()

function showDetails(id?: string) {
  if (id) store.selected = id
  assistant.value?.close(false)
  details.value = true
}

function closeDetails() {
  details.value = false
  detailTrigger.value?.focus()
}

function assistantOpened() {
  menu.value = ''
  details.value = false
}

function switchSubmodule(target: DocumentSubmodule) {
  checked.value = []
  details.value = false
  menu.value = ''
  activeGroupId.value = ''
  const currentScroll = main.value?.scrollTop || 0
  store.switchSubmodule(target, currentScroll)
  nextTick(() => {
    if (main.value) main.value.scrollTop = store.getSavedScroll(target)
  })
}

let revision = 0
async function detail() {
  const run = ++revision
  annotations.value = []
  backlinks.value = []
  if (!current.value) return
  try {
    const [a, b] = await Promise.all([
      workspace.documents.annotations(current.value.id),
      workspace.links.backlinks(current.value.id),
    ])
    if (run === revision) {
      annotations.value = a
      backlinks.value = b
    }
  } catch (e) {
    if (run === revision) error.value = errorMessage(e)
  }
}

watch(
  () => current.value?.id,
  () => void detail()
)

const unsubscribe = workspace.onChanged(() => {
  void detail()
  invalidateDocumentCovers()
})

onMounted(async () => {
  resumeDocumentCovers()
  await store.refresh()
  await nextTick()
  if (main.value) main.value.scrollTop = store.getSavedScroll(store.submodule)
})

onBeforeUnmount(() => {
  revision++
  unsubscribe()
  void pauseDocumentCovers()
  if (main.value) store.saveCurrentMemory(main.value.scrollTop)
})

async function run(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function scan(directory: boolean) {
  await run(async () => {
    menu.value = ''
    preview.value = await workspace.documents.prepareImport(directory, store.type)
  })
}

async function onImported(payload: { insightStatus: string; errors: string[] }) {
  preview.value = null
  await store.refresh()
  if (payload.errors.length) error.value = payload.errors.join('\n')
  insightImportMessage.value = payload.insightStatus
}

async function open(item: DocumentItem) {
  await pauseDocumentCovers()
  await router.push({
    path: '/document/' + item.id,
    query: { from: '/document' },
  })
}

function remove() {
  if (current.value) removing.value = true
}

function removed() {
  store.selected = ''
  void store.refresh()
}

const { dragging: dropActive, dropHandlers } = useFileDrop((paths) => {
  if (busy.value) return
  void run(async () => {
    const result = await workspace.documents.prepareImport(false, store.type, paths)
    if (result) preview.value = result
  })
}, { disabled: () => busy.value || !!preview.value })

function ownerPath(b: (typeof backlinks.value)[number]) {
  return b.ownerType === 'project'
    ? `/project/${b.ownerId}`
    : b.ownerType === 'event'
      ? `/project/${b.projectId}?event=${b.ownerId}`
      : `/personal?section=${b.ownerType}&record=${b.ownerId}`
}
</script>

<template>
  <main class="ws ws-layout document-home" v-on="dropHandlers" @click="dismissMenu" @keydown.esc="menu = ''">
    <DropZoneOverlay :active="dropActive" :title="$t('松开以导入到{p0}', {p0: currentTitle})" :hint="$t('支持拖入 PDF、EPUB、TXT、Markdown、Word 文档或整个资料文件夹')" />
    <DocumentSidebar
      :submodule="store.submodule"
      :favorite="store.favorite"
      :favorite-count="moduleRows.filter((i) => i.favorite).length"
      :current-categories="store.currentCategories"
      :items="store.items"
      :selected-type="store.type"
      :sidebar-groups="sidebarGroups"
      :active-group-id="activeGroupId"
      :current-category-name="currentCategoryName"
      :base-rows-count="baseRows.length"
      :tags="tags"
      :selected-tag="store.tag"
      :selected-state="store.state"
      @switch-submodule="switchSubmodule"
      @toggle-favorite="store.favorite = !store.favorite"
      @select-category="(id) => { store.type = id; store.customGroupId = ''; activeGroupId = '' }"
      @toggle-group="toggleGroupView"
      @manage-tags="categoryTagDialog = true"
      @clear-tag="store.tag = ''; store.state = ''"
      @toggle-tag="(t) => (store.tag = store.tag === t ? '' : t)"
    />

    <section ref="main" class="ws-main">
      <header class="document-compact-header">
        <div class="header-left">
          <h1>
            {{ currentTitle }} <small>{{ $t("{p0} 份", {p0: (rows.length)}) }}</small>
          </h1>
        </div>

        <div class="header-search">
          <Search :size="16" class="search-icon" />
          <input
            ref="searchInput"
            v-model="store.search"
            type="search"
            :aria-label="$t('搜索资料')"
            :placeholder="store.searchAll ? $t('搜索全库标题、作者或标签…') : $t('搜索当前{p0}…', {p0: currentTitle})"
          />
          <button
            type="button"
            class="scope-toggle"
            :class="{ active: store.searchAll }"
            :title="store.searchAll ? $t('当前：全库搜索（点击仅搜{p0}）', {p0: currentTitle}) : $t('当前：仅搜{p0}（点击切换全库）', {p0: currentTitle})"
            @click="store.searchAll = !store.searchAll"
          >
            {{ store.searchAll ? $t('全库') : $t('当前') }}
          </button>
        </div>

        <p v-if="insightImportMessage" class="ws-muted" role="status">{{ insightImportMessage }}</p>
        <div class="header-controls">
          <div class="ws-tabs view-switcher">
            <button type="button" :class="{ active: store.view === 'insights' }" :aria-label="$t('精要视图')" @click="store.view = 'insights'">{{ $t("精要") }}</button>
            <button type="button" :class="{ active: store.view === 'list' }" :aria-label="$t('列表视图')" @click="store.view = 'list'">
              <List :size="16" />
            </button>
            <button type="button" :class="{ active: store.view === 'grid' }" :aria-label="$t('网格视图')" @click="store.view = 'grid'">
              <Grid2X2 :size="16" />
            </button>
          </div>

          <div class="toolbar-menu" @keydown.esc.stop="menu = ''">
            <button
              type="button"
              class="ws-icon"
              :aria-label="$t('显示选项')"
              :aria-expanded="menu === 'display'"
              @click="menu = menu === 'display' ? '' : 'display'"
            >
              <SlidersHorizontal :size="17" />
            </button>
            <div v-if="menu === 'display'" class="toolbar-popover">
              <label>{{ $t("来源目录") }}<select v-model="store.sourceDir" :aria-label="$t('筛选来源目录')">
                  <option value="">{{ $t("全部来源") }}</option>
                  <option v-for="source in sources" :key="source" :value="source">{{ source }}</option>
                </select>
              </label>
              <label>{{ $t("排序") }}<select v-model="store.sort" :aria-label="$t('资料排序')">
                  <option value="updated">{{ $t("最近更新") }}</option>
                  <option value="read">{{ $t("最近阅读") }}</option>
                  <option value="name">{{ $t("按名称") }}</option>
                </select>
              </label>
              <label>{{ $t("分组") }}<select v-model="store.groupBy" :aria-label="$t('资料分组')">
                  <option value="none">{{ $t("不分组") }}</option>
                  <option value="category">{{ $t("按分类") }}</option>
                  <option value="source">{{ $t("按来源目录") }}</option>
                  <option value="custom">{{ $t("按自定义分组") }}</option>
                  <option value="tag">{{ $t("按标签") }}</option>
                </select>
              </label>
              <label>{{ $t("卡片大小") }}<input v-model.number="store.cardSize" :aria-label="$t('卡片大小')" type="range" min="150" max="260" step="10" />
              </label>
            </div>
          </div>

          <div class="toolbar-menu" @keydown.esc.stop="menu = ''">
            <button
              type="button"
              class="ws-button primary"
              :aria-label="$t('导入资料')"
              :aria-expanded="menu === 'import'"
              :disabled="busy"
              @click="assistant?.close(false); menu = menu === 'import' ? '' : 'import'"
            >
              <Plus :size="15" />{{ $t("导入") }}<ChevronDown :size="13" />
            </button>
            <div v-if="menu === 'import'" class="toolbar-popover import-options">
              <button type="button" class="ws-button" @click="scan(false)"><Plus :size="15" />{{ $t("选择文件") }}</button>
              <button type="button" class="ws-button" @click="scan(true)"><FolderSearch :size="15" />{{ $t("扫描文件夹") }}</button>
            </div>
          </div>

          <button type="button" class="ws-button" :class="{ active: bulk }" @click="bulk = !bulk; checked = []; menu = ''">
            {{ bulk ? $t('退出批量') : $t('批量管理') }}
          </button>

          <DocumentAssistant
            ref="assistant"
            :context="{ documentIds: store.selected ? [store.selected] : [] }"
            @opened="assistantOpened"
          />

          <button
            ref="detailTrigger"
            type="button"
            class="ws-icon"
            :aria-label="details ? $t('收起资料详情') : $t('展开资料详情')"
            :aria-expanded="details"
            @click="details ? closeDetails() : showDetails()"
          >
            <PanelRightClose v-if="details" :size="20" />
            <PanelRightOpen v-else :size="20" />
          </button>
        </div>
      </header>

      <div v-if="store.type || store.favorite || store.sourceDir || store.tag" class="active-filter-strip">
        <span v-if="store.type" class="ws-badge">{{ currentCategoryName }}</span>
        <span v-if="store.favorite" class="ws-badge">{{ $t("仅看收藏") }}</span>
        <span v-if="store.tag" class="ws-badge">{{ $t("标签：{p0}", {p0: (store.tag)}) }}</span>
        <span v-if="store.sourceDir" class="ws-badge">{{ $t("目录筛选") }}</span>
        <button type="button" class="ws-button ghost small" @click="store.resetFilters(); activeGroupId = ''">{{ $t("显示全部{p0}", {p0: (currentTitle)}) }}</button>
      </div>
      <p v-if="error || store.error" class="ws-error" role="alert">
        {{ error || store.error }}
      </p>

      <div v-if="!rows.length" class="ws-empty">
        <BookOpen v-if="store.submodule === 'reading'" :size="36" />
        <FileText v-else :size="36" />
        <h2>
          {{
            store.items.length
              ? $t('没有匹配的内容')
              : store.submodule === 'reading'
                ? $t('从一本好书开始')
                : $t('留存一份重要资料')
          }}
        </h2>
        <p>
          {{
            store.submodule === 'reading'
              ? $t('导入小说、书籍或论文。断网也能随时翻阅，书签与笔记永久留存。')
              : $t('导入证书、证件或档案文件。快速检索、预览与关联项目记录。')
          }}
        </p>
        <button type="button" class="ws-button primary" :disabled="busy" @click="scan(false)">{{ $t("选择导入文件") }}</button>
      </div>

      <div v-if="bulk" class="ws-toolbar bulk-selection">
        <label>
          <input
            type="checkbox"
            :aria-label="$t('全选当前资料')"
            :checked="rows.length > 0 && rows.every((i) => checked.includes(i.id))"
            @change="checked = ($event.target as HTMLInputElement).checked ? rows.map((i) => i.id) : []"
          />{{ $t("全选当前结果") }}</label>
        <span>{{ $t("已选 {p0} 份", {p0: (checked.length)}) }}</span>
      </div>
      <DocumentBulk
        v-if="bulk && checked.length"
        :items="store.items.filter((i) => checked.includes(i.id))"
        :categories="store.categories"
        :groups="store.customGroups"
        :available-tags="tags.map((t) => t.name)"
        @failure="error = $event"
        @updated="store.refresh"
        @removed="checked = []; store.refresh()"
      />

      <section v-if="activeGroupId && activeGroup" class="document-group-view">
        <div class="group-view-header">
          <button type="button" class="ws-button ghost group-back-btn" @click="exitGroup">
            <ChevronLeft :size="16" />{{ $t("返回{p0}", {p0: (currentCategoryName ? ' ' + currentCategoryName : store.submodule === 'reading' ? $t('阅读') : $t('资料'))}) }}
          </button>
          <div class="group-view-title-block">
            <h2>{{ activeGroup.name }}</h2>
            <span class="ws-badge count-badge">{{ $t("{p0} 份", {p0: (activeGroupItems.length)}) }}</span>
            <span v-if="activeGroupCategoryName" class="ws-badge category-badge">{{ activeGroupCategoryName }}</span>
          </div>
          <div class="group-view-actions">
            <button type="button" class="ws-button small" :disabled="busy" @click="renameGroup(activeGroup)">
              <Pencil :size="13" />{{ $t("重命名") }}</button>
            <button type="button" class="ws-button danger small" :disabled="busy" @click="dissolveGroup(activeGroup)">
              <Trash2 :size="13" />{{ $t("解散分组") }}</button>
          </div>
        </div>

        <div
          class="document-list"
          :class="{ 'document-grid': store.view === 'grid' }"
          :style="{ '--card-size': store.cardSize + 'px' }"
        >
          <DocumentRowItem
            v-for="item in activeGroupItems"
            :key="item.id"
            :item="item"
            :selected="store.selected === item.id"
            :view="store.view"
            :bulk="bulk"
            :checked="checked.includes(item.id)"
            :all-search="allSearch"
            :project-count="counts.get(item.id)"
            @toggle-check="toggleItemSelection(item.id)"
            @select="showDetails"
            @open="open"
          />
        </div>
      </section>

      <template v-else>
        <section v-for="section in sections" :key="section.key" class="document-section">
          <button
            v-if="section.title"
            type="button"
            class="document-section-heading"
            :aria-expanded="!store.collapsed.includes(sectionKey(section.key))"
            @click="store.toggleSection(sectionKey(section.key))"
          >
            <ChevronDown :size="15" :class="{ collapsed: store.collapsed.includes(sectionKey(section.key)) }" />
            {{ section.title }}
            <small>{{ section.items.length }}</small>
          </button>
          <div
            v-show="!section.title || !store.collapsed.includes(sectionKey(section.key))"
            class="document-list"
            :class="{ 'document-grid': store.view === 'grid' }"
            :style="{ '--card-size': store.cardSize + 'px' }"
          >
            <template v-for="entry in getSectionEntries(section)" :key="entry.key">
              <DocumentGroupCard
                v-if="entry.isGroup"
                :group="entry.group"
                :items="entry.items"
                :view="store.view === 'insights' ? 'list' : store.view"
                :category-name="store.categories.find((c) => c.id === entry.group.categoryId)?.name"
                :submodule="store.submodule"
                :bulk="bulk"
                :checked="entry.items.length > 0 && entry.items.every((i) => checked.includes(i.id))"
                @open="openGroup(entry.group.id)"
                @toggle-check="toggleGroupSelection(entry.items)"
              />
              <DocumentRowItem
                v-else
                :item="entry.item"
                :selected="store.selected === entry.item.id"
                :view="store.view"
                :bulk="bulk"
                :checked="checked.includes(entry.item.id)"
                :all-search="allSearch"
                :project-count="counts.get(entry.item.id)"
                :custom-groups="store.customGroups"
                show-group-badge
                @toggle-check="toggleItemSelection(entry.item.id)"
                @select="showDetails"
                @open="open"
              />
            </template>
          </div>
        </section>
      </template>
    </section>

    <aside
      v-if="details"
      class="document-inspector"
      :aria-label="$t('资料详情')"
      @keydown.esc.stop="closeDetails"
    >
      <button type="button" class="ws-icon inspector-close" :aria-label="$t('关闭资料详情')" @click="closeDetails">
        ×
      </button>

      <template v-if="current">
        <DocumentDetails
          :key="current.id"
          :item="current"
          :categories="store.categories"
          :groups="store.customGroups"
          @open="open(current)"
          @updated="store.refresh"
        />
        <p v-if="counts.get(current.id)" class="ws-muted">{{ $t("被 {p0} 个项目引用 · 书签 {p1} 个 · 摘录 {p2} 条", {p0: (counts.get(current.id)), p1: (annotations.filter((a) => a.kind === 'bookmark').length), p2: (annotations.filter((a) => a.kind === 'excerpt').length)}) }}</p>

        <section class="ws-links">
          <h3>{{ $t("用于这些事") }}</h3>
          <p v-if="!backlinks.length" class="ws-muted">{{ $t("尚未被项目或个人记录引用。") }}</p>
          <button
            v-for="b in backlinks"
            :key="b.ownerType + b.ownerId"
            type="button"
            class="document-backlink"
            @click="router.push(ownerPath(b))"
          >
            {{ b.name }}
            <span class="ws-muted">
              {{ b.ownerType === 'project' ? $t('项目') : b.ownerType === 'event' ? $t('项目记录') : $t('个人记录') }}
            </span>
          </button>
        </section>

        <button type="button" class="ws-button danger" :disabled="busy" @click="remove">{{ $t("移除资料索引") }}</button>
      </template>

      <div v-else class="ws-empty">
        <FileText :size="28" />
        <p>{{ $t("选择一份资料，查看详情与关联。") }}</p>
      </div>
    </aside>

    <DocumentRemove v-if="removing && current" :id="current.id" @close="removing = false" @removed="removed" />

    <DocumentImportDialog
      v-if="preview"
      :key="preview.token"
      :preview="preview"
      :categories="store.categories"
      :default-category="store.type"
      :submodule="store.submodule"
      @close="preview = null"
      @imported="onImported"
    />

    <DocumentTagDialog
      v-if="categoryTagDialog"
      :available-tags="tags.map((t) => t.name)"
      :category-id="store.type"
      :category-name="currentCategoryName"
      @close="categoryTagDialog = false"
      @updated="store.refresh"
    />
  </main>
</template>

<style scoped>
.active-filter-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.document-home {
  position: relative;
}
.bulk-selection label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.document-group-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.group-view-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--divider);
  border-radius: var(--radius-card);
}
.group-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  padding: 5px 8px;
}
.group-view-title-block {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.group-view-title-block h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-view-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.group-view-actions .small {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 4px 10px;
}
.document-compact-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--divider);
  flex-wrap: wrap;
}
.header-left h1 {
  font-size: 18px;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}
.header-left small {
  font-size: 13px;
  color: var(--text-sub);
  font-weight: normal;
}
.header-search {
  flex: 1;
  min-width: 150px;
  position: relative;
  display: flex;
  align-items: center;
}
.header-search .search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-faint);
  pointer-events: none;
}
.header-search input {
  width: 100%;
  padding: 6px 54px 6px 32px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--divider);
  font-size: 13px;
  background: var(--bg-card);
  color: var(--text-main);
}
.scope-toggle {
  position: absolute;
  right: 6px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  background: var(--hover-surface);
  color: var(--text-sub);
  cursor: pointer;
}
.scope-toggle.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.header-controls {
  flex-wrap: wrap;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.view-switcher {
  display: flex;
}
.document-section {
  margin-top: 20px;
}
.document-list {
  border-top: 1px solid var(--divider);
}
.document-grid {
  border: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--card-size, 190px)), 1fr));
  gap: 16px;
}
.document-inspector {
  position: relative;
  flex: 0 0 290px;
  padding: 30px 24px;
  overflow: auto;
  border-left: 1px solid var(--divider);
}
.inspector-close {
  position: absolute;
  right: 4px;
  top: 4px;
}
.document-backlink {
  display: block;
  text-align: left;
  padding: 10px 0;
  width: 100%;
  border-bottom: 1px solid var(--divider);
  color: var(--text-main);
}
.document-inspector > .danger {
  margin-top: 24px;
  font-size: 12px;
}
.toolbar-menu {
  position: relative;
}
.toolbar-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  width: 220px;
  padding: 14px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  background: var(--bg-card);
  box-shadow: var(--shadow-pop);
}
.toolbar-popover label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.toolbar-popover select {
  width: 100%;
}
.import-options {
  width: 160px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.document-section-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  margin-bottom: 12px;
  color: var(--text-main);
  font-weight: 600;
  font-size: 15px;
}
.document-section-heading small {
  color: var(--text-sub);
  font-weight: 400;
}
.document-section-heading .collapsed {
  transform: rotate(-90deg);
}
@media (max-width: 1100px) {
  .document-home .ws-main {
    padding: 22px 18px;
  }
  .document-inspector {
    position: absolute;
    z-index: 30;
    right: 0;
    top: 65px;
    bottom: 0;
    width: min(320px, 70%);
    padding: 25px 16px;
    background: var(--bg-main);
    box-shadow: -8px 0 24px rgb(0 0 0 / 0.12);
  }
}
@media (max-width: 860px) {
  .document-compact-header {
    position: sticky;
    top: -20px;
    z-index: 25;
    background: var(--bg-main);
    gap: 10px;
  }
  .document-home .document-inspector {
    top: 90px;
  }
  .document-home :deep(.document-assistant-panel) {
    top: 90px;
  }
  .header-search {
    flex-basis: 180px;
  }
  .header-controls {
    gap: 6px;
  }
}
</style>
