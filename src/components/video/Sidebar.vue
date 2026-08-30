<script setup lang="ts">
/**
 * 影视库侧边栏。
 *
 * 和另两份各写各的，理由同 game/Sidebar.vue 顶上那段：结构像，格子不一样。
 * 这边多一组「类型」（电影 / 剧集）——它是影视库里最常用的一刀，
 * 而软件和游戏没有对应物。
 */
import { computed, ref } from 'vue'
import { Archive, Box, ChevronDown, Clapperboard, Film, Hash, Tv } from 'lucide-vue-next'
import { VIDEO_TYPE_LABEL, WATCH_STATUS_LABEL, useVideoStore } from '@/stores/video'
import type { VideoType, WatchStatus } from '@/types'

const store = useVideoStore()

/** 在看排第一：这一格是这组里唯一有行动含义的那一格（接着看什么） */
const STATUSES: WatchStatus[] = ['watching', 'unwatched', 'watched', 'dropped']
const TYPES: VideoType[] = ['movie', 'series']

const tagsOpen = ref(false)
const visibleTags = computed(() =>
  tagsOpen.value ? store.counts.tags : store.counts.tags.slice(0, 8)
)

const isActive = (kind: string, value: string) => store.activeKey === `${kind}:${value}`
</script>

<template>
  <nav class="sidebar">
    <div class="sidebar__scroll">
      <button
        class="row"
        :class="{ 'row--active': isActive('group', 'all') }"
        @click="store.select({ kind: 'group', value: 'all' })"
      >
        <Clapperboard :size="15" />
        <span class="row__label">全部影视</span>
        <span class="row__count">{{ store.counts.all }}</span>
      </button>

      <p class="sidebar__title">类型</p>
      <!-- 两格都留着，哪怕计数为 0：闭集，空的那格是「这里可以放东西」的空位 -->
      <button
        v-for="t in TYPES"
        :key="t"
        class="row"
        :class="{ 'row--active': isActive('type', t) }"
        @click="store.select({ kind: 'type', value: t })"
      >
        <Film v-if="t === 'movie'" :size="15" />
        <Tv v-else :size="15" />
        <span class="row__label">{{ VIDEO_TYPE_LABEL[t] }}</span>
        <span class="row__count">{{ store.counts.type[t] }}</span>
      </button>

      <p class="sidebar__title">观看</p>
      <!-- 四态是闭集，计数为 0 的也留着。分类那边相反，空分类不出现 ——
           分类是开集，会越长越多 -->
      <button
        v-for="s in STATUSES"
        :key="s"
        class="row"
        :class="{ 'row--active': isActive('status', s) }"
        @click="store.select({ kind: 'status', value: s })"
      >
        <span class="dot" :class="`dot--${s}`" />
        <span class="row__label">{{ WATCH_STATUS_LABEL[s] }}</span>
        <span class="row__count">{{ store.counts.status[s] }}</span>
      </button>

      <template v-if="store.counts.categories.length > 0">
        <p class="sidebar__title">分类</p>
        <button
          v-for="c in store.counts.categories"
          :key="c.name"
          class="row"
          :class="{ 'row--active': isActive('category', c.name) }"
          @click="store.select({ kind: 'category', value: c.name })"
        >
          <Box :size="15" />
          <span class="row__label">{{ c.name }}</span>
          <span class="row__count">{{ c.count }}</span>
        </button>
      </template>

      <template v-if="store.counts.tags.length > 0">
        <button class="sidebar__title sidebar__title--btn" @click="tagsOpen = !tagsOpen">
          <span>标签</span>
          <ChevronDown :size="13" :class="['chev', { 'chev--open': tagsOpen }]" />
        </button>
        <button
          v-for="t in visibleTags"
          :key="t.name"
          class="row"
          :class="{ 'row--active': isActive('tag', t.name) }"
          @click="store.select({ kind: 'tag', value: t.name })"
        >
          <Hash :size="15" />
          <span class="row__label">{{ t.name }}</span>
          <span class="row__count">{{ t.count }}</span>
        </button>
      </template>

      <template v-if="store.counts.archived > 0">
        <div class="sidebar__divider" />
        <button
          class="row"
          :class="{ 'row--active': isActive('group', 'archived') }"
          @click="store.select({ kind: 'group', value: 'archived' })"
        >
          <Archive :size="15" />
          <span class="row__label">已归档</span>
          <span class="row__count">{{ store.counts.archived }}</span>
        </button>
      </template>
    </div>
  </nav>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-side);
  border-right: 1px solid var(--divider);
}

.sidebar__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px;
}

.sidebar__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0 8px;
  margin: 16px 0 6px;
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-faint);
}

.sidebar__title--btn {
  cursor: pointer;
}
.sidebar__title--btn:hover {
  color: var(--text-sub);
}

.chev {
  transition: transform var(--t-fast) ease;
}
.chev--open {
  transform: rotate(180deg);
}

.sidebar__divider {
  height: 1px;
  background: var(--divider);
  margin: 14px 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-btn);
  color: var(--text-sub);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}

.row:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

.row--active {
  background: var(--active-surface);
  color: var(--accent);
}

.row__label {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__count {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.row--active .row__count {
  color: var(--accent);
}

/*
 * 观看状态四色。和游戏那边的游玩状态对齐，同一个位置同一种读法：
 * 强调色 = 正在进行，绿 = 完成了，灰 = 还没开始。
 * 「弃」用空心圈 —— 项目里「实心 = 记到了，空心 = 没有实据」这个约定，
 * 而「弃」说的正是「这条不会再往下走了」，不是一个进度。
 */
.dot {
  width: 8px;
  height: 8px;
  margin: 0 3px;
  border-radius: 50%;
  flex: none;
}
.dot--watching {
  background: var(--accent);
}
.dot--unwatched {
  background: var(--text-faint);
}
.dot--watched {
  background: #6aa84f;
}
.dot--dropped {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--text-faint);
}
</style>
