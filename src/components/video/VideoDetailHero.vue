<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Check,
  Clapperboard,
  FolderOpen,
  Image,
  ImageDown,
  ImageOff,
  Loader2,
  Pencil,
  Star,
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { WATCH_STATUS_LABEL, VIDEO_TYPE_LABEL } from '@/stores/video'
import { formatDuration, posterUrl, videoTitle } from '@/utils'
import { videoDateLabel } from '@/utils/video-content'
import type { VideoItem, WatchStatus } from '@/types'
import type { VideoWorkContent, VideoWorkLibrary } from '@/types/video-workflow'

const HENTAI_CATEGORY = '里番'
const STATUSES: WatchStatus[] = ['unwatched', 'watching', 'watched', 'dropped']

const props = defineProps<{
  item: VideoItem
  library: VideoWorkLibrary | null
  editing: boolean
  posterBusy: boolean
  episodeArtworkAvailable: boolean
  presentCount: number
}>()

const emit = defineEmits<{
  (e: 'update:editing', val: boolean): void
  (e: 'save', patch: Partial<VideoItem>): void
  (e: 'commit-tags', raw: string): void
  (e: 'change-type', val: string): void
  (e: 'filter-tag', tag: string): void
  (e: 'copy-path', path: string): void
  (e: 'fetch-poster'): void
  (e: 'pick-poster'): void
  (e: 'clear-poster'): void
  (e: 'open-episode-artwork'): void
  (e: 'poster-missing'): void
}>()

const title = computed(() => videoTitle(props.item))
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')
const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})
const isSeries = computed(() => props.item.video_type === 'series')
const yearText = computed(() => {
  const v = props.item
  if (!v.year) return ''
  if (v.end_year && v.end_year !== v.year) return `${v.year} – ${v.end_year}`
  return String(v.year)
})
const singleEpisode = computed<VideoWorkContent | null>(() =>
  props.library?.contents.length === 1 ? props.library.contents[0] : null
)
const publicationRange = computed(() => {
  const dates = (props.library?.contents || [])
    .map((e) => videoDateLabel(e.published_at || e.air_date))
    .filter(Boolean)
    .sort()
  const first = dates[0] || videoDateLabel(props.item.published_start)
  const last = dates.at(-1) || videoDateLabel(props.item.published_end)
  return {
    first,
    last,
    collection: (props.library?.contents.length || props.item.episode_total || 0) > 1,
  }
})

const poster = computed(() => posterUrl(props.item.poster_path, props.item.updated_at))
const posterFailed = ref(false)
watch(poster, () => {
  posterFailed.value = false
})

const visibleTags = computed(() =>
  [...new Set([...(props.item.tags ?? []), ...(props.item.hanime_tags ?? [])])].filter(
    (tag) => tag.trim() && !/^(add|remove)$/i.test(tag.trim())
  )
)
const tagsElement = ref<HTMLElement | null>(null)
const tagsExpanded = ref(false)
const tagsOverflow = ref(false)
const tagsHeight = ref(80)
const tagVisibleCount = ref(Infinity)
let tagsObserver: ResizeObserver | undefined

function measureTags(): void {
  const element = tagsElement.value
  if (!element) return
  const boxes = Array.from(element.children).map((child) => (child as HTMLElement).getBoundingClientRect())
  const rows = [...new Set(boxes.map((box) => Math.round(box.top)))].sort((a, b) => a - b)
  tagsOverflow.value = rows.length > 3
  tagVisibleCount.value = rows.length > 3 ? boxes.filter((box) => Math.round(box.top) < rows[3]).length : boxes.length
  if (rows.length >= 3) {
    tagsHeight.value = Math.ceil(
      Math.max(...boxes.filter((box) => Math.round(box.top) === rows[2]).map((box) => box.bottom)) -
        element.getBoundingClientRect().top
    )
  }
}

watch(tagsElement, (element) => {
  tagsObserver?.disconnect()
  if (element) {
    tagsObserver = new ResizeObserver(measureTags)
    tagsObserver.observe(element)
    void nextTick(measureTags)
  }
})
watch(visibleTags, () => {
  tagsExpanded.value = false
  void nextTick(measureTags)
})
onBeforeUnmount(() => tagsObserver?.disconnect())
</script>

<template>
  <section class="hero panel">
    <div class="hero__poster" :style="{ '--hue': hue }">
      <img
        v-if="poster && !posterFailed"
        :src="poster"
        :alt="title"
        class="hero__img"
        @error="posterFailed = true; emit('poster-missing')"
      />
      <span v-else class="hero__initial">{{ initial }}</span>

      <div class="hero__posterActs">
        <button
          type="button"
          class="hero__posterBtn"
          :disabled="posterBusy"
          :title="$t('依次查找：同目录海报图 → 已记录的在线海报')"
          @click="emit('fetch-poster')"
        >
          <Loader2 v-if="posterBusy" :size="13" class="spin" />
          <ImageDown v-else :size="13" />
          {{ posterBusy ? $t('查找中') : $t('找海报') }}
        </button>
        <button
          type="button"
          class="hero__posterBtn"
          :title="item.poster_path ? $t('更换海报') : $t('选择海报图片')"
          @click="emit('pick-poster')"
        >
          <Image :size="13" />
          {{ item.poster_path ? $t('更换') : $t('选图') }}
        </button>
        <button
          v-if="item.poster_path"
          type="button"
          class="hero__posterBtn"
          :title="$t('撤掉海报，恢复文字占位')"
          :aria-label="$t('撤掉海报')"
          @click="emit('clear-poster')"
        >
          <ImageOff :size="13" />
        </button>
        <button
          v-if="episodeArtworkAvailable"
          type="button"
          class="hero__posterBtn hero__posterBtn--wide"
          :title="$t('从本作品的单集封面或预览图中选用一张作为主海报')"
          @click="emit('open-episode-artwork')"
        >
          <Clapperboard :size="13" />{{ $t("从单集选") }}</button>
      </div>
    </div>

    <div class="hero__text">
      <template v-if="editing">
        <textarea
          class="hero__name"
          :aria-label="$t('片名')"
          rows="2"
          :value="item.name_zh"
          :placeholder="$t('片名')"
          @change="emit('save', { name_zh: ($event.target as HTMLTextAreaElement).value.trim() })"
        />
        <input
          class="hero__en"
          :aria-label="$t('原名 / 英文名')"
          :value="item.name_en"
          :placeholder="$t('原名 / 英文名')"
          @change="emit('save', { name_en: ($event.target as HTMLInputElement).value.trim() })"
        />
      </template>
      <template v-else>
        <div class="hero__title-line">
          <h1 class="hero__title">{{ title }}</h1>
          <span class="hero__badge">
            <Clapperboard :size="12" />
            {{
              item.media_kind === 'other'
                ? $t('其他')
                : item.category === HENTAI_CATEGORY
                  ? $t('里番')
                  : VIDEO_TYPE_LABEL[item.video_type]
            }}
          </span>
        </div>
        <p v-if="item.name_en && item.name_en !== title" class="hero__original">{{ item.name_en }}</p>
      </template>

      <div class="hero__meta">
        <span v-if="yearText">{{ yearText }}</span>
        <span v-if="singleEpisode?.air_date">{{ $t("发行 {p0}", {p0: (videoDateLabel(singleEpisode.air_date))}) }}</span>
        <span v-if="singleEpisode?.published_at">{{ $t("发布 {p0}", {p0: (videoDateLabel(singleEpisode.published_at))}) }}</span>
        <span v-if="publicationRange.collection" class="hero__publication">{{ $t("发布时间：最早 {p0} · 最晚 {p1}", {p0: (publicationRange.first || $t('未知')), p1: (publicationRange.last || $t('未知'))}) }}
        </span>
        <span v-else-if="!singleEpisode?.published_at && !singleEpisode?.air_date" class="hero__publication">{{ $t("发布时间：{p0}", {p0: (publicationRange.first || $t('未知'))}) }}
        </span>
        <span v-if="item.resolution">{{ item.resolution }}</span>
        <span>{{ $t("{p0} 个视频文件可用", {p0: (presentCount)}) }}</span>
        <span v-if="!isSeries && item.duration_sec > 0">{{ formatDuration(item.duration_sec) }}</span>
        <span v-if="item.rating > 0" class="hero__rating" :title="$t('TMDB 评分')">
          <Star :size="11" />{{ item.rating.toFixed(1) }}
        </span>
        <span v-if="item.douban_rating > 0" class="hero__rating" :title="$t('豆瓣评分')">{{ $t("豆 {p0}", {p0: (item.douban_rating.toFixed(1))}) }}
        </span>
      </div>

      <input
        v-if="editing"
        class="hero__summary"
        :aria-label="$t('一句话说明')"
        :value="item.summary"
        :placeholder="$t('一句话说明')"
        @change="emit('save', { summary: ($event.target as HTMLInputElement).value.trim() })"
      />
      <p v-else-if="item.summary" class="hero__summary-text">{{ item.summary }}</p>

      <div class="statuses" role="group" :aria-label="$t('作品观看状态')">
        <button
          v-for="s in STATUSES"
          :key="s"
          type="button"
          class="chip"
          :class="{ on: item.watch_status === s }"
          :aria-pressed="item.watch_status === s"
          @click="emit('save', { watch_status: s })"
        >
          {{ WATCH_STATUS_LABEL[s] }}
        </button>
        <button
          type="button"
          class="btn btn--subtle hero__edit"
          :aria-pressed="editing"
          @click="emit('update:editing', !editing)"
        >
          <Check v-if="editing" :size="13" />
          <Pencil v-else :size="13" />
          {{ editing ? $t('完成编辑') : $t('编辑资料') }}
        </button>
      </div>

      <button
        v-if="library?.directory?.path || item.path"
        class="hero__location"
        type="button"
        :title="$t('复制作品位置：') + (library?.directory?.path || item.path)"
        @click="emit('copy-path', library?.directory?.path || item.path)"
      >
        <FolderOpen :size="12" />
        <span>{{ library?.directory?.path || item.path }}</span>
      </button>
    </div>

    <aside class="hero__facts" :aria-label="$t('作品信息')">
      <span v-if="item.category && item.category !== HENTAI_CATEGORY" class="hero__category">
        {{ item.category }}
      </span>
      <label v-if="editing" class="hero__field">{{ $t("类型") }}<select
          class="input"
          :aria-label="$t('视频类型')"
          :value="item.media_kind === 'other' ? item.media_kind : item.category === HENTAI_CATEGORY ? 'hentai' : item.video_type"
          @change="emit('change-type', ($event.target as HTMLSelectElement).value)"
        >
          <option value="movie">{{ $t("电影") }}</option>
          <option value="series">{{ $t("剧集") }}</option>
          <option value="hentai">{{ $t("里番") }}</option>
          <option value="other">{{ $t("其他") }}</option>
          <option value="audio">{{ $t("音频") }}</option>
        </select>
      </label>
      <label v-if="editing && item.category !== HENTAI_CATEGORY" class="hero__field">{{ $t("分类") }}<input
          class="input"
          :value="item.category"
          list="video-category-options"
          :aria-label="$t('视频分类')"
          @change="emit('save', { category: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>
      <datalist id="video-category-options">
        <option
          v-for="name in ['华语', '欧美', '日韩', '动画', '纪录片', '综艺', '其他']"
          :key="name"
          :value="name"
        />
      </datalist>

      <div class="hero__tag-heading">{{ $t("作品标签") }}<span v-if="(library?.contents.length || 0) > 1">{{ $t("· 各集标签独立保存") }}</span>
      </div>
      <div v-if="visibleTags.length" class="hero__tag-area">
        <div
          id="video-work-tags"
          ref="tagsElement"
          class="tags hero__tags"
          :style="{ maxHeight: tagsExpanded ? 'none' : tagsHeight + 'px' }"
        >
          <TagBadge
            v-for="(tag, index) in visibleTags"
            :key="tag"
            :label="tag"
            clickable
            :inert="!tagsExpanded && index >= tagVisibleCount"
            :aria-hidden="!tagsExpanded && index >= tagVisibleCount ? true : undefined"
            :title="$t('筛选含「{p0}」的作品', {p0: tag})"
            @click="emit('filter-tag', tag)"
          />
        </div>
        <button
          v-if="tagsOverflow"
          class="hero__tags-more"
          type="button"
          :aria-expanded="tagsExpanded"
          aria-controls="video-work-tags"
          :aria-label="tagsExpanded ? $t('收起标签') : $t('展开全部标签')"
          @click="tagsExpanded = !tagsExpanded"
        >
          {{ tagsExpanded ? $t('收起') : '...' }}
        </button>
      </div>
      <p v-else class="hero__empty-tags">{{ $t("暂无标签") }}</p>
      <EditableField
        v-if="editing"
        :model-value="item.tags.join('、')"
        :placeholder="$t('用顿号隔开，最多 8 个')"
        @commit="emit('commit-tags', $event)"
      />
      <p v-if="library?.contents.length" class="hero__progress">{{ $t("已看 {p0} / {p1} 集", {p0: (library.contents.filter((episode) => episode.watch_status === 'watched').length), p1: (library.contents.length)}) }}</p>
    </aside>
  </section>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr) minmax(180px, 23%);
  gap: 16px;
  align-items: start;
  padding: 16px;
}
.hero__poster {
  position: relative;
  flex: none;
  width: 84px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(155deg, hsl(var(--hue) 26% 26%), hsl(calc(var(--hue) + 28) 22% 15%));
}
.hero__initial {
  font-family: var(--font-display);
  font-size: 40px;
  color: rgb(255 255 255 / 0.82);
}
.hero__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.hero__posterActs {
  position: absolute;
  inset: auto 0 0 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  gap: 2px;
  padding: 3px;
  background: rgb(0 0 0 / 0.62);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity var(--t-fast) ease;
}
.hero__poster:hover .hero__posterActs,
.hero__posterActs:focus-within {
  opacity: 1;
}
.hero__posterBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 10px;
  min-height: 22px;
  white-space: nowrap;
  color: rgb(255 255 255 / 0.86);
}
.hero__posterBtn:hover {
  color: #fff;
}
.hero__posterBtn:first-child,
.hero__posterBtn:nth-child(2):last-child,
.hero__posterBtn--wide {
  grid-column: 1 / -1;
}
.hero__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hero__name,
.hero__en,
.hero__summary {
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  padding: 3px 6px;
  margin-left: -6px;
  color: inherit;
  transition: border-color var(--t-fast) ease;
}
.hero__name:hover,
.hero__en:hover,
.hero__summary:hover {
  border-color: var(--divider);
}
.hero__name:focus,
.hero__en:focus,
.hero__summary:focus {
  border-color: var(--accent);
}
.hero__name {
  resize: vertical;
  min-height: 44px;
  font-size: 18px;
  font-weight: 500;
  line-height: 1.4;
}
.hero__en {
  font-size: var(--fs-body);
  color: var(--text-faint);
}
.hero__summary {
  font-size: var(--fs-body);
  color: var(--text-sub);
}
.hero__title {
  font-size: 19px;
  font-weight: 500;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.hero__title-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.hero__title-line h1 {
  min-width: 0;
}
.hero__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 400;
  padding: 3px 7px;
  border-radius: var(--radius-tag);
  background: var(--hover-surface);
  color: var(--text-main);
}
.hero__original,
.hero__summary-text {
  font-size: var(--fs-tag);
  color: var(--text-sub);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.hero__summary-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.hero__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero__rating {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--warning);
}
.statuses {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.chip {
  height: 26px;
  padding: 0 12px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  transition: background var(--t-fast) ease, color var(--t-fast) ease, border-color var(--t-fast) ease;
}
.chip:hover {
  color: var(--text-main);
}
.chip.on {
  background: var(--active-surface);
  border-color: transparent;
  color: var(--text-main);
}
.hero__edit {
  margin-left: auto;
  min-height: 28px;
}
.hero__location {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  text-align: left;
  color: var(--text-sub);
  font-size: 11px;
  line-height: 1.5;
}
.hero__location svg {
  flex: none;
  margin-top: 2px;
}
.hero__location span {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.hero__facts {
  min-width: 0;
  border-left: 1px solid var(--divider);
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.hero__category,
.hero__tag-heading,
.hero__empty-tags,
.hero__progress {
  font-size: 11px;
  color: var(--text-sub);
  line-height: 1.6;
}
.hero__tag-heading {
  margin-top: 3px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
  overflow: hidden;
  align-content: start;
}
.hero__tag-area {
  min-width: 0;
}
.hero__tags-more {
  color: var(--text-sub);
  margin-top: 3px;
  padding: 0 8px;
  min-width: 28px;
  min-height: 22px;
  border-radius: 4px;
  font-size: 12px;
}
.hero__tags-more:hover {
  background: var(--hover-surface);
  color: var(--accent);
}
.hero__progress {
  padding-top: 8px;
  border-top: 1px solid var(--divider);
  font-variant-numeric: tabular-nums;
}
.hero__field {
  display: grid;
  gap: 5px;
  color: var(--text-sub);
  font-size: 11px;
}
.spin {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1060px) {
  .hero {
    grid-template-columns: 70px minmax(0, 1fr) 180px;
    gap: 12px;
    padding: 12px;
  }
  .hero__poster {
    width: 70px;
  }
  .hero__facts {
    padding-left: 12px;
  }
  .hero__title {
    font-size: 17px;
  }
  .hero__text {
    gap: 5px;
  }
}
@media (max-width: 720px) {
  .hero {
    grid-template-columns: 70px minmax(0, 1fr);
  }
  .hero__facts {
    grid-column: 1 / -1;
    padding: 10px 0 0;
    border-left: 0;
    border-top: 1px solid var(--divider);
  }
}
</style>
