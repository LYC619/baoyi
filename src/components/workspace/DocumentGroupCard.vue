<script setup lang="ts">
import { computed } from 'vue'
import { Folder, ChevronRight, Layers } from 'lucide-vue-next'
import type { DocumentItem, DocumentCustomGroup, DocumentSubmodule } from '@/types/workspace'
import DocumentCover from './DocumentCover.vue'
import { recentGroupDocuments } from '@/utils/document-library-view'

const props = defineProps<{
  group: DocumentCustomGroup;
  items: DocumentItem[];
  view: 'list' | 'grid';
  categoryName?: string;
  submodule: DocumentSubmodule;
  bulk?: boolean;
  checked?: boolean;
}>()

const emit = defineEmits<{
  open: [];
  toggleCheck: [];
}>()

// 优先最近读过的书；不足四本时才用未读资料补位。
const recentItems = computed(() => recentGroupDocuments(props.items))

const emptySlotsCount = computed(() => Math.max(0, 4 - recentItems.value.length))
const tags = computed(() => [...new Set(props.items.flatMap(i => i.tags))].slice(0, 3))
const countLabel = computed(() => {
  const n = props.items.length
  return props.submodule === 'reading' ? `${n} 本` : `${n} 份`
})
</script>

<template>
  <article
    class="document-group-card"
    :class="{ 'grid-mode': view === 'grid', 'list-mode': view === 'list' }"
    tabindex="0"
    role="button"
    :aria-label="`分组 ${group.name}，包含 ${items.length} 份资料`"
    @click="bulk ? emit('toggleCheck') : emit('open')"
    @keydown.enter.self="emit('open')"
    @keydown.space.prevent.self="emit('open')"
  >
    <!-- Checkbox in bulk mode -->
    <input
      v-if="bulk"
      type="checkbox"
      class="bulk-checkbox"
      :checked="checked"
      :aria-label="`选择分组 ${group.name} 的全部内容`"
      @click.stop="emit('toggleCheck')"
    />

    <!-- Grid View: 2x2 Quad of 4 Recent Novels -->
    <div v-if="view === 'grid'" class="group-cover-quad">
      <div class="quad-grid">
        <div
          v-for="item in recentItems"
          :key="item.id"
          class="quad-item"
        >
          <DocumentCover
            :item="item"
            size="list"
            class="quad-cover"
          />
        </div>
        <div
          v-for="n in emptySlotsCount"
          :key="'empty-' + n"
          class="quad-item quad-item--empty"
        >
          <Folder v-if="recentItems.length === 0 && n === 1" :size="24" class="empty-icon" />
        </div>
      </div>

      <!-- Count Badge on Cover -->
      <span class="stack-count-badge">
        <Layers :size="12" /> {{ countLabel }}
      </span>
    </div>

    <!-- List View: Mini 2x2 Thumbnail -->
    <div v-else class="group-list-thumbnail">
      <div class="list-quad-grid">
        <div
          v-for="item in recentItems.slice(0, 4)"
          :key="item.id"
          class="list-quad-slot"
        >
          <DocumentCover :item="item" size="list" class="list-quad-cover" />
        </div>
        <div
          v-for="n in Math.max(0, 4 - Math.min(recentItems.length, 4))"
          :key="'list-empty-' + n"
          class="list-quad-slot list-quad-slot--empty"
        >
          <Folder v-if="recentItems.length === 0 && n === 1" :size="14" class="empty-icon" />
        </div>
      </div>
    </div>

    <!-- Metadata Info -->
    <div class="group-card-info">
      <div class="group-title-row">
        <strong class="group-title" :title="group.name">{{ group.name }}</strong>
        <span class="ws-badge group-badge">分组</span>
        <span v-if="categoryName" class="ws-badge category-badge">{{ categoryName }}</span>
      </div>

      <small class="group-subtitle">
        合集 · 共 {{ countLabel }}
        <template v-if="submodule === 'reading' && items.some(i => i.author)">
          · {{ items.map(i => i.author).filter(Boolean)[0] }} 等
        </template>
      </small>

      <span v-if="tags.length" class="row-tags ws-muted" :title="tags.join(' · ')">
        {{ tags.join(' · ') }}
      </span>
    </div>

    <!-- Right Chevron (List mode) -->
    <button
      v-if="view === 'list'"
      type="button"
      class="ws-icon group-open-btn"
      :aria-label="`展开分组 ${group.name}`"
      @click.stop="emit('open')"
    >
      <ChevronRight :size="18" />
    </button>
  </article>
</template>

<style scoped>
.document-group-card {
  position: relative;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  user-select: none;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
}

.document-group-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}

.document-group-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Grid Mode Styling */
.grid-mode {
  display: flex;
  flex-direction: column;
  padding: 10px;
  gap: 10px;
  width: var(--card-size, 170px);
}

.group-cover-quad {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1.414;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-sub));
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
  border-radius: var(--radius-md, 8px);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
  overflow: hidden;
  box-sizing: border-box;
}

.document-group-card:hover .group-cover-quad {
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-sub));
  border-color: var(--accent);
}

.quad-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 5px;
  width: 100%;
  height: 100%;
}

.quad-item {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.quad-item :deep(.document-cover) {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 0 !important;
}

.quad-item :deep(.cover-fallback) {
  padding: 4px 5px !important;
  text-align: left;
}

.quad-item :deep(.cover-fallback strong) {
  font-size: 10px !important;
  line-height: 1.25 !important;
  -webkit-line-clamp: 3 !important;
  font-weight: 600;
}

.quad-item :deep(.cover-type),
.quad-item :deep(.cover-line),
.quad-item :deep(.cover-fallback small),
.quad-item :deep(.cover-format) {
  display: none !important;
}

.quad-item--empty {
  background: color-mix(in srgb, var(--bg-card) 50%, transparent);
  border: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
  box-shadow: none;
}

.empty-icon {
  color: var(--text-muted);
}

.stack-count-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(4px);
  border-radius: 9999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

/* List Mode Styling */
.list-mode {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  width: 100%;
}

.group-list-thumbnail {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-sub));
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
  padding: 3px;
  box-sizing: border-box;
}

.list-quad-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
  width: 100%;
  height: 100%;
}

.list-quad-slot {
  width: 100%;
  height: 100%;
  border-radius: 2px;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.list-quad-slot :deep(.document-cover) {
  width: 100% !important;
  height: 100% !important;
  border: none !important;
}

.list-quad-slot :deep(.cover-fallback) {
  padding: 1px !important;
}

.list-quad-slot :deep(.cover-fallback strong) {
  font-size: 7px !important;
  line-height: 1 !important;
  -webkit-line-clamp: 2 !important;
}

.list-quad-slot :deep(.cover-type),
.list-quad-slot :deep(.cover-line),
.list-quad-slot :deep(.cover-fallback small),
.list-quad-slot :deep(.cover-format) {
  display: none !important;
}

.list-quad-slot--empty {
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--border) 50%, transparent);
}

/* Metadata Info */
.group-card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.group-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-badge {
  font-size: 10px;
  padding: 1px 5px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
  border-radius: 4px;
  font-weight: 500;
  flex-shrink: 0;
}

.category-badge {
  font-size: 10px;
  padding: 1px 5px;
  background: var(--bg-sub);
  color: var(--text-muted);
  border-radius: 4px;
  flex-shrink: 0;
}

.group-subtitle {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-tags {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-open-btn {
  margin-left: auto;
  color: var(--text-muted);
  transition: color 0.15s ease;
}

.document-group-card:hover .group-open-btn {
  color: var(--accent);
}

.bulk-checkbox {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 10;
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: var(--accent);
}
</style>
