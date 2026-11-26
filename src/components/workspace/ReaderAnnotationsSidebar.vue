<script setup lang="ts">
import { Copy, Download, Pencil, Trash2 } from 'lucide-vue-next'
import AnnotationProjectLinks from '@/components/workspace/AnnotationProjectLinks.vue'
import type { DocumentAnnotation, DocumentProjectReference } from '@/types/workspace'

const props = defineProps<{
  documentId: string
  format?: string
  isNovel: boolean
  annotations: DocumentAnnotation[]
  activeAnnotation: string
  selected: string[]
  locationStates: Record<string, string>
  projectReferences: DocumentProjectReference[]
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'focus', annotation: DocumentAnnotation): void
  (e: 'edit', annotation: DocumentAnnotation): void
  (e: 'remove', annotation: DocumentAnnotation): void
  (e: 'update:selected', ids: string[]): void
  (e: 'remove-selected'): void
  (e: 'copy-selected'): void
  (e: 'export-selected'): void
  (e: 'refresh-references'): void
}>()

function toggleOne(id: string) {
  emit(
    'update:selected',
    props.selected.includes(id)
      ? props.selected.filter((x) => x !== id)
      : [...props.selected, id]
  )
}

function toggleAll(checked: boolean) {
  emit('update:selected', checked ? props.annotations.map((a) => a.id) : [])
}
</script>

<template>
  <aside class="reader-annotations" @keydown.esc.stop="emit('close')">
    <header class="ws-section-head">
      <h2>{{ $t("标注与书签") }}<small class="ws-muted">{{ annotations.length }}</small>
      </h2>
      <button type="button" class="ws-icon" :aria-label="$t('收起标注栏')" @click="emit('close')">×</button>
    </header>
    <p v-if="!annotations.length" class="ws-muted">{{ $t("选中原文即可高亮，或补充自己的想法。") }}</p>
    <article
      v-for="a in annotations"
      :id="'annotation-' + a.id"
      :key="a.id"
      class="annotation-card"
      :class="{ active: a.id === activeAnnotation }"
      tabindex="0"
      role="button"
      :aria-label="$t('定位标注 ') + (a.quote || a.note || a.location.page)"
      @click="emit('focus', a)"
      @keydown.enter.self="emit('focus', a)"
    >
      <div class="annotation-heading">
        <input
          type="checkbox"
          :checked="selected.includes(a.id)"
          :aria-label="$t('选择标注 ') + (a.quote || a.note || a.location.page)"
          @click.stop
          @change="toggleOne(a.id)"
        />
        <span>
          {{ $t("{p0} · 第 {p1}{p2} {p3}", {p0: (a.kind === 'bookmark' ? $t('书签') : $t('标注')), p1: (a.location.page), p2: (a.location.anchor?.pages?.length ? '–' + a.location.anchor.pages.at(-1)!.page : ''), p3: (isNovel ? $t('章') : format === 'pdf' ? $t('页') : $t('段'))}) }}
        </span>
        <button type="button" class="ws-icon" :aria-label="$t('编辑标注')" @click.stop="emit('edit', a)">
          <Pencil :size="13" />
        </button>
        <button type="button" class="ws-icon" :aria-label="$t('移除标注')" @click.stop="emit('remove', a)">
          <Trash2 :size="13" />
        </button>
      </div>
      <blockquote v-if="a.quote">{{ a.quote }}</blockquote>
      <p v-if="a.note" class="ws-pre annotation-note">{{ a.note }}</p>
      <p v-if="locationStates[a.id] === 'changed'" class="annotation-location">{{ $t("原文位置已变化") }}</p>
      <p v-else-if="locationStates[a.id] === 'coarse'" class="annotation-location">{{ $t("仅保留页/段位置，原句无法唯一定位") }}</p>
      <AnnotationProjectLinks
        v-if="a.kind === 'excerpt'"
        :document-id="documentId"
        :annotation-id="a.id"
        :references="projectReferences.filter((r) => r.annotationId === a.id)"
        @changed="emit('refresh-references')"
      />
    </article>

    <footer v-if="annotations.length" class="annotation-footer">
      <label>
        <input
          type="checkbox"
          :aria-label="$t('全选标注')"
          :checked="selected.length === annotations.length"
          @change="toggleAll(($event.target as HTMLInputElement).checked)"
        />{{ $t("全选") }}</label>
      <button type="button" class="ws-button danger" :disabled="busy || !selected.length" @click="emit('remove-selected')">
        <Trash2 :size="14" />{{ $t("删除所选标注") }}</button>
      <span class="ws-muted">{{ $t("已选择 {p0} 条", {p0: (selected.length)}) }}</span>
      <button type="button" class="ws-button" :disabled="busy || !selected.length" @click="emit('copy-selected')">
        <Copy :size="14" />{{ $t("复制 Markdown") }}</button>
      <button type="button" class="ws-button" :disabled="busy || !selected.length" @click="emit('export-selected')">
        <Download :size="14" />{{ $t("导出所选") }}</button>
    </footer>
  </aside>
</template>

<style scoped>
.reader-annotations {
  flex: 0 0 295px;
  border-left: 1px solid var(--divider);
  padding: 22px 18px;
  overflow: auto;
}
.reader-annotations h2 {
  font-size: 16px;
}
.annotation-card {
  padding: 15px 5px;
  border-bottom: 1px solid var(--divider);
  cursor: pointer;
  scroll-margin: 10px;
}
.annotation-card.active {
  background: var(--ws-tint);
  box-shadow: inset 3px 0 var(--accent);
}
.annotation-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--text-sub);
}
.annotation-heading > span {
  flex: 1;
  text-align: left;
}
.annotation-heading .ws-icon {
  width: 22px;
  height: 26px;
}
.annotation-card blockquote {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.8;
  border-left: 2px solid var(--accent);
  padding-left: 12px;
  margin: 12px 0;
}
.annotation-note,
.annotation-location {
  font-size: 12px;
  color: var(--text-sub);
}
.annotation-location {
  color: var(--accent);
}
.annotation-footer {
  position: sticky;
  bottom: -22px;
  background: var(--bg-main);
  padding: 17px 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.annotation-footer > span {
  width: 100%;
}
@media (max-width: 1100px) {
  .reader-annotations {
    flex-basis: 250px;
    padding: 18px 14px;
  }
}
@media (max-width: 850px) {
  .reader-annotations {
    position: absolute;
    right: 0;
    top: 70px;
    bottom: 0;
    width: 285px;
    z-index: 15;
    background: var(--bg-main);
    box-shadow: -8px 0 24px rgb(0 0 0 / 0.14);
  }
}
</style>
