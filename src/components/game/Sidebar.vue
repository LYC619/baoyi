<script setup lang="ts">
/**
 * 游戏库侧边栏。
 *
 * 和软件那份刻意各写各的：结构像，格子不一样 —— 软件按「熟练度 / 长期未用 /
 * 绿色软件」分，游戏按「游玩状态」分。抽一个公共 Sidebar 出来要先把这两套
 * 分组抽象成一样的东西，那层抽象比多出来的这一百行更贵。
 */
import { computed, ref } from 'vue'
import { Archive, Box, ChevronDown, Gamepad2, Hash } from 'lucide-vue-next'
import { PLAY_STATUS_LABEL, useGameStore } from '@/stores/game'
import type { PlayStatus } from '@/types'

const store = useGameStore()

const STATUSES: PlayStatus[] = ['playing', 'unplayed', 'completed', 'shelved']

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
        <Gamepad2 :size="15" />
        <span class="row__label">全部游戏</span>
        <span class="row__count">{{ store.counts.all }}</span>
      </button>

      <p class="sidebar__title">状态</p>
      <!-- 四态是闭集，计数为 0 的也留着：它是一个「这里可以放东西」的空位，
           不是噪音。分类那边就相反，空分类不出现 —— 分类是开集，会越长越多 -->
      <button
        v-for="s in STATUSES"
        :key="s"
        class="row"
        :class="{ 'row--active': isActive('status', s) }"
        @click="store.select({ kind: 'status', value: s })"
      >
        <span class="dot" :class="`dot--${s}`" />
        <span class="row__label">{{ PLAY_STATUS_LABEL[s] }}</span>
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

/* 状态点：四个颜色不是装饰，是让用户不用读字就能扫到「在玩」的那一行 */
.dot {
  width: 8px;
  height: 8px;
  margin: 0 3px;
  border-radius: 50%;
  flex: none;
}
.dot--playing {
  background: var(--accent);
}
.dot--unplayed {
  background: var(--text-faint);
}
.dot--completed {
  background: #6aa84f;
}
.dot--shelved {
  background: var(--warning);
}
</style>
