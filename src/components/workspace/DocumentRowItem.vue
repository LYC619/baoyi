<script setup lang="ts">
import type { DocumentCustomGroup, DocumentItem } from '@/types/workspace'
import DocumentCover from '@/components/workspace/DocumentCover.vue'
import DocumentInsightSummary from '@/components/workspace/DocumentInsightSummary.vue'
import DocumentProgress from '@/components/workspace/DocumentProgress.vue'

const props = defineProps<{
  item: DocumentItem
  selected: boolean
  view: 'list' | 'grid' | 'insights'
  bulk: boolean
  checked: boolean
  allSearch: boolean
  projectCount?: number
  customGroups?: DocumentCustomGroup[]
  showGroupBadge?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-check'): void
  (e: 'select', id: string): void
  (e: 'open', item: DocumentItem): void
}>()

function onRowClick() {
  if (props.bulk) emit('toggle-check')
  else emit('select', props.item.id)
}
</script>

<template>
  <article
    class="document-row"
    :class="{ selected, 'document-row--grid': view === 'grid' }"
    tabindex="0"
    :aria-label="item.name"
    @click="onRowClick"
    @dblclick="emit('open', item)"
    @keydown.enter.self="emit('open', item)"
    @keydown.space.prevent.self="emit('select', item.id)"
  >
    <input
      v-if="bulk"
      type="checkbox"
      :checked="checked"
      :aria-label="'选择资料 ' + item.name"
      @click.stop
      @change="emit('toggle-check')"
    />
    <DocumentCover :item="item" :size="view === 'grid' ? 'grid' : 'list'" />
    <div class="document-row-info">
      <strong>
        {{ item.name }}
        <span class="ws-badge">{{ item.typeName }}</span>
        <span v-if="allSearch" class="ws-badge">{{ item.submodule === 'reading' ? '阅读' : '资料' }}</span>
        <span v-if="showGroupBadge && item.customGroupId" class="ws-badge group-badge">
          {{ customGroups?.find((g) => g.id === item.customGroupId)?.name }}
        </span>
      </strong>
      <small>
        {{
          item.submodule === 'reading'
            ? item.author || item.typeName
            : item.counterpart || item.typeName
        }}
        <template v-if="item.expiresOn"> · 有效期至 {{ item.expiresOn }} </template>
      </small>
      <span v-if="item.tags.length" class="row-tags ws-muted" :title="item.tags.join(' · ')">
        {{ item.tags.join(' · ') }}
      </span>
      <DocumentInsightSummary
        :item="item"
        :expanded="view === 'insights'"
        :disabled="bulk"
        @open="emit('select', item.id)"
      />
    </div>
    <div class="document-row-state">
      <DocumentProgress v-if="item.submodule === 'reading'" :item="item" />
      <span v-if="projectCount" class="ws-badge project-count">
        被 {{ projectCount }} 个项目引用
      </span>
      <small v-if="!item.available">文件暂不可用</small>
    </div>
    <button
      type="button"
      class="ws-icon row-open"
      :aria-label="(item.submodule === 'reading' ? '阅读 ' : '查看 ') + item.name"
      @click.stop="emit('open', item)"
    >
      ›
    </button>
  </article>
</template>

<style scoped>
.document-row {
  display: flex;
  gap: 15px;
  align-items: center;
  text-align: left;
  width: 100%;
  padding: 12px 10px;
  border-bottom: 1px solid var(--divider);
  color: var(--text-main);
  cursor: pointer;
}

.document-row:hover,
.document-row.selected {
  background: var(--ws-tint);
}

.document-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.document-row-info {
  flex: 1;
  min-width: 0;
}

.document-row strong {
  display: block;
  overflow-wrap: anywhere;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.6;
}

.document-row strong .ws-badge {
  vertical-align: middle;
  margin-left: 5px;
}

.ws-badge.group-badge {
  background: var(--hover-surface);
  color: var(--text-sub);
  font-size: 11px;
}

.document-row-info small,
.document-row-state > small {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-sub);
}

.row-tags {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin-top: 4px;
  font-size: 11px;
}

.document-row-state {
  flex: 0 0 150px;
  min-width: 0;
}

.project-count {
  margin-top: 7px;
  color: var(--accent);
}

.row-open {
  font-size: 24px;
  width: 22px;
}

.document-row--grid {
  position: relative;
  align-items: stretch;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--divider);
  border-radius: var(--radius-card);
  padding: 16px;
}

.document-row--grid .document-row-info {
  width: 100%;
}

.document-row--grid .document-row-state {
  flex: none;
  width: 100%;
  margin-top: auto;
}

.document-row--grid .row-open {
  position: absolute;
  right: 6px;
  top: 5px;
}

@media (max-width: 1100px) {
  .document-row-state {
    flex-basis: 120px;
  }
  .document-row {
    gap: 9px;
    padding: 14px 5px;
  }
}

@media (max-width: 860px) {
  .document-row-state {
    flex-basis: 90px;
  }
}
</style>
