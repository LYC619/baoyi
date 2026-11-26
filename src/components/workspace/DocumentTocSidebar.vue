<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import PdfOutline from './PdfOutline.vue'
import type { OutlineNode } from '@/utils/pdf-outline'
import type { NovelIndexResult } from '@/types/workspace'

const props = defineProps<{
  pdfMode: boolean
  streamedMode: boolean
  outline: OutlineNode[]
  outlineLoading: boolean
  outlineError: string
  outlineTruncated: boolean
  outlineActive: string
  page: number
  count: number
  activeChapter: number
  novelIndex?: NovelIndexResult | null
  headings: Array<{ text: string; page: number }>
}>()

const emit = defineEmits<{
  (e: 'navigate-outline', node: OutlineNode): void
  (e: 'jump-page', page: number): void
  (e: 'load-chapter', index: number): void
}>()

const tocPanel = ref<HTMLElement>()

watch(
  () => props.activeChapter,
  async () => {
    await nextTick()
    tocPanel.value?.querySelector('.toc-chapter-item.active')?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true }
)
</script>

<template>
  <aside ref="tocPanel" class="reader-toc">
    <h3>{{ $t("目录") }}</h3>
    <template v-if="pdfMode">
      <PdfOutline
        :nodes="outline"
        :loading="outlineLoading"
        :error="outlineError"
        :truncated="outlineTruncated"
        :active="outlineActive"
        @navigate="emit('navigate-outline', $event)"
      />
      <p class="ws-muted">{{ $t("原版页面 · {p0} 页", {p0: (count)}) }}</p>
      <label>{{ $t("跳转页码") }}<input
          type="number"
          :aria-label="$t('跳转到页码')"
          :value="page"
          min="1"
          :max="count"
          @change="emit('jump-page', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
    </template>
    <template v-else-if="streamedMode">
      <div class="toc-novel-list">
        <button
          v-for="ch in novelIndex?.chapters"
          :key="ch.index"
          type="button"
          class="toc-chapter-item"
          :class="{ active: activeChapter === ch.index }"
          :title="ch.title"
          @click="emit('load-chapter', ch.index)"
        >
          {{ ch.title }}
        </button>
      </div>
    </template>
    <template v-else>
      <button
        v-for="heading in headings"
        :key="heading.page"
        type="button"
        :class="{ active: page === heading.page }"
        @click="emit('jump-page', heading.page)"
      >
        {{ heading.text }}
      </button>
      <p v-if="!headings.length" class="ws-muted">{{ $t("此资料没有章节标题。") }}</p>
    </template>
  </aside>
</template>

<style scoped>
.reader-toc {
  width: 230px;
  flex: none;
  padding: 22px 15px;
  border-right: 1px solid var(--divider);
  overflow: auto;
}
.reader-toc button {
  display: block;
  width: 100%;
  text-align: left;
  color: var(--text-sub);
  font-size: 12px;
  padding: 8px 5px;
  overflow-wrap: anywhere;
}
.reader-toc button.active {
  color: var(--accent);
}
.toc-novel-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toc-chapter-item {
  flex: 0 0 auto;
  min-height: 34px;
  line-height: 1.5;
  text-align: left;
  background: transparent;
  border: none;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-sub);
}
.toc-chapter-item:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}
.toc-chapter-item.active {
  background: var(--accent);
  color: #fff !important;
}
@media (max-width: 1000px) {
  .reader-toc {
    width: 140px;
  }
}
</style>
