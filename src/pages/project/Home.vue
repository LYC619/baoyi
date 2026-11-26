<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { errorMessage } from '@/utils'
import {computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { FolderKanban, Plus, Search, Pin, ArrowUpRight, FolderOpen, History, Code2, BookOpen, Wrench, RefreshCw, LayoutGrid, List } from 'lucide-vue-next'
import { useProjectStore } from '@/stores/project'
import {useProjectLaunch} from '@/composables/useProjectLaunch'
const launcher=useProjectLaunch()
import { useToast } from '@/composables/useToast'
import { rememberScroll, recallScroll } from '@/composables/useModules'
import { useLibrarySelection } from '@/composables/useLibrarySelection'
import { type ProjectItem, type ProjectMoveRecord } from '@/types/project'
import LibraryBulkPanel from '@/components/library/LibraryBulkPanel.vue'
import LibraryToolbarMenu from '@/components/library/LibraryToolbarMenu.vue'
import ProjectImport from '@/components/project/ProjectImport.vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { useFileDrop } from '@/composables/useFileDrop'
import DropZoneOverlay from '@/components/ui/DropZoneOverlay.vue'
import '@/styles/project.css'

const store = useProjectStore(), router = useRouter(), { error: toastError, success } = useToast()
const importer = ref(false), droppedProjectPaths = ref<string[]>([]), history = ref(false), records = ref<ProjectMoveRecord[]>([]), busy = ref(false), bulkBusy = ref(false)
const { dragging: dropActive, dropHandlers } = useFileDrop((paths) => { if (!paths.length) return; droppedProjectPaths.value = paths; importer.value = true }, { disabled: () => importer.value || history.value || bulkBusy.value })
const scroll = ref<HTMLElement>(), searchInput = ref<HTMLInputElement>()
const selection = useLibrarySelection(() => store.shown, () => bulkBusy.value)
const { selecting, selectedIds } = selection
const bulkTrigger = ref<HTMLButtonElement>()
watch(selecting, async active => { if (!active) { await nextTick(); bulkTrigger.value?.focus() } })
const sourceNames: Record<string, string> = { get self() { return tr("自己建立") }, get 'third-party'() { return tr("第三方") }, get mixed() { return tr("混合来源") }, get unknown() { return tr("来源未标记") } }
const stateNames: Record<string, string> = { get active() { return tr("使用中") }, get maintaining() { return tr("维护中") }, get paused() { return tr("已暂停") }, get archived() { return tr("已归档") } }
const heading = computed(() => store.pinned ? tr('置顶项目') : store.group || store.category || tr('全部项目'))
const filtered = computed(() => !!(store.search.trim() || store.category || store.group || store.source || store.state || store.pinned || store.availability||store.tag))
const opening=ref(new Set<string>())
const removing=ref<ProjectItem|null>(null),removeBusy=ref(false)
async function removeProject(){const target=removing.value;if(!target||removeBusy.value)return;removeBusy.value=true;try{await window.baoyi.project.remove(target.id);removing.value=null;success(tr("项目已删除，原文件保留"));await store.refresh()}catch(e){toastError(errorMessage(e))}finally{removeBusy.value=false}}
const tags=computed(()=>[...new Set(store.items.flatMap(item=>item.tags))].sort())
const icon = (category: string) => category === '软件项目' ? Code2 : category === '调研写作' ? BookOpen : category === '资料处理' ? Wrench : FolderKanban
function clearFilters() { store.search = ''; store.category = ''; store.group = ''; store.source = ''; store.state = ''; store.pinned = false; store.availability = '';store.tag='' }
function detail(item: ProjectItem) { if (selecting.value) { if (!store.loading && !store.error) selection.toggle(item.id) } else void router.push('/project/' + item.id) }
function onCardClick(item: ProjectItem, event: MouseEvent) {
  if (bulkBusy.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, select, a, summary, details, label, [popover]')) return
  detail(item)
}
async function bulkCompleted(failedIds: string[]) { selectedIds.value = new Set(failedIds); await store.refresh() }
async function open(item: ProjectItem,entryId?:string) { if(opening.value.has(item.id))return;opening.value.add(item.id);try { await window.baoyi.project.open(item.id,entryId) } catch (e) { toastError(errorMessage(e)) } finally{opening.value.delete(item.id)} }
function openChoice(item:ProjectItem,event:Event){const input=event.target as HTMLSelectElement;if(input.value)void open(item,input.value);input.value=''}
async function pin(item: ProjectItem) { try { await window.baoyi.project.update(item.id, { pinned: !item.pinned }); await store.refresh() } catch (e) { toastError(errorMessage(e)) } }
async function revealProject(item: ProjectItem) { try { await window.baoyi.project.reveal(item.id) } catch (e) { toastError(errorMessage(e)) } }
async function showHistory() { try { records.value = await window.baoyi.project.moveRecords(); history.value = true } catch (e) { toastError(errorMessage(e)) } }
async function recover(id: string) { busy.value = true; try { success(await window.baoyi.project.recoverMove(id)); records.value = await window.baoyi.project.moveRecords(); await store.refresh() } catch (e) { toastError(errorMessage(e)) } finally { busy.value = false } }
function key(event: KeyboardEvent) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !importer.value && !history.value) { event.preventDefault(); searchInput.value?.focus() } }
const gitClock = ref(Date.now())
function syncGitClock() { if (typeof document === 'undefined' || !document.hidden) gitClock.value = Date.now() }
const gitTimer = setInterval(syncGitClock, 30000)
onMounted(async () => { document.addEventListener('keydown', key); window.addEventListener('focus', syncGitClock); document.addEventListener('visibilitychange', syncGitClock); await store.refresh(); await nextTick(); if (scroll.value) scroll.value.scrollTop = recallScroll('project') })
onBeforeUnmount(() => { clearInterval(gitTimer); document.removeEventListener('keydown', key); window.removeEventListener('focus', syncGitClock); document.removeEventListener('visibilitychange', syncGitClock); rememberScroll('project', scroll.value?.scrollTop || 0) })
async function refreshGit(id:string){try{await window.baoyi.project.git(id,{refresh:true});await store.refresh()}catch(e){toastError(errorMessage(e))}}
</script>

<template>
  <div class="pj-home" v-on="dropHandlers" @keydown="selection.key">
    <DropZoneOverlay :active="dropActive" :title="$t('松开以添加项目')" :hint="$t('支持拖入项目文件夹或文稿文件，保留原位置建立项目入口')" />
    <aside class="pj-sidebar">
      <div class="pj-sidebar-heading"><FolderKanban :size="20" /><span>{{ $t("项目") }}</span></div>
      <nav :aria-label="$t('项目筛选')">
        <button :class="{ active: !store.category && !store.pinned && !store.group }" @click="store.category = ''; store.pinned = false; store.group = ''"><FolderOpen :size="17" />{{ $t("全部项目") }}<span>{{ store.items.length }}</span></button>
        <button :class="{ active: store.pinned }" @click="store.pinned = !store.pinned; store.category = ''; store.group = ''"><Pin :size="17" />{{ $t("置顶项目") }}</button>
      </nav>
      <h3>{{ $t("项目类型") }}</h3>
      <nav><button v-for="c in store.categories" :key="c" :class="{ active: store.category === c }" @click="store.category = store.category === c ? '' : c; store.pinned = false; store.group = ''"><component :is="icon(c)" :size="16" />{{ c }}<span>{{ store.items.filter(i => i.category === c).length }}</span></button></nav>
      <template v-if="store.groups.length"><h3>{{ $t("我的分组") }}</h3><nav><button v-for="g in store.groups" :key="g" :class="{ active: store.group === g }" @click="store.group = store.group === g ? '' : g; store.category = ''; store.pinned = false"><span class="pj-dot" />{{ g }}</button></nav></template>
      <div class="pj-sidebar-bottom"><button @click="showHistory"><History :size="17" />{{ $t("移动记录") }}</button></div>
    </aside>
    <main ref="scroll" class="pj-content">
      <header class="pj-page-header"><div><h1>{{ heading }}<small>{{ $t("{p0} 个项目", {p0: (store.shown.length)}) }}</small></h1></div><button class="pj-button pj-primary" :disabled="bulkBusy" @click="importer = true"><Plus :size="18" />{{ $t("添加项目") }}</button></header>
      <div class="pj-toolbar">
        <label class="pj-search"><Search :size="18" /><input ref="searchInput" v-model="store.search" :placeholder="$t('搜索名称、分组、入口或路径，多词用空格…')" :aria-label="$t('搜索项目')" /><kbd>Ctrl K</kbd></label>
        <select v-model="store.sort" :aria-label="$t('项目排序')"><option value="recent">{{ $t("最近打开") }}</option><option value="updated">{{ $t("最近更新") }}</option><option value="name">{{ $t("按名称") }}</option></select>
        <button class="pj-icon" :aria-label="$t('刷新项目')" :disabled="store.loading || bulkBusy" @click="store.refresh"><RefreshCw :size="17" /></button>
        <div class="pj-view-switch" role="group" :aria-label="$t('项目显示方式')"><button class="pj-icon" :aria-pressed="store.layout==='cards'" :aria-label="$t('卡片视图')" @click="store.layout='cards'"><LayoutGrid :size="16"/></button><button class="pj-icon" :aria-pressed="store.layout==='list'" :aria-label="$t('列表视图')" @click="store.layout='list'"><List :size="16"/></button></div>
        <button ref="bulkTrigger" v-if="!selecting" class="pj-button" :disabled="!store.shown.length || store.loading" @click="selection.toggleMode">{{ $t("批量管理") }}</button>
      </div>
      <div class="pj-filter-tags" :aria-label="$t('项目标签筛选')">
        <div role="group" :aria-label="$t('项目状态')"><button :aria-pressed="!store.state" @click="store.state=''">{{ $t("全部状态") }}</button><button v-for="(label,value) in stateNames" :key="value" :aria-pressed="store.state===value" @click="store.state=store.state===value?'':value">{{label}}</button></div>
        <div v-if="tags.length" role="group" :aria-label="$t('项目标签')"><button :aria-pressed="!store.tag" @click="store.tag=''">{{ $t("全部标签") }}</button><button v-for="tag in tags" :key="tag" :aria-pressed="store.tag===tag" @click="store.tag=store.tag===tag?'':tag">#{{tag}}</button></div>
        <details><summary>{{ $t("来源与位置{p0}", {p0: (store.source||store.availability?$t('（已筛选）'):'')}) }}</summary><div role="group" :aria-label="$t('项目来源')"><button :aria-pressed="!store.source" @click="store.source=''">{{ $t("全部来源") }}</button><button v-for="(label,value) in sourceNames" :key="value" :aria-pressed="store.source===value" @click="store.source=store.source===value?'':value">{{label}}</button></div><div role="group" :aria-label="$t('项目位置')"><button :aria-pressed="!store.availability" @click="store.availability=''">{{ $t("全部位置") }}</button><button :aria-pressed="store.availability==='available'" @click="store.availability=store.availability==='available'?'':'available'">{{ $t("位置可用") }}</button><button :aria-pressed="store.availability==='missing'" @click="store.availability=store.availability==='missing'?'':'missing'">{{ $t("位置失效") }}</button></div></details>
      </div>
      <div v-if="store.items.length" class="pj-filter-summary"><span>{{ $t("显示 {p0} / {p1} 个项目", {p0: (store.shown.length), p1: (store.items.length)}) }}<span v-if="store.availability"> · {{store.availability==='missing'?$t('位置失效'):$t('位置可用')}}</span></span><button v-if="filtered" @click="clearFilters">{{ $t("清空筛选") }}</button></div>
      <p v-if="store.error" class="pj-error" role="alert">{{ $systemMessage(store.error) }} <button class="pj-button" @click="store.refresh">{{ $t("重试") }}</button></p>

      <LibraryBulkPanel v-if="selecting" kind="project" :pending="store.loading || !!store.error" @refresh="store.refresh" :items="store.shown" :ids="[...selectedIds]" :categories="store.categories" @all="selection.selectAll" @clear="selection.clear" @close="selection.toggleMode" @busy="bulkBusy = $event" @completed="bulkCompleted" />
      <div v-if="!store.items.length && store.loading" class="pj-empty" role="status">{{ $t("正在载入项目…") }}</div>
      <div v-else-if="!store.shown.length && !store.error" class="pj-empty">
        <FolderKanban :size="48" /><h2>{{ filtered ? $t('没有符合条件的项目') : $t('从一个项目目录开始') }}</h2>
        <p>{{ filtered ? $t('试试清空筛选，查看已收录的项目。') : $t('把源码、文稿、资料和常用工具放在同一个入口。') }}</p>
        <button v-if="filtered" class="pj-button" @click="clearFilters">{{ $t("清空筛选") }}</button>
        <button v-else class="pj-button pj-primary" @click="importer = true">{{ $t("添加项目") }}</button>
      </div>
      <div v-else class="pj-grid" :class="{'pj-list':store.layout==='list'}">
        <article v-for="item in store.shown" :key="item.id" class="pj-card" :class="{ 'pj-card-selected': selectedIds.has(item.id) }" :data-project-id="item.id" @click="onCardClick(item, $event)">
          <div class="pj-card-top">
            <input v-if="selecting" type="checkbox" :checked="selectedIds.has(item.id)" :disabled="bulkBusy || store.loading || !!store.error" :aria-label="$t('选择 {p0}', {p0: item.name})" @change="selection.toggle(item.id)" />
            <div class="pj-project-symbol" :class="{ 'pj-symbol-research': item.category === '调研写作' }"><component :is="icon(item.category)" :size="25" /></div>
            <span class="pj-chip">{{ sourceNames[item.source] }}</span>
            <button v-if="!selecting" class="pj-icon" :class="{ selected: item.pinned }" :aria-label="item.pinned ? $t('取消置顶') : $t('置顶项目')" @click="pin(item)"><Pin :size="16" /></button>
            <LibraryToolbarMenu v-if="!selecting" :label="$t('更多')"><button @click="router.push({path:'/project/'+item.id,query:{tab:'notes',handoff:'1'}})">{{ $t("下一步交接") }}</button><button @click="revealProject(item)">{{ $t("打开所在目录") }}</button><button class="pj-danger" @click="removing=item">{{ $t("删除项目") }}</button></LibraryToolbarMenu>
          </div>
          <button class="pj-card-title" :disabled="bulkBusy" @click="detail(item)">{{ item.name }}</button>
          <p class="pj-card-summary">{{ item.summary || $t('添加一句简介，下次更快找到它。') }}</p>
          <button v-if="!selecting" class="pj-git-status" :title="item.git?.message||$t('只读取 Git 短状态')" @click="refreshGit(item.id)">{{item.git?.available?$t('{p0} · {p1} 处改动', {p0: item.git.branch, p1: item.git.changed}):$t('读取 Git 状态')}}<small v-if="item.git"> · {{new Date(item.git.readAt).toLocaleTimeString($locale)}} · {{gitClock-item.git.readAt>30000?$t('已过期，点击刷新'):$t('点击刷新')}}</small></button>
          <div v-if="item.contextPreview?.current||item.contextPreview?.next" class="pj-context-preview"><p v-if="item.contextPreview.current"><span>{{ $t("当前") }}</span>{{item.contextPreview.current}}</p><p v-if="item.contextPreview.next"><span>{{ $t("下一步") }}</span>{{item.contextPreview.next}}</p></div>
          <div class="pj-tags"><span>{{ item.category }}</span><span v-if="item.group">{{ item.group }}</span><span v-for="tag in item.tags.slice(0, 2)" :key="tag">#{{ tag }}</span></div>
          <div class="pj-card-path" :title="item.path"><FolderOpen :size="13" /><span>{{ item.path }}</span></div>
          <footer>
            <button v-if="!selecting" class="pj-button" :disabled="bulkBusy||launcher.busy.value" @click="launcher.open(item)">{{ $t("启动") }}</button>
            <button v-if="!selecting&&launcher.last(item.id)" class="pj-button" :disabled="bulkBusy||launcher.busy.value||!item.available" :title="launcher.last(item.id)?.profileName" @click="launcher.rerun(item)">{{ $t("重跑上次") }}</button>
            <button v-if="selecting" class="pj-button" :disabled="bulkBusy" @click="detail(item)">{{ selectedIds.has(item.id) ? $t('取消选择') : $t('选择') }}</button>
            <span :class="{ 'pj-missing': !item.available }">{{ item.available ? stateNames[item.state] : $t('位置失效') }}</span>
            <select v-if="!selecting&&item.entries.length>1" class="pj-entry-choice" :aria-label="$t('打开项目入口 ')+item.name" :disabled="opening.has(item.id)||bulkBusy" value="" @change="openChoice(item,$event)"><option value="" disabled>{{ $t("其他入口") }}</option><option v-for="entry in item.entries" :key="entry.id" :value="entry.id">{{entry.label}}</option></select>
            <button v-if="!selecting" class="pj-icon" :aria-label="$t('打开项目默认入口')" :title="item.entries.find(e=>e.id===item.defaultEntryId)?.label||$t('请先设置默认入口')" :disabled="opening.has(item.id)||!item.defaultEntryId" @click="open(item)"><ArrowUpRight :size="19" /></button>
          </footer>
        </article>
      </div>
    </main>
    <ProjectImport v-if="importer" :initial-paths="droppedProjectPaths" @close="importer = false; droppedProjectPaths = []" @imported="store.refresh" />
    <ProjectDialog v-if="removing" :title="$t('删除项目')" :busy="removeBusy" @close="removing=null"><p>{{ $t("从抱一中删除“{p0}”及其项目登记与记录？项目目录和原文件保留在原位置。", {p0: (removing.name)}) }}</p><template #footer><button class="pj-button" :disabled="removeBusy" @click="removing=null">{{ $t("取消") }}</button><button class="pj-button pj-danger" :disabled="removeBusy" @click="removeProject">{{ $t("确认删除项目") }}</button></template></ProjectDialog>
    <ProjectDialog v-if="history" :title="$t('项目移动记录')" :busy="busy" @close="history = false">
      <p class="pj-muted">{{ $t("记录保留原位置、新位置及恢复结果。原位关联的参考文件不会随主目录搬走。") }}</p><p v-if="!records.length">{{ $t("还没有移动记录。") }}</p>
      <article v-for="r in records" :key="r.id" class="pj-history">
        <strong>{{ ({ done: $t('已完成'), 'rolled-back': $t('已回退'), attention: $t('需要核对'), prepared: $t('待核对'), copied: $t('已复制'), placed: $t('已转移'), committed: $t('已登记') })[r.phase] }}</strong>
        <p class="pj-path">{{ r.source }} → {{ r.destination }}</p><p v-if="r.error" class="pj-error">{{ $systemMessage(r.error) }}</p>
        <button v-if="!['done', 'rolled-back'].includes(r.phase)" class="pj-button" :disabled="busy" @click="recover(r.id)">{{ $t("核对并恢复") }}</button>
      </article>
    </ProjectDialog>
  </div>
</template>

<style scoped>
.pj-filter-tags{margin:0 0 12px;display:grid;gap:8px;font-size:12px}.pj-filter-tags [role=group]{display:flex;gap:6px;flex-wrap:wrap}.pj-filter-tags button{padding:4px 9px;border-radius:12px;border:1px solid var(--divider);color:var(--text-sub)}.pj-filter-tags button[aria-pressed=true]{color:var(--accent);background:var(--hover-surface);border-color:var(--accent)}.pj-filter-tags summary{cursor:pointer;color:var(--text-sub)}.pj-filter-tags details [role=group]{margin-top:8px}
.pj-git-status{display:block;text-align:left;margin:10px 0;color:var(--text-sub);font-size:12px}.pj-git-status small{font-size:10px;color:var(--text-faint)}

.pj-context-preview{font-size:12px;line-height:1.7;color:var(--text-sub);margin:10px 0}.pj-context-preview p{margin:4px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.pj-context-preview span{color:var(--text-faint);margin-right:8px}
.pj-content>.library-bulk{margin:0 0 18px}.pj-card-selected{outline:2px solid var(--accent);outline-offset:-2px}.pj-card-top>input{width:18px;height:18px;accent-color:var(--accent)}
</style>
