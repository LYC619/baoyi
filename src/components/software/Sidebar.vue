<script setup lang="ts">
import { Archive, Layers, Leaf, Sparkles, Timer } from 'lucide-vue-next'
import LibrarySidebar from '@/components/library/LibrarySidebar.vue'
import { useCategoriesStore } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'

const store = useSoftwareStore()
const categories = useCategoriesStore()
const iconFor = (name: string) => categories.iconComponent(name)
const MOTTOS = [
  { text: '少则得，多则惑。', from: '《道德经》第二十二章' },
  { text: '知止而后有定。', from: '《大学》' },
  { text: '圣人抱一为天下式。', from: '《道德经》第二十二章' },
  { text: '见素抱朴，少私寡欲。', from: '《道德经》第十九章' }
]
const motto = MOTTOS[Math.floor(Math.random() * MOTTOS.length)]
const isActive = (kind: string, value: string) => store.activeKey === kind + ':' + value
</script>

<template>
  <LibrarySidebar all-label="全部" :all-icon="Layers" :all-count="store.counts.all" :active-key="store.activeKey"
    :categories="store.counts.categories" :category-icon="iconFor" empty-categories="尚无分类" :tags="store.counts.tags"
    @all="store.select({ kind: 'group', value: 'all' })"
    @category="store.select({ kind: 'category', value: $event })" @tag="store.select({ kind: 'tag', value: $event })">
    <template #after-tags>
      <div class="sidebar__divider" />
      <button class="row" :class="{ 'row--active': isActive('group', 'archived') }" @click="store.select({ kind: 'group', value: 'archived' })">
        <Archive :size="15" /><span class="row__label">已归档</span><span class="row__count">{{ store.counts.archived }}</span>
      </button>
      <button class="row" :class="{ 'row--active': isActive('group', 'unused'), 'row--warn': store.counts.unused > 0 }" @click="store.select({ kind: 'group', value: 'unused' })">
        <Timer :size="15" /><span class="row__label">长期未用</span><span class="row__count">{{ store.counts.unused }}</span>
      </button>
      <button v-if="store.counts.portable > 0" class="row" :class="{ 'row--active': isActive('group', 'portable') }" @click="store.select({ kind: 'group', value: 'portable' })">
        <Leaf :size="15" /><span class="row__label">绿色软件</span><span class="row__count">{{ store.counts.portable }}</span>
      </button>
      <button v-if="store.counts.pending > 0" class="row" :class="{ 'row--active': isActive('group', 'pending') }" @click="store.select({ kind: 'group', value: 'pending' })">
        <Sparkles :size="15" /><span class="row__label">待识别</span><span class="row__count">{{ store.counts.pending }}</span>
      </button>
    </template>
    <template #footer>
      <footer class="motto"><p class="motto__text">{{ motto.text }}</p><p class="motto__from">——{{ motto.from }}</p></footer>
    </template>
  </LibrarySidebar>
</template>

<style scoped>
.motto { flex: none; padding: 14px 18px 16px; border-top: 1px solid var(--divider); font-family: var(--font-display); color: var(--text-faint); }
.motto__text { font-size: 13px; letter-spacing: 1px; line-height: 1.7; }
.motto__from { margin-top: 4px; font-size: 10px; opacity: 0.72; }
</style>
