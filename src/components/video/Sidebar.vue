<script setup lang="ts">
import { computed } from 'vue'
import { Archive, CircleAlert, Clapperboard, Film, Flame, Folder, ListMusic, Music2, Tv } from 'lucide-vue-next'
import LibrarySidebar from '@/components/library/LibrarySidebar.vue'
import { VIDEO_TYPE_LABEL, useVideoStore } from '@/stores/video'
import type { VideoFilterType } from '@/types'

const store = useVideoStore()
const props = withDefaults(
  defineProps<{ pendingActive?: boolean; pendingCount?: number; privateHidden?: boolean }>(),
  { pendingActive: false, pendingCount: 0, privateHidden: false }
)
defineEmits<{ pending: [] }>()

const TYPES: Exclude<VideoFilterType, 'hentai'>[] = ['movie', 'series', 'other', 'audio']
const inHentaiScope = computed(() => store.inHentaiScope)
const inAudioScope = computed(() => store.inAudioScope)
const scopeType = computed<'hentai' | 'audio' | undefined>(() =>
  inHentaiScope.value ? 'hentai' : inAudioScope.value ? 'audio' : undefined
)

const collections = computed(() => {
  const saved = inHentaiScope.value
    ? props.privateHidden ? [] : (store.counts.hentai_collections ?? [])
    : inAudioScope.value
      ? (store.counts.audio_collections ?? [])
      : (store.counts.collections ?? [])
  const total = inHentaiScope.value
    ? props.privateHidden ? 0 : (store.counts.hentai ?? 0)
    : inAudioScope.value
      ? (store.counts.audio ?? 0)
      : store.counts.all
  if (inAudioScope.value && saved.length === 0) return []
  return [{ name: '', count: Math.max(0, (total || 0) - saved.reduce((sum, row) => sum + row.count, 0)) }, ...saved]
})

const categories = computed(() => {
  if (inAudioScope.value) return []
  return store.counts.categories.filter(c => !['里番', '音频', '其他', '其他分类'].includes(c.name))
})

const tagCounts = computed(() =>
  inHentaiScope.value
    ? (props.privateHidden ? [] : store.counts.hanime_tags)
    : inAudioScope.value
      ? (store.counts.audio_tags ?? [])
      : store.counts.tags
)

const archivedCount = computed(() =>
  inHentaiScope.value
    ? (props.privateHidden ? 0 : (store.counts.hentai_archived ?? 0))
    : inAudioScope.value
      ? (store.counts.audio_archived ?? 0)
      : store.counts.archived
)

const isActive = (kind: string, value: string) => !props.pendingActive && store.activeKey === `${kind}:${value}`
</script>

<template>
  <LibrarySidebar
    class="video-sidebar"
    aria-label="影视分类与待处理"
    all-label="全部影视"
    :all-icon="Clapperboard"
    :all-count="store.counts.all"
    :active-key="pendingActive ? '' : store.activeKey"
    :categories="categories"
    :show-categories="categories.length > 0"
    :tags="tagCounts"
    :tag-label="inHentaiScope ? '里番标签' : inAudioScope ? '音频标签' : '标签'"
    tag-expanded-aria
    @all="store.select({ kind: 'group', value: 'all' })"
    @category="store.select({ kind: 'category', value: $event })"
    @tag="store.select({ kind: 'tag', value: $event, ...(scopeType ? { type: scopeType } : {}) })"
  >
    <template #after-all>
      <button
        type="button"
        class="row"
        :class="{ 'row--active': pendingActive }"
        :aria-pressed="pendingActive"
        title="查看当前范围的待处理项"
        @click="$emit('pending')"
      >
        <CircleAlert :size="15" /><span class="row__label">待处理</span><span class="row__count">{{ pendingCount }}</span>
      </button>
      <p class="sidebar__title">类型</p>
      <button
        v-for="t in TYPES"
        :key="t"
        class="row"
        :class="{ 'row--active': (t === 'audio' ? inAudioScope && store.selection.kind === 'type' && !pendingActive : isActive('type', t)) }"
        @click="store.select({ kind: 'type', value: t })"
      >
        <Film v-if="t === 'movie'" :size="15" />
        <Music2 v-else-if="t === 'audio'" :size="15" />
        <Folder v-else-if="t === 'other'" :size="15" />
        <Tv v-else :size="15" />
        <span class="row__label">{{ VIDEO_TYPE_LABEL[t] }}</span>
        <span class="row__count">{{ t === 'audio' || t === 'other' ? store.counts[t] || 0 : store.counts.type[t] }}</span>
      </button>
      <button
        v-if="!privateHidden && store.counts.hentai_visible !== false"
        class="row"
        :class="{ 'row--active': isActive('type', 'hentai') }"
        @click="store.select({ kind: 'type', value: 'hentai' })"
      >
        <Flame :size="15" />
        <span class="row__label">里番</span>
        <span class="row__count">{{ store.counts.hentai ?? 0 }}</span>
      </button>
    </template>
    <template #before-tags>
      <template v-if="collections.length">
        <p class="sidebar__title">{{ inAudioScope ? '歌单分组' : '收藏分组' }}</p>
        <button
          v-for="collection in collections"
          :key="collection.name"
          class="row"
          :class="{ 'row--active': isActive('collection', collection.name) }"
          @click="store.select({ kind: 'collection', value: collection.name, ...(scopeType ? { type: scopeType } : {}) })"
        >
          <ListMusic v-if="inAudioScope" :size="15" />
          <Folder v-else :size="15" />
          <span class="row__label" :title="collection.name || '未设置'">{{ collection.name || '未设置' }}</span>
          <span class="row__count">{{ collection.count }}</span>
        </button>
      </template>
    </template>
    <template #after-tags>
      <template v-if="archivedCount > 0">
        <div class="sidebar__divider" />
        <button
          class="row"
          :class="{ 'row--active': isActive('group', 'archived') }"
          @click="store.select({ kind: 'group', value: 'archived', ...(scopeType ? { type: scopeType } : {}) })"
        >
          <Archive :size="15" />
          <span class="row__label">{{ inAudioScope ? '已归档音频' : '已归档' }}</span>
          <span class="row__count">{{ archivedCount }}</span>
        </button>
      </template>
    </template>
  </LibrarySidebar>
</template>

<style scoped>
.video-sidebar {
  --text-faint: var(--text-sub);
  --library-title-spacing: 0;
  --library-row-height: auto;
  --library-row-min-height: 32px;
  --library-row-padding: 6px;
  --library-label-wrap: normal;
  --library-label-overflow: anywhere;
  --library-active-color: var(--text-main);
}
.video-sidebar :deep(button:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
