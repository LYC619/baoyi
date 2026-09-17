<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, Loader2, X } from 'lucide-vue-next'
import type { VideoItem } from '@/types'
import type { VideoDirectory } from '@/types/video-library'
import type { VideoOrganizeJournal, VideoOrganizeMode } from '@/types/video-organize'
import { useVideoWorkflow } from '@/composables/useVideoWorkflow'
import { videoTitle } from '@/utils'
import { useRouter } from 'vue-router'
import { useOrganizeSession } from './useOrganizeSession'
import OrganizePreview from './OrganizePreview.vue'
import OrganizeHistory from './OrganizeHistory.vue'

const props = withDefaults(defineProps<{
  works: VideoItem[]; mode?: 'organize' | 'relocate' | 'history'; resourceId?: string
  directory?: VideoDirectory | null; returnFocus?: HTMLElement | null
}>(), { mode: 'organize', resourceId: '', directory: null, returnFocus: null })
const emit = defineEmits<{ close: []; changed: [journal: VideoOrganizeJournal] }>()
const workflow = useVideoWorkflow()
const router = useRouter()
const tab = ref<'preview' | 'history'>(props.mode === 'history' ? 'history' : 'preview')
const session = useOrganizeSession({ works: () => props.works, resourceId: props.resourceId || undefined,
  privacyReady: () => workflow.privacyReady.value, privateHidden: () => !workflow.privacyReady.value || workflow.hideHentai.value,
  kind: props.mode === 'relocate' ? 'relocate' : 'organize', autoPreview: () => props.mode === 'organize' && tab.value === 'preview',
  changed: journal => emit('changed', journal) })
const { works, survivorId, collectionAction, collectionTitle, episodeNumbers, transfer, copyFiles, targetDirectory, root, fileNames, relocateMode, preview, journals,
  historyLoaded, busy, error, notice, stale, canPreview } = session
const panel = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const review = ref<HTMLElement | null>(null)
const resultHeading = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
let unlisten: (() => void) | undefined
const title = computed(() => props.mode === 'history' ? '整理记录' : props.mode === 'relocate' ? '作品目录管理' : '组建合集')
const mutation = computed(() => busy.value === 'apply' || busy.value === 'retry' || busy.value === 'rollback')
const inputLocked = computed(() => mutation.value || busy.value === 'pick' || busy.value === 'history')
const applyLabel = computed(() => (collectionAction.value === 'join' ? '加入合集' : '创建合集') + (copyFiles.value ? transfer.value === 'move' ? '并移动文件' : '并复制文件' : ''))
const fileAction = computed({
  get: () => copyFiles.value ? transfer.value : 'none',
  set: (value: string) => { transfer.value = value === 'move' ? 'move' : 'copy'; copyFiles.value = value !== 'none' }
})
const applyDisabled = computed(() => !!busy.value || stale.value || !canPreview.value || preview.value?.kind !== 'organize'
  || !(copyFiles.value ? preview.value.canOrganize : preview.value.canMerge))
const canRelocate = computed(() => props.mode === 'relocate' && !!props.directory)
const previewDisabled = computed(() => !!busy.value || !canPreview.value || (props.mode === 'relocate' && (!canRelocate.value || !targetDirectory.value.trim())))

async function showHistory(): Promise<void> {
  tab.value = 'history'
  await session.refreshHistory()
}
async function showSelection(): Promise<void> {
  tab.value = 'preview'
  if (props.mode === 'organize' && stale.value) void session.previewChanges('organize')
  await nextTick()
  if (body.value) body.value.scrollTop = 0
}
async function generatePreview(): Promise<void> {
  await session.previewChanges(props.mode === 'relocate' ? 'relocate' : 'organize')
  await nextTick()
  if (props.mode === 'relocate' && preview.value && !stale.value) {
    review.value?.focus({ preventScroll: true })
    review.value?.scrollIntoView({ block: 'start' })
  } else if (error.value && body.value) body.value.scrollTop = 0
}
async function applied(mode?: VideoOrganizeMode): Promise<void> {
  const journal = mode ? await session.apply(mode) : await session.relocate()
  if (journal) {
    tab.value = 'history'
    await nextTick()
    resultHeading.value?.focus()
  } else if (error.value && body.value) body.value.scrollTop = 0
}
async function recover(id: string, action: 'retry' | 'rollback'): Promise<void> {
  await session[action](id)
  if (error.value && body.value) body.value.scrollTop = 0
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')]
    .filter(element => element.getClientRects().length > 0)
  const first = controls[0], last = controls.at(-1)
  if (!panel.value.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => {
  previousFocus = props.returnFocus || document.activeElement as HTMLElement | null
  // Disabling a focused submit button during IPC can move focus to body.
  // Escape still closes this panel and Tab brings focus back inside it.
  document.addEventListener('keydown', keydown)
  unlisten = window.baoyi.video.onLibraryChanged?.(id => {
    if (props.resourceId === id || works.value.some(work => work.id === id)) session.invalidate()
  })
  await nextTick()
  panel.value?.querySelector<HTMLElement>('button')?.focus()
  // This mode is opened only by the explicit “整理记录” action in Home/Detail.
  if (props.mode === 'history') void session.refreshHistory()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keydown)
  session.dispose()
  unlisten?.()
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="organize-overlay" @click.self="$emit('close')">
      <section ref="panel" class="organize-panel" role="dialog" aria-modal="true" aria-labelledby="organize-title" tabindex="-1">
        <header class="organize-panel__head"><div><h2 id="organize-title">{{ title }}</h2><p>{{ mode === 'organize' ? '选好名称和集数，让同一部作品集中显示。' : '核对目录与文件，保留原有资料和观看记录。' }}</p></div><button class="btn btn--subtle" type="button" aria-label="关闭整理面板" @click="$emit('close')"><X :size="18" /></button></header>
        <nav class="organize-tabs" aria-label="整理步骤">
          <button v-if="mode !== 'history'" type="button" :aria-current="tab === 'preview' ? 'step' : undefined" @click="showSelection">{{ mode === 'organize' ? '合集内容' : '目录与预览' }}</button>
          <button type="button" :aria-current="tab === 'history' ? 'step' : undefined" :disabled="!!busy" @click="showHistory">整理记录</button>
        </nav>
        <div ref="body" class="organize-panel__body" :aria-busy="!!busy">
          <p v-if="error" class="organize-error" role="alert">{{ error }}</p>
          <p v-if="notice" class="organize-notice" role="status">{{ notice }}</p>
          <p v-if="busy" class="organize-hint" role="status"><Loader2 :size="13" class="spin" />{{ mutation ? '正在处理，可关闭面板；稍后在整理记录查看结果。' : busy === 'history' ? '正在读取可见记录…' : busy === 'pick' ? '正在选择目录…' : '正在核对资料与文件…' }}</p>
          <template v-if="tab === 'preview'">
            <form class="organize-form" @submit.prevent="generatePreview">
              <template v-if="mode === 'organize'">
                <fieldset class="collection-mode" :disabled="inputLocked"><legend class="sr-only">合集方式</legend><label :class="{ active: collectionAction === 'create' }"><input v-model="collectionAction" type="radio" value="create" />创建新合集</label><label :class="{ active: collectionAction === 'join' }"><input v-model="collectionAction" type="radio" value="join" />加入已有合集</label></fieldset>
                <label v-if="collectionAction === 'create'" class="organize-field collection-name"><span>合集名称</span><input v-model="collectionTitle" maxlength="240" :disabled="inputLocked" placeholder="例如：某部作品的系列名称" /></label>
                <template v-else>
                  <label class="organize-field"><span>加入哪个合集</span><select v-model="survivorId" :disabled="inputLocked"><option disabled value="">请选择已选作品中的合集</option><option v-for="work in works" :key="work.id" :value="work.id">{{ videoTitle(work) }}{{ work.episode_total > 1 ? `（已有 ${work.episode_total} 集）` : '' }}</option></select></label>
                  <p class="organize-hint">现有合集也需要一并选中。它的名称、封面和整体简介继续保留。</p>
                </template>
                <p class="organize-selection-count">已选 {{ works.length }} 部作品<span>更改后自动核对</span></p>
                <div class="organize-file-options">
                  <fieldset class="organize-file-actions" :disabled="inputLocked"><legend>文件整理</legend><label><input v-model="fileAction" type="radio" value="none" />保留位置</label><label><input v-model="fileAction" type="radio" value="move" />移动</label><label><input v-model="fileAction" type="radio" value="copy" />复制</label></fieldset>
                  <template v-if="copyFiles">
                    <div class="organize-field"><span>整理根目录</span><p class="organize-path">{{ targetDirectory || '请先在设置中保存影视整理根目录' }}</p><p class="organize-hint">将在根目录下新建以合集名命名的文件夹。</p><button class="btn btn--ghost" type="button" :disabled="!!busy" @click="emit('close'); router.push({ name: 'settings', query: { tab: 'scan' } })">前往设置修改</button></div>
                    <p class="organize-hint">{{ transfer === 'move' ? '全部复制并校验成功后移除原文件，共享文件保留原件。' : '复制后保留原件。' }}下方列出各文件去向，目标重名时不会覆盖。</p>
                  </template>
                </div>
              </template>
              <template v-else>
                <p v-if="works[0]" class="organize-work-title">{{ videoTitle(works[0]) }}</p>
                <p class="organize-path">当前作品目录：{{ directory?.path || '尚未绑定受管理目录' }}</p>
                <p v-if="!directory" class="organize-hint">此作品尚无受管理目录。可在首页创建合集时选择“文件整理 · 复制”，复制到统一目录。</p>
                <fieldset class="organize-mode" :disabled="!!busy || !canRelocate"><legend>目录处理方式</legend><label><input v-model="relocateMode" type="radio" value="rebind" />重新绑定已移动的目录</label><label><input v-model="relocateMode" type="radio" value="copy" />复制整目录（保留原件）</label></fieldset>
                <label class="organize-field"><span>新作品目录</span><div class="organize-location"><input v-model="targetDirectory" :disabled="!!busy || !canRelocate" spellcheck="false" placeholder="填写完整的新作品目录路径" /><button class="btn btn--ghost" type="button" :disabled="!!busy || !canRelocate" aria-label="选择整理目标目录" @click="session.pickDirectory"><FolderOpen :size="14" />选择</button></div></label>
                <p class="organize-hint">{{ relocateMode === 'copy' ? '目标应是不存在或为空的作品目录；复制成功后仍保留原目录。' : '选择你已移动或复制好的作品目录，预览会核对文件和作品身份。' }}</p>
                <details class="organize-root"><summary>指定所属影视库根目录（可选）</summary><label class="organize-field"><span>所属影视库根目录</span><input v-model="root" :disabled="!!busy" placeholder="留空使用作品绑定或目标的上级目录" spellcheck="false" /></label></details>
              </template>
              <div v-if="mode !== 'organize' || error" class="organize-preview-action"><span v-if="!works.length" class="organize-hint">当前没有可见的已选作品。</span><button class="btn btn--ghost" type="submit" :disabled="previewDisabled">{{ mode === 'organize' || preview ? '重新预览' : '生成预览' }}</button></div>
            </form>
            <p v-if="preview && stale && mode !== 'organize'" class="organize-notice" role="status">预览已失效，重新预览后才能执行。</p>
            <div v-if="preview" ref="review" :data-preview-stale="stale" tabindex="-1"><OrganizePreview :preview="preview" :file-names="fileNames" :episode-numbers="episodeNumbers" :without-season="works.every(work => work.category === '里番')" :copy-files="mode === 'relocate' || copyFiles" :disabled="inputLocked" @number="(id, season, episode) => episodeNumbers = { ...episodeNumbers, [id]: { season, episode } }" @rename="(id, name) => fileNames = { ...fileNames, [id]: name }" /></div>
            <p v-else class="organize-empty">{{ mode === 'organize' ? canPreview ? '正在整理集数与原作品资料…' : '填写合集名称并选择作品后，将自动显示内容。' : '预览会列出各文件的当前位置与目标位置。' }}</p>
          </template>
          <template v-else>
            <h3 ref="resultHeading" class="organize-result-title" tabindex="-1">本次结果与历史</h3>
            <OrganizeHistory :journals="journals" :loaded="historyLoaded" :busy="!!busy" @refresh="session.refreshHistory" @retry="id => recover(id, 'retry')" @rollback="id => recover(id, 'rollback')" />
          </template>
        </div>
        <footer v-if="tab === 'preview' && mode !== 'history'" class="organize-panel__footer">
          <p>{{ mode === 'organize' ? copyFiles ? transfer === 'move' ? '创建合集并移动文件，校验完成后移除原件。' : '创建合集并复制文件，原文件继续保留。' : '在影视库中合为一个作品，视频保留在原位置。' : '核对完整预览后才更新目录绑定。' }}</p>
          <button v-if="mode === 'organize'" type="button" class="btn btn--primary" :disabled="applyDisabled" @click="applied(copyFiles ? 'physical' : 'logical')">{{ applyLabel }}</button>
          <button v-else type="button" class="btn btn--primary" :disabled="!!busy || stale || preview?.kind !== 'relocate' || !preview.canApply" @click="applied()">{{ relocateMode === 'rebind' ? '确认重新绑定' : '确认复制整目录' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.organize-file-actions { display: flex; flex-wrap: wrap; gap: 18px; margin: 0 0 12px; padding: 0; border: 0; font-size: 13px; }
.organize-file-actions legend { margin-bottom: 10px; font-weight: 600; }
.organize-file-actions label { display: flex; align-items: center; gap: 7px; cursor: pointer; }
.organize-file-actions input { accent-color: var(--accent); }
.organize-overlay { position: fixed; inset: 0; z-index: 135; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / .48); -webkit-app-region: no-drag; }
.organize-panel { --text-sub: color-mix(in srgb, var(--text-main) 75%, var(--bg-main)); width: min(820px, 100%); max-height: calc(100dvh - 40px); display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--divider); border-radius: var(--radius-card); background: var(--bg-main); color: var(--text-main); box-shadow: var(--shadow-pop); overflow: hidden; }
.organize-panel__head { display: flex; justify-content: space-between; gap: 12px; padding: 14px 20px 12px; }
.organize-panel__head h2 { font-size: 17px; font-weight: 500; }
.organize-panel__head p { margin-top: 4px; font-size: 12px; color: var(--text-sub); }
.organize-tabs { display: flex; gap: 18px; padding: 0 20px; border-bottom: 1px solid var(--divider); }
.organize-tabs button { padding: 9px 0; font-size: 12px; color: var(--text-sub); border-bottom: 2px solid transparent; }
.organize-tabs button[aria-current] { color: var(--text-main); border-color: var(--accent); }
.organize-panel__body { min-height: 0; overflow-y: auto; display: grid; gap: 14px; padding: 16px 20px; }
.organize-form { display: grid; gap: 10px; }
.collection-mode { display: flex; gap: 6px; padding: 0; border: 0; margin-bottom: 4px; }
.collection-mode legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.collection-mode label { display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 6px 12px; border: 1px solid var(--divider); border-radius: 6px; color: var(--text-sub); font-size: 12px; cursor: pointer; }
.collection-mode label.active { color: var(--text-main); background: var(--active-surface); border-color: var(--accent); }
.collection-mode input, .organize-copy-option input { accent-color: var(--accent); }
.collection-name input { height: 38px; font-size: 14px; }
.organize-selection-count { display: flex; justify-content: space-between; color: var(--text-sub); font-size: 12px; padding-top: 4px; }
.organize-selection-count span { color: var(--text-sub); font-size: 11px; }
.organize-file-options { border-block: 1px solid var(--divider); padding: 10px 0; }
.organize-file-options > summary { cursor: pointer; font-size: 12px; color: var(--text-sub); }
.organize-file-options > :not(summary) { margin-top: 12px; }
.organize-copy-option { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.organize-field { display: grid; gap: 6px; min-width: 0; font-size: 12px; color: var(--text-sub); }
.organize-field :is(input, select) { width: 100%; min-width: 0; height: 33px; padding: 0 9px; border: 1px solid var(--divider); border-radius: 5px; background: var(--bg-main); color: var(--text-main); font-size: 12px; }
.organize-field input:disabled { opacity: .6; }
.organize-location { display: flex; gap: 8px; }
.organize-location input { flex: 1; }
.organize-location button { flex: none; }
.organize-hint, .organize-path, .organize-empty { font-size: 12px; line-height: 1.6; color: var(--text-sub); overflow-wrap: anywhere; }
.organize-hint svg { vertical-align: middle; margin-right: 5px; }
.organize-path { font-family: var(--font-mono); font-size: 11px; }
.organize-work-title { font-size: 14px; overflow-wrap: anywhere; }
.organize-root summary { font-size: 11px; color: var(--text-sub); cursor: pointer; }
.organize-root .organize-field { margin-top: 8px; }
.organize-mode { display: flex; flex-wrap: wrap; gap: 10px 18px; border: 1px solid var(--divider); border-radius: 5px; padding: 10px 12px; font-size: 12px; }
.organize-mode legend { padding: 0 4px; color: var(--text-sub); }
.organize-mode label { display: flex; align-items: center; gap: 6px; }
.organize-preview-action { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.organize-notice, .organize-error { padding: 9px 12px; border-left: 3px solid var(--warning); background: var(--bg-card); color: var(--text-main); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.organize-error { border-color: var(--danger); }
.organize-empty { padding-block: 14px; }
.organize-result-title { font-size: 13px; font-weight: 500; }
.organize-panel__footer { flex: none; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--divider); padding: 12px 20px; }
.organize-panel__footer p { flex: 1 1 220px; color: var(--text-sub); font-size: 11px; line-height: 1.6; }
.organize-panel__footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
.organize-panel .btn--primary { background: #6652c8; color: #fff; }
.organize-panel :is(button, input, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.spin { animation: organize-spin 1s linear infinite; }
@keyframes organize-spin { to { transform: rotate(360deg); } }
:global([data-theme='light']) .organize-panel { --warning: #825800; --danger: #b42332; }
@media (max-width: 600px) { .organize-overlay { padding: 10px; } .organize-panel { max-height: calc(100dvh - 20px); } .organize-panel__head, .organize-panel__body, .organize-panel__footer { padding-inline: 14px; } .organize-tabs { padding-inline: 14px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
