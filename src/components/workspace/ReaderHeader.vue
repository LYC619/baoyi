<script setup lang="ts">
import { ref } from 'vue'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize2,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-vue-next'
import type { DocumentItem, NovelIndexResult } from '@/types/workspace'

export interface ReaderSettingsModel {
  fontSize: number
  lineHeight: number
  theme: 'light' | 'sepia' | 'eye' | 'dark'
  encoding: string
  immersive: boolean
}

defineProps<{
  item: DocumentItem | null
  supported: boolean
  hasContent: boolean
  unsaved: boolean
  busy: boolean
  toc: boolean
  side: boolean
  settingsOpen: boolean
  zoom: number
  searching: boolean
  novelIndex: NovelIndexResult | null
  currentChapterIndex: number
  readerSettings: ReaderSettingsModel
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'find', query: string): void
  (e: 'change-zoom', delta: number): void
  (e: 'prev-chapter'): void
  (e: 'next-chapter'): void
  (e: 'toggle-toc'): void
  (e: 'toggle-side'): void
  (e: 'update:settingsOpen', val: boolean): void
  (e: 'update:readerSettings', patch: Partial<ReaderSettingsModel>): void
  (e: 'reload-encoding'): void
  (e: 'open-external'): void
}>()

const searchQuery = ref('')
const sideTrigger = ref<HTMLButtonElement>()

function focusSideTrigger() {
  sideTrigger.value?.focus()
}

defineExpose({ focusSideTrigger })

function patchSetting<K extends keyof ReaderSettingsModel>(key: K, value: ReaderSettingsModel[K]) {
  emit('update:readerSettings', { [key]: value })
}

function onEncodingChange(e: Event) {
  patchSetting('encoding', (e.target as HTMLSelectElement).value)
  emit('reload-encoding')
}
</script>

<template>
  <header class="reader-header">
    <button type="button" class="ws-icon" aria-label="返回来源" @click="emit('back')">
      <ArrowLeft :size="18" />
    </button>

    <div class="header-book-info">
      <h1 class="header-book-title" :title="item?.name">{{ item?.name || '资料' }}</h1>
      <span
        v-if="novelIndex?.chapters.length"
        class="ws-muted current-chapter-label"
        :title="novelIndex.chapters[currentChapterIndex]?.title"
      >
        {{ novelIndex.chapters[currentChapterIndex]?.title }}
      </span>
      <span v-else class="ws-muted">
        {{ item?.format.toUpperCase() }}
        <template v-if="unsaved"> · 正在保存位置</template>
      </span>
    </div>

    <div class="header-reader-tools">
      <form
        v-if="supported && hasContent && !['png', 'jpg', 'jpeg'].includes(item?.format || '')"
        class="reader-search"
        @submit.prevent="emit('find', searchQuery)"
      >
        <input v-model="searchQuery" type="search" aria-label="搜索正文" placeholder="搜索正文…" />
        <button
          type="submit"
          class="ws-icon"
          aria-label="查找下一处"
          title="查找下一处"
          :disabled="!searchQuery.trim() || searching"
        >
          <Search :size="16" />
        </button>
      </form>

      <div v-if="item?.format === 'pdf'" class="pdf-zoom-tools">
        <button type="button" class="ws-icon" aria-label="缩小页面" title="缩小页面" @click="emit('change-zoom', -0.1)">
          <Minus :size="16" />
        </button>
        <span>{{ Math.round(zoom * 100) }}%</span>
        <button type="button" class="ws-icon" aria-label="放大页面" title="放大页面" @click="emit('change-zoom', 0.1)">
          <Plus :size="16" />
        </button>
      </div>

      <template v-if="novelIndex?.chapters.length">
        <button
          type="button"
          class="ws-icon"
          :disabled="currentChapterIndex <= 0"
          aria-label="上一章"
          title="上一章"
          @click="emit('prev-chapter')"
        >
          <ChevronLeft :size="18" />
        </button>
        <span class="chapter-indicator">
          {{ currentChapterIndex + 1 }} / {{ novelIndex.chapters.length }}
        </span>
        <button
          type="button"
          class="ws-icon"
          :disabled="currentChapterIndex >= novelIndex.chapters.length - 1"
          aria-label="下一章"
          title="下一章"
          @click="emit('next-chapter')"
        >
          <ChevronRight :size="18" />
        </button>
      </template>

      <button
        type="button"
        class="ws-icon"
        :class="{ active: toc }"
        aria-label="切换阅读目录"
        title="切换阅读目录"
        @click="emit('toggle-toc')"
      >
        <PanelLeft :size="18" />
      </button>

      <div class="settings-anchor">
        <button
          type="button"
          class="ws-icon"
          :class="{ active: settingsOpen }"
          aria-label="阅读偏好与设置"
          title="阅读偏好（字号、配色、编码）"
          @click="emit('update:settingsOpen', !settingsOpen)"
        >
          <SlidersHorizontal :size="16" />
        </button>

        <div v-if="settingsOpen" class="reader-settings-panel">
          <div v-if="item?.format !== 'pdf'" class="setting-row">
            <span>字号</span>
            <div class="setting-controls">
              <button
                type="button"
                class="ws-icon"
                :disabled="readerSettings.fontSize <= 12"
                @click="patchSetting('fontSize', readerSettings.fontSize - 2)"
              >
                <Minus :size="13" />
              </button>
              <span>{{ readerSettings.fontSize }}px</span>
              <button
                type="button"
                class="ws-icon"
                :disabled="readerSettings.fontSize >= 32"
                @click="patchSetting('fontSize', readerSettings.fontSize + 2)"
              >
                <Plus :size="13" />
              </button>
            </div>
          </div>

          <div v-if="item?.format !== 'pdf'" class="setting-row">
            <span>行距</span>
            <div class="setting-controls">
              <button
                type="button"
                class="ws-icon"
                :disabled="readerSettings.lineHeight <= 1.4"
                @click="patchSetting('lineHeight', Number((readerSettings.lineHeight - 0.2).toFixed(1)))"
              >
                <Minus :size="13" />
              </button>
              <span>{{ readerSettings.lineHeight }}</span>
              <button
                type="button"
                class="ws-icon"
                :disabled="readerSettings.lineHeight >= 2.6"
                @click="patchSetting('lineHeight', Number((readerSettings.lineHeight + 0.2).toFixed(1)))"
              >
                <Plus :size="13" />
              </button>
            </div>
          </div>

          <div class="setting-row">
            <span>配色</span>
            <div class="theme-chips">
              <button
                type="button"
                class="theme-chip light"
                :class="{ active: readerSettings.theme === 'light' }"
                title="白昼"
                @click="patchSetting('theme', 'light')"
              >
                白
              </button>
              <button
                type="button"
                class="theme-chip sepia"
                :class="{ active: readerSettings.theme === 'sepia' }"
                title="暖纸"
                @click="patchSetting('theme', 'sepia')"
              >
                暖
              </button>
              <button
                type="button"
                class="theme-chip eye"
                :class="{ active: readerSettings.theme === 'eye' }"
                title="护眼柔绿"
                @click="patchSetting('theme', 'eye')"
              >
                绿
              </button>
              <button
                type="button"
                class="theme-chip dark"
                :class="{ active: readerSettings.theme === 'dark' }"
                title="深色夜读"
                @click="patchSetting('theme', 'dark')"
              >
                夜
              </button>
            </div>
          </div>

          <div v-if="item && ['txt', 'md', 'markdown'].includes(item.format)" class="setting-row">
            <span>编码</span>
            <select :value="readerSettings.encoding" class="encoding-select" @change="onEncodingChange">
              <option value="auto">自动识别</option>
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GBK / GB18030</option>
              <option value="utf-16le">UTF-16 LE</option>
            </select>
          </div>
        </div>
      </div>

      <button
        ref="sideTrigger"
        type="button"
        class="ws-icon"
        aria-label="切换标注栏"
        :aria-expanded="side"
        :class="{ active: side }"
        title="切换书签与笔记"
        @click="emit('toggle-side')"
      >
        <PanelRight :size="18" />
      </button>

      <button
        type="button"
        class="ws-icon"
        aria-label="沉浸模式"
        title="沉浸阅读（隐藏工具栏）"
        @click="patchSetting('immersive', true)"
      >
        <Maximize2 :size="16" />
      </button>

      <button
        type="button"
        class="ws-button"
        :disabled="busy || !item?.available"
        title="在系统默认应用中打开"
        @click="emit('open-external')"
      >
        <ExternalLink :size="15" />外部打开
      </button>
    </div>
  </header>
</template>

<style scoped>
.reader-search,
.pdf-zoom-tools {
  display: flex;
  align-items: center;
  gap: 3px;
}
.reader-search input {
  width: 135px;
  min-width: 65px;
}
.pdf-zoom-tools span {
  font-size: 12px;
  min-width: 36px;
}
.reader-header {
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--divider);
  padding: 8px 18px;
  background: var(--bg-main);
  z-index: 30;
}
.header-book-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.header-book-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 0;
}
.current-chapter-label {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.header-reader-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chapter-indicator {
  font-size: 12px;
  color: var(--text-sub);
  white-space: nowrap;
}
.settings-anchor {
  position: relative;
}
.reader-settings-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: -50px;
  width: 240px;
  background: var(--bg-card);
  border: 1px solid var(--divider);
  border-radius: 8px;
  box-shadow: var(--shadow-pop);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 50;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.setting-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.theme-chips {
  display: flex;
  gap: 6px;
}
.theme-chip {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--divider);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.1s ease;
}
.theme-chip:hover {
  transform: scale(1.08);
}
.theme-chip.active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.theme-chip.light {
  background: #ffffff;
  color: #111;
}
.theme-chip.sepia {
  background: #fbf0d9;
  color: #5f4b32;
}
.theme-chip.eye {
  background: #e8f5e9;
  color: #2e4d34;
}
.theme-chip.dark {
  background: #18181b;
  color: #fff;
}
.encoding-select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  font-size: 12px;
  background: var(--bg-card);
  color: var(--text-main);
}
@media (max-width: 1100px) {
  .reader-header {
    padding: 12px 15px;
    gap: 9px;
  }
}
@media (max-width: 850px) {
  .reader-header .ws-button {
    font-size: 11px;
    padding: 7px;
  }
  .reader-header .ws-button svg {
    display: none;
  }
}
</style>
