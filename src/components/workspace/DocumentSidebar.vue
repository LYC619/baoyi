<script setup lang="ts">
import { BookOpen, FileText, Star, Tag } from 'lucide-vue-next'
import type { DocumentCategory, DocumentCustomGroup, DocumentItem, DocumentSubmodule } from '@/types/workspace'

defineProps<{
  submodule: DocumentSubmodule
  favorite: boolean
  favoriteCount: number
  currentCategories: DocumentCategory[]
  items: DocumentItem[]
  selectedType: string
  sidebarGroups: DocumentCustomGroup[]
  activeGroupId: string
  currentCategoryName: string
  baseRowsCount: number
  tags: Array<{ name: string; count: number }>
  selectedTag: string
  selectedState: string
}>()

const emit = defineEmits<{
  (e: 'switch-submodule', target: DocumentSubmodule): void
  (e: 'toggle-favorite'): void
  (e: 'select-category', categoryId: string): void
  (e: 'toggle-group', groupId: string): void
  (e: 'manage-tags'): void
  (e: 'clear-tag'): void
  (e: 'toggle-tag', tagName: string): void
}>()
</script>

<template>
  <aside class="ws-sidebar document-sidebar">
    <nav class="document-subnav" aria-label="子模块切换">
      <button
        type="button"
        :class="{ on: submodule === 'reading' }"
        @click="emit('switch-submodule', 'reading')"
      >
        <BookOpen :size="18" />阅读
      </button>
      <button
        type="button"
        :class="{ on: submodule === 'archive' }"
        @click="emit('switch-submodule', 'archive')"
      >
        <FileText :size="18" />资料
      </button>
    </nav>

    <button type="button" :class="{ active: favorite }" @click="emit('toggle-favorite')">
      <Star :size="15" />收藏<span>{{ favoriteCount }}</span>
    </button>

    <div class="sidebar-list">
      <button
        v-for="category in currentCategories"
        :key="category.id"
        type="button"
        :class="{ active: selectedType === category.id }"
        @click="emit('select-category', category.id)"
      >
        {{ category.name }}
        <span>{{ items.filter((i) => i.submodule === submodule && i.type === category.id).length }}</span>
      </button>
    </div>

    <details v-if="sidebarGroups.length > 0" open class="custom-group-filter">
      <hr />
      <summary>自定义分组</summary>
      <div class="sidebar-list">
        <button
          v-for="group in sidebarGroups"
          :key="group.id"
          type="button"
          :class="{ active: activeGroupId === group.id }"
          @click="emit('toggle-group', group.id)"
        >
          {{ group.name }}
          <span>{{ items.filter((i) => i.customGroupId === group.id).length }}</span>
        </button>
      </div>
    </details>

    <hr />
    <div class="sidebar-heading-row">
      <h2>标签</h2>
      <button
        v-if="selectedType"
        type="button"
        class="ws-icon tag-manage-trigger"
        :title="`管理「${currentCategoryName}」分类标签`"
        :aria-label="`管理「${currentCategoryName}」分类标签`"
        @click="emit('manage-tags')"
      >
        <Tag :size="13" />
      </button>
    </div>
    <div class="document-tags" aria-label="筛选资料标签">
      <button
        type="button"
        class="tag-pill"
        :class="{ active: !selectedTag && !selectedState }"
        :aria-pressed="!selectedTag && !selectedState"
        @click="emit('clear-tag')"
      >
        全部标签<span>{{ baseRowsCount }}</span>
      </button>
      <button
        v-for="tag in tags"
        :key="tag.name"
        type="button"
        class="tag-pill"
        :class="{ active: selectedTag === tag.name }"
        :aria-pressed="selectedTag === tag.name"
        :title="tag.name"
        @click="emit('toggle-tag', tag.name)"
      >
        {{ tag.name }}<span>{{ tag.count }}</span>
      </button>
    </div>

    <small>知止而后得</small>
  </aside>
</template>

<style scoped>
.document-sidebar > * {
  flex-shrink: 0;
}
.document-sidebar h2 {
  font-size: 13px;
  margin: 10px 12px;
}
.sidebar-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 10px 12px 6px;
}
.sidebar-heading-row h2 {
  margin: 0 !important;
}
.tag-manage-trigger {
  padding: 3px;
  color: var(--text-sub);
  border-radius: 4px;
}
.tag-manage-trigger:hover {
  color: var(--accent);
  background: var(--hover-surface);
}
.document-subnav {
  display: flex;
  gap: 6px;
  background: var(--hover-surface);
  padding: 4px;
  border-radius: 8px;
  margin-bottom: 14px;
}
.document-subnav button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: transparent;
  border: none;
  padding: 7px 4px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-sub);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}
.document-subnav button.on {
  background: var(--bg-card);
  color: var(--text-main);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.08);
}
.sidebar-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.custom-group-filter summary {
  cursor: pointer;
  color: var(--text-sub);
  padding: 8px 12px;
  font-size: 13px;
}
.document-tags {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  max-height: 260px;
  overflow: auto;
}
.document-tags .tag-pill {
  max-width: 100%;
  border: 1px solid var(--divider);
  border-radius: 18px;
  padding: 5px 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: normal;
}
.tag-pill span {
  flex: none;
  padding-left: 5px;
}
</style>
