<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue'
import { Leaf, Play } from 'lucide-vue-next'
import type { SoftwareItem } from '@/types'
import AppIcon from '@/components/ui/AppIcon.vue'
import MasteryDots from '@/components/ui/MasteryDots.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useSettingsStore } from '@/stores/settings'
import { activityOf, daysSince, displayName, subtitleName } from '@/utils'

const props = withDefaults(
  defineProps<{
    item: SoftwareItem
    view?: 'grid' | 'list'
    unusedDays?: number
    selectable?: boolean
    selected?: boolean
    locked?: boolean
  }>(),
  { view: 'grid', unusedDays: 60 }
)

const emit = defineEmits<{
  (e: 'open', id: string): void
  (e: 'launch', id: string): void
  (e: 'select', id: string): void
}>()

const settings = useSettingsStore()
const lang = computed(() => settings.settings.title_lang)
const name = computed(() => displayName(props.item, lang.value))
const subtitle = computed(() => subtitleName(props.item, lang.value))
const activity = computed(() => activityOf(props.item))
const isUnused = computed(() => daysSince(activity.value.at) > props.unusedDays)
const pending = computed(() => props.item.ai_status !== 'done')

/* 单击进详情、双击启动：单击先延后，等确认没有第二下再走 */
let clickTimer: ReturnType<typeof setTimeout> | null = null

function onClick(): void {
  if (props.locked) return
  if (props.selectable) { emit('select', props.item.id); return }
  if (clickTimer) return
  clickTimer = setTimeout(() => {
    clickTimer = null
    emit('open', props.item.id)
  }, 220)
}

function onDblClick(): void {
  if (props.selectable || props.locked) return
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

watch(() => props.selectable, () => { if (clickTimer) clearTimeout(clickTimer); clickTimer = null })

onUnmounted(() => clickTimer && clearTimeout(clickTimer))
</script>

<template>
  <article
    class="card"
    :class="[`card--${view}`, { 'card--archived': item.is_archived, 'card--selected': selected, 'card--selectable': selectable }]"
    :title="item.exe_path"
    tabindex="0"
    :aria-label="name"
    @keydown.enter.self.prevent="onClick"
    @keydown.space.self.prevent="onClick"
    @click="onClick"
    @dblclick="onDblClick"
  >
    <input v-if="selectable" class="card__select" type="checkbox" :checked="selected" :disabled="locked" :aria-label="`选择 ${name}`" @click.stop @dblclick.stop @change="emit('select', item.id)" />
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
          <span
            class="card__time"
            :class="[`card__time--${activity.source}`, { 'card__time--warn': isUnused }]"
            :title="activity.hint"
          >
            <i v-if="activity.source !== 'none'" class="card__dot" />
            {{ activity.label }}
          </span>
        </div>
      </footer>
    </div>

    <button v-if="!selectable" class="card__play" title="启动（或双击卡片）" :aria-label="`启动 ${name}`" @click="onLaunchClick">
      <Play :size="13" fill="currentColor" />
    </button>

    <!--
      绿色软件标识。和启动按钮占同一个角 —— 悬浮时让位给它：
      鼠标已经在卡片上了，那一刻用户想的是「打开它」，不是「它是不是绿色的」。
    -->
    <Leaf v-if="item.is_portable === true && !selectable" :size="13" class="card__leaf" title="绿色软件" />
  </article>
</template>

<style scoped>
.card--selected{outline:2px solid var(--accent);outline-offset:-2px}.card__select{flex:none;width:18px;height:18px;align-self:center;accent-color:var(--accent)}
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

.card--list:not(.card--selectable) { padding-right: 50px; }

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
  min-width: 0;
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}

.card__time--warn {
  color: var(--warning);
}

/*
 * 时间是抱一记的还是从磁盘推的，差别不小 —— 实心点是抱一亲眼见过的启动，
 * 空心点只是「目录里的配置文件那天被改过」。悬浮有完整说明。
 */
.card__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  border: 1px solid currentColor;
  flex: none;
}

.card__time--baoyi .card__dot {
  background: currentColor;
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

.card:hover .card__play, .card:focus-within .card__play {
  opacity: 1;
  transform: scale(1);
}

.card__leaf {
  position: absolute;
  top: 12px;
  right: 12px;
  color: var(--success);
  opacity: 0.75;
  transition: opacity var(--t-fast) ease;
}

.card--list .card__leaf {
  top: 50%;
  margin-top: -6px;
}

.card:hover .card__leaf, .card:focus-within .card__leaf {
  opacity: 0;
}
</style>
