<script setup lang="ts">
import { Archive, Unlink, Box, Gamepad2, Smartphone, Monitor } from 'lucide-vue-next'
import LibrarySidebar from '@/components/library/LibrarySidebar.vue'
import { PLAY_STATUS_LABEL, useGameStore, type GameSelection } from '@/stores/game'
import type { PlayStatus } from '@/types'
import { PROJECT_FILTERS } from '@/utils/game-project'

const store = useGameStore()
const emit = defineEmits<{ selected: [] }>()
function select(value: GameSelection) {
  store.select(value)
  emit('selected')
}
const STATUSES: PlayStatus[] = ['playing', 'unplayed', 'completed', 'shelved']
const isActive = (kind: string, value: string) => store.activeKey === kind + ':' + value
</script>

<template>
  <LibrarySidebar
    class="game-sidebar"
    :all-label="$t('全部游戏')"
    :all-icon="Gamepad2"
    :all-count="store.counts.all"
    :active-key="store.activeKey"
    :categories="store.counts.categories.filter((c) => c.name && c.name !== '其他' && c.name !== '未分类')"
    :tags="store.counts.tags"
    @all="select({ kind: 'group', value: 'all' })"
    @category="select({ kind: 'category', value: $event })"
    @tag="select({ kind: 'tag', value: $event })"
  >
    <template #after-all>
      <button
        v-if="store.unavailableCount"
        class="row"
        :class="{ 'row--active': isActive('path', 'unavailable') }"
        @click="select({ kind: 'path', value: 'unavailable' })"
      >
        <Unlink :size="15" /><span class="row__label">{{ $t("路径不可用") }}</span>
        <span class="row__count">{{ store.unavailableCount }}</span>
      </button>
      <template v-if="store.androidCount > 0">
        <button
          class="row"
          :class="{ 'row--active': isActive('platform', 'windows') }"
          @click="select({ kind: 'platform', value: 'windows' })"
        >
          <Monitor :size="15" /><span class="row__label">{{ $t("电脑游戏") }}</span>
          <span class="row__count">{{ store.windowsCount }}</span>
        </button>
        <button
          class="row"
          :class="{ 'row--active': isActive('platform', 'android') }"
          @click="select({ kind: 'platform', value: 'android' })"
        >
          <Smartphone :size="15" /><span class="row__label">{{ $t("安卓游戏") }}</span>
          <span class="row__count">{{ store.androidCount }}</span>
        </button>
      </template>
      <template v-if="store.projectCounts.all">
        <p class="sidebar__title">{{ $t("精修档案") }}</p>
        <button
          v-for="(label, key) in PROJECT_FILTERS"
          :key="key"
          class="row"
          :class="{ 'row--active': isActive('project', key) }"
          @click="select({ kind: 'project', value: key })"
        >
          <span class="row__label">{{ label }}</span>
          <span class="row__count">{{ store.projectCounts[key] }}</span>
        </button>
        <button class="row" :disabled="store.checkingProjects" @click="store.checkProjects()">
          {{ store.checkingProjects ? $t('检查中…') : $t('检查资料更新') }}
        </button>
      </template>
      <p class="sidebar__title">{{ $t("状态") }}</p>
      <button
        v-for="s in STATUSES"
        :key="s"
        class="row"
        :class="{ 'row--active': isActive('status', s), 'row--empty': !store.counts.status[s] }"
        @click="select({ kind: 'status', value: s })"
      >
        <span class="dot" :class="'dot--' + s" />
        <span class="row__label">{{ PLAY_STATUS_LABEL[s] }}</span>
        <span class="row__count">{{ store.counts.status[s] }}</span>
      </button>
    </template>
    <template #before-categories>
      <button
        v-if="store.counts.uncategorized || isActive('uncategorized', 'uncategorized')"
        class="row"
        :class="{ 'row--active': isActive('uncategorized', 'uncategorized') }"
        @click="select({ kind: 'uncategorized', value: 'uncategorized' })"
      >
        <Box :size="15" /><span class="row__label">{{ $t("未分类") }}</span>
        <span class="row__count">{{ store.counts.uncategorized || 0 }}</span>
      </button>
    </template>
    <template #after-tags>
      <p class="sidebar__title">{{ $t("存档") }}</p>
      <button
        v-for="(label, key) in { unbacked: $t('未备份'), backed: $t('已备份'), none: $t('未发现存档') }"
        :key="key"
        class="row"
        :title="label + $t('的游戏数量')"
        :class="{ 'row--active': isActive('save', key) }"
        @click="select({ kind: 'save', value: key })"
      >
        <span class="dot" :class="'dot--save-' + key" />
        <span class="row__label">{{ label }}</span>
        <span class="row__count">{{ store.counts.save[key] }}</span>
      </button>
      <template v-if="store.counts.archived > 0">
        <div class="sidebar__divider" />
        <button
          class="row"
          :class="{ 'row--active': isActive('group', 'archived') }"
          @click="select({ kind: 'group', value: 'archived' })"
        >
          <Archive :size="15" /><span class="row__label">{{ $t("已归档") }}</span>
          <span class="row__count">{{ store.counts.archived }}</span>
        </button>
      </template>
    </template>
  </LibrarySidebar>
</template>

<style scoped>
.game-sidebar {
  --library-row-height: 30px;
  --library-active-color: var(--text-main);
  --library-title-weight: 600;
  --library-title-spacing: 0.08em;
}
.game-sidebar :deep(.row) {
  position: relative;
}
.game-sidebar :deep(.row--active::before) {
  content: '';
  position: absolute;
  left: -10px;
  top: 7px;
  bottom: 7px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}
.game-sidebar :deep(.row--active > svg) {
  color: var(--accent-ink);
}
.row--empty:not(.row--active) {
  opacity: 0.55;
}
.dot {
  width: 8px;
  height: 8px;
  margin: 0 3px;
  border-radius: 50%;
  flex: none;
}
.dot--playing {
  background: var(--accent);
}
.dot--unplayed {
  background: var(--text-faint);
}
.dot--completed,
.dot--save-backed {
  background: #6aa84f;
}
.dot--shelved {
  background: var(--warning);
}
.dot--save-unbacked {
  background: #e8913a;
}
.dot--save-none {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--text-faint);
}
</style>
