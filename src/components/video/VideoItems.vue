<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Clapperboard, FolderOpen, LayoutGrid, List, LocateFixed, Loader2, Play, RefreshCw } from 'lucide-vue-next'
import type { VideoAsset, VideoItem, WatchStatus } from '@/types'
import type { VideoWorkContent, VideoWorkLibrary } from '@/types/video-workflow'
import { errorMessage, formatBytes, formatDuration, posterUrl } from '@/utils'
import { useToast } from '@/composables/useToast'
import { videoEpisodeLabel, registeredVideoContent } from '@/utils/video-content'

const props = defineProps<{ item: VideoItem; library: VideoWorkLibrary | null; checking?: boolean; checkMessage?: string; marking?: boolean; selectedId?: string }>()
const emit = defineEmits<{ changed: []; check: []; watched: [content: VideoWorkContent | null, status: WatchStatus]; select: [content: VideoWorkContent]; remove: [content: VideoWorkContent] }>()
const { error, success } = useToast()
const busy = ref('')
const selectedVersions = ref<Record<string, string>>({})
const view = ref<'cards' | 'list'>('cards')
try { if (localStorage.getItem('video-content-view') === 'list') view.value = 'list' } catch { /* Use the default when storage is unavailable. */ }
const failedPosters = ref<Record<string, string>>({})
function changeView(value: 'cards' | 'list'): void {
  view.value = value
  try { localStorage.setItem('video-content-view', value) } catch { /* A preference need not block the view. */ }
}
type ContentRow = { id: string; title: string; label: string; poster: string; content: VideoWorkContent | null; assets: VideoAsset[]; path: string; watched: boolean; duration: number }
const rows = computed<ContentRow[]>(() => {
  const contents = (props.library?.contents ?? []).filter(registeredVideoContent)
  const episodes = contents.map(content => ({
    id: content.id, title: content.original_title || content.title || content.display_label || '未命名内容',
    label: videoEpisodeLabel(content, props.item.category === '里番'), poster: (content.thumbnail_path || content.poster_path) ? posterUrl((content.thumbnail_path || content.poster_path)!) : '',
    content, assets: content.assets.filter(asset => asset.role === 'video'), path: content.path,
    watched: content.watch_status === 'watched', duration: content.duration_sec
  }))
  const linked = new Set(contents.flatMap(content => content.assets.map(asset => asset.id)))
  const loose = (props.library?.assets ?? []).filter(asset => asset.role === 'video' && !linked.has(asset.id)).map(asset => ({
    id: asset.id, title: props.item.parts.find(part => part.path === asset.path)?.label || (props.library!.assets.filter(value => value.role === 'video').length === 1 ? props.item.name_zh || props.item.name_en || props.item.file_name : basename(asset.path)),
    label: contents.length ? '未归集文件' : '', poster: '', content: null, assets: [asset], path: asset.path,
    watched: props.item.watch_status === 'watched', duration: props.item.duration_sec
  }))
  return [...episodes, ...loose]
})
const available = computed(() => rows.value.filter(row => row.assets.some(asset => asset.state === 'present')).length)
const stateLabels = { present: '文件可用', missing: '文件缺失', offline: '磁盘离线', unchecked: '尚未检查' }
function basename(path: string): string { return path.split(/[\\/]/).pop() || path }
function selected(row: ContentRow): VideoAsset | undefined {
  return row.assets.find(asset => asset.id === selectedVersions.value[row.id])
    ?? row.assets.find(asset => asset.path === row.path) ?? row.assets.find(asset => asset.state === 'present') ?? row.assets[0]
}
function versionLabel(asset: VideoAsset): string {
  return [asset.quality, basename(asset.path), asset.file_size ? formatBytes(asset.file_size) : '', asset.state === 'present' ? '' : stateLabels[asset.state]].filter(Boolean).join(' · ')
}
function checkedAt(asset?: VideoAsset): string {
  return asset?.checked_at ? `检查于 ${new Date(asset.checked_at).toLocaleString('zh-CN', { hour12: false })}` : '尚未检查'
}
watch(() => props.library, () => {
  const next: Record<string, string> = {}
  for (const row of rows.value) {
    const asset = selected(row)
    if (asset) next[row.id] = asset.id
  }
  selectedVersions.value = next
}, { immediate: true })
async function play(row: ContentRow): Promise<void> {
  const asset = selected(row)
  if (!asset || busy.value || asset.state !== 'present') return
  busy.value = row.id
  try {
    const outcome = await window.baoyi.video.playAsset(asset.id)
    if (!outcome.ok) error(outcome.message || '无法打开文件')
    emit('changed')
  } catch (cause) { error(errorMessage(cause)) }
  finally { busy.value = '' }
}
async function setDefault(row: ContentRow): Promise<void> {
  const asset = selected(row)
  if (!asset || asset.state !== 'present' || !row.content || busy.value) return
  busy.value = row.id
  try {
    if (await window.baoyi.video.setDefaultAsset(row.content.id, asset.id)) { success('已设为默认版本'); emit('changed') }
    else error('未能设置默认版本，请重新检查文件')
  } catch (cause) { error(errorMessage(cause)) }
  finally { busy.value = '' }
}
async function reveal(row: ContentRow): Promise<void> {
  const asset = selected(row)
  if (!asset) return
  try { if (!(await window.baoyi.video.revealAsset(asset.id))) error('文件位置不可用，请检查磁盘是否在线') }
  catch (cause) { error(errorMessage(cause)) }
}
async function relocate(row: ContentRow): Promise<void> {
  const asset = selected(row)
  if (!asset || busy.value) return
  busy.value = row.id
  try {
    if (await window.baoyi.video.relocateAsset(asset.id)) { success('已更新文件位置'); emit('changed') }
  } catch (cause) { error(errorMessage(cause)) }
  finally { busy.value = '' }
}
async function copyPath(row: ContentRow): Promise<void> {
  const asset = selected(row)
  if (!asset) return
  try { await window.baoyi.app.copyText(asset.path); success('文件路径已复制') }
  catch (cause) { error(errorMessage(cause)) }
}
</script>

<template>
  <section class="panel video-items" :class="{ 'video-items--cards': view === 'cards' }">
    <header class="video-items__head">
      <h2>作品内容 <span>{{ rows.length }} 项内容 · {{ available }} 项可播放<template v-if="available < rows.length"> · {{ rows.length - available }} 项待补齐</template></span></h2>
      <div class="video-items__tools">
        <div class="video-items__views" role="group" aria-label="内容视图">
          <button type="button" aria-label="卡片视图" :aria-pressed="view === 'cards'" title="卡片视图" @click="changeView('cards')"><LayoutGrid :size="15" /></button>
          <button type="button" aria-label="列表视图" :aria-pressed="view === 'list'" title="列表视图" @click="changeView('list')"><List :size="15" /></button>
        </div>
        <button class="btn btn--subtle" type="button" :disabled="checking" @click="emit('check')"><Loader2 v-if="checking" :size="13" class="spin" /><RefreshCw v-else :size="13" />{{ checking ? '正在检查…' : '检查文件' }}</button>
      </div>
    </header>
    <p v-if="checkMessage" class="video-items__check-result" role="status">{{ checkMessage }}</p>
    <div v-if="rows.length && view === 'list'" class="video-items__columns" aria-hidden="true"><span>看过</span><span>内容</span><span>文件 / 版本</span><span>可用性</span><span>操作</span></div>
    <ul v-if="rows.length" class="video-items__list" aria-label="作品内容">
      <li v-for="row in rows" :key="row.id" class="video-item" :class="{ 'video-item--watched': row.watched, 'video-item--selected': row.id === selectedId }">
        <button v-if="view === 'cards'" class="video-item__cover" type="button" :disabled="!row.content" :aria-label="`打开${row.label || row.title}资料`" @click="row.content && emit('select', row.content)">
          <img v-if="row.poster && failedPosters[row.id] !== row.poster" :src="row.poster" :alt="row.title" loading="lazy" @error="failedPosters[row.id] = row.poster" />
          <span v-else class="video-item__placeholder"><Clapperboard :size="30" /><span>暂无封面</span></span>
          <span class="video-item__cover-label">{{ row.label || '视频' }}</span>
        </button>
        <button class="video-item__check" type="button" :disabled="marking" :aria-label="`${row.watched ? '标记未看' : '标记看过'}：${row.title}`" :aria-pressed="row.watched" @click="emit('watched', row.content, row.watched ? 'unwatched' : 'watched')"><Check v-if="row.watched" :size="13" /></button>
        <div class="video-item__title">
          <small v-if="view === 'cards' && row.content?.tags?.length" class="video-item__tags">{{ row.content.tags.slice(0, 5).join(' · ') }}</small>
          <small v-if="row.label" class="video-item__number">{{ row.label }}<template v-if="row.content?.display_label && row.content.display_label !== row.label"> · {{ row.content.display_label }}</template></small>
          <button v-if="row.content" type="button" :title="row.content.title || row.title" :aria-label="`查看${row.label}简介`" @click="emit('select', row.content)">{{ row.title }}</button>
          <span v-else :title="row.title">{{ row.title }}</span>
          <small v-if="row.duration > 0">{{ formatDuration(row.duration) }}</small>
        </div>
        <div class="video-item__version">
          <template v-if="row.assets.length > 1">
            <select :value="selected(row)?.id" :disabled="!!busy" :aria-label="`${row.title} 的文件版本`" @change="selectedVersions[row.id] = ($event.target as HTMLSelectElement).value"><option v-for="asset in row.assets" :key="asset.id" :value="asset.id">{{ versionLabel(asset) }}</option></select>
            <button v-if="row.content && selected(row)?.path !== row.path" type="button" :disabled="!!busy || selected(row)?.state !== 'present'" @click="setDefault(row)">设为默认</button><small v-else>默认版本 · {{ row.assets.length }} 个文件</small>
          </template>
          <span v-else-if="selected(row)" class="truncate" :title="selected(row)?.path">{{ selected(row)?.quality || basename(selected(row)!.path) }}</span>
          <small v-else>尚无本地文件</small>
          <button v-if="selected(row)" type="button" :aria-label="`复制文件路径：${row.title}`" @click="copyPath(row)">复制路径</button>
        </div>
        <div class="video-item__state" :class="`video-item__state--${selected(row)?.state || 'missing'}`" :title="checkedAt(selected(row))"><span>{{ selected(row) ? stateLabels[selected(row)!.state] : '尚未下载' }}</span><small v-if="selected(row)?.checked_at">已检查</small></div>
        <div class="video-item__actions">
          <button type="button" :disabled="!!busy || selected(row)?.state !== 'present'" :aria-label="`播放：${row.title}`" title="播放所选文件" @click="play(row)"><Loader2 v-if="busy === row.id" :size="15" class="spin" /><Play v-else :size="15" /></button>
          <button type="button" :disabled="!selected(row)" :aria-label="`打开文件位置：${row.title}`" title="打开文件位置" @click="reveal(row)"><FolderOpen :size="15" /></button>
          <button type="button" :disabled="!!busy || !selected(row)" :aria-label="`重新定位文件：${row.title}`" title="重新定位文件" @click="relocate(row)"><LocateFixed :size="15" /></button>
        </div>
      </li>
    </ul>
    <p v-else class="video-items__empty">尚无内容记录。可添加本地目录、导入资源包，或从来源链接补齐。</p>
  </section>
</template>

<style scoped>
.video-items { padding: 12px 14px; min-width: 0; }
.video-items__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.video-items__head h2 { min-width: 0; font-size: var(--fs-body); font-weight: 500; }
.video-items__head h2 span { color: var(--text-faint); font-size: var(--fs-tag); font-weight: 400; margin-left: 8px; }
.video-items__tools, .video-items__views { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
.video-items__views { padding: 2px; border: 1px solid var(--divider); border-radius: 6px; margin-right: 6px; }
.video-items__views button { display: grid; place-items: center; width: 28px; height: 27px; border-radius: 4px; color: var(--text-sub); }
.video-items__views button[aria-pressed='true'] { background: var(--hover-surface); color: var(--accent); }
.video-items__check-result { font-size: 11px; color: var(--text-sub); line-height: 1.7; margin: 6px 0 12px; }
.video-items__columns, .video-item { display: grid; grid-template-columns: 26px minmax(110px, 1fr) minmax(90px, .65fr) 66px 84px; align-items: center; gap: 10px; }
.video-items__columns { color: var(--text-faint); font-size: 10px; padding: 5px 0; border-bottom: 1px solid var(--divider); }
.video-items__list { list-style: none; margin: 0; padding: 0; }
.video-item { min-height: 48px; padding: 5px 0; }
.video-item + .video-item { border-top: 1px solid var(--divider); }
.video-item__check { display: grid; place-items: center; width: 19px; height: 19px; border: 1px solid var(--divider); border-radius: 4px; color: var(--accent); }
.video-item__title, .video-item__version, .video-item__state { min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-tag); }
.video-item__title > span, .video-item__title > button { text-align: left; font-size: var(--fs-body); line-height: 1.5; overflow-wrap: anywhere; }
.video-item__title > button:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.video-item--watched .video-item__title > :is(span, button) { color: var(--text-sub); }
.video-item--selected { background: var(--hover-surface); }
.video-item .video-item__number { color: var(--text-sub); font-variant-numeric: tabular-nums; }
.video-item small { color: var(--text-faint); font-size: 10px; }
.video-item__version { color: var(--text-sub); }
.video-item__version select { width: 100%; min-width: 0; height: 25px; padding: 0 4px; border: 1px solid var(--divider); border-radius: 4px; background: var(--bg-main); color: var(--text-sub); font-size: 11px; }
.video-item__version button { text-align: left; color: var(--accent); font-size: 10px; }
.video-item__state { color: var(--text-sub); font-size: 11px; }
.video-item__state--missing, .video-item__state--offline { color: var(--warning); }
.video-item__actions { display: flex; gap: 2px; }
.video-item__actions button { width: 27px; height: 28px; display: grid; place-items: center; color: var(--text-sub); border-radius: 4px; }
.video-item__actions button:hover:not(:disabled) { background: var(--hover-surface); color: var(--accent); }
.video-item__actions button:disabled { opacity: .35; cursor: default; }
.video-items--cards { padding: 16px; }
.video-items--cards .video-items__head { margin-bottom: 14px; }
.video-items--cards .video-items__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(205px, 1fr)); gap: 14px; align-items: start; }
.video-items--cards .video-item { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 9px; padding: 0 11px 10px; border: 1px solid var(--divider); border-radius: 9px; overflow: hidden; }
.video-items--cards .video-item--selected { border-color: var(--accent); }
.video-item__cover { position: relative; grid-column: 1 / -1; width: calc(100% + 22px); margin: 0 -11px; aspect-ratio: 16 / 10; display: grid; place-items: center; overflow: hidden; background: var(--bg-main); }
.video-item__cover img { width: 100%; height: 100%; object-fit: contain; }
.video-item__cover-label { position: absolute; bottom: 9px; left: 10px; background: rgba(20, 20, 29, .85); color: #fff; border-radius: 4px; padding: 3px 7px; font-size: 11px; }
.video-item__placeholder { display: grid; justify-items: center; gap: 9px; color: var(--text-faint); font-size: 12px; }
.video-items--cards .video-item__check { position: absolute; right: 9px; top: 9px; z-index: 1; width: 24px; height: 24px; background: var(--bg-elevated); border-color: var(--text-faint); }
.video-items--cards .video-item__title { grid-column: 1 / -1; min-height: 44px; }
.video-items--cards .video-item__title > :is(span, button) { font-size: 12px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.video-items--cards .video-item__number { display: none; }
.video-items--cards .video-item__version { grid-column: 1 / -1; min-height: 34px; }
.video-items--cards .video-item__state { grid-column: 1; grid-row: auto; }
.video-items--cards .video-item__state small { display: none; }
.video-items--cards .video-item__actions { grid-column: 2; }
.video-items :is(button, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.video-items__empty { padding: 12px 0; color: var(--text-faint); font-size: var(--fs-tag); line-height: 1.7; }
.video-items { --text-sub: color-mix(in srgb, var(--text-main) 70%, var(--bg-main)); --text-faint: var(--text-sub); }
.video-item__version button { color: var(--text-sub); min-height: 20px; text-decoration: underline; text-underline-offset: 2px; }
.video-item__version button:disabled { opacity: .5; cursor: default; }
:global([data-theme='light']) .video-items { --warning: #825800; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 620px) { .video-items__columns { display: none; } .video-item { grid-template-columns: 22px minmax(0, 1fr) 68px 84px; gap: 7px; } .video-item__version { grid-column: 2; grid-row: auto; } .video-item__state { grid-column: 3; grid-row: auto; } .video-items__head h2 span { display: block; margin: 4px 0 0; } .video-items__head { flex-wrap: wrap; } .video-items--cards .video-items__list { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
