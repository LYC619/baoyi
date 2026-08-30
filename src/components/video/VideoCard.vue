<script setup lang="ts">
/**
 * 海报墙的一格。竖版 2:3 —— 影视海报本来就是这个比例，和游戏封面同一个框。
 *
 * 和游戏卡片刻意各写一份而不是抽一个公共组件：两边角标说的话不一样
 * （那边是存档失效，这边是缺集数），而把差异塞进 props 的结果是一个谁都读不懂的
 * 组件。理由和两个侧栏不合并是同一条，见 game/Sidebar.vue 顶上那段。
 */
import { computed } from 'vue'
import { Film, Tv } from 'lucide-vue-next'
import type { VideoItem } from '@/types'
import { formatDuration, posterUrl, videoTitle } from '@/utils'
import { WATCH_STATUS_LABEL } from '@/stores/video'

const props = defineProps<{ item: VideoItem }>()
defineEmits<{ (e: 'open', id: string): void }>()

const title = computed(() => videoTitle(props.item))

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
const poster = computed(() => posterUrl(props.item.poster_path, props.item.updated_at))

/** 剧集第二行显示进度，电影显示片长 */
const isSeries = computed(() => props.item.video_type === 'series')

/**
 * 「看了几集 / 一共几集」。缺文件的那些也算在总数里 —— 详情页那一列「在 / 缺」
 * 就是这么来的，卡片上如果只数手上有的，两处的数字会对不上。
 */
const episodeLine = computed(() => {
  const { episode_watched: w, episode_total: t, episode_present: p } = props.item
  if (t <= 0) return '未刮到季集表'
  // 缺集数放在括号里而不是另起一行：一格卡片只有一行小字的位置，
  // 而「有 3 集不在」这件事比「一共 12 集」更值得占那点地方
  const missing = t - p
  return missing > 0 ? `${w}/${t} 集 · 缺 ${missing}` : `${w}/${t} 集`
})
</script>

<template>
  <button class="card" :title="item.summary || title" @click="$emit('open', item.id)">
    <div class="card__poster" :style="{ '--hue': hue }">
      <img v-if="poster" :src="poster" :alt="title" class="card__img" />
      <span v-else class="card__initial">{{ initial }}</span>

      <span v-if="item.watch_status !== 'unwatched'" class="card__status">
        {{ WATCH_STATUS_LABEL[item.watch_status] }}
      </span>

      <!-- 右上角只标类型。和左下的状态角标对开，两个同时出现也不叠 -->
      <span class="card__type" :title="isSeries ? '剧集' : '电影'">
        <Tv v-if="isSeries" :size="11" />
        <Film v-else :size="11" />
      </span>
    </div>

    <p class="card__name truncate">{{ title }}</p>
    <p class="card__meta truncate">
      <span v-if="item.year > 0" class="card__year">{{ item.year }}</span>
      <span v-if="isSeries">{{ episodeLine }}</span>
      <span v-else>{{ formatDuration(item.duration_sec) }}</span>
    </p>
  </button>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  text-align: left;
  min-width: 0;
}

.card__poster {
  position: relative;
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
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.card__year {
  font-variant-numeric: tabular-nums;
}
</style>
