<script setup lang="ts">
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
  Star,
  SlidersHorizontal,
  ChevronDown,
  ChevronLeft,
  Pencil,
  Trash2,
  Tag,
} from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { workspace } from '@/utils/workspace-api'
import {
  type DocumentItem,
  type DocumentScan,
  type DocumentAnnotation,
  type DocumentSubmodule,
  type DocumentCustomGroup,
  type DocumentImportSuggestion,
} from '@/types/workspace'
import DocumentRemove from '@/components/workspace/DocumentRemove.vue'
import DocumentInsightSummary from '@/components/workspace/DocumentInsightSummary.vue'
import DocumentDetails from '@/components/workspace/DocumentDetails.vue'
import DocumentBulk from '@/components/workspace/DocumentBulk.vue'
import DocumentAssistant from '@/components/workspace/DocumentAssistant.vue'
import DocumentCover from '@/components/workspace/DocumentCover.vue'
import DocumentProgress from '@/components/workspace/DocumentProgress.vue'
import DocumentGroupCard from '@/components/workspace/DocumentGroupCard.vue'
import DocumentTagDialog from '@/components/workspace/DocumentTagDialog.vue'
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
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import '@/styles/workspace.css'

const store = useDocumentsStore(),
  router = useRouter(),
  details = ref(false),
  menu = ref<'' | 'import' | 'display'>(''),
  bulk = ref(false),
  checked = ref<string[]>([]),
  removing = ref(false),
  busy = ref(false),
  error = ref(''),
  main = ref<HTMLElement>()

const preview = ref<
  (DocumentScan & { token: string; categoryId: string }) | null
>(null),
  selectedPaths = ref<string[]>([]),
  importCategoryId = ref(''),
  importChoices = ref<Record<string, string>>({}),
  annotations = ref<DocumentAnnotation[]>([]),
  backlinks = ref<Awaited<ReturnType<typeof workspace.links.backlinks>>>([])

const agentImport = ref(false), analyzing = ref(false), analysisAttempted = ref(false), stopAnalysis = ref(false), analysisStatus = ref(''), suggestions = ref<Record<string, DocumentImportSuggestion>>({})
const insightImportMessage=ref('')
const current = computed(() => store.items.find((i) => i.id === store.selected))

const currentTitle = computed(() => {
  return store.submodule === 'reading' ? '阅读' : '资料'
})

const allSearch = computed(() => store.searchAll && !!store.search.trim())
const moduleRows = computed(() => store.items.filter(i => allSearch.value || i.submodule === store.submodule))
const sources = computed(() => [...new Set(moduleRows.value.map(i => i.sourceDir).filter(Boolean))] as string[])
const baseRows = computed(() => moduleRows.value.filter(i => {
  if (!allSearch.value && store.type && i.type !== store.type) return false
  if (!allSearch.value && store.customGroupId && i.customGroupId !== store.customGroupId) return false
  if (store.favorite && !i.favorite) return false
  if (store.sourceDir && i.sourceDir !== store.sourceDir) return false
  const query = store.search.trim().toLowerCase()
  return !query || [i.name, i.author, i.counterpart, i.notes, ...i.tags].join(' ').toLowerCase().includes(query)
}))
const tags = computed(() => tagCounts(baseRows.value))
const rows = computed(() => baseRows.value.filter(i =>
  (!store.tag || i.tags.includes(store.tag)) &&
  (!store.state || (i.submodule === 'reading' && i.readable && i.readState === store.state))
).sort((a, b) => store.sort === 'name' ? a.name.localeCompare(b.name, 'zh') : b.updatedAt - a.updatedAt))
const counts = computed(() => projectCounts(store.projectReferences))
const atHome = computed(() => !store.type && !store.tag && !store.state && !store.search.trim() && !store.customGroupId && !store.favorite && !store.sourceDir)
const activeGroupId = ref('')
const categoryTagDialog = ref(false)

const currentCategoryName = computed(() => {
  return store.categories.find(c => c.id === store.type)?.name || ''
})

const activeGroup = computed(() => store.customGroups.find(g => g.id === activeGroupId.value))
const activeGroupItems = computed(() => rows.value.filter(i => i.customGroupId === activeGroupId.value))
const activeGroupCategoryName = computed(() => {
  const catId = activeGroup.value?.categoryId || activeGroupItems.value[0]?.type
  return store.categories.find(c => c.id === catId)?.name || ''
})

function openGroup(groupId: string) {
  activeGroupId.value = groupId
}

function exitGroup() {
  activeGroupId.value = ''
}

function toggleGroupView(groupId: string) {
  if (activeGroupId.value === groupId) {
    exitGroup()
  } else {
    openGroup(groupId)
  }
}

async function renameGroup(group: DocumentCustomGroup) {
  const newName = prompt('请输入新分组名称：', group.name)
  if (!newName || newName.trim() === group.name) return
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
  if (!confirm(`确定要解散分组“${group.name}”吗？\n解散后，组内 ${activeGroupItems.value.length} 份资料将保留在原分类中。`)) return
  await run(async () => {
    await store.removeCustomGroup(group.id)
    activeGroupId.value = ''
    await store.refresh()
  })
}

function toggleGroupSelection(groupItems: DocumentItem[]) {
  const ids = groupItems.map(i => i.id)
  const allChecked = ids.every(id => checked.value.includes(id))
  if (allChecked) {
    checked.value = checked.value.filter(id => !ids.includes(id))
  } else {
    checked.value = [...new Set([...checked.value, ...ids])]
  }
}

type ShelfEntry =
  | { key: string; isGroup: true; group: DocumentCustomGroup; items: DocumentItem[] }
  | { key: string; isGroup: false; item: DocumentItem }

function getSectionEntries(section: (typeof sections.value)[number]): ShelfEntry[] {
  if (activeGroupId.value) return []
  if (store.groupBy !== 'none' || section.key === 'recent') {
    return section.items.map(item => ({ key: 'item:' + item.id, isGroup: false, item }))
  }

  const entries: ShelfEntry[] = []
  const groupedMap = new Map<string, DocumentItem[]>()
  const ungrouped: DocumentItem[] = []

  for (const item of section.items) {
    if (item.customGroupId && store.customGroups.some(g => g.id === item.customGroupId)) {
      if (!groupedMap.has(item.customGroupId)) groupedMap.set(item.customGroupId, [])
      groupedMap.get(item.customGroupId)!.push(item)
    } else {
      ungrouped.push(item)
    }
  }

  for (const [groupId, items] of groupedMap) {
    const group = store.customGroups.find(g => g.id === groupId)!
    entries.push({
      key: 'group:' + groupId,
      isGroup: true,
      group,
      items,
    })
  }

  for (const item of ungrouped) {
    entries.push({
      key: 'item:' + item.id,
      isGroup: false,
      item,
    })
  }

  if (store.sort === 'name') {
    entries.sort((a, b) => {
      const nameA = a.isGroup ? a.group!.name : a.item!.name
      const nameB = b.isGroup ? b.group!.name : b.item!.name
      return nameA.localeCompare(nameB, 'zh')
    })
  } else {
    entries.sort((a, b) => {
      const timeA = a.isGroup ? Math.max(...a.items!.map(i => i.updatedAt)) : a.item!.updatedAt
      const timeB = b.isGroup ? Math.max(...b.items!.map(i => i.updatedAt)) : b.item!.updatedAt
      return timeB - timeA
    })
  }

  return entries
}

const sidebarGroups = computed(() => {
  return store.customGroups.filter(g => {
    if (g.submodule !== store.submodule) return false
    if (store.type && g.categoryId && g.categoryId !== store.type) return false
    return true
  })
})

const sections = computed(() => {
  const recent = store.submodule === 'reading' && atHome.value && !activeGroupId.value ? groupDocuments(rows.value, store.sort).recent : []
  const used = new Set(recent.map(i => i.id))
  const names = new Map(store.customGroups.map(g => [g.id, g.name]))
  return [
    ...(recent.length ? [{ key: 'recent', title: '最近在读', items: recent }] : []),
    ...documentSections(rows.value.filter(i => !used.has(i.id)), store.groupBy, names, ''),
  ]
})
function sectionKey(key: string) { return store.groupBy + ':' + key }
function applyImportCategory() {
  for (const file of selectedPaths.value) importChoices.value[file] = importCategoryId.value
}
function dismissMenu(event: MouseEvent) { if (!(event.target as Element).closest('.toolbar-menu')) menu.value = '' }
watch(rows, value => { const visible = new Set(value.map(i => i.id)); checked.value = checked.value.filter(id => visible.has(id)) })
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
  checked.value = []; details.value = false; menu.value = ''; activeGroupId.value = ''
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
  () => void detail(),
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
    suggestions.value = {}; analysisStatus.value = ''; agentImport.value = false; analysisAttempted.value = false
    const category = store.type, fallback = store.submodule === 'reading' ? 'reading_other' : 'archive_other'
    preview.value = await workspace.documents.prepareImport(directory, category)
    importCategoryId.value = category || preview.value?.categoryId || fallback
    selectedPaths.value = preview.value?.items.filter(i => !i.existing).map(i => i.path) || []
    importChoices.value = Object.fromEntries((preview.value?.items || []).map(i => [i.path, category || preview.value?.categoryId || i.suggestedCategoryId || importCategoryId.value]))
  })
}

watch(selectedPaths, () => { analysisAttempted.value = false })
async function analyzeImport() {
  if (!preview.value || analyzing.value) return
  analyzing.value = true; stopAnalysis.value = false; error.value = ''
  const token = preview.value.token, paths = [...selectedPaths.value], failures:string[] = []
  try {
    for (const [index,path] of paths.entries()) {
      if (stopAnalysis.value) break
      analysisStatus.value = '正在识别 ' + (index+1) + ' / ' + paths.length
      try {
        const result = await workspace.documents.analyzeImport(token,path)
        if (preview.value?.token !== token) return
        suggestions.value[path] = result; importChoices.value[path] = result.categoryId
      } catch (e) { failures.push(path.split(/[\\/]/).pop() + '：' + errorMessage(e)) }
    }
    analysisStatus.value = '已识别 ' + Object.keys(suggestions.value).length + ' 份，可修改建议后导入。'
    error.value = failures.join('\n')
  } finally { analyzing.value = false; analysisAttempted.value = true }
}
async function importFiles() {
  if (!preview.value) return
  if (agentImport.value && !analysisAttempted.value) { await analyzeImport(); return }
  await run(async () => {
    const result = await workspace.documents.confirmImport(
      preview.value!.token,
      [...selectedPaths.value],
      '',
      undefined,
      undefined,
      selectedPaths.value.map(path => ({ path, categoryId: importChoices.value[path] || importCategoryId.value, ...(agentImport.value && suggestions.value[path] ? {name:suggestions.value[path].name,author:suggestions.value[path].author,tags:[...suggestions.value[path].tags]} : {}) })),
    )
    preview.value = null
    await store.refresh()
    if (result.errors.length) error.value = result.errors.join('\n')
    insightImportMessage.value=result.insightStatus||''
  })
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

function ownerPath(b: (typeof backlinks.value)[number]) {
  return b.ownerType === 'project'
    ? `/project/${b.ownerId}`
    : b.ownerType === 'event'
      ? `/project/${b.projectId}?event=${b.ownerId}`
      : `/personal?section=${b.ownerType}&record=${b.ownerId}`
}
</script>

<template>
  <main class="ws ws-layout document-home" @click="dismissMenu" @keydown.esc="menu = ''">
    <!-- Sidebar -->
    <aside class="ws-sidebar">
      <!-- Submodule Switcher -->
      <nav class="document-subnav" aria-label="子模块切换">
        <button
          :class="{ on: store.submodule === 'reading' }"
          @click="switchSubmodule('reading')"
        >
          <BookOpen :size="18" />阅读
        </button>
        <button
          :class="{ on: store.submodule === 'archive' }"
          @click="switchSubmodule('archive')"
        >
          <FileText :size="18" />资料
        </button>
      </nav>

      <button :class="{ active: store.favorite }" @click="store.favorite = !store.favorite"><Star :size="15" />收藏<span>{{ moduleRows.filter(i => i.favorite).length }}</span></button>
      <div class="sidebar-list">
        <button
          v-for="category in store.currentCategories"
          :key="category.id"
          :class="{ active: store.type === category.id }"
          @click="store.type = category.id; store.customGroupId = ''; activeGroupId = ''"
        >
          {{ category.name }}
          <span>{{ store.items.filter((i) => i.submodule === store.submodule && i.type === category.id).length }}</span>
        </button>
      </div>

      <!-- Custom Groups for Current Submodule / Category (if any) -->
      <details v-if="sidebarGroups.length > 0" open class="custom-group-filter">
        <hr />
        <summary>自定义分组</summary>
        <div class="sidebar-list">
          <button
            v-for="group in sidebarGroups"
            :key="group.id"
            :class="{ active: activeGroupId === group.id }"
            @click="toggleGroupView(group.id)"
          >
            {{ group.name }}
            <span>{{ store.items.filter((i) => i.customGroupId === group.id).length }}</span>
          </button>
        </div>
      </details>

      <hr />
      <!-- Tags -->
      <div class="sidebar-heading-row">
        <h2>标签</h2>
        <button
          v-if="store.type"
          type="button"
          class="ws-icon tag-manage-trigger"
          :title="`管理【${currentCategoryName}】分类标签`"
          :aria-label="`管理【${currentCategoryName}】分类标签`"
          @click="categoryTagDialog = true"
        >
          <Tag :size="13" />
        </button>
      </div>
      <div class="document-tags" aria-label="筛选资料标签">
        <button
          class="tag-pill"
          :class="{ active: !store.tag && !store.state }"
          :aria-pressed="!store.tag && !store.state"
          @click="store.tag = ''; store.state = ''"
        >
          全部标签<span>{{ baseRows.length }}</span>
        </button>
        <button
          v-for="tag in tags"
          :key="tag.name"
          class="tag-pill"
          :class="{ active: store.tag === tag.name }"
          :aria-pressed="store.tag === tag.name"
          :title="tag.name"
          @click="store.tag = store.tag === tag.name ? '' : tag.name"
        >
          {{ tag.name }}<span>{{ tag.count }}</span>
        </button>
      </div>


      <small>知止而后得</small>
    </aside>

    <!-- Main Content Area -->
    <section ref="main" class="ws-main">
      <!-- Compact Top Header Toolbar -->
      <header class="document-compact-header">
        <div class="header-left">
          <h1>
            {{ currentTitle }} <small>{{ rows.length }} 份</small>
          </h1>
        </div>

        <div class="header-search">
          <Search :size="16" class="search-icon" />
          <input
            v-model="store.search"
            type="search"
            aria-label="搜索资料"
            :placeholder="store.searchAll ? '搜索全库标题、作者或标签…' : `搜索当前${currentTitle}…`"
          />
          <button
            class="scope-toggle"
            :class="{ active: store.searchAll }"
            :title="store.searchAll ? '当前处于：全库搜索（点击切回当前子模块）' : '当前处于：本子模块搜索（点击切换全库搜索）'"
            @click="store.searchAll = !store.searchAll"
          >
            {{ store.searchAll ? '全库' : '当前' }}
          </button>
        </div>

        <p v-if="insightImportMessage" class="ws-muted" role="status">{{insightImportMessage}}</p>
        <div class="header-controls">
          <div class="ws-tabs view-switcher">
            <button :class="{active:store.view==='insights'}" aria-label="精要视图" @click="store.view='insights'">精要</button>
            <button
              :class="{ active: store.view === 'list' }"
              aria-label="列表视图"
              @click="store.view = 'list'"
            >
              <List :size="16" />
            </button>
            <button
              :class="{ active: store.view === 'grid' }"
              aria-label="网格视图"
              @click="store.view = 'grid'"
            >
              <Grid2X2 :size="16" />
            </button>
          </div>

          <div class="toolbar-menu" @keydown.esc.stop="menu = ''">
            <button class="ws-icon" aria-label="显示选项" :aria-expanded="menu === 'display'" @click="menu = menu === 'display' ? '' : 'display'"><SlidersHorizontal :size="17" /></button>
            <div v-if="menu === 'display'" class="toolbar-popover">
              <label>来源目录<select v-model="store.sourceDir" aria-label="筛选来源目录"><option value="">全部来源</option><option v-for="source in sources" :key="source" :value="source">{{ source }}</option></select></label>
              <label>排序<select v-model="store.sort" aria-label="资料排序"><option value="updated">最近更新</option><option value="name">按名称</option></select></label>
              <label>分组<select v-model="store.groupBy" aria-label="资料分组"><option value="none">不分组</option><option value="category">按分类</option><option value="source">按来源目录</option><option value="custom">按自定义分组</option><option value="tag">按标签</option></select></label>
              <label>卡片大小<input v-model.number="store.cardSize" aria-label="卡片大小" type="range" min="150" max="260" step="10" /></label>
            </div>
          </div>
          <div class="toolbar-menu" @keydown.esc.stop="menu = ''">
            <button class="ws-button primary" aria-label="导入资料" :aria-expanded="menu === 'import'" :disabled="busy" @click="assistant?.close(false); menu = menu === 'import' ? '' : 'import'"><Plus :size="15" />导入<ChevronDown :size="13" /></button>
            <div v-if="menu === 'import'" class="toolbar-popover import-options">
              <button class="ws-button" @click="scan(false)"><Plus :size="15" />选择文件</button>
              <button class="ws-button" @click="scan(true)"><FolderSearch :size="15" />扫描文件夹</button>
            </div>
          </div>

          <button class="ws-button" :class="{ active: bulk }" @click="bulk = !bulk; checked = []; menu = ''">{{ bulk ? '退出批量' : '批量管理' }}</button>

          <DocumentAssistant
            ref="assistant"
            :context="{ documentIds: store.selected ? [store.selected] : [] }"
            @opened="assistantOpened"
          />

          <button
            ref="detailTrigger"
            class="ws-icon"
            :aria-label="details ? '收起资料详情' : '展开资料详情'"
            :aria-expanded="details"
            @click="details ? closeDetails() : showDetails()"
          >
            <PanelRightClose v-if="details" :size="20" />
            <PanelRightOpen v-else :size="20" />
          </button>
        </div>
      </header>

      <p v-if="error || store.error" class="ws-error" role="alert">
        {{ error || store.error }}
      </p>

      <div v-if="!rows.length" class="ws-empty">
        <BookOpen v-if="store.submodule === 'reading'" :size="36" />
        <FileText v-else :size="36" />
        <h2>
          {{
            store.items.length
              ? '没有匹配的内容'
              : store.submodule === 'reading'
                ? '从一本好书开始'
                : '留存一份重要资料'
          }}
        </h2>
        <p>
          {{
            store.submodule === 'reading'
              ? '导入小说、书籍或论文。断网也能随时翻阅，书签与笔记永久留存。'
              : '导入证书、证件或档案文件。快速检索、预览与关联项目记录。'
          }}
        </p>
        <button class="ws-button primary" :disabled="busy" @click="scan(false)">
          选择导入文件
        </button>
      </div>

      <div v-if="bulk" class="ws-toolbar bulk-selection"><label><input type="checkbox" aria-label="全选当前资料" :checked="rows.length > 0 && rows.every(i => checked.includes(i.id))" @change="checked = ($event.target as HTMLInputElement).checked ? rows.map(i => i.id) : []"/>全选当前结果</label><span>已选 {{ checked.length }} 份</span></div>
      <DocumentBulk
        v-if="bulk && checked.length"
        :items="store.items.filter(i => checked.includes(i.id))"
        :categories="store.categories"
        :groups="store.customGroups"
        :available-tags="tags.map(t => t.name)"
        @failure="error = $event"
        @updated="store.refresh"
        @removed="checked = []; store.refresh()"
      />

      <!-- Group View (when activeGroupId is set) -->
      <section v-if="activeGroupId && activeGroup" class="document-group-view">
        <div class="group-view-header">
          <button class="ws-button ghost group-back-btn" @click="exitGroup">
            <ChevronLeft :size="16" /> 返回{{ currentCategoryName ? ' ' + currentCategoryName : (store.submodule === 'reading' ? '阅读' : '资料') }}
          </button>
          <div class="group-view-title-block">
            <h2>{{ activeGroup.name }}</h2>
            <span class="ws-badge count-badge">{{ activeGroupItems.length }} 份</span>
            <span v-if="activeGroupCategoryName" class="ws-badge category-badge">{{ activeGroupCategoryName }}</span>
          </div>
          <div class="group-view-actions">
            <button class="ws-button small" :disabled="busy" @click="renameGroup(activeGroup)"><Pencil :size="13" /> 重命名</button>
            <button class="ws-button danger small" :disabled="busy" @click="dissolveGroup(activeGroup)"><Trash2 :size="13" /> 解散分组</button>
          </div>
        </div>

        <div
          class="document-list"
          :class="{ 'document-grid': store.view === 'grid' }"
          :style="{ '--card-size': store.cardSize + 'px' }"
        >
          <article
            v-for="item in activeGroupItems"
            :key="item.id"
            class="document-row"
            :class="{ selected: store.selected === item.id }"
            tabindex="0"
            :aria-label="item.name"
            @click="bulk ? (checked.includes(item.id) ? checked = checked.filter(id => id !== item.id) : checked.push(item.id)) : showDetails(item.id)"
            @dblclick="open(item)"
            @keydown.enter.self="open(item)"
            @keydown.space.prevent.self="showDetails(item.id)"
          >
            <input v-if="bulk" v-model="checked" type="checkbox" :value="item.id" :aria-label="'选择资料 ' + item.name" @click.stop />
            <DocumentCover
              :item="item"
              :size="store.view === 'grid' ? 'grid' : 'list'"
            />
            <div class="document-row-info">
              <strong>
                {{ item.name }}
                <span class="ws-badge">{{ item.typeName }}</span>
                <span v-if="allSearch" class="ws-badge">{{ item.submodule === 'reading' ? '阅读' : '资料' }}</span>
              </strong>
              <small>
                {{
                  item.submodule === 'reading'
                    ? item.author || item.typeName
                    : item.counterpart || item.typeName
                }}
                <template v-if="item.expiresOn">
                  · 有效期至 {{ item.expiresOn }}
                </template>
              </small>
              <span
                v-if="item.tags.length"
                class="row-tags ws-muted"
                :title="item.tags.join(' · ')"
              >
                {{ item.tags.join(' · ') }}
              </span>
              <DocumentInsightSummary :item="item" :expanded="store.view==='insights'" :disabled="bulk" @open="showDetails(item.id)"/>
            </div>
            <div class="document-row-state">
              <DocumentProgress
                v-if="item.submodule === 'reading'"
                :item="item"
              />
              <span v-if="counts.get(item.id)" class="ws-badge project-count">
                被 {{ counts.get(item.id) }} 个项目引用
              </span>
              <small v-if="!item.available">文件暂不可用</small>
            </div>
            <button
              class="ws-icon row-open"
              :aria-label="(item.submodule === 'reading' ? '阅读 ' : '查看 ') + item.name"
              @click.stop="open(item)"
            >
              ›
            </button>
          </article>
        </div>
      </section>

      <!-- Section lists (Shelf view) -->
      <template v-else>
        <section
          v-for="section in sections"
          :key="section.key"
          class="document-section"
        >
          <button
            v-if="section.title"
            class="document-section-heading"
            :aria-expanded="!store.collapsed.includes(sectionKey(section.key))"
            @click="store.toggleSection(sectionKey(section.key))"
          >
            <ChevronDown :size="15" :class="{ collapsed: store.collapsed.includes(sectionKey(section.key)) }" />{{ section.title }}<small>{{ section.items.length }}</small>
          </button>
          <div
            v-show="!section.title || !store.collapsed.includes(sectionKey(section.key))"
            class="document-list"
            :class="{ 'document-grid': store.view === 'grid' }"
            :style="{ '--card-size': store.cardSize + 'px' }"
          >
            <template v-for="entry in getSectionEntries(section)" :key="entry.key">
              <!-- Group Card -->
              <DocumentGroupCard
                v-if="entry.isGroup"
                :group="entry.group"
                :items="entry.items"
                :view="store.view==='insights'?'list':store.view"
                :category-name="store.categories.find(c => c.id === entry.group.categoryId)?.name"
                :submodule="store.submodule"
                :bulk="bulk"
                :checked="entry.items.length > 0 && entry.items.every(i => checked.includes(i.id))"
                @open="openGroup(entry.group.id)"
                @toggle-check="toggleGroupSelection(entry.items)"
              />

              <!-- Single Document Row -->
              <article
                v-else
                class="document-row"
                :class="{ selected: store.selected === entry.item.id }"
                tabindex="0"
                :aria-label="entry.item.name"
                @click="bulk ? (checked.includes(entry.item.id) ? checked = checked.filter(id => id !== entry.item.id) : checked.push(entry.item.id)) : showDetails(entry.item.id)"
                @dblclick="open(entry.item)"
                @keydown.enter.self="open(entry.item)"
                @keydown.space.prevent.self="showDetails(entry.item.id)"
              >
                <input v-if="bulk" v-model="checked" type="checkbox" :value="entry.item.id" :aria-label="'选择资料 ' + entry.item.name" @click.stop />
                <DocumentCover
                  :item="entry.item"
                  :size="store.view === 'grid' ? 'grid' : 'list'"
                />
                <div class="document-row-info">
                  <strong>
                    {{ entry.item.name }}
                    <span class="ws-badge">{{ entry.item.typeName }}</span>
                    <span v-if="allSearch" class="ws-badge">{{ entry.item.submodule === 'reading' ? '阅读' : '资料' }}</span>
                    <span v-if="entry.item.customGroupId" class="ws-badge group-badge">
                      {{ store.customGroups.find((g) => g.id === entry.item.customGroupId)?.name }}
                    </span>
                  </strong>
                  <small>
                    {{
                      entry.item.submodule === 'reading'
                        ? entry.item.author || entry.item.typeName
                        : entry.item.counterpart || entry.item.typeName
                    }}
                    <template v-if="entry.item.expiresOn">
                      · 有效期至 {{ entry.item.expiresOn }}
                    </template>
                  </small>
                  <span
                    v-if="entry.item.tags.length"
                    class="row-tags ws-muted"
                    :title="entry.item.tags.join(' · ')"
                  >
                    {{ entry.item.tags.join(' · ') }}
                  </span>
                  <DocumentInsightSummary :item="entry.item" :expanded="store.view==='insights'" :disabled="bulk" @open="showDetails(entry.item.id)"/>
                </div>
                <div class="document-row-state">
                  <DocumentProgress
                    v-if="entry.item.submodule === 'reading'"
                    :item="entry.item"
                  />
                  <span v-if="counts.get(entry.item.id)" class="ws-badge project-count">
                    被 {{ counts.get(entry.item.id) }} 个项目引用
                  </span>
                  <small v-if="!entry.item.available">文件暂不可用</small>
                </div>
                <button
                  class="ws-icon row-open"
                  :aria-label="(entry.item.submodule === 'reading' ? '阅读 ' : '查看 ') + entry.item.name"
                  @click.stop="open(entry.item)"
                >
                  ›
                </button>
              </article>
            </template>
          </div>
        </section>
      </template>
    </section>

    <!-- Detail Inspector -->
    <aside
      v-if="details"
      class="document-inspector"
      aria-label="资料详情"
      @keydown.esc.stop="closeDetails"
    >
      <button
        class="ws-icon inspector-close"
        aria-label="关闭资料详情"
        @click="closeDetails"
      >
        ×
      </button>

      <template v-if="current">
        <DocumentDetails :key="current.id" :item="current" :categories="store.categories" :groups="store.customGroups" @open="open(current)" @updated="store.refresh"/>
        <p v-if="counts.get(current.id)" class="ws-muted">被 {{counts.get(current.id)}} 个项目引用 · 书签 {{annotations.filter(a=>a.kind==='bookmark').length}} 个 · 摘录 {{annotations.filter(a=>a.kind==='excerpt').length}} 条</p>

        <!-- Backlinks section -->
        <section class="ws-links">
          <h3>用于这些事</h3>
          <p v-if="!backlinks.length" class="ws-muted">
            尚未被项目或个人记录引用。
          </p>
          <button
            v-for="b in backlinks"
            :key="b.ownerType + b.ownerId"
            class="document-backlink"
            @click="router.push(ownerPath(b))"
          >
            {{ b.name }}
            <span class="ws-muted">
              {{
                b.ownerType === 'project'
                  ? '项目'
                  : b.ownerType === 'event'
                    ? '项目记录'
                    : '个人记录'
              }}
            </span>
          </button>
        </section>

        <button class="ws-button danger" :disabled="busy" @click="remove">
          移除资料索引
        </button>
      </template>

      <div v-else class="ws-empty">
        <FileText :size="28" />
        <p>选择一份资料，查看详情与关联。</p>
      </div>
    </aside>

    <!-- Modals -->
    <DocumentRemove
      v-if="removing && current"
      :id="current.id"
      @close="removing = false"
      @removed="removed"
    />

    <!-- Import Dialog -->
    <ProjectDialog
      v-if="preview"
      title="导入资料预览"
      wide
      :busy="busy || analyzing"
      @close="preview = null"
    >
      <div class="ws">
        <p class="ws-muted">
          已找到 {{ preview.items.length }} 份资料，已登记的文件会跳过。
        </p>
        <p v-for="warning in preview.warnings" :key="warning" class="ws-notice">
          {{ warning }}
        </p>
        <p v-if="error" class="ws-error">{{ error }}</p>

        <p class="ws-notice">请确认每份资料的分类，也可选择当前模块的“其他”。</p>
        <div class="import-agent-options">
          <label><input v-model="agentImport" type="checkbox" :disabled="busy || analyzing"/>Agent 辅助识别分类、作者和标签</label>
          <template v-if="agentImport">
            <button class="ws-button" :disabled="busy || analyzing || !selectedPaths.length" @click="analyzeImport">{{Object.keys(suggestions).length ? '重新识别' : '识别所选'}}</button>
            <button v-if="analyzing" class="ws-button" @click="stopAnalysis = true">{{stopAnalysis ? '当前文件结束后停止' : '停止后续识别'}}</button>
            <p class="ws-muted">使用资料模块配置的模型；识别结果可修改后注册。识别失败时仍可手动导入。</p>
            <p v-if="analysisStatus" role="status">{{analysisStatus}}</p>
          </template>
        </div>
        <div class="import-batch">
          <select v-model="importCategoryId" aria-label="批量导入分类">

            <optgroup v-for="sub in (['reading', 'archive'] as const)" :key="sub" :label="sub === 'reading' ? '阅读' : '资料'">
              <option v-for="cat in store.categories.filter(c => c.submodule === sub)" :key="cat.id" :value="cat.id">{{ cat.name }}</option>
            </optgroup>
          </select>
          <button class="ws-button" @click="applyImportCategory">应用到所选</button>
        </div>

        <div class="document-import">
          <div v-for="candidate in preview.items" :key="candidate.path" class="import-candidate">
            <input
              v-model="selectedPaths"
              type="checkbox"
              :value="candidate.path"
              :disabled="candidate.existing || busy || analyzing"
              :aria-label="'导入 ' + candidate.name"
            />
            <span>
              <strong>{{ candidate.name }}</strong>
              <small>{{ candidate.existing ? '已登记' : '' }}</small>
              <span
                v-if="candidate.suggestedSubmodule"
                class="ws-badge suggestion-badge"
              >
                推测：{{ candidate.suggestedSubmodule === 'archive' ? '资料' : '阅读' }}
                {{ candidate.suggestedReason ? `· ${candidate.suggestedReason}` : '' }}
              </span>
              <span class="ws-path">{{ candidate.path }}</span>
              <div v-if="agentImport && suggestions[candidate.path]" class="import-metadata">
                <label>标题<input v-model="suggestions[candidate.path].name" :aria-label="'识别标题 '+candidate.name" :disabled="busy || analyzing"/></label>
                <label>作者<input v-model="suggestions[candidate.path].author" :aria-label="'识别作者 '+candidate.name" :disabled="busy || analyzing"/></label>
                <label>标签<input :value="suggestions[candidate.path].tags.join('，')" :aria-label="'识别标签 '+candidate.name" :disabled="busy || analyzing" @change="suggestions[candidate.path].tags=($event.target as HTMLInputElement).value.split(/[,，;；]/).map(t=>t.trim()).filter(Boolean)"/></label>
                <small>{{suggestions[candidate.path].reason}}</small>
              </div>
            </span>
            <select v-model="importChoices[candidate.path]" :aria-label="'归类 ' + candidate.name" :disabled="candidate.existing || busy">

              <optgroup v-for="sub in (['reading', 'archive'] as const)" :key="sub" :label="sub === 'reading' ? '阅读' : '资料'">
                <option v-for="cat in store.categories.filter(c => c.submodule === sub)" :key="cat.id" :value="cat.id">{{ cat.name }}</option>
              </optgroup>
            </select>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="ws">
          <button
            class="ws-button primary"
            :disabled="busy || analyzing || !selectedPaths.length"
            @click="importFiles"
          >
            {{agentImport && !analysisAttempted ? '识别并预览所选' : '导入所选'}} {{ selectedPaths.length }} 份资料
          </button>
        </div>
      </template>
    </ProjectDialog>

    <!-- Category Tag Management Dialog -->
    <DocumentTagDialog
      v-if="categoryTagDialog"
      :available-tags="tags.map(t => t.name)"
      :category-id="store.type"
      :category-name="currentCategoryName"
      @close="categoryTagDialog = false"
      @updated="store.refresh"
    />
  </main>
</template>

<style scoped>
.import-agent-options{padding:12px 0}.import-agent-options>label{display:flex;align-items:center;gap:6px;margin-bottom:8px}.import-metadata{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}.import-metadata label{display:flex;flex-direction:column;min-width:0;gap:4px}.import-metadata label:first-child,.import-metadata small{grid-column:1/-1}.bulk-selection label{display:flex;align-items:center;gap:5px}
.document-home {
  position: relative;
}
.document-home .ws-sidebar > * { flex-shrink: 0; }
.document-home .ws-sidebar h2 { font-size: 13px; margin: 10px 12px; }
.sidebar-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 10px 12px 6px;
}
.sidebar-heading-row h2 {
  margin: 0 !important;
}
.tag-manage-trigger {
  padding: 3px;
  color: var(--text-muted);
  border-radius: 4px;
}
.tag-manage-trigger:hover {
  color: var(--accent);
  background: var(--bg-hover);
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
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
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
  font-weight: 650;
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
.document-home .header-search input { padding-left: 32px; padding-right: 54px; }
.document-home .document-subnav button { padding: 7px 4px; gap: 4px; white-space: nowrap; }

/* Sidebar Submodule Switcher */
.document-subnav {
  display: flex;
  gap: 6px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  padding: 4px;
  border-radius: 8px;
  margin-bottom: 14px;
}

.document-subnav button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.document-subnav button.on {
  background: var(--bg-card, #fff);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.sidebar-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pending-pill {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.ws-badge.warning {
  background: #f59e0b;
  color: #fff;
}

.ws-badge.group-badge {
  background: var(--bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--text-muted);
  font-size: 11px;
}

/* Compact Header */
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
}

.header-left small {
  font-size: 13px;
  color: var(--text-muted);
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
  color: var(--text-muted);
  pointer-events: none;
}

.header-search input {
  width: 100%;
  padding: 6px 54px 6px 32px;
  border-radius: 6px;
  border: 1px solid var(--divider);
  font-size: 13px;
  background: var(--bg-card, transparent);
  color: var(--text);
}

.scope-toggle {
  position: absolute;
  right: 6px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  background: var(--bg-hover, transparent);
  color: var(--text-muted);
  cursor: pointer;
}

.scope-toggle.active {
  background: var(--primary, #3b82f6);
  color: #fff;
  border-color: var(--primary, #3b82f6);
}

.header-controls {
  flex-wrap: wrap;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-select {
  font-size: 13px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--divider);
  background: var(--bg-card, transparent);
  color: var(--text);
}

.view-switcher {
  display: flex;
}

@media (max-width: 860px) {
  .document-compact-header {
    position: sticky;
    top: -20px;
    z-index: 25;
    background: var(--bg-main);
  }
  .document-home .document-inspector {
    top: 90px;
  }
  .document-home :deep(.document-assistant-panel) {
    top: 90px;
  }
}

.document-section {
  margin-top: 20px;
}

.document-section h2 {
  font-size: 15px;
  margin-bottom: 10px;
}

.document-list {
  border-top: 1px solid var(--divider);
}

.document-row {
  display: flex;
  gap: 15px;
  align-items: center;
  text-align: left;
  width: 100%;
  padding: 12px 10px;
  border-bottom: 1px solid var(--divider);
  color: var(--text-main);
  cursor: pointer;
}

.document-row:hover,
.document-row.selected {
  background: var(--ws-tint);
}

.document-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.document-row-info {
  flex: 1;
  min-width: 0;
}

.document-row strong {
  display: block;
  overflow-wrap: anywhere;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.6;
}

.document-row strong .ws-badge {
  vertical-align: middle;
  margin-left: 5px;
}

.document-row-info small,
.document-row-state > small {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-sub);
}

.row-tags {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin-top: 4px;
  font-size: 11px;
}

.document-row-state {
  flex: 0 0 150px;
  min-width: 0;
}

.project-count {
  margin-top: 7px;
  color: var(--accent);
}

.row-open {
  font-size: 24px;
  width: 22px;
}

.document-grid {
  border: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--card-size, 190px)), 1fr));
  gap: 16px;
}

.document-grid .document-row {
  position: relative;
  align-items: stretch;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 16px;
}

.document-grid .document-row-info {
  width: 100%;
}

.document-grid .document-row-state {
  flex: none;
  width: 100%;
  margin-top: auto;
}

.document-grid .row-open {
  position: absolute;
  right: 6px;
  top: 5px;
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

.document-inspector h2 {
  overflow-wrap: anywhere;
  font-size: 20px;
  line-height: 1.6;
  margin-top: 20px;
}

.document-open {
  width: 100%;
  margin-top: 15px;
}

.archive-dates {
  margin-top: 10px;
  font-size: 13px;
}

.archive-dates p {
  margin: 4px 0;
}

.inspector-actions {
  margin-top: 15px;
  flex-wrap: wrap;
}

.group-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  font-size: 13px;
}

.group-select-row select {
  flex: 1;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  background: var(--bg-card, transparent);
  font-size: 12px;
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

.document-tags {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-height: 260px;
  overflow: auto;
}

.document-tags .tag-pill {
  max-width: 100%;
  border: 1px solid var(--divider);
  border-radius: 18px;
  padding: 5px 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: normal;
}

.tag-pill span {
  flex: none;
  padding-left: 5px;
}

.document-import {
  max-height: 50vh;
  overflow: auto;
  margin-top: 12px;
}

.document-import .import-candidate {
  display: flex;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--divider);
}

.document-import .ws-path {
  display: block;
}

.document-import input {
  flex: none;
}

.document-import small {
  color: var(--accent);
}

.suggestion-badge {
  display: inline-block;
  margin-left: 6px;
  font-size: 11px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--accent);
}

@media (max-width: 1100px) {
  .document-inspector {
    flex-basis: 240px;
    padding: 25px 16px;
  }
  .document-row-state {
    flex-basis: 120px;
  }
  .document-row {
    gap: 9px;
    padding: 14px 5px;
  }
  .document-home .ws-main {
    padding: 22px 18px;
  }
  .document-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--card-size, 190px)), 1fr));
  }
}

@media (max-width: 860px) {
  .document-inspector {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    background: var(--bg-main);
  }
}

.toolbar-menu { position: relative; }
.toolbar-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; width: 220px; padding: 14px; border: 1px solid var(--divider); border-radius: 8px; background: var(--bg-card); box-shadow: 0 8px 24px #0002; }
.toolbar-popover label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.toolbar-popover select { width: 100%; }
.import-options { width: 160px; display: flex; flex-direction: column; gap: 8px; }
.document-section-heading { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; margin-bottom: 12px; color: var(--text-main); font-weight: 600; font-size: 15px; }
.document-section-heading small { color: var(--text-sub); font-weight: 400; }
.document-section-heading .collapsed { transform: rotate(-90deg); }
.source-filter summary, .custom-group-filter summary { cursor: pointer; color: var(--text-sub); padding: 8px 12px; font-size: 13px; }
.source-filter button { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.import-batch { display: flex; flex-wrap: wrap; gap: 10px; }
.import-candidate { align-items: center; }
.import-candidate > span { flex: 1; min-width: 0; }
.import-candidate select { max-width: 200px; }
.document-tags { flex-direction: row; flex-wrap: wrap; }
.document-compact-header h1 { font-size: 18px; white-space: nowrap; }
@media (max-width: 1100px) {
  .document-inspector { position: absolute; z-index: 30; right: 0; top: 65px; bottom: 0; width: min(320px, 70%); background: var(--bg-main); box-shadow: -8px 0 24px #0001; }
}
@media (max-width: 860px) {
  .document-row-state { flex-basis: 90px; }
  .document-compact-header { gap: 10px; }
  .header-search { flex-basis: 180px; }
  .header-controls { gap: 6px; }
  .import-candidate { flex-wrap: wrap; }
}
</style>
