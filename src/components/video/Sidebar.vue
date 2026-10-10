<script setup lang="ts">
/**
 * 影视库侧边栏。
 *
 * 和另两份各写各的，理由同 game/Sidebar.vue 顶上那段：结构像，格子不一样。
 * 这边多一组「类型」（电影 / 剧集）——它是影视库里最常用的一刀，
 * 而软件和游戏没有对应物。
 */
import { computed, ref } from 'vue'
import { Archive, Box, ChevronDown, CircleAlert, Clapperboard, Film, Flame, Folder, Hash, Music2, Tv } from 'lucide-vue-next'
import { VIDEO_TYPE_LABEL, WATCH_STATUS_LABEL, useVideoStore } from '@/stores/video'
import type { VideoFilterType, WatchStatus } from '@/types'

const store = useVideoStore()
const props = withDefaults(defineProps<{ pendingActive?: boolean; pendingCount?: number; privateHidden?: boolean }>(), { pendingActive: false, pendingCount: 0, privateHidden: false })
defineEmits<{ pending: [] }>()

/** 在看排第一：这一格是这组里唯一有行动含义的那一格（接着看什么） */
const STATUSES: WatchStatus[] = ['watching', 'unwatched', 'watched', 'dropped']
const TYPES: Exclude<VideoFilterType,'hentai'>[] = ['movie', 'series', 'other', 'audio']

const tagsOpen = ref(false)
const inHentaiScope = computed(() => store.inHentaiScope)
const collections = computed(() => {
  const saved = (inHentaiScope.value ? props.privateHidden ? [] : store.counts.hentai_collections : store.counts.collections) ?? []
  const total = inHentaiScope.value ? props.privateHidden ? 0 : store.counts.hentai : store.counts.all
  return [{ name: '', count: Math.max(0, (total || 0) - saved.reduce((sum, row) => sum + row.count, 0)) }, ...saved]
})
const categories = computed(() => {
  const list = store.counts.categories.filter(c => c.name !== '里番')
  return list.some(c => c.name === '其他') ? list : [...list, { name: '其他', count: 0 }]
})
const tagCounts = computed(() => (inHentaiScope.value ? props.privateHidden ? [] : store.counts.hanime_tags : store.counts.tags))
const archivedCount = computed(() => inHentaiScope.value ? props.privateHidden ? 0 : store.counts.hentai_archived ?? 0 : store.counts.archived)
const visibleTags = computed(() =>
  tagsOpen.value ? tagCounts.value : tagCounts.value.slice(0, 8)
)

const isActive = (kind: string, value: string) => !props.pendingActive && store.activeKey === `${kind}:${value}`
</script>

<template>
  <nav class="sidebar" aria-label="影视分类与待处理">
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
      <button type="button" class="row" :class="{ 'row--active': pendingActive }" :aria-pressed="pendingActive" title="查看当前范围的待处理作品" @click="$emit('pending')">
        <CircleAlert :size="15" /><span class="row__label">待处理</span><span class="row__count">{{ pendingCount }}</span>
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
        <Music2 v-else-if="t === 'audio'" :size="15" /><Folder v-else-if="t === 'other'" :size="15" /><Tv v-else :size="15" />
        <span class="row__label">{{ VIDEO_TYPE_LABEL[t] }}</span>
        <span class="row__count">{{ t==='audio'||t==='other' ? store.counts[t]||0 : store.counts.type[t] }}</span>
      </button>

      <button v-if="!privateHidden && store.counts.hentai_visible !== false" class="row"
        :class="{ 'row--active': isActive('type', 'hentai') }"
        @click="store.select({ kind: 'type', value: 'hentai' })">
        <Flame :size="15" />
        <span class="row__label">里番</span>
        <span class="row__count">{{ store.counts.hentai ?? 0 }}</span>
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

      <template v-if="categories.length > 0">
        <p class="sidebar__title">分类</p>
        <button
          v-for="c in categories"
          :key="c.name"
          class="row"
          :class="{ 'row--active': isActive('category', c.name) }"
          @click="store.select({ kind: 'category', value: c.name })"
        >
          <Box :size="15" />
          <span class="row__label">{{ c.name === '其他' || c.name === '音频' ? c.name + '分类' : c.name }}</span>
          <span class="row__count">{{ c.count }}</span>
        </button>
      </template>

      <template v-if="collections.length">
        <p class="sidebar__title">收藏分组</p>
        <button v-for="collection in collections" :key="collection.name" class="row"
          :class="{ 'row--active': isActive('collection', collection.name) }"
          @click="store.select({ kind: 'collection', value: collection.name, ...(inHentaiScope ? { type: 'hentai' as const } : {}) })">
          <Folder :size="15" />
          <span class="row__label" :title="collection.name || '未设置'">{{ collection.name || '未设置' }}</span>
          <span class="row__count">{{ collection.count }}</span>
        </button>
      </template>

      <template v-if="tagCounts.length > 0">
        <button class="sidebar__title sidebar__title--btn" :aria-expanded="tagsOpen" @click="tagsOpen = !tagsOpen">
          <span>{{ inHentaiScope ? '里番标签' : '标签' }}</span>
          <ChevronDown :size="13" :class="['chev', { 'chev--open': tagsOpen }]" />
        </button>
        <button
          v-for="t in visibleTags"
          :key="t.name"
          class="row"
          :class="{ 'row--active': isActive('tag', t.name) }"
          @click="store.select({ kind: 'tag', value: t.name, ...(inHentaiScope ? { type: 'hentai' as const } : {}) })"
        >
          <Hash :size="15" />
          <span class="row__label">{{ t.name }}</span>
          <span class="row__count">{{ t.count }}</span>
        </button>
      </template>

      <template v-if="archivedCount > 0">
        <div class="sidebar__divider" />
        <button
          class="row"
          :class="{ 'row--active': isActive('group', 'archived') }"
          @click="store.select({ kind: 'group', value: 'archived', ...(inHentaiScope ? { type: 'hentai' as const } : {}) })"
        >
          <Archive :size="15" />
          <span class="row__label">已归档</span>
          <span class="row__count">{{ archivedCount }}</span>
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
  letter-spacing: 0;
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
.sidebar { --text-faint: var(--text-sub); }
.sidebar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row { height: auto; min-height: 32px; padding-block: 6px; }
.row__label { white-space: normal; overflow-wrap: anywhere; }
.row--active, .row--active .row__count { color: var(--text-main); }

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
