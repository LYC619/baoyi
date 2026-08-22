<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Archive,
  Bot,
  Box,
  Bug,
  ChevronDown,
  Clapperboard,
  Code2,
  FileText,
  Folder,
  Globe,
  Hash,
  Image,
  Layers,
  Search,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Timer,
  Zap
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { useCategoriesStore } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'

const store = useSoftwareStore()
const categories = useCategoriesStore()

/** 分类图标名 → 组件。旧名字留着，用户自建的分类可能还在用 */
const ICONS: Record<string, Component> = {
  bug: Bug,
  bot: Bot,
  search: Search,
  'file-text': FileText,
  'sliders-horizontal': SlidersHorizontal,
  globe: Globe,
  image: Image,
  clapperboard: Clapperboard,
  shield: Shield,
  'sticky-note': StickyNote,
  box: Box,
  'code-2': Code2,
  'settings-2': Settings2,
  folder: Folder,
  zap: Zap
}

const iconFor = (name: string) => ICONS[categories.iconOf(name)] ?? Box

/**
 * 左下角这句话是氛围，不是功能 —— 所以用衬线体、压小、压淡，并带上出处。
 * 放在模块作用域而不是 setup 里：一次启动认一句，来回切页面时不会跳来跳去。
 */
const MOTTOS = [
  { text: '少则得，多则惑。', from: '《道德经》第二十二章' },
  { text: '知止而后有定。', from: '《大学》' },
  { text: '圣人抱一为天下式。', from: '《道德经》第二十二章' },
  { text: '见素抱朴，少私寡欲。', from: '《道德经》第十九章' }
]
const motto = MOTTOS[Math.floor(Math.random() * MOTTOS.length)]

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
        <Layers :size="15" />
        <span class="row__label">全部</span>
        <span class="row__count">{{ store.counts.all }}</span>
      </button>

      <p class="sidebar__title">分类</p>
      <button
        v-for="c in store.counts.categories"
        :key="c.name"
        class="row"
        :class="{ 'row--active': isActive('category', c.name) }"
        @click="store.select({ kind: 'category', value: c.name })"
      >
        <component :is="iconFor(c.name)" :size="15" />
        <span class="row__label">{{ c.name }}</span>
        <span class="row__count">{{ c.count }}</span>
      </button>
      <p v-if="store.counts.categories.length === 0" class="sidebar__empty">尚无分类</p>

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

      <button
        class="row"
        :class="{ 'row--active': isActive('group', 'unused'), 'row--warn': store.counts.unused > 0 }"
        @click="store.select({ kind: 'group', value: 'unused' })"
      >
        <Timer :size="15" />
        <span class="row__label">长期未用</span>
        <span class="row__count">{{ store.counts.unused }}</span>
      </button>

      <button
        v-if="store.counts.pending > 0"
        class="row"
        :class="{ 'row--active': isActive('group', 'pending') }"
        @click="store.select({ kind: 'group', value: 'pending' })"
      >
        <Sparkles :size="15" />
        <span class="row__label">待识别</span>
        <span class="row__count">{{ store.counts.pending }}</span>
      </button>
    </div>

    <footer class="motto">
      <p class="motto__text">{{ motto.text }}</p>
      <p class="motto__from">——{{ motto.from }}</p>
    </footer>
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

.sidebar__empty {
  padding: 4px 8px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
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

.row--warn .row__count {
  color: var(--warning);
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

.motto {
  flex: none;
  padding: 14px 18px 16px;
  border-top: 1px solid var(--divider);
  font-family: var(--font-serif);
  color: var(--text-faint);
}

.motto__text {
  font-size: 13px;
  letter-spacing: 1px;
  line-height: 1.7;
}

.motto__from {
  margin-top: 4px;
  font-size: 10px;
  opacity: 0.72;
}
</style>
