<script setup lang="ts">
import {computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { FolderKanban, Plus, Search, Pin, ArrowUpRight, FolderOpen, Settings2, History, Code2, BookOpen, Wrench, RefreshCw } from 'lucide-vue-next'
import { useProjectStore } from '@/stores/project'
import { useToast } from '@/composables/useToast'
import { rememberScroll, recallScroll } from '@/composables/useModules'
import { useLibrarySelection } from '@/composables/useLibrarySelection'
import { type ProjectItem, type ProjectMoveRecord } from '@/types/project'
import LibraryBulkPanel from '@/components/library/LibraryBulkPanel.vue'
import ProjectImport from '@/components/project/ProjectImport.vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import '@/styles/project.css'

const store = useProjectStore(), router = useRouter(), { error: toastError, success } = useToast()
const importer = ref(false), history = ref(false), records = ref<ProjectMoveRecord[]>([]), busy = ref(false), bulkBusy = ref(false)
const scroll = ref<HTMLElement>(), searchInput = ref<HTMLInputElement>()
const selection = useLibrarySelection(() => store.shown, () => bulkBusy.value)
const { selecting, selectedIds } = selection
const bulkTrigger = ref<HTMLButtonElement>()
watch(selecting, async active => { if (!active) { await nextTick(); bulkTrigger.value?.focus() } })
const sourceNames: Record<string, string> = { self: '自己建立', 'third-party': '第三方', mixed: '混合来源', unknown: '来源未标记' }
const stateNames: Record<string, string> = { active: '使用中', maintaining: '维护中', paused: '已暂停', archived: '已归档' }
const heading = computed(() => store.pinned ? '置顶项目' : store.group || store.category || '全部项目')
const filtered = computed(() => !!(store.search.trim() || store.category || store.group || store.source || store.state || store.pinned))
const icon = (category: string) => category === '软件项目' ? Code2 : category === '调研写作' ? BookOpen : category === '资料处理' ? Wrench : FolderKanban
function clearFilters() { store.search = ''; store.category = ''; store.group = ''; store.source = ''; store.state = ''; store.pinned = false }
function detail(item: ProjectItem) { if (selecting.value) { if (!store.loading && !store.error) selection.toggle(item.id) } else void router.push('/project/' + item.id) }
async function bulkCompleted(failedIds: string[]) { selectedIds.value = new Set(failedIds); await store.refresh() }
async function open(item: ProjectItem) { try { await window.baoyi.project.open(item.id) } catch (e) { toastError((e as Error).message) } }
async function pin(item: ProjectItem) { try { await window.baoyi.project.update(item.id, { pinned: !item.pinned }); await store.refresh() } catch (e) { toastError((e as Error).message) } }
async function showHistory() { try { records.value = await window.baoyi.project.moveRecords(); history.value = true } catch (e) { toastError((e as Error).message) } }
async function recover(id: string) { busy.value = true; try { success(await window.baoyi.project.recoverMove(id)); records.value = await window.baoyi.project.moveRecords(); await store.refresh() } catch (e) { toastError((e as Error).message) } finally { busy.value = false } }
function key(event: KeyboardEvent) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !importer.value && !history.value) { event.preventDefault(); searchInput.value?.focus() } }
onMounted(async () => { document.addEventListener('keydown', key); await store.refresh(); await nextTick(); if (scroll.value) scroll.value.scrollTop = recallScroll('project') })
onBeforeUnmount(() => { document.removeEventListener('keydown', key); rememberScroll('project', scroll.value?.scrollTop || 0) })
</script>

<template>
  <div class="pj-home" @keydown="selection.key">
    <aside class="pj-sidebar">
      <div class="pj-sidebar-heading"><FolderKanban :size="20" /><span>项目</span></div>
      <nav aria-label="项目筛选">
        <button :class="{ active: !store.category && !store.pinned && !store.group }" @click="store.category = ''; store.pinned = false; store.group = ''"><FolderOpen :size="17" />全部项目<span>{{ store.items.length }}</span></button>
        <button :class="{ active: store.pinned }" @click="store.pinned = !store.pinned; store.category = ''; store.group = ''"><Pin :size="17" />置顶项目</button>
      </nav>
      <h3>项目类型</h3>
      <nav><button v-for="c in store.categories" :key="c" :class="{ active: store.category === c }" @click="store.category = store.category === c ? '' : c; store.pinned = false; store.group = ''"><component :is="icon(c)" :size="16" />{{ c }}<span>{{ store.items.filter(i => i.category === c).length }}</span></button></nav>
      <template v-if="store.groups.length"><h3>我的分组</h3><nav><button v-for="g in store.groups" :key="g" :class="{ active: store.group === g }" @click="store.group = store.group === g ? '' : g; store.category = ''; store.pinned = false"><span class="pj-dot" />{{ g }}</button></nav></template>
      <div class="pj-sidebar-bottom"><button @click="showHistory"><History :size="17" />移动记录</button><button @click="router.push('/settings')"><Settings2 :size="17" />设置</button></div>
    </aside>
    <main ref="scroll" class="pj-content">
      <header class="pj-page-header"><div><h1>{{ heading }}<small>{{ store.shown.length }} 个项目</small></h1></div><button class="pj-button pj-primary" :disabled="bulkBusy" @click="importer = true"><Plus :size="18" />添加项目</button></header>
      <div class="pj-toolbar">
        <label class="pj-search"><Search :size="18" /><input ref="searchInput" v-model="store.search" placeholder="搜索项目、标签或位置…" aria-label="搜索项目" /><kbd>Ctrl K</kbd></label>
        <select v-model="store.source" aria-label="筛选项目来源"><option value="">全部来源</option><option v-for="(label, value) in sourceNames" :key="value" :value="value">{{ label }}</option></select>
        <select v-model="store.state" aria-label="筛选项目状态"><option value="">全部状态</option><option v-for="(label, value) in stateNames" :key="value" :value="value">{{ label }}</option></select>
        <select v-model="store.sort" aria-label="项目排序"><option value="recent">最近打开</option><option value="updated">最近更新</option><option value="name">按名称</option></select>
        <button class="pj-icon" aria-label="刷新项目" :disabled="store.loading || bulkBusy" @click="store.refresh"><RefreshCw :size="17" /></button>
        <button ref="bulkTrigger" v-if="!selecting" class="pj-button" :disabled="!store.shown.length || store.loading" @click="selection.toggleMode">批量管理</button>
      </div>
      <p v-if="store.error" class="pj-error" role="alert">{{ store.error }} <button class="pj-button" @click="store.refresh">重试</button></p>

      <LibraryBulkPanel v-if="selecting" kind="project" :pending="store.loading || !!store.error" @refresh="store.refresh" :items="store.shown" :ids="[...selectedIds]" :categories="store.categories" @all="selection.selectAll" @clear="selection.clear" @close="selection.toggleMode" @busy="bulkBusy = $event" @completed="bulkCompleted" />
      <div v-if="!store.items.length && store.loading" class="pj-empty" role="status">正在载入项目…</div>
      <div v-else-if="!store.shown.length && !store.error" class="pj-empty">
        <FolderKanban :size="48" /><h2>{{ filtered ? '没有符合条件的项目' : '从一个项目目录开始' }}</h2>
        <p>{{ filtered ? '试试清空筛选，查看已收录的项目。' : '把源码、文稿、资料和常用工具放在同一个入口。' }}</p>
        <button v-if="filtered" class="pj-button" @click="clearFilters">清空筛选</button>
        <button v-else class="pj-button pj-primary" @click="importer = true">添加项目</button>
      </div>
      <div v-else class="pj-grid">
        <article v-for="item in store.shown" :key="item.id" class="pj-card" :class="{ 'pj-card-selected': selectedIds.has(item.id) }" :data-project-id="item.id">
          <div class="pj-card-top">
            <input v-if="selecting" type="checkbox" :checked="selectedIds.has(item.id)" :disabled="bulkBusy || store.loading || !!store.error" :aria-label="`选择 ${item.name}`" @change="selection.toggle(item.id)" />
            <div class="pj-project-symbol" :class="{ 'pj-symbol-research': item.category === '调研写作' }"><component :is="icon(item.category)" :size="25" /></div>
            <span class="pj-chip">{{ sourceNames[item.source] }}</span>
            <button v-if="!selecting" class="pj-icon" :class="{ selected: item.pinned }" :aria-label="item.pinned ? '取消置顶' : '置顶项目'" @click="pin(item)"><Pin :size="16" /></button>
          </div>
          <button class="pj-card-title" :disabled="bulkBusy" @click="detail(item)">{{ item.name }}</button>
          <p class="pj-card-summary">{{ item.summary || '添加一句简介，下次更快找到它。' }}</p>
          <div class="pj-tags"><span>{{ item.category }}</span><span v-if="item.group">{{ item.group }}</span><span v-for="tag in item.tags.slice(0, 2)" :key="tag">#{{ tag }}</span></div>
          <div class="pj-card-path" :title="item.path"><FolderOpen :size="13" /><span>{{ item.path }}</span></div>
          <footer>
            <span :class="{ 'pj-missing': !item.available }">{{ item.available ? stateNames[item.state] : '位置失效' }}</span>
            <button class="pj-button" :disabled="bulkBusy" @click="detail(item)">{{ selecting ? selectedIds.has(item.id) ? '取消选择' : '选择' : '详情' }}</button>
            <button v-if="!selecting" class="pj-icon" aria-label="打开项目默认入口" @click="open(item)"><ArrowUpRight :size="19" /></button>
          </footer>
        </article>
      </div>
    </main>
    <ProjectImport v-if="importer" @close="importer = false" @imported="store.refresh" />
    <ProjectDialog v-if="history" title="项目移动记录" :busy="busy" @close="history = false">
      <p class="pj-muted">记录保留原位置、新位置及恢复结果。原位关联的参考文件不会随主目录搬走。</p><p v-if="!records.length">还没有移动记录。</p>
      <article v-for="r in records" :key="r.id" class="pj-history">
        <strong>{{ ({ done: '已完成', 'rolled-back': '已回退', attention: '需要核对', prepared: '待核对', copied: '已复制', placed: '已转移', committed: '已登记' })[r.phase] }}</strong>
        <p class="pj-path">{{ r.source }} → {{ r.destination }}</p><p v-if="r.error" class="pj-error">{{ r.error }}</p>
        <button v-if="!['done', 'rolled-back'].includes(r.phase)" class="pj-button" :disabled="busy" @click="recover(r.id)">核对并恢复</button>
      </article>
    </ProjectDialog>
  </div>
</template>

<style scoped>
.pj-content>.library-bulk{margin:0 0 18px}.pj-card-selected{outline:2px solid var(--accent);outline-offset:-2px}.pj-card-top>input{width:18px;height:18px;accent-color:var(--accent)}
</style>
