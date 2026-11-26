<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Download, ExternalLink, FolderOpen, Globe, Link, Loader2, RefreshCw, X } from 'lucide-vue-next'
import { errorMessage } from '@/utils'
import { useVideoWorkflow } from '@/composables/useVideoWorkflow'

const props = withDefaults(defineProps<{ id?: string; updatesOnly?:boolean; discovery?: import('@/types/video-discovery').DiscoverySelection }>(), { id: '' })
const emit = defineEmits<{ close: []; queued: [id: string] }>()
const router = useRouter()
const flow = useVideoWorkflow(props.id, props.discovery)
const { url, draft, title, selectedVideoCodes, sourceLabel, strictQuality, register,
  preparing, picking, enqueuing, error, currentJob, draftHidden, needsPrepare, episodes } = flow
const panel = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
const busy = computed(() => preparing.value || picking.value || enqueuing.value)
const selectable = computed(() => episodes.value.filter(episode => episode.state !== 'queued' && episode.state !== 'other-work' && (!props.updatesOnly||episode.state!=='local')))
const availableCount = computed(() => episodes.value.filter(episode=>episode.state==='available').length)
const missingCount = computed(() => episodes.value.filter(episode=>episode.state==='missing').length)
const stateLabels = { get local() { return tr('本地已有') }, get missing() { return tr('文件缺失') }, get available() { return tr('可下载') }, get queued() { return tr('已在队列') }, get 'other-work'() { return tr('已在其他作品') } }
const localCount = computed(() => episodes.value.filter(episode => episode.state === 'local').length)
const location = computed(() => {
  const value = draft.value
  if (!value) return ''
  if (value.bound || title.value.trim() === value.title) return value.directory
  return (title.value.trim() || tr("未填写作品名称")) + tr("（入队时生成目录）")
})
const missingMetadata = computed(() => (draft.value?.missing ?? []).map(value => ({ get poster() { return tr("海报") }, description: tr('简介') }[value] || value)))
const hanimeError = ref('')
/** 站内窗口挑好视频后，窗口菜单「下载当前视频」会把链接送回这个面板（main.ts 里接 hanimeBrowser.onDownload） */
async function openHanime(): Promise<void> {
  hanimeError.value = ''
  try { await window.baoyi.hanimeBrowser.open() }
  catch (cause) { hanimeError.value = errorMessage(cause) }
}

function selectMissing(): void {
  selectedVideoCodes.value = selectable.value.filter(episode => episode.state !== 'local').map(episode => episode.videoCode)
}
function selectAll(): void { selectedVideoCodes.value = selectable.value.map(episode => episode.videoCode) }
function close(): void {
  if (enqueuing.value) return
  flow.reset()
  emit('close')
}
async function enqueue(): Promise<void> {
  if(props.updatesOnly)selectedVideoCodes.value=selectedVideoCodes.value.filter(code=>selectable.value.some(episode=>episode.videoCode===code))
  const job = await flow.enqueue()
  if (job) emit('queued', job.id)
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
    .filter(element => element.getClientRects().length > 0)
  const first = controls[0], last = controls.at(-1)
  if (!panel.value.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement | null
  document.addEventListener('keydown', keydown)
  await nextTick()
  panel.value?.querySelector<HTMLElement>('input, button')?.focus()
  if (props.discovery) await flow.prepare()
})
onBeforeUnmount(() => { document.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <Teleport to="body">
    <div class="download-overlay" @click.self="close">
      <section ref="panel" class="download-panel" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <header class="download-panel__head">
          <div><h2 id="download-title">{{ updatesOnly ? $t('检查系列更新') : discovery ? $t('保存到本地') : id ? $t('补齐作品内容') : $t('从 Hanime 添加作品') }}</h2><p>{{ $t("{p0}先确认内容和保存位置，再加入下载队列。", {p0: (draft?.sourceName ? draft.sourceName + ' · ' : '')}) }}</p></div>
          <button class="btn btn--subtle" type="button" :aria-label="$t('关闭下载面板')" :disabled="enqueuing" @click="close"><X :size="18" /></button>
        </header>
        <div class="download-panel__body">
          <form v-if="!discovery && (!id || !draft) && !draftHidden" class="download-url" @submit.prevent="flow.prepare">
            <label for="video-source-url"><Link :size="14" />{{ $t("来源页面链接") }}</label>
            <div class="download-url__input">
              <input id="video-source-url" v-model="url" type="url" class="input" placeholder="https://hanime1.me/watch?v=…" :disabled="busy" required />
              <button class="btn btn--ghost" type="submit" :disabled="busy || !url.trim()"><Loader2 v-if="preparing" :size="14" class="spin" /><RefreshCw v-else :size="14" />{{ preparing ? $t('正在解析') : draft ? $t('重新解析') : $t('解析链接') }}</button>
              <button v-if="!id" class="btn btn--ghost" type="button" :disabled="busy || flow.hideHentai.value" :title="flow.hideHentai.value ? $t('里番内容已隐藏，请先在设置中恢复显示') : $t('在应用内打开 Hanime 站点，挑好视频后用窗口菜单「下载当前视频」')" @click="openHanime"><Globe :size="14" />{{ $t("在 Hanime 里找") }}</button>
            </div>
            <p class="download-hint">{{ id ? $t('粘贴 Hanime 视频页链接，补充后仍归入当前作品。') : $t('目前只支持 Hanime：粘贴视频页链接，或到站内挑好后用窗口菜单「下载当前视频」，会自动回到这里。解析阶段只创建草稿。') }}</p>
            <p v-if="hanimeError" class="download-error" role="alert">{{ hanimeError }}</p>
          </form>
          <p v-if="preparing" class="download-hint" role="status">{{ $t("正在读取来源内容和核对本地文件…") }}</p>
          <p v-if="draftHidden" class="download-hint">{{ $t("此作品所属分类已隐藏，可在设置中恢复显示。") }}</p>
          <template v-else-if="draft">
            <p v-if="updatesOnly&&!preparing" class="download-hint" role="status">{{availableCount||missingCount?$t('发现 {p0} 项未收录内容、{p1} 项文件缺失，已选中可补齐项。', {p0: availableCount, p1: missingCount}):$t('当前没有待补齐内容；本地已有、队列中和其他作品的集数会跳过。')}}</p>
            <label class="download-field"><span>{{ $t("作品名称") }}</span><input v-model="title" class="input" maxlength="240" :readonly="draft.bound" :disabled="busy" /></label>
            <div class="download-location">
              <div><span class="download-hint">{{ $t("影视库根目录") }}</span><p class="mono">{{ draft.root || $t('尚未选择') }}</p>
                <template v-if="draft.directoryChange"><span class="download-hint">{{ $t("当前作品目录") }}</span><p class="mono">{{ draft.directoryChange.from }}</p></template>
                <span class="download-hint">↓ {{ draft.directoryChange ? $t('本次使用的合集目录') : draft.bound ? $t('当前作品目录') : $t('作品子目录') }}</span><p class="mono" :title="location">{{ location || $t('请先选择影视库目录') }}</p></div>
              <button class="btn btn--ghost" type="button" :disabled="busy || draft.bound" @click="flow.pickRoot"><FolderOpen :size="14" />{{ $t("更换目录") }}</button>
            </div>
            <p v-if="draft.directoryChange" class="download-directory-change">{{ $t("开始补齐时，当前文件夹会更名为上面的合集目录。现有视频文件名和观看记录保留；同名目录已存在时会停止并提示。") }}</p>
            <p v-if="!draft.bound" class="download-hint">{{ $t("名称中的特殊字符和目录重名会在加入队列时自动处理，实际保存位置可在任务中打开。") }}</p>
            <p v-if="needsPrepare" class="download-hint" role="status">{{ $t("链接已更改，请重新解析后再下载。") }}</p>
            <div class="download-selection">
              <span>{{ $t("已发现 {p0} 项 · {p1} 项本地已有 · 已选 {p2}", {p0: (episodes.length), p1: (localCount), p2: (selectedVideoCodes.length)}) }}</span>
              <div><button type="button" :disabled="busy" @click="selectMissing">{{ $t("只选缺失") }}</button><button type="button" :disabled="busy" @click="selectAll">{{ $t("全选") }}</button><button type="button" :disabled="busy" @click="selectedVideoCodes = []">{{ $t("清空") }}</button></div>
            </div>
            <ul class="download-contents" :aria-label="$t('来源内容与本地状态')">
              <li v-for="episode in episodes" :key="episode.videoCode">
                <label><input v-model="selectedVideoCodes" type="checkbox" :value="episode.videoCode" :disabled="busy || episode.state === 'queued' || episode.state === 'other-work' || updatesOnly&&episode.state==='local'" /><span><small v-if="!discovery" class="download-episode-number">{{ episode.numbered === false ? $t('集数待确认') : $t('第 {p0} 集', {p0: episode.order}) }}</small>{{ episode.originalTitle || episode.title || episode.videoCode }}<small v-if="episode.qualities.length">{{ episode.qualities.join(' · ') }}</small></span></label>
                <span :class="['download-state', `download-state--${episode.state}`]">{{ stateLabels[episode.state] }}</span>
              </li>
            </ul>
            <div class="download-options">
              <label class="download-field"><span>{{ $t("目标清晰度") }}</span><select v-model="sourceLabel" class="select" :disabled="busy"><option value="">{{ $t("最高可用") }}</option><option v-for="quality in draft?.qualities || ['1080p', '720p', '480p', '360p']" :key="quality" :value="quality">{{ quality }}</option></select></label>
              <label class="download-check"><input v-model="strictQuality" type="checkbox" :disabled="busy || !sourceLabel" /><span>{{ $t("严格匹配清晰度") }}<small>{{ strictQuality && sourceLabel ? $t('没有目标清晰度时保留为待处理') : $t('没有目标清晰度时回退到可用清晰度') }}</small></span></label>
            </div>
            <fieldset class="download-mode" :disabled="busy"><legend>{{ $t("下载完成后") }}</legend><label><input v-model="register" type="radio" :value="true" />{{ $t("登记到影视库") }}</label><label><input v-model="register" type="radio" :value="false" />{{ $t("仅保存文件") }}</label></fieldset>
            <p v-if="missingMetadata.length && register" class="download-hint">{{ $t("{p0}待补齐，任务中会单独记录资料与入库结果。", {p0: (missingMetadata.join('、'))}) }}</p>
            <ul v-if="draft.warnings.length" class="download-warnings"><li v-for="warning in draft.warnings" :key="warning">{{ $systemMessage(warning) }}</li></ul>
          </template>
          <p v-if="error && !draftHidden" class="download-error" role="alert">{{ $systemMessage(error) }}</p>
          <div v-if="currentJob" class="download-result" role="status">
            <p>{{ $systemMessage(currentJob.message) }}</p><small>{{ $t("可在顶部任务中心查看进度，离开页面后仍会继续。") }}</small>
            <button v-if="currentJob.resourceId" class="btn btn--ghost" type="button" @click="router.push({ name: 'video-detail', params: { id: currentJob.resourceId } }); close()"><ExternalLink :size="14" />{{ $t("打开作品") }}</button>
          </div>
        </div>
        <footer class="download-panel__footer">
          <p class="hint">{{ $t("下载工具与缓存可在右上角设置 → 影视 → 下载与缓存中管理。") }}</p>
          <button v-if="(id || discovery) && (!draft||updatesOnly)" type="button" class="btn btn--ghost" :disabled="busy" @click="flow.prepare"><RefreshCw :size="14" />{{updatesOnly?$t('重新检查'):$t('重新解析')}}</button>
          <button type="button" class="btn btn--primary" :disabled="busy || !draft || draftHidden || needsPrepare || !title.trim() || !selectedVideoCodes.length" @click="enqueue"><Loader2 v-if="enqueuing" :size="14" class="spin" /><Download v-else :size="14" />{{ enqueuing ? $t('正在加入队列') : $t('下载所选{p0}', {p0: selectedVideoCodes.length ? $t(' {p0} 项', {p0: selectedVideoCodes.length}) : ''}) }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.download-overlay { position: fixed; inset: 0; z-index: 130; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / .48); -webkit-app-region: no-drag; }
.download-panel { width: min(720px, 100%); max-height: calc(100dvh - 48px); display: flex; flex-direction: column; background: var(--bg-main); color: var(--text-main); border: 1px solid var(--divider); border-radius: var(--radius-card); box-shadow: var(--shadow-pop); overflow: hidden; }
.download-panel__head, .download-panel__footer { display: flex; align-items: center; gap: 12px; padding: 16px 20px; }
.download-panel__head { border-bottom: 1px solid var(--divider); justify-content: space-between; }
.download-panel__head h2 { font-size: 17px; font-weight: 500; }
.download-panel__head p { margin-top: 5px; color: var(--text-faint); font-size: var(--fs-tag); }
.download-panel__body { display: flex; flex-direction: column; gap: 14px; min-height: 0; padding: 18px 20px; overflow-y: auto; }
.download-panel__footer { border-top: 1px solid var(--divider); flex-wrap: wrap; }
.download-panel__footer .btn--primary { margin-left: auto; }
.download-url, .download-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; color: var(--text-sub); font-size: var(--fs-tag); }
.download-url > label { display: flex; align-items: center; gap: 6px; }
.download-url__input { display: flex; gap: 8px; }
.download-url__input input { flex: 1; min-width: 0; }
.download-hint { font-size: var(--fs-tag); line-height: 1.6; color: var(--text-faint); }
.download-location { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--hover-surface); border-radius: var(--radius-input); }
.download-location > div { flex: 1; min-width: 0; }
.download-location p { margin-top: 3px; font-size: var(--fs-tag); overflow-wrap: anywhere; }
.download-directory-change { border-left: 2px solid var(--accent); padding-left: 10px; color: var(--text-sub); font-size: 12px; line-height: 1.7; }
.download-contents .download-episode-number { color: var(--text-sub); margin: 0 0 3px; font-variant-numeric: tabular-nums; }
.download-selection { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: var(--fs-tag); color: var(--text-sub); }
.download-selection > div { display: flex; gap: 12px; }
.download-selection button { color: var(--accent); }
.download-contents { margin: 0; padding: 0; list-style: none; max-height: 260px; overflow-y: auto; border-block: 1px solid var(--divider); }
.download-contents li { display: flex; align-items: center; gap: 14px; min-height: 40px; padding: 7px 3px; }
.download-contents li + li { border-top: 1px solid var(--divider); }
.download-contents label { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; font-size: var(--fs-body); }
.download-contents label span { min-width: 0; overflow-wrap: anywhere; }
.download-contents small { display: block; margin-top: 2px; color: var(--text-faint); font-size: 11px; }
.download-state { flex: none; color: var(--text-faint); font-size: var(--fs-tag); }
.download-state--local { color: var(--success); }
.download-state--missing { color: var(--warning); }
.download-options { display: grid; grid-template-columns: 170px minmax(0, 1fr); align-items: end; gap: 20px; }
.download-check { display: flex; gap: 8px; align-items: center; font-size: var(--fs-tag); color: var(--text-sub); }
.download-check small { display: block; color: var(--text-faint); margin-top: 4px; }
.download-mode { display: flex; gap: 18px; border: 0; padding: 0; margin: 0; font-size: var(--fs-tag); color: var(--text-sub); }
.download-mode legend { margin-bottom: 7px; }
.download-mode label { display: flex; gap: 6px; align-items: center; }
input[type=checkbox], input[type=radio] { accent-color: var(--accent); flex: none; }
.download-warnings { padding-left: 18px; margin: 0; color: var(--warning); font-size: var(--fs-tag); line-height: 1.6; }
.download-error { color: var(--danger); font-size: var(--fs-tag); overflow-wrap: anywhere; }
.download-result { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px 12px; border: 1px solid var(--divider); border-radius: var(--radius-input); }
.download-result p { font-size: var(--fs-body); }
.download-result small { color: var(--text-faint); }
.download-panel :is(button, input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.download-panel { --text-faint: var(--text-sub); }
.download-selection button { min-height: 28px; color: var(--text-main); text-decoration: underline; text-underline-offset: 3px; }
.download-location .download-hint:not(:first-child) { display: block; margin-top: 6px; }
:global([data-theme='light']) .download-panel { --success: #21713c; --warning: #825800; --danger: #b42332; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 620px) { .download-overlay { padding: 10px; } .download-panel { max-height: calc(100dvh - 20px); } .download-options { grid-template-columns: 1fr; gap: 12px; } .download-panel__body { padding: 14px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
