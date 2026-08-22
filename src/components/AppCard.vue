<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import { Play } from 'lucide-vue-next'
import type { SoftwareItem } from '@/types'
import AppIcon from './AppIcon.vue'
import MasteryDots from './MasteryDots.vue'
import TagBadge from './TagBadge.vue'
import { useSettingsStore } from '@/stores/settings'
import { daysSince, displayName, formatRelative, subtitleName } from '@/utils'

const props = withDefaults(
  defineProps<{
    item: SoftwareItem
    view?: 'grid' | 'list'
    unusedDays?: number
  }>(),
  { view: 'grid', unusedDays: 60 }
)

const emit = defineEmits<{
  (e: 'open', id: string): void
  (e: 'launch', id: string): void
}>()

const settings = useSettingsStore()
const lang = computed(() => settings.settings.title_lang)
const name = computed(() => displayName(props.item, lang.value))
const subtitle = computed(() => subtitleName(props.item, lang.value))
const isUnused = computed(() => daysSince(props.item.last_used_at) > props.unusedDays)
const pending = computed(() => props.item.ai_status !== 'done')

/* 单击进详情、双击启动：单击先延后，等确认没有第二下再走 */
let clickTimer: ReturnType<typeof setTimeout> | null = null

function onClick(): void {
  if (clickTimer) return
  clickTimer = setTimeout(() => {
    clickTimer = null
    emit('open', props.item.id)
  }, 220)
}

function onDblClick(): void {
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
  emit('launch', props.item.id)
}

function onLaunchClick(e: MouseEvent): void {
  e.stopPropagation()
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
  emit('launch', props.item.id)
}

onUnmounted(() => clickTimer && clearTimeout(clickTimer))
</script>

<template>
  <article
    class="card"
    :class="[`card--${view}`, { 'card--archived': item.is_archived }]"
    :title="item.exe_path"
    @click="onClick"
    @dblclick="onDblClick"
  >
    <AppIcon :item="item" :size="view === 'grid' ? 44 : 32" />

    <div class="card__body">
      <header class="card__head">
        <h3 class="card__name">{{ name }}</h3>
        <span v-if="subtitle" class="card__en">{{ subtitle }}</span>
      </header>

      <p class="card__summary">
        {{ item.summary || (pending ? '待 AI 识别' : item.file_description || '暂无说明') }}
      </p>

      <footer class="card__foot">
        <div class="card__tags">
          <TagBadge v-if="item.category" :label="item.category" tone="accent" />
          <TagBadge
            v-for="tag in item.tags.slice(0, view === 'grid' ? 2 : 3)"
            :key="tag"
            :label="tag"
            tone="muted"
          />
        </div>
        <div class="card__meta">
          <MasteryDots :level="item.mastery_level" :show-label="false" />
          <span class="card__time" :class="{ 'card__time--warn': isUnused }">
            {{ formatRelative(item.last_used_at) }}
          </span>
        </div>
      </footer>
    </div>

    <button class="card__play" title="启动（或双击卡片）" @click="onLaunchClick">
      <Play :size="13" fill="currentColor" />
    </button>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  gap: 12px;
  background: var(--bg-card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-card);
  padding: var(--pad-card);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  transition:
    transform var(--t-fast) ease,
    box-shadow var(--t-fast) ease,
    background var(--t-fast) ease;
}

.card:hover {
  background: var(--bg-card-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-card-hover);
}

.card--archived {
  opacity: 0.6;
}

.card--list {
  align-items: center;
  padding: 10px 14px;
}

.card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card--list .card__body {
  flex-direction: row;
  align-items: center;
  gap: 16px;
}

.card__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.card--list .card__head {
  width: 200px;
  flex: none;
}

.card__name {
  font-size: var(--fs-card-title);
  font-weight: 500;
  color: var(--text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__en {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__summary {
  font-size: var(--fs-body);
  line-height: 1.6;
  color: var(--text-sub);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: calc(1.6em * 2);
}

.card--list .card__summary {
  flex: 1;
  -webkit-line-clamp: 1;
  min-height: 0;
}

.card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 2px;
}

.card--list .card__foot {
  flex: none;
  margin-top: 0;
  gap: 16px;
}

.card__tags {
  display: flex;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.card__time {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}

.card__time--warn {
  color: var(--warning);
}

.card__play {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  opacity: 0;
  transform: scale(0.85);
  transition:
    opacity var(--t-fast) ease,
    transform var(--t-fast) ease;
}

.card--list .card__play {
  top: 50%;
  margin-top: -13px;
}

.card:hover .card__play {
  opacity: 1;
  transform: scale(1);
}
</style>
