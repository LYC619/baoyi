<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowUpRight, Check, ChevronDown, ChevronUp, ListPlus, Loader2, Music2, Pause, Play } from 'lucide-vue-next'
import { useAudioStore } from '@/stores/audio'
import { useToast } from '@/composables/useToast'
import { audioTracks, type AudioTrack } from '@/utils/audio'
import { formatPosition, posterUrl } from '@/utils'
import type { VideoItem } from '@/types'

const props = withDefaults(
  defineProps<{
    items: VideoItem[]
    view: 'cards' | 'list'
    selecting?: boolean
    selectedIds?: string[]
  }>(),
  {
    selecting: false,
    selectedIds: () => []
  }
)
const emit = defineEmits<{
  open: [item: VideoItem, episode?: string]
  select: [id: string, event?: MouseEvent]
}>()

const audio = useAudioStore()
const { success } = useToast()
const tracks = ref<AudioTrack[]>([])
const failure = ref('')
const loading = ref(false)
const broken = ref(new Set<string>())
const kindFilter = ref<'all' | 'albums' | 'singles'>('all')
const expandedId = ref('')
let revision = 0

async function load() {
  const round = ++revision
  failure.value = ''
  tracks.value = []
  loading.value = true
  const items = [...props.items]
  const rows: AudioTrack[] = []
  for (let start = 0; start < items.length; start += 4) {
    const batch = await Promise.all(
      items.slice(start, start + 4).map(async item => {
        try {
          return audioTracks(item, await window.baoyi.video.library(item.id))
        } catch {
          if (round === revision) failure.value = tr("部分曲目暂时无法读取，请重试")
          return []
        }
      })
    )
    if (round !== revision) return
    rows.push(...batch.flat())
  }
  if (round === revision) {
    tracks.value = rows
    loading.value = false
  }
}

watch(() => props.items, load, { immediate: true })
onBeforeUnmount(() => revision++)

const tracksByResource = computed(() => {
  const map = new Map<string, AudioTrack[]>()
  for (const t of tracks.value) {
    const list = map.get(t.resource.id)
    if (list) list.push(t)
    else map.set(t.resource.id, [t])
  }
  return map
})

function ownTracks(item: VideoItem): AudioTrack[] {
  return tracksByResource.value.get(item.id) ?? []
}

function isAlbum(item: VideoItem): boolean {
  return (item.episode_total || ownTracks(item).length) > 1
}

const albumCount = computed(() => props.items.filter(isAlbum).length)
const singleCount = computed(() => props.items.length - albumCount.value)

const filteredItems = computed(() => {
  if (kindFilter.value === 'albums') return props.items.filter(isAlbum)
  if (kindFilter.value === 'singles') return props.items.filter(item => !isAlbum(item))
  return props.items
})

const filteredIds = computed(() => new Set(filteredItems.value.map(item => item.id)))
const filteredTracks = computed(() => tracks.value.filter(t => filteredIds.value.has(t.resource.id)))

watch(filteredItems, rows => {
  if (expandedId.value && !rows.some(r => r.id === expandedId.value)) expandedId.value = ''
})

const expandedItem = computed(() => filteredItems.value.find(item => item.id === expandedId.value) ?? null)

const title = (item: VideoItem) => item.name_zh || item.file_name

function play(track: AudioTrack, scopeTracks = filteredTracks.value) {
  void audio.play(track, scopeTracks)
}

function playAlbum(item: VideoItem) {
  const own = ownTracks(item).filter(t => t.available !== false)
  if (!own.length) return
  // 专辑/合集按本辑曲目连播；单曲则将当前可见曲目一并载入播放清单，播完自然顺延下一首
  if (own.length > 1) {
    const track = own.find(t => t.id === audio.current?.id) || own[0]
    void audio.play(track, own)
  } else {
    void audio.play(own[0], filteredTracks.value)
  }
}

function enqueueItem(item: VideoItem) {
  const own = ownTracks(item).filter(t => t.available !== false)
  const added = audio.enqueue(own)
  if (added > 0) success(tr("已加入播放清单（{p0} 首）", {p0: (added)}))
}

function playAllVisible() {
  const playable = filteredTracks.value.filter(t => t.available !== false)
  if (playable[0]) void audio.play(playable[0], playable)
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? '' : id
}
</script>

<template>
  <section class="audio-library" :aria-label="$t('我的音频')">
    <header class="audio-header">
      <div class="audio-disc"><Music2 :size="30" /></div>
      <div class="audio-header-main">
        <span class="audio-eyebrow">{{ $t("音乐 · 播客 · 有声书") }}</span>
        <h2>{{ $t("我的音频") }}</h2>
        <p>{{ $t("{p0} 项音频 · {p1}", {p0: (items.length), p1: (loading ? $t('正在读取曲目…') : tracks.length + $t(' 首曲目'))}) }}</p>
      </div>
      <div v-if="items.length" class="audio-header-tools">
        <div v-if="albumCount > 0 && singleCount > 0" class="audio-kind-pills" role="group" :aria-label="$t('音频形态筛选')">
          <button type="button" :class="{ active: kindFilter === 'all' }" @click="kindFilter = 'all'">{{ $t("全部 {p0}", {p0: (items.length)}) }}
          </button>
          <button type="button" :class="{ active: kindFilter === 'albums' }" @click="kindFilter = 'albums'">{{ $t("专辑 / 合集 {p0}", {p0: (albumCount)}) }}
          </button>
          <button type="button" :class="{ active: kindFilter === 'singles' }" @click="kindFilter = 'singles'">{{ $t("单曲 {p0}", {p0: (singleCount)}) }}
          </button>
        </div>
        <button
          v-if="!selecting"
          type="button"
          class="btn btn--subtle"
          :disabled="loading || !filteredTracks.some(t => t.available !== false)"
          @click="playAllVisible"
        >
          <Play :size="15" />{{ $t("全部播放") }}</button>
      </div>
    </header>

    <p v-if="failure" class="audio-error" role="alert">
      {{ failure }} <button class="btn btn--ghost" @click="load">{{ $t("重试") }}</button>
    </p>
    <p v-if="!items.length" class="audio-empty">{{ $t("点右上角「找音乐」在线搜索试听，或把本地专辑、播客、单曲直接拖进来。") }}</p>
    <p v-else-if="!filteredItems.length" class="audio-empty">{{ $t("当前筛选下没有音频。") }}<button type="button" class="btn btn--ghost" @click="kindFilter = 'all'">{{ $t("查看全部") }}</button>
    </p>

    <template v-else-if="view === 'cards'">
      <div v-if="expandedItem && !selecting" class="audio-album-drawer" role="region" :aria-label="title(expandedItem) + $t(' 曲目列表')">
        <header>
          <div>
            <strong>{{ title(expandedItem) }}</strong>
            <span>{{ $t("共 {p0} 首曲目", {p0: (ownTracks(expandedItem).length)}) }}</span>
          </div>
          <div class="audio-album-drawer-actions">
            <button
              type="button"
              class="btn btn--primary"
              :disabled="!ownTracks(expandedItem).some(t => t.available !== false)"
              @click="playAlbum(expandedItem)"
            >
              <Play :size="14" />{{ $t("播放本辑") }}</button>
            <button
              type="button"
              class="btn btn--ghost"
              :disabled="!ownTracks(expandedItem).some(t => t.available !== false)"
              @click="enqueueItem(expandedItem)"
            >
              <ListPlus :size="14" />{{ $t("加入清单") }}</button>
            <button type="button" class="btn btn--ghost" @click="emit('open', expandedItem)">{{ $t("专辑详情") }}</button>
            <button type="button" class="btn btn--subtle" @click="expandedId = ''">{{ $t("收起") }}</button>
          </div>
        </header>
        <ul class="audio-drawer-tracks">
          <li
            v-for="(track, idx) in ownTracks(expandedItem)"
            :key="track.id"
            :class="{ current: audio.current?.id === track.id }"
          >
            <button
              type="button"
              class="audio-drawer-play"
              :disabled="track.available === false"
              @click="play(track, ownTracks(expandedItem))"
            >
              <Pause v-if="audio.current?.id === track.id && audio.playing" :size="14" />
              <Play v-else-if="audio.current?.id === track.id" :size="14" />
              <span v-else class="audio-drawer-idx">{{ String(idx + 1).padStart(2, '0') }}</span>
              <span class="audio-drawer-name">{{ track.title }}</span>
              <small v-if="track.available === false">{{ $t("文件缺失") }}</small>
              <span v-else class="audio-drawer-dur">{{ formatPosition(track.duration) || '—' }}</span>
            </button>
            <button
              type="button"
              class="audio-drawer-detail"
              :title="$t('查看歌词与详情：') + track.title"
              @click="emit('open', expandedItem, track.episode)"
            >
              <ArrowUpRight :size="14" />
            </button>
          </li>
        </ul>
      </div>

      <div class="audio-cards">
        <article
          v-for="item in filteredItems"
          :key="item.id"
          class="audio-card"
          :class="{
            current: audio.current?.resource.id === item.id,
            selected: selecting && selectedIds.includes(item.id),
            expanded: expandedId === item.id
          }"
        >
          <div class="audio-card-art">
            <button
              class="audio-card-open"
              :aria-label="(selecting ? $t('选择音频 ') : $t('查看音频 ')) + title(item)"
              @click="selecting ? emit('select', item.id, $event) : emit('open', item)"
            >
              <img
                v-if="posterUrl(item.poster_path) && !broken.has(item.id)"
                :src="posterUrl(item.poster_path, item.updated_at)"
                :alt="title(item)"
                loading="lazy"
                @error="broken.add(item.id)"
              />
              <span v-else class="audio-cover-fallback">
                <Music2 :size="38" />
                <small>{{ title(item).slice(0, 1) }}</small>
              </span>
            </button>
            <span v-if="selecting" class="audio-card-check" :class="{ checked: selectedIds.includes(item.id) }" aria-hidden="true">
              <Check v-if="selectedIds.includes(item.id)" :size="14" />
            </span>
            <template v-else>
              <button
                v-if="ownTracks(item).some(t => t.available !== false)"
                type="button"
                class="audio-card-enqueue"
                :title="$t('加入播放清单：') + title(item)"
                :aria-label="$t('加入播放清单 ') + title(item)"
                @click.stop="enqueueItem(item)"
              >
                <ListPlus :size="15" />
              </button>
              <button
                class="audio-card-play"
                :aria-label="(audio.current?.resource.id === item.id && audio.playing ? $t('暂停 ') : $t('播放 ')) + title(item)"
                :disabled="loading || !ownTracks(item).some(t => t.available !== false)"
                @click="playAlbum(item)"
              >
                <Loader2 v-if="loading" :size="18" class="spin" />
                <Pause v-else-if="audio.current?.resource.id === item.id && audio.playing" :size="19" />
                <Play v-else :size="19" />
              </button>
            </template>
          </div>
          <button
            class="audio-card-title audio-name"
            @click="selecting ? emit('select', item.id, $event) : emit('open', item)"
          >
            {{ title(item) }}
          </button>
          <div class="audio-card-meta">
            <span class="truncate">{{ item.collection_name || item.tags.slice(0, 2).join(' · ') || item.category || $t('音频') }}</span>
            <button
              v-if="isAlbum(item) && !selecting"
              type="button"
              class="audio-card-tracks-btn"
              :aria-expanded="expandedId === item.id"
              @click="toggleExpand(item.id)"
            >
              {{ expandedId === item.id ? $t('收起') : $t('{p0} 首', {p0: item.episode_total || ownTracks(item).length}) }}
              <ChevronUp v-if="expandedId === item.id" :size="13" />
              <ChevronDown v-else :size="13" />
            </button>
            <span v-else class="audio-card-count">{{ $t("{p0} 首", {p0: (item.episode_total || 1)}) }}</span>
          </div>
        </article>
      </div>
    </template>

    <div v-else class="audio-table">
      <div class="audio-row audio-head">
        <span>#</span><span>{{ $t("曲目") }}</span><span>{{ $t("专辑 / 来源") }}</span><span>{{ $t("时长") }}</span><span />
      </div>
      <div
        v-for="(track, i) in filteredTracks"
        :key="track.id"
        class="audio-row"
        :class="{
          current: audio.current?.id === track.id,
          selected: selecting && selectedIds.includes(track.resource.id)
        }"
        @click="selecting ? emit('select', track.resource.id, $event) : undefined"
      >
        <button
          v-if="!selecting"
          :aria-label="(audio.current?.id === track.id && audio.playing ? $t('暂停 ') : $t('播放 ')) + track.title"
          :disabled="track.available === false"
          @click="play(track)"
        >
          <Pause v-if="audio.current?.id === track.id && audio.playing" :size="15" />
          <Play v-else-if="audio.current?.id === track.id" :size="15" />
          <span v-else>{{ i + 1 }}</span>
        </button>
        <span v-else class="audio-row-check" :class="{ checked: selectedIds.includes(track.resource.id) }">
          <Check v-if="selectedIds.includes(track.resource.id)" :size="13" />
        </span>
        <button class="audio-name" @click.stop="selecting ? emit('select', track.resource.id, $event) : emit('open', track.resource, track.episode)">
          {{ track.title }}<small v-if="track.available === false">{{ $t("文件缺失") }}</small>
        </button>
        <button class="audio-album" @click.stop="selecting ? emit('select', track.resource.id, $event) : emit('open', track.resource)">
          {{ title(track.resource) }}
        </button>
        <span>{{ formatPosition(track.duration) || '—' }}</span>
        <div class="audio-row-actions">
          <button
            v-if="!selecting && track.available !== false"
            type="button"
            :title="$t('加入播放清单：') + track.title"
            :aria-label="$t('加入播放清单 ') + track.title"
            @click.stop="audio.enqueue([track]) && success($t('已加入播放清单'))"
          >
            <ListPlus :size="15" />
          </button>
          <button
            v-if="!selecting"
            :aria-label="$t('查看 ') + track.title"
            @click.stop="emit('open', track.resource, track.episode)"
          >
            <ArrowUpRight :size="16" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.audio-library {
  padding: 10px 6px 32px;
}
.audio-header {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: center;
  margin-bottom: 24px;
}
.audio-header-main {
  flex: 1;
  min-width: 180px;
}
.audio-header-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.audio-kind-pills {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  background: var(--bg-card);
  gap: 2px;
}
.audio-kind-pills button {
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-sub);
}
.audio-kind-pills button.active {
  background: var(--active-surface);
  color: var(--accent);
  font-weight: 500;
}
.audio-disc {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 10px double var(--divider);
  background: var(--active-surface);
  color: var(--accent);
  flex-shrink: 0;
}
.audio-eyebrow {
  font-size: 11px;
  letter-spacing: 1.5px;
  color: var(--text-sub);
}
.audio-library h2 {
  font-size: 24px;
  margin: 6px 0;
}
.audio-library p {
  font-size: 12px;
  color: var(--text-sub);
}
.audio-album-drawer {
  margin-bottom: 22px;
  padding: 16px 18px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-card);
  background: var(--bg-card);
}
.audio-album-drawer > header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--divider);
}
.audio-album-drawer > header strong {
  font-size: 15px;
}
.audio-album-drawer > header span {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-sub);
}
.audio-album-drawer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.audio-drawer-tracks {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 4px 16px;
  max-height: 260px;
  overflow-y: auto;
}
.audio-drawer-tracks li {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--divider);
  border-radius: 6px;
  padding-inline: 4px;
}
.audio-drawer-tracks li.current {
  background: var(--active-surface);
  color: var(--accent);
}
.audio-drawer-play {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 4px;
  text-align: left;
  font-size: 13px;
}
.audio-drawer-idx,
.audio-drawer-dur {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.audio-drawer-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audio-drawer-detail {
  flex: none;
  padding: 6px;
  color: var(--text-sub);
  border-radius: 5px;
}
.audio-drawer-detail:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}
.audio-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-min, 190px), 1fr));
  gap: 26px 20px;
}
.audio-card {
  min-width: 0;
}
.audio-card-art {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  overflow: hidden;
  background: var(--active-surface);
  border: 2px solid transparent;
  transition: border-color 0.15s;
}
.audio-card.selected .audio-card-art,
.audio-card.expanded .audio-card-art {
  border-color: var(--accent);
}
.audio-card-open {
  width: 100%;
  height: 100%;
  display: block;
}
.audio-card-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.2s;
}
.audio-card-open:hover img {
  transform: scale(1.035);
}
.audio-cover-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  height: 100%;
  color: var(--accent);
  background: radial-gradient(
    circle at 50% 44%,
    transparent 27%,
    var(--divider) 28%,
    transparent 29%,
    transparent 37%,
    var(--divider) 38%,
    transparent 39%
  );
}
.audio-cover-fallback small {
  font-size: 15px;
}
.audio-card-check {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--divider-strong);
  display: grid;
  place-items: center;
  color: #fff;
  pointer-events: none;
}
.audio-card-check.checked {
  background: var(--accent);
  border-color: var(--accent);
}
.audio-card-enqueue {
  position: absolute;
  left: 10px;
  bottom: 10px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-card);
  color: var(--text-main);
  display: grid;
  place-items: center;
  box-shadow: 0 2px 8px #0003;
  opacity: 0;
  transition: opacity 0.15s;
}
.audio-card:hover .audio-card-enqueue,
.audio-card:focus-within .audio-card-enqueue {
  opacity: 1;
}
.audio-card-play {
  position: absolute;
  right: 12px;
  bottom: 12px;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  background: var(--bg-card);
  color: var(--accent);
  display: grid;
  place-items: center;
  box-shadow: 0 3px 12px #0002;
}
.audio-card-play:disabled {
  opacity: 0.5;
}
.audio-card-title {
  font-size: 14px;
  font-weight: 600;
  display: block;
  margin-top: 10px;
  max-width: 100%;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audio-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-sub);
}
.audio-card-count {
  white-space: nowrap;
  color: var(--text-faint);
}
.audio-card-tracks-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--divider);
  background: var(--bg-card);
  color: var(--text-main);
  font-size: 11px;
}
.audio-card-tracks-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.audio-card.current .audio-card-title {
  color: var(--accent);
}
.audio-table {
  border-top: 1px solid var(--divider);
}
.audio-row {
  display: grid;
  grid-template-columns: 35px minmax(0, 2fr) minmax(0, 1fr) 65px 58px;
  align-items: center;
  gap: 15px;
  padding: 12px 10px;
  border-bottom: 1px solid var(--divider);
  font-size: 13px;
}
.audio-row.current {
  background: var(--active-surface);
  color: var(--accent);
}
.audio-row.selected {
  background: var(--active-surface);
}
.audio-row-check {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: 1px solid var(--divider-strong);
  display: grid;
  place-items: center;
  color: #fff;
}
.audio-row-check.checked {
  background: var(--accent);
  border-color: var(--accent);
}
.audio-row > button {
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audio-row > button:disabled {
  opacity: 0.4;
}
.audio-row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.audio-row-actions button {
  padding: 5px;
  border-radius: 5px;
  color: var(--text-sub);
}
.audio-row-actions button:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}
.audio-head {
  font-size: 11px;
  color: var(--text-faint);
}
.audio-album,
.audio-row > span {
  color: var(--text-sub);
}
.audio-name {
  font-weight: 500;
}
.audio-name small {
  display: block;
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 4px;
}
.audio-empty {
  padding: 36px 12px;
  text-align: center;
}
.audio-error {
  color: var(--danger) !important;
}
.audio-library button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
@media (max-width: 800px) {
  .audio-row {
    grid-template-columns: 28px minmax(0, 1fr) 48px 52px;
    gap: 8px;
  }
  .audio-album,
  .audio-head > span:nth-child(3) {
    display: none;
  }
  .audio-cards {
    grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr));
  }
}
</style>
