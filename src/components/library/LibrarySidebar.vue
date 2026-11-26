<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { computed, ref, type Component } from 'vue'
import { Box, ChevronDown, Hash } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  allLabel: string
  allIcon: Component
  allCount: number
  activeKey: string
  categories: { name: string; count: number }[]
  tags: { name: string; count: number }[]
  categoryIcon?: (name: string) => Component
  categoryLabel?: (name: string) => string
  showCategories?: boolean
  emptyCategories?: string
  tagLabel?: string
  tagExpandedAria?: boolean
}>(), { showCategories: true, tagExpandedAria: false })
defineEmits<{ all: []; category: [name: string]; tag: [name: string] }>()
const tagsOpen = ref(false)
const visibleTags = computed(() => tagsOpen.value ? props.tags : props.tags.slice(0, 8))
const visibleTagLabel = computed(() => props.tagLabel ?? tr('标签'))
</script>

<template>
  <nav class="sidebar">
    <div class="sidebar__scroll">
      <button class="row" :class="{ 'row--active': activeKey === 'group:all' }" @click="$emit('all')">
        <component :is="allIcon" :size="15" />
        <span class="row__label">{{ allLabel }}</span><span class="row__count">{{ allCount }}</span>
      </button>
      <slot name="after-all" />
      <template v-if="showCategories">
        <p class="sidebar__title">{{ $t("分类") }}</p>
        <slot name="before-categories" />
        <button v-for="c in categories" :key="c.name" class="row" :class="{ 'row--active': activeKey === `category:${c.name}` }" @click="$emit('category', c.name)">
          <component :is="categoryIcon ? categoryIcon(c.name) : Box" :size="15" />
          <span class="row__label">{{ categoryLabel ? categoryLabel(c.name) : c.name }}</span><span class="row__count">{{ c.count }}</span>
        </button>
        <p v-if="!categories.length && emptyCategories" class="sidebar__empty">{{ emptyCategories }}</p>
      </template>
      <slot name="before-tags" />
      <template v-if="tags.length">
        <button class="sidebar__title sidebar__title--btn" :aria-expanded="tagExpandedAria ? tagsOpen : undefined" @click="tagsOpen = !tagsOpen">
          <span>{{ visibleTagLabel }}</span><ChevronDown :size="13" :class="['chev', { 'chev--open': tagsOpen }]" />
        </button>
        <button v-for="t in visibleTags" :key="t.name" class="row" :class="{ 'row--active': activeKey === `tag:${t.name}` }" @click="$emit('tag', t.name)">
          <Hash :size="15" /><span class="row__label">{{ t.name }}</span><span class="row__count">{{ t.count }}</span>
        </button>
      </template>
      <slot name="after-tags" />
    </div>
    <slot name="footer" />
  </nav>
</template>

<style scoped>
.sidebar { width: var(--sidebar-w); flex: none; display: flex; flex-direction: column; background: var(--bg-side); border-right: 1px solid var(--divider); }
.sidebar__scroll { flex: 1; overflow-y: auto; padding: 12px 10px; }
.sidebar :deep(.sidebar__title) { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0 8px; margin: 16px 0 6px; font-size: 11px; font-weight: var(--library-title-weight, inherit); letter-spacing: var(--library-title-spacing, 1px); color: var(--text-faint); }
.sidebar__title--btn { cursor: pointer; }
.sidebar .sidebar__title--btn:hover { color: var(--text-sub); }
.chev { transition: transform var(--t-fast) ease; }
.chev--open { transform: rotate(180deg); }
.sidebar__empty { padding: 4px 8px; font-size: var(--fs-tag); color: var(--text-faint); }
.sidebar :deep(.sidebar__divider) { height: 1px; background: var(--divider); margin: 14px 8px; }
.sidebar :deep(.row) { display: flex; align-items: center; gap: 9px; width: 100%; height: var(--library-row-height, 32px); min-height: var(--library-row-min-height, 0); padding: var(--library-row-padding, 0) 8px; border-radius: var(--radius-btn); color: var(--text-sub); transition: background var(--t-fast) ease, color var(--t-fast) ease; }
.sidebar :deep(.row:hover) { background: var(--hover-surface); color: var(--text-main); }
.sidebar :deep(.row--active) { background: var(--active-surface); color: var(--library-active-color, var(--accent)); }
.sidebar :deep(.row--warn .row__count) { color: var(--warning); }
.sidebar :deep(.row__label) { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: var(--library-label-wrap, nowrap); overflow-wrap: var(--library-label-overflow, normal); }
.sidebar :deep(.row__count) { font-size: var(--fs-tag); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.sidebar :deep(.row--active .row__count) { color: var(--accent); }
</style>
