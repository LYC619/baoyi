<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ExternalLink,
  FolderOpen,
  Image,
  ListOrdered,
  ListPlus,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Trash2
} from 'lucide-vue-next'
import type { VideoItem } from '@/types'
import type { VideoWorkLibrary } from '@/types/video-workflow'
import type { AudioLyrics } from '@/utils/lyrics'
import { activeLyricIndex } from '@/utils/lyrics'
import { audioTracks, type AudioMetadata, type AudioTrack } from '@/utils/audio'
import { useAudioStore } from '@/stores/audio'
import { useVideoStore } from '@/stores/video'
import { errorMessage, formatBytes, formatPosition, posterUrl } from '@/utils'
import { useToast } from '@/composables/useToast'
import DetailTabs from '@/components/ui/DetailTabs.vue'
import VideoRemovalDialog from './VideoRemovalDialog.vue'
import ResourceBacklinksPanel from '@/components/workspace/ResourceBacklinksPanel.vue'

const props = defineProps<{ item: VideoItem; library: VideoWorkLibrary | null }>()
const emit = defineEmits<{ refresh: [] }>()

const route = useRoute()
const router = useRouter()
const audio = useAudioStore()
const store = useVideoStore()
const { error, success } = useToast()

const title = computed(() => props.item.name_zh || props.item.file_name)
const tracks = computed(() => (props.library ? audioTracks(props.item, props.library) : []))
const trackId = ref('')
const selected = computed(() => tracks.value.find(t => t.id === trackId.value) || tracks.value[0])
const tabs = [
  { id: 'listen', get label() { return tr("曲目与歌词") } },
  { id: 'info', get label() { return tr("简介与笔记") } },
  { id: 'files', get label() { return tr("音频信息与文件") } }
]
const tab = ref(tabs.some(t => t.id === route.query.audioTab) ? String(route.query.audioTab) : 'listen')
const editing = ref(false)
const removing = ref(false)
const removingEpisodeId = ref('')
const posterFailed = ref(false)
const busy = ref(false)
const reordering = ref(false)
const draftOrder = ref<AudioTrack[]>([])
const metadata = ref<AudioMetadata | null>(null)
const lyrics = ref<AudioLyrics | null>(null)
const reading = ref(false)
const readError = ref('')
const measuredDuration = ref(0)
const lyricPane = ref<HTMLElement>()
const follow = ref(true)

const selectedFile = computed(
  () =>
    props.library?.contents.find(c => c.id === selected.value?.episode)?.path ||
    props.item.parts[0]?.path ||
    props.item.path
)
const current = computed(() => !!selected.value && audio.current?.id === selected.value.id)
const currentLine = computed(() =>
  current.value && lyrics.value?.timed ? activeLyricIndex(lyrics.value.lines, audio.position) : -1
)
const length = computed(() => (current.value ? audio.duration : measuredDuration.value || selected.value?.duration || 0))

watch(
  () => route.query.track,
  value => {
    if (typeof value === 'string' && tracks.value.some(t => t.id === value || t.episode === value)) {
      trackId.value = value
    }
  },
  { immediate: true }
)
watch(
  tracks,
  rows => {
    if (!rows.some(t => t.id === trackId.value)) {
      trackId.value =
        rows.find(t => t.id === route.query.track || t.episode === route.query.track)?.id ||
        rows.find(t => t.id === audio.current?.id)?.id ||
        rows[0]?.id ||
        ''
    }
    if (reordering.value) draftOrder.value = [...rows]
  },
  { immediate: true }
)
watch(
  () => audio.current?.id,
  id => {
    if (id && tracks.value.some(t => t.id === id)) select(tracks.value.find(t => t.id === id)!)
  }
)
watch(tab, value => {
  void router.replace({ query: { ...route.query, audioTab: value } })
})
watch(
  () => route.query.audioTab,
  value => {
    tab.value = tabs.some(t => t.id === value) ? String(value) : 'listen'
  }
)
watch(
  () => props.item.poster_path,
  () => (posterFailed.value = false)
)

function select(track: AudioTrack) {
  trackId.value = track.id
  void router.replace({ query: { ...route.query, track: track.id } })
}

function play(track = selected.value) {
  if (track) {
    select(track)
    void audio.play(track, tracks.value)
  }
}

function enqueueAll() {
  const added = audio.enqueue(tracks.value)
  if (added > 0) success(tr("已加入播放清单（{p0} 首）", {p0: (added)}))
}

function startReorder() {
  draftOrder.value = [...tracks.value]
  reordering.value = true
}

function moveTrack(idx: number, delta: number) {
  const target = idx + delta
  if (target < 0 || target >= draftOrder.value.length) return
  const next = [...draftOrder.value]
  const [picked] = next.splice(idx, 1)
  next.splice(target, 0, picked)
  draftOrder.value = next
}

async function saveOrder() {
  if (busy.value) return
  const contents = props.library?.contents ?? []
  const changes = draftOrder.value
    .map((track, i) => {
      const orig = contents.find(c => c.id === track.episode)
      const nextNum = i + 1
      if (!orig || (orig.season === 0 && orig.episode === nextNum)) return null
      return { episodeId: orig.id, season: 0, number: nextNum }
    })
    .filter((v): v is { episodeId: string; season: number; number: number } => !!v)
  if (!changes.length) {
    reordering.value = false
    return
  }
  busy.value = true
  try {
    const res = await window.baoyi.video.renumberEpisodes(props.item.id, changes)
    if (!res.ok) {
      error(res.message)
      return
    }
    reordering.value = false
    success(tr("曲目顺序已保存"))
    emit('refresh')
  } catch (e) {
    error(errorMessage(e))
  } finally {
    busy.value = false
  }
}

let generation = 0
async function read() {
  const own = ++generation
  lyrics.value = null
  metadata.value = null
  measuredDuration.value = 0
  readError.value = ''
  reading.value = true
  const track = selected.value
  if (!track) {
    reading.value = false
    return
  }
  const results = await Promise.allSettled([
    window.baoyi.video.audioLyrics(props.item.id, track.episode),
    window.baoyi.video.audioInfo(props.item.id, track.episode)
  ])
  if (own !== generation) return
  if (results[0].status === 'fulfilled') lyrics.value = results[0].value
  else readError.value = errorMessage(results[0].reason)
  if (results[1].status === 'fulfilled') {
    metadata.value = results[1].value?.music || null
    measuredDuration.value = results[1].value?.duration_sec || 0
  }
  reading.value = false
}

watch(() => [selected.value?.id, selectedFile.value, props.library], read, { immediate: true })
onBeforeUnmount(() => {
  generation++
})
watch(currentLine, async () => {
  if (!follow.value || tab.value !== 'listen') return
  await nextTick()
  const pane = lyricPane.value
  const line = pane?.querySelector<HTMLElement>('.lyric-current')
  if (pane && line) {
    pane.scrollTo({ top: line.offsetTop - pane.clientHeight / 2 + line.clientHeight / 2, behavior: 'smooth' })
  }
})

function back() {
  store.select({ kind: 'type', value: 'audio' })
  void router.push({ name: 'video-home' })
}

async function save(patch: Partial<VideoItem>) {
  busy.value = true
  try {
    const updated = await window.baoyi.video.update(props.item.id, patch)
    store.merge(updated)
    emit('refresh')
    success(tr("已保存音频资料"))
  } catch (e) {
    error(errorMessage(e))
  } finally {
    busy.value = false
  }
}

async function systemPlay() {
  if (!selected.value) return
  try {
    const r = selected.value.episode
      ? await window.baoyi.video.playEpisode(selected.value.episode)
      : await window.baoyi.video.play(props.item.id)
    if (!r.ok) error(r.message)
  } catch (e) {
    error(errorMessage(e))
  }
}

async function pickCover() {
  try {
    const result = await window.baoyi.video.pickPoster(props.item.id)
    if (result && !result.ok) error(result.message)
    else if (result) emit('refresh')
  } catch (e) {
    error(errorMessage(e))
  }
}

async function reveal(id?: string) {
  try {
    if (id) {
      if (!(await window.baoyi.video.revealAsset(id))) error(tr("未找到本地音频文件，请确认所在磁盘已连接"))
    } else if ((await window.baoyi.video.revealInFolder(props.item.id)) === false) {
      error(tr("未找到本地音频目录，请确认所在磁盘已连接"))
    }
  } catch (e) {
    error(errorMessage(e))
  }
}
</script>

<template>
  <article class="audio-detail" :aria-label="$t('音频详情')">
    <header class="audio-detail-toolbar">
      <button class="btn btn--subtle" @click="back"><ArrowLeft :size="16" />{{ $t("返回音频库") }}</button>
      <div>
        <button class="btn btn--ghost" @click="reveal()"><FolderOpen :size="15" />{{ $t("所在文件夹") }}</button>
        <button class="btn btn--ghost" :disabled="busy" @click="save({ is_archived: !item.is_archived })">
          <Archive :size="15" />{{ item.is_archived ? $t('取消归档') : $t('归档') }}
        </button>
        <button class="btn btn--ghost" @click="removingEpisodeId = ''; removing = true">
          <Trash2 :size="15" />{{ $t("移除") }}</button>
      </div>
    </header>

    <section class="audio-hero">
      <div class="audio-art">
        <img
          v-if="posterUrl(item.poster_path) && !posterFailed"
          :src="posterUrl(item.poster_path, item.updated_at)"
          :alt="title"
          @error="posterFailed = true"
        />
        <Music2 v-else :size="60" />
        <button class="btn btn--subtle" @click="pickCover"><Image :size="14" />{{ $t("选择封面") }}</button>
      </div>
      <div class="audio-hero-copy">
        <span class="audio-kicker">
          {{ tracks.length > 1 ? $t('专辑 / 音频合集') : $t('音频单曲') }} · {{ item.collection_name || item.category || $t('音频') }}
        </span>
        <h1>{{ title }}</h1>
        <p class="audio-byline">
          {{ metadata?.artist || item.tags.slice(0, 2).join(' · ') || $t('本地音频') }}
          <span v-if="metadata?.album"> / {{ metadata.album }}</span>
        </p>
        <p>
          {{ $t("{p0} 首曲目", {p0: (tracks.length)}) }}<span v-if="tracks.some(t => t.duration)">
            · {{ formatPosition(tracks.reduce((sum, t) => sum + t.duration, 0)) }}
          </span>
        </p>
        <div class="audio-hero-actions">
          <button
            class="btn btn--primary"
            :disabled="!selected || selected.available === false"
            :aria-label="current && audio.playing ? $t('暂停当前曲目') : $t('播放当前曲目')"
            @click="play()"
          >
            <Pause v-if="current && audio.playing" :size="17" />
            <Play v-else :size="17" />
            {{ current && audio.playing ? $t('暂停') : $t('播放') }}
          </button>
          <button
            class="btn btn--subtle"
            :disabled="!tracks.some(t => t.available !== false)"
            @click="enqueueAll"
          >
            <ListPlus :size="15" />{{ $t("加入播放清单") }}</button>
          <button class="btn btn--subtle" :disabled="!selected || selected.available === false" @click="systemPlay">
            <ExternalLink :size="14" />{{ $t("系统播放器") }}</button>
        </div>
        <p class="audio-selected">
          {{ current && audio.playing ? $t('正在播放') : $t('所选曲目') }} · {{ selected?.title || $t('暂无曲目') }}
        </p>
      </div>
    </section>

    <DetailTabs v-model="tab" :tabs="tabs" prefix="audio" :label="$t('音频详情页签')" />

    <section v-show="tab === 'listen'" id="audio-panel-listen" class="audio-listen" role="tabpanel" aria-labelledby="audio-tab-listen">
      <div class="audio-tracks">
        <header>
          <h2>{{ $t("曲目 / 章节") }}<span>{{ tracks.length }}</span></h2>
          <div v-if="tracks.length > 1 && tracks.every(t => !!t.episode)" class="audio-tracks-tools">
            <template v-if="reordering">
              <button type="button" class="btn btn--primary" :disabled="busy" @click="saveOrder">{{ $t("保存顺序") }}</button>
              <button type="button" class="btn btn--ghost" :disabled="busy" @click="reordering = false">{{ $t("取消") }}</button>
            </template>
            <button v-else type="button" class="btn btn--ghost" @click="startReorder">
              <ListOrdered :size="14" />{{ $t("管理曲序") }}</button>
          </div>
        </header>

        <template v-if="reordering">
          <div v-for="(track, index) in draftOrder" :key="track.id" class="audio-track audio-track--reorder">
            <span class="audio-reorder-idx">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="audio-reorder-name truncate">{{ track.title }}</span>
            <div class="audio-reorder-btns">
              <button type="button" :disabled="index === 0 || busy" :title="$t('上移')" @click="moveTrack(index, -1)">
                <ArrowUp :size="14" />
              </button>
              <button
                type="button"
                :disabled="index === draftOrder.length - 1 || busy"
                :title="$t('下移')"
                @click="moveTrack(index, 1)"
              >
                <ArrowDown :size="14" />
              </button>
              <button
                v-if="track.episode && draftOrder.length > 1"
                type="button"
                :disabled="busy"
                :title="$t('从本专辑移出或删除')"
                @click="removingEpisodeId = track.episode; removing = true"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </template>

        <template v-else>
          <div
            v-for="(track, index) in tracks"
            :key="track.id"
            class="audio-track"
            :class="{ selected: track.id === selected?.id, playing: track.id === audio.current?.id }"
          >
            <button
              class="audio-track-play"
              :aria-label="(track.id === audio.current?.id && audio.playing ? $t('暂停 ') : $t('播放 ')) + track.title"
              :disabled="track.available === false"
              @click="play(track)"
            >
              <Pause v-if="track.id === audio.current?.id && audio.playing" :size="15" />
              <Play v-else :size="15" />
            </button>
            <button
              class="audio-track-title"
              :aria-label="$t('查看歌词 ') + track.title"
              :aria-pressed="selected?.id === track.id"
              @click="select(track)"
            >
              <span>{{ String(index + 1).padStart(2, '0') }} · {{ track.title }}</span>
              <small>{{ track.available === false ? $t('文件缺失或磁盘未连接') : formatPosition(track.duration) || $t('时长待读取') }}</small>
            </button>
          </div>
        </template>
      </div>

      <div class="audio-lyrics">
        <header>
          <div>
            <h2>{{ $t("歌词") }}</h2>
            <p>{{ selected?.title }}</p>
          </div>
          <button class="btn btn--ghost" :disabled="reading" @click="read"><RefreshCw :size="14" />{{ $t("刷新歌词") }}</button>
        </header>
        <p v-if="reading" class="lyrics-state" role="status">{{ $t("读取歌词中…") }}</p>
        <p v-else-if="readError" class="lyrics-state" role="alert">{{ readError }}</p>
        <template v-else-if="lyrics?.status === 'available'">
          <div class="lyrics-options">
            <span>{{ lyrics.timed ? $t('时间轴歌词') : $t('文本歌词') }}</span>
            <label v-if="lyrics.timed"><input v-model="follow" type="checkbox" />{{ $t("跟随播放") }}</label>
          </div>
          <div ref="lyricPane" class="lyrics-body" tabindex="0" :aria-label="$t('歌词正文')">
            <template v-for="(line, index) in lyrics.lines" :key="index">
              <button
                v-if="line.time !== null"
                class="lyric-line"
                :class="{ 'lyric-current': currentLine === index }"
                :aria-current="currentLine === index ? 'true' : undefined"
                :disabled="!current || !audio.duration"
                :aria-label="$t('跳转到 ') + formatPosition(line.time) + ' ' + line.text"
                @click="audio.seek(line.time)"
              >
                <small>{{ formatPosition(line.time) || '0:00' }}</small>
                <span>{{ line.text }}</span>
              </button>
              <p v-else class="lyric-plain">{{ line.text }}</p>
            </template>
          </div>
          <footer>
            <span>{{ lyrics.source.split(/[\\/]/).pop() }}</span>
            <span v-if="lyrics.timed && !current">{{ $t("播放本曲后可点击歌词定位") }}</span>
          </footer>
        </template>
        <p v-else class="lyrics-state" role="status">{{ lyrics?.message || $t('暂无本地歌词') }}</p>
      </div>
    </section>

    <section v-show="tab === 'info'" id="audio-panel-info" role="tabpanel" aria-labelledby="audio-tab-info" class="audio-info">
      <div class="audio-section-title">
        <h2>{{ $t("音频资料") }}</h2>
        <button class="btn btn--subtle" @click="editing = !editing">{{ editing ? $t('结束编辑') : $t('编辑资料') }}</button>
      </div>
      <template v-if="editing">
        <label>{{ $t("名称") }}<input
            class="input"
            :aria-label="$t('音频名称')"
            :value="item.name_zh"
            :disabled="busy"
            @change="save({ name_zh: ($event.target as HTMLInputElement).value.trim() })"
          />
        </label>
        <label>{{ $t("所属歌单分组") }}<input
            class="input"
            :aria-label="$t('所属歌单分组')"
            :value="item.collection_name"
            :placeholder="$t('填写歌单或系列名，留空则不分组')"
            :disabled="busy"
            @change="save({ collection_name: ($event.target as HTMLInputElement).value.trim() })"
          />
        </label>
        <label>{{ $t("简介") }}<textarea
            class="input"
            rows="5"
            :aria-label="$t('音频简介')"
            :value="item.description"
            :disabled="busy"
            @change="save({ description: ($event.target as HTMLTextAreaElement).value })"
          />
        </label>
      </template>
      <p v-else class="audio-description">{{ item.description || $t('暂无简介，可记录歌手、专辑背景或节目介绍。') }}</p>
      <h2>{{ $t("个人笔记") }}</h2>
      <textarea
        class="input"
        rows="6"
        :aria-label="$t('音频个人笔记')"
        :value="item.notes"
        :placeholder="$t('记录喜欢的段落、听后感或下次想听的章节…')"
        :disabled="busy"
        @change="save({ notes: ($event.target as HTMLTextAreaElement).value })"
      />
      <ResourceBacklinksPanel :resource-id="item.id" style="margin-top: 20px" />
    </section>

    <section v-show="tab === 'files'" id="audio-panel-files" role="tabpanel" aria-labelledby="audio-tab-files" class="audio-info">
      <h2>{{ $t("{p0} · 音频信息", {p0: (selected?.title)}) }}</h2>
      <dl class="audio-facts">
        <div><dt>{{ $t("格式") }}</dt><dd>{{ selectedFile.split('.').pop()?.toUpperCase() || '—' }}</dd></div>
        <div><dt>{{ $t("时长") }}</dt><dd>{{ formatPosition(length) || $t('待读取') }}</dd></div>
        <div><dt>{{ $t("采样率") }}</dt><dd>{{ metadata?.sampleRate ? metadata.sampleRate / 1000 + ' kHz' : '—' }}</dd></div>
        <div><dt>{{ $t("位深") }}</dt><dd>{{ metadata?.bitDepth ? metadata.bitDepth + ' bit' : '—' }}</dd></div>
        <div><dt>{{ $t("码率") }}</dt><dd>{{ metadata?.bitRate ? Math.round(metadata.bitRate / 1000) + ' kbps' : '—' }}</dd></div>
      </dl>
      <h2>{{ $t("本地文件") }}</h2>
      <div v-for="asset in library?.assets" :key="asset.id" class="audio-file">
        <div>
          <strong>{{ asset.path.split(/[\\/]/).pop() }}</strong>
          <p>{{ asset.path }}</p>
          <small>{{ formatBytes(asset.file_size) }} · {{ asset.state === 'present' ? $t('可用') : asset.state === 'offline' ? $t('磁盘离线') : $t('文件缺失') }}</small>
        </div>
        <button class="btn btn--ghost" :disabled="asset.state !== 'present'" @click="reveal(asset.id)">
          <FolderOpen :size="15" />{{ $t("定位") }}</button>
      </div>
    </section>

    <VideoRemovalDialog
      v-if="removing"
      :resource-ids="[item.id]"
      :episode-id="removingEpisodeId || undefined"
      @close="removing = false; removingEpisodeId = ''"
      @changed="removingEpisodeId ? emit('refresh') : back()"
    />
  </article>
</template>

<style scoped>
.audio-detail { padding: 20px 32px 36px; min-width: 0; }
.audio-detail-toolbar, .audio-detail-toolbar > div { display: flex; align-items: center; gap: 8px; }
.audio-detail-toolbar { justify-content: space-between; margin-bottom: 30px; }
.audio-hero { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 32px; align-items: center; margin-bottom: 30px; }
.audio-art { aspect-ratio: 1; border-radius: 12px; background: var(--active-surface); color: var(--accent); position: relative; display: grid; place-items: center; overflow: hidden; }
.audio-art img { width: 100%; height: 100%; object-fit: cover; }
.audio-art button { position: absolute; bottom: 10px; right: 10px; background: var(--bg-card); font-size: 11px; }
.audio-kicker { font-size: 11px; letter-spacing: 1.5px; color: var(--text-sub); }
.audio-hero h1 { font-size: 30px; line-height: 1.25; margin: 12px 0; overflow-wrap: anywhere; font-weight: 650; letter-spacing: -0.5px; }
.audio-hero p { font-size: 12px; color: var(--text-sub); margin: 9px 0; }
.audio-hero .audio-byline { font-size: 15px; }
.audio-hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.audio-selected { margin-top: 14px !important; }
.audio-listen { display: grid; grid-template-columns: minmax(240px, 0.9fr) minmax(0, 1.5fr); gap: 32px; padding-top: 24px; }
.audio-tracks > header, .audio-lyrics > header, .audio-section-title { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.audio-tracks > header { margin-bottom: 12px; }
.audio-tracks > header h2 { margin: 0; }
.audio-tracks > header h2 span { color: var(--text-faint); font-size: 12px; font-weight: 400; margin-left: 6px; }
.audio-tracks-tools { display: flex; gap: 6px; }
.audio-tracks-tools button { padding: 4px 9px; font-size: 12px; }
.audio-detail h2 { font-size: 15px; font-weight: 600; margin: 0 0 15px; }
.audio-track { display: flex; gap: 10px; align-items: center; padding: 12px 10px; border-bottom: 1px solid var(--divider); border-radius: 6px; }
.audio-track.selected { background: var(--active-surface); }
.audio-track.playing { color: var(--accent); }
.audio-track-play { flex-shrink: 0; padding: 6px; }
.audio-track-play:disabled { opacity: 0.35; }
.audio-track-title { display: grid; gap: 6px; min-width: 0; flex: 1; text-align: left; }
.audio-track-title span { font-size: 13px; overflow-wrap: anywhere; }
.audio-track small { font-size: 11px; color: var(--text-sub); }
.audio-track--reorder { justify-content: space-between; padding: 9px 10px; }
.audio-reorder-idx { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.audio-reorder-name { flex: 1; min-width: 0; font-size: 13px; }
.audio-reorder-btns { display: flex; gap: 4px; flex: none; }
.audio-reorder-btns button { padding: 5px; border-radius: 5px; color: var(--text-sub); }
.audio-reorder-btns button:hover:not(:disabled) { background: var(--hover-surface); color: var(--text-main); }
.audio-lyrics { min-width: 0; border-left: 1px solid var(--divider); padding-left: 30px; }
.audio-lyrics h2 { margin-bottom: 6px; }
.audio-lyrics header p { font-size: 12px; color: var(--text-sub); margin: 0; }
.lyrics-options { display: flex; justify-content: space-between; margin-top: 20px; color: var(--text-sub); font-size: 11px; }
.lyrics-options label { display: flex; gap: 6px; align-items: center; }
.lyrics-body { position: relative; max-height: 380px; overflow: auto; margin: 18px 0; padding: 14px 0 80px; user-select: text; scrollbar-gutter: stable; }
.lyric-line { display: flex; text-align: left; align-items: baseline; gap: 16px; width: 100%; padding: 14px 10px; color: var(--text-sub); border-radius: 7px; white-space: pre-wrap; line-height: 1.7; }
.lyric-line small { flex-shrink: 0; font-size: 10px; min-width: 30px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lyric-line span { font-size: 16px; overflow-wrap: anywhere; }
.lyric-line.lyric-current { color: var(--accent); font-weight: 600; background: var(--active-surface); }
.lyric-line:hover:not(:disabled) { background: var(--hover-surface); }
.lyric-plain { font-size: 16px; line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 10px; }
.lyrics-state { min-height: 200px; display: flex; align-items: center; justify-content: center; padding: 30px; line-height: 1.9; font-size: 13px; color: var(--text-sub); text-align: center; }
.audio-lyrics footer { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--text-faint); overflow-wrap: anywhere; }
.audio-info { padding-top: 24px; max-width: 960px; }
.audio-info > label { display: grid; gap: 8px; margin: 14px 0; font-size: 12px; }
.audio-info textarea { width: 100%; line-height: 1.8; }
.audio-description { white-space: pre-wrap; user-select: text; font-size: 14px; line-height: 1.9; margin-bottom: 28px; }
.audio-facts { display: flex; flex-wrap: wrap; gap: 20px 40px; margin-bottom: 30px; }
.audio-facts dt { color: var(--text-sub); font-size: 11px; margin-bottom: 8px; }
.audio-facts dd { margin: 0; font-size: 14px; }
.audio-file { display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--divider); padding: 15px 0; }
.audio-file > div { min-width: 0; }
.audio-file strong { font-size: 13px; }
.audio-file p { font-size: 11px; color: var(--text-sub); overflow-wrap: anywhere; user-select: text; }
.audio-file small { font-size: 11px; color: var(--text-faint); }
.audio-detail button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 1000px) {
  .audio-detail { padding: 18px 22px; }
  .audio-hero { grid-template-columns: 160px minmax(0, 1fr); gap: 24px; }
  .audio-hero h1 { font-size: 25px; }
  .audio-listen { grid-template-columns: minmax(190px, 0.8fr) minmax(0, 1.3fr); gap: 20px; }
  .audio-lyrics { padding-left: 20px; }
}
@media (max-width: 760px) {
  .audio-detail-toolbar { flex-wrap: wrap; gap: 12px; }
  .audio-hero { grid-template-columns: 120px minmax(0, 1fr); gap: 18px; }
  .audio-hero h1 { font-size: 21px; }
  .audio-hero-actions { flex-wrap: wrap; }
  .audio-listen { grid-template-columns: minmax(0, 1fr); }
  .audio-lyrics { border-left: 0; border-top: 1px solid var(--divider); padding: 22px 0 0; }
  .audio-tracks { max-height: 250px; overflow: auto; }
  .audio-art button { font-size: 0; padding: 6px; }
  .audio-art button svg { width: 17px; height: 17px; }
}
</style>
