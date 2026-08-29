<script setup lang="ts">
/**
 * 封面墙的一格。竖版 2:3，因为游戏封面本来就是这个比例。
 *
 * 封面是用户在详情页手工指的（Step 7），自动找封面仍然没做 —— 它在规划书里是 P2。
 * 所以**大多数卡片长期是占位形态**，占位不能当「临时凑合」来做，它得自己站得住：
 * 首字 + 按名字散出来的稳定色，看上去像一张有意为之的卡，而不是一个破图。
 */
import { computed } from 'vue'
import { Clock, Unlink } from 'lucide-vue-next'
import type { GameItem } from '@/types'
import { coverUrl, formatPlaytime, formatRelative, gameTitle } from '@/utils'
import { PLAY_STATUS_LABEL, useGameStore } from '@/stores/game'

const props = defineProps<{ item: GameItem }>()
defineEmits<{ (e: 'open', id: string): void }>()

const store = useGameStore()

/**
 * 存档路径失效的角标。
 *
 * 独立于「游玩状态」那个角标显示，两者含义不冲突：一个说他玩到哪儿了，
 * 一个说抱一记的那条路径现在指不到东西。压成一个角标会丢掉其中一句。
 */
const stale = computed(() => store.staleSaves.get(props.item.id) ?? [])

const title = computed(() => gameTitle(props.item))

/** 占位封面上的那个字。中文取首字，英文取首字母 */
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')

/**
 * 按名字散出一个稳定的色相：同一个游戏每次进来都是同一个颜色，
 * 用户对「那张紫色的卡」建立起的空间记忆才不会每次刷新都作废。
 */
const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

/**
 * 走 baoyi://cover/ 而不是把 cover_path 直接当 src：打包后页面跑在 `file://` 下，
 * `src="C:\..."` 加载不出来。updated_at 当版本号破缓存 —— 换封面时文件名不变
 * （按 id 定的），不带它换了图也不会刷新。
 */
const cover = computed(() => coverUrl(props.item.cover_path, props.item.updated_at))
</script>

<template>
  <button class="card" :title="item.summary || title" @click="$emit('open', item.id)">
    <div class="card__cover" :style="{ '--hue': hue }">
      <img v-if="cover" :src="cover" :alt="title" class="card__img" />
      <span v-else class="card__initial">{{ initial }}</span>
      <span v-if="item.play_status !== 'unplayed'" class="card__status">
        {{ PLAY_STATUS_LABEL[item.play_status] }}
      </span>
      <span
        v-if="stale.length > 0"
        class="card__stale"
        :title="`存档路径找不到了：\n${stale.join('\n')}`"
      >
        <Unlink :size="11" />
      </span>
    </div>

    <p class="card__name truncate">{{ title }}</p>
    <p class="card__meta truncate">
      <Clock :size="11" />
      <span v-if="item.total_playtime_sec > 0">{{ formatPlaytime(item.total_playtime_sec) }}</span>
      <span v-else>{{ formatRelative(item.last_played_at) === '从未使用' ? '未玩过' : formatRelative(item.last_played_at) }}</span>
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

.card__cover {
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

.card:hover .card__cover {
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

/* 右上角，和左下的状态角标对开，两个同时出现也不叠 */
.card__stale {
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
  gap: 4px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}
</style>
