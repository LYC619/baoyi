<script setup lang="ts">
import { computed } from 'vue'
import type { VideoOrganizePreview, VideoOrganizeRequest, VideoRelocatePreview } from '@/types/video-organize'
import { formatBytes, formatPosition } from '@/utils'
import { WATCH_STATUS_LABEL } from '@/stores/video'
import type { WatchStatus } from '@/types'

const props = withDefaults(defineProps<{ preview: VideoOrganizePreview | VideoRelocatePreview; fileNames: Record<string, string>; episodeNumbers?: VideoOrganizeRequest['episodeNumbers']; copyFiles?: boolean; disabled?: boolean; withoutSeason?: boolean }>(), { disabled: false, copyFiles: false, episodeNumbers: () => ({}), withoutSeason: false })
defineEmits<{ rename: [id: string, name: string]; number: [id: string, season: number, episode: number] }>()
const actionLabels = { move: '移动，校验后移除原件', copy: '复制，保留原件', keep: '保留原位置', verify: '核对后重绑', none: '仅合并关联' }
const stateLabels = { present: '可用', missing: '文件缺失', offline: '磁盘离线', unchecked: '尚未检查' }
const scopeLabels = { logical: '请调整集数或作品归属', physical: '请调整复制目录', file: '此文件待处理' }
const basename = (path: string) => path.split(/[\\/]/).pop() || path
const orderedEpisodes = computed(() => props.preview.kind === 'organize'
  ? [...props.preview.episodes].sort((a, b) => a.season - b.season || a.episode - b.episode || a.title.localeCompare(b.title, 'zh-CN', { numeric: true }))
  : [])
const showSeasons = computed(() => !props.withoutSeason && orderedEpisodes.value.some(episode => episode.season > 0))
const collisions = computed(() => props.preview.collisions.filter(collision => props.copyFiles || collision.scope === 'logical'))
</script>

<template>
  <section class="organize-preview" aria-label="整理预览">
    <template v-if="preview.kind === 'organize'">
      <section class="organize-episodes">
        <header><h3>合集内容 <span>{{ preview.episodes.length }} 集</span></h3><p>原名、单集简介、笔记和观看进度随各集保留。可以直接调整编号。</p></header>
        <ul aria-label="合集集数">
          <li v-for="episode in orderedEpisodes" :key="episode.id">
            <div class="organize-episode-title"><strong>{{ episode.title || '未命名内容' }}</strong><small>{{ preview.works.find(work => work.resourceId === episode.resourceId)?.name }}</small></div>
            <label v-if="showSeasons"><span>季</span><input type="number" min="0" max="1000" :value="episodeNumbers[episode.id]?.season ?? episode.season" :aria-label="(episode.title || '未命名内容') + ' 的季数'" :disabled="disabled" @input="$emit('number', episode.id, Number(($event.target as HTMLInputElement).value), episodeNumbers[episode.id]?.episode ?? episode.episode)" /></label>
            <label><span>第</span><input type="number" min="0" max="10000" :value="episodeNumbers[episode.id]?.episode ?? episode.episode" :aria-label="(episode.title || '未命名内容') + ' 的集数'" :disabled="disabled" @input="$emit('number', episode.id, episodeNumbers[episode.id]?.season ?? episode.season, Number(($event.target as HTMLInputElement).value))" /><span>集</span></label>
          </li>
        </ul>
      </section>
      <details class="organize-originals">
        <summary>查看原作品与笔记 · {{ preview.works.length }} 部</summary>
        <p class="organize-preview__impact">内容统一展示在合集里，原作品记录归档保存。可在整理记录中回退本次操作。</p>
        <ul class="organize-works" aria-label="所选作品的资料与笔记">
          <li v-for="work in preview.works" :key="work.resourceId">
            <div class="organize-works__name"><strong>{{ work.name }}</strong><span>{{ work.resourceId === preview.survivor.resourceId ? '合集所用记录' : '合并后归档' }}</span></div>
            <p class="organize-path">{{ work.path || '尚无主文件位置' }}</p>
            <p class="organize-works__notes">笔记：{{ work.notes || '无' }}</p>
            <small>{{ WATCH_STATUS_LABEL[work.watchStatus as WatchStatus] || work.watchStatus }} · {{ work.positionSec ? `进度 ${formatPosition(work.positionSec)}` : '尚无播放进度' }} · {{ work.fileIds.length }} 个关联文件</small>
          </li>
        </ul>
      </details>
    </template>
    <template v-else>
      <h3>{{ preview.request.mode === 'rebind' ? '重新绑定已有目录' : '复制整个作品目录' }}</h3>
      <p class="organize-preview__impact">{{ preview.request.mode === 'rebind' ? '核对你已移动或复制的目录后，更新作品、内容和文件的位置。' : '复制视频、字幕、海报、附件及子目录，全部核对成功后切换作品位置。' }}作品身份、资料、观看记录和原文件保留；任何文件失败都不会切换整个目录。</p>
      <p class="organize-path">原目录：{{ preview.sourceDirectory }}</p>
      <p v-if="preview.directories.length">包含 {{ preview.directories.length }} 个子目录（含空目录）。</p>
    </template>
    <section v-if="collisions.length" class="organize-collisions" aria-label="整理冲突">
      <h3>需要处理</h3>
      <ul><li v-for="(collision, index) in collisions" :key="index"><strong>{{ scopeLabels[collision.scope] }}</strong><span>{{ collision.message }}</span><small v-if="collision.path" class="organize-path">{{ collision.path }}</small></li></ul>
      <p v-if="copyFiles && preview.kind === 'organize' && preview.canOrganize">文件问题只影响对应文件，其余文件可继续完成；结果会逐项记录。</p>
    </section>
    <template v-if="copyFiles || preview.kind === 'relocate'">
      <p class="organize-path organize-preview__target">目标目录：{{ preview.targetDirectory || '请填写目标目录' }}</p>
      <ul v-if="preview.warnings.length" class="organize-warnings"><li v-for="(warning, index) in preview.warnings" :key="index">{{ warning }}</li></ul>
      <h3>文件计划 · {{ preview.files.length }} 个</h3>
      <p v-if="preview.kind === 'organize'" class="organize-hint">{{ preview.request.transfer === 'move' ? '移动会在全部文件和清单校验成功后移除原件，可在整理记录回退。' : '复制后保留原件。' }}同名目标不会覆盖，修改文件名后自动更新预览。</p>
      <ul class="organize-files" aria-label="源文件与目标文件">
        <li v-for="file in preview.files" :key="file.id">
          <div><strong>{{ basename(file.source) }}</strong><small>{{ formatBytes(file.size) }} · {{ stateLabels[file.state] }} · {{ actionLabels[file.action] }}</small></div>
          <p class="organize-path"><span>源</span>{{ file.source }}</p>
          <p class="organize-path"><span>→</span>{{ file.destination || '尚未指定' }}</p>
          <label v-if="preview.kind === 'organize' && preview.targetDirectory" class="organize-files__rename"><span>目标相对路径</span><input :value="fileNames[file.id] ?? file.relativePath" :disabled="disabled" :aria-label="'目标相对路径：' + basename(file.source)" spellcheck="false" @input="$emit('rename', file.id, ($event.target as HTMLInputElement).value)" /></label>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.organize-preview { display: grid; gap: 12px; min-width: 0; }
h3 { font-size: 13px; font-weight: 600; }
p, li { font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.organize-preview__impact, .organize-hint { color: var(--text-sub); }
.organize-preview__capabilities { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
.organize-preview__capabilities span { padding: 4px 8px; border: 1px solid var(--divider); border-radius: 4px; color: var(--text-main); }
.organize-preview__capabilities .blocked { color: var(--warning); }
.organize-path { font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; }
.organize-preview__target { padding-block: 8px; border-block: 1px solid var(--divider); }
.organize-works, .organize-files, .organize-episodes ul, .organize-collisions ul { padding: 0; margin: 0; list-style: none; }
.organize-works > li, .organize-files > li { display: grid; gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--divider); }
.organize-works__name { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.organize-works__name span { flex: none; color: var(--text-sub); font-size: 11px; }
.organize-works__notes { white-space: pre-wrap; }
small { color: var(--text-sub); font-size: 11px; }
.organize-episodes { padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--divider); border-radius: 5px; }
.organize-episodes summary { cursor: pointer; font-size: 12px; }
.organize-episodes p { margin: 8px 0; color: var(--text-sub); }
.organize-episodes ul { max-height: 180px; overflow: auto; }
.organize-episodes li { display: flex; flex-wrap: wrap; gap: 6px 12px; padding-block: 3px; }
.organize-episodes strong { font-weight: 400; }
.organize-warnings { margin: 0; padding-left: 18px; color: var(--text-sub); }
.organize-collisions { display: grid; gap: 8px; border-left: 3px solid var(--warning); padding: 8px 12px; background: var(--bg-card); }
.organize-collisions li { display: flex; flex-wrap: wrap; gap: 4px 8px; padding-block: 4px; }
.organize-collisions strong { color: var(--warning); }
.organize-collisions small { flex-basis: 100%; }
.organize-files > li > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.organize-files .organize-path { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 4px; }
.organize-files__rename { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-sub); }
.organize-files__rename span { flex: none; }
.organize-files__rename input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--divider); border-radius: 4px; background: var(--bg-main); color: var(--text-main); font-size: 12px; }
.organize-episodes { padding: 0; border: 0; background: transparent; }
.organize-episodes h3 { display: flex; gap: 8px; align-items: center; }
.organize-episodes h3 span { color: var(--text-sub); font-size: 11px; font-weight: 400; }
.organize-episodes header p { font-size: 11px; }
.organize-episodes ul { max-height: 280px; }
.organize-episodes li { align-items: center; flex-wrap: nowrap; padding: 10px 0; border-bottom: 1px solid var(--divider); }
.organize-episode-title { display: grid; gap: 3px; flex: 1; min-width: 0; }
.organize-episode-title strong { font-weight: 500; }
.organize-episode-title small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.organize-episodes label { flex: none; display: flex; align-items: center; gap: 5px; color: var(--text-sub); font-size: 11px; }
.organize-episodes input { width: 60px; min-width: 0; height: 31px; padding: 4px 5px; border: 1px solid var(--divider); border-radius: 5px; color: var(--text-main); background: var(--bg-main); font-size: 12px; }
.organize-originals > summary { cursor: pointer; font-size: 12px; color: var(--text-sub); }
.organize-originals > p { margin-top: 9px; }
:is(input, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
