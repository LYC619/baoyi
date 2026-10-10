<script setup lang="ts">
/**
 * 海报墙的一格。竖版 2:3 —— 影视海报本来就是这个比例，和游戏封面同一个框。
 *
 * 和游戏卡片刻意各写一份而不是抽一个公共组件：两边角标说的话不一样
 * （那边是存档失效，这边是缺集数），而把差异塞进 props 的结果是一个谁都读不懂的
 * 组件。理由和两个侧栏不合并是同一条，见 game/Sidebar.vue 顶上那段。
 */
import { computed, ref, watch } from 'vue'
import { Check, Film, Tv } from 'lucide-vue-next'
import type { VideoItem } from '@/types'
import type { VideoWorkContent } from '@/types/video-workflow'
import { formatDuration, posterUrl, videoTitle } from '@/utils'
import { videoDateLabel, videoEpisodeLabel } from '@/utils/video-content'
import { WATCH_STATUS_LABEL } from '@/stores/video'

const props = withDefaults(defineProps<{ item: VideoItem; episode?: VideoWorkContent; status?: string; recent?: string; selectable?: boolean; selected?: boolean; locked?: boolean; showPublished?: boolean }>(), { status: '', recent: '', selectable: false, selected: false, showPublished: false })
defineEmits<{ (e: 'open', id: string): void; (e: 'poster-error', id: string): void; (e: 'select', id: string, event: MouseEvent): void }>()

const title = computed(() => props.episode ? props.episode.title || props.episode.original_title || videoEpisodeLabel(props.episode, props.item.category === '里番') : videoTitle(props.item))
const watchStatus = computed(() => props.episode?.watch_status || props.item.watch_status)
const episodeAvailability = computed(() => props.episode?.assets.some(asset => asset.role === 'video' && asset.state === 'present') ? '本地可播放' : props.episode?.path ? '本地文件缺失' : '待下载')

/** 占位海报上的那个字。中文取首字，英文取首字母 */
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')

/**
 * 按名字散出一个稳定的色相，同游戏卡片：同一部片每次进来都是同一个颜色，
 * 用户对「那张蓝色的卡」建立起的空间记忆才不会每次刷新都作废。
 */
const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

/**
 * `posterUrl` 会把刮削阶段落下的 TMDB 相对路径挡掉（返回空串），
 * 于是那种条目在海报下载完之前显示首字占位，而不是一张破图。
 */
const poster = computed(() => posterUrl(props.episode ? props.episode.poster_path || '' : props.item.poster_path, props.item.updated_at))
const posterFailed = ref(false)
watch(poster, () => { posterFailed.value = false })

/** 剧集第二行显示进度，电影显示片长 */
const isSeries = computed(() => !props.episode && props.item.video_type === 'series')

/**
 * 「看了几集 / 一共几集」。缺文件的那些也算在总数里 —— 详情页那一列「在 / 缺」
 * 就是这么来的，卡片上如果只数手上有的，两处的数字会对不上。
 */
const episodeLine = computed(() => {
  const { episode_watched: watched, episode_total: discovered } = props.item
  return discovered > 0 ? `已发现 ${discovered} 项 · 已看 ${watched} 项` : '内容总数尚未确定'
})
const videoCount = computed(() => typeof props.item.available_files === 'number'
  ? `已有 ${props.item.available_files} 个视频` : '视频文件待检查')
</script>

<template>
  <button :disabled="selectable && locked" class="card" :class="{ 'card--selected': selectable && selected }" type="button" :title="title" :aria-label="selectable ? '选择作品：' + title : undefined" :aria-pressed="selectable ? selected : undefined" @click="selectable ? $emit('select', item.id, $event) : $emit('open', item.id)">
    <div class="card__poster" :style="{ '--hue': hue }">
      <img v-if="poster && !posterFailed" :src="poster" :alt="title" class="card__img"
        @error="posterFailed = true; !episode && $emit('poster-error', item.id)" />
      <span v-else class="card__initial">{{ initial }}</span>
      <span v-if="selectable" class="card__selection" aria-hidden="true"><Check v-if="selected" :size="14" /></span>

      <span v-if="watchStatus !== 'unwatched'" class="card__status">
        {{ WATCH_STATUS_LABEL[watchStatus] }}
      </span>

      <!-- 右上角只标类型。和左下的状态角标对开，两个同时出现也不叠 -->
      <span class="card__type" :title="episode ? '单集' : isSeries ? '剧集' : '电影'">
        <Tv v-if="isSeries" :size="11" />
        <Film v-else :size="11" />
      </span>
    </div>

    <div class="card__body">
      <p class="card__name">{{ title }}</p>
      <template v-if="episode">
        <p class="card__meta"><span>{{ videoEpisodeLabel(episode, item.category === '里番') }}</span><span v-if="episode.duration_sec > 0">{{ formatDuration(episode.duration_sec) }}</span></p>
        <p class="card__detail"><span v-if="episode.air_date">发行 {{ videoDateLabel(episode.air_date) }}</span><span v-else-if="episode.published_at">发布 {{ videoDateLabel(episode.published_at) }}</span><span v-else>{{ episodeAvailability }}</span></p>
      </template>
      <template v-else>
      <p class="card__meta"><span v-if="item.year > 0" class="card__year">{{ item.year }}</span><span>{{ videoCount }}</span></p>
      <p v-if="isSeries" class="card__detail">{{ episodeLine }}</p>
      <p v-if="showPublished" class="card__detail">{{item.published_end ? '发布 ' + videoDateLabel(item.published_end) : '发布日期未知'}}</p>
      <p v-if="status" class="card__pending">{{ status }}</p>
      <p v-if="item.matched_content" class="card__match">命中内容：{{ item.matched_content }}</p>
      <p v-else-if="recent" class="card__detail">最近新增：{{ recent }}</p>
      </template>
    </div>
  </button>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  text-align: left;
  min-width: 0;
  width: 100%;
  align-self: start;
}

.card--selected { background: var(--hover-surface); outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 5px; }
.card__selection { position: absolute; top: 6px; left: 6px; z-index: 1; display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--divider); border-radius: 4px; background: var(--bg-main); color: var(--text-main); }

.card__poster {
  position: relative;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card, 10px);
  overflow: hidden;
  display: grid;
  place-items: center;
  border: 1px solid var(--card-border);
  background: linear-gradient(
    155deg,
    hsl(var(--hue) 26% 26%),
    hsl(calc(var(--hue) + 28) 22% 15%)
  );
  transition:
    transform var(--t-fast) ease,
    box-shadow var(--t-fast) ease;
}

.card:hover .card__poster {
  transform: translateY(-3px);
  box-shadow: var(--shadow-pop);
}

.card__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card__initial {
  font-family: var(--font-display);
  font-size: 40px;
  color: rgb(255 255 255 / 0.82);
}

.card__status {
  position: absolute;
  left: 7px;
  bottom: 7px;
  padding: 2px 7px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  color: #fff;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(4px);
}

.card__type {
  position: absolute;
  right: 7px;
  top: 7px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: #fff;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(4px);
}

.card__name {
  font-size: var(--fs-body);
  color: var(--text-main);
}

.card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.card__year {
  font-variant-numeric: tabular-nums;
}
.card { --text-faint: var(--text-sub); border-radius: var(--radius-input); }
.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.card__body { display: flex; flex-direction: column; gap: 5px; min-width: 0; width: 100%; }
.card__name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; line-height: 1.6; min-height: 3.2em; }
.card__detail, .card__pending, .card__match { color: var(--text-sub); font-size: var(--fs-tag); line-height: 1.5; overflow-wrap: anywhere; }
.card__pending { color: var(--text-main); }
.card__match { padding-top: 4px; border-top: 1px solid var(--divider); }
@media (prefers-reduced-motion: reduce) { .card__poster { transition: none; } }
</style>
