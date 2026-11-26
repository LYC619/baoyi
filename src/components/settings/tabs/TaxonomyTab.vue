<script setup lang="ts">
import { tr } from "../../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { computed, onMounted, ref, watch } from 'vue'
import { activeModule, type ModuleKey } from '@/composables/useModules'
import { latestOnly, STALE } from '@/composables/latestOnly'
import { ChevronDown, ChevronUp, Merge, Plus, Trash2 } from 'lucide-vue-next'
import TagBadge from '@/components/ui/TagBadge.vue'
import VideoTaxonomySettings from '@/components/settings/VideoTaxonomySettings.vue'
import { useProjectStore } from '@/stores/project'
import { useToast } from '@/composables/useToast'
import { ICON_NAMES } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'
import { useGameStore } from '@/stores/game'
import { useVideoStore } from '@/stores/video'
import { errorMessage, plain } from '@/utils'
import type { Category, Tag } from '@/types'

const store = useSoftwareStore()

// 「隐藏里番」的开关要在设置页里当场让影视那边重查，所以这儿得拿到它的 store
const video = useVideoStore()

const game = useGameStore()

const project = useProjectStore()

const { success, error, toast } = useToast()

/* --------------------------- 分类与标签 --------------------------- */

const tags = ref<Tag[]>([])

const taxonomyLoaded = ref(0)

const taxonomyCategories = ref<Category[]>([])

const taxonomyLoading = ref(false), taxonomySaving = ref(false)

const readTaxonomy = latestOnly(async (module: ModuleKey) => {
  if (!['software', 'game', 'video', 'project'].includes(module)) return null
  const result = await Promise.all([window.baoyi.categories.list(module), window.baoyi.tags.list(module)])
  await refreshTaxonomy(module)
  return result
})

const tagFilter = ref<'all' | 'ai' | 'fragment'>('all')

/** 合并时勾中的源标签 */
const mergePick = ref<number[]>([])

const mergeInto = ref<number | null>(null)

const newCategory = ref('')

const newTag = ref('')

async function loadTaxonomy(): Promise<void> {
  const module = activeModule.value
  taxonomyCategories.value = []; tags.value = []
  taxonomyLoading.value = true
  try {
    const result = await readTaxonomy(module)
    if (result === STALE) return
    if (result) {
      const [categories, loadedTags] = result
      taxonomyCategories.value = module === 'video' ? categories.filter(category => category.name !== '里番') : categories; tags.value = loadedTags
      taxonomyLoaded.value++
    }
  } catch (cause) { error(errorMessage(cause)) }
  taxonomyLoading.value = false
}

const taxonomyStore = computed(() => activeModule.value === 'game' ? game : activeModule.value === 'video' ? video : store)

async function refreshTaxonomy(module = activeModule.value): Promise<void> {
  if (module === 'project') await project.refresh()
  else if (module === 'game') await game.reload()
  else if (module === 'video') await video.reload()
  else if (module === 'software') await store.reload()
}

async function mutateTaxonomy(action: (module: ModuleKey) => Promise<unknown>): Promise<boolean> {
  if (taxonomySaving.value || taxonomyLoading.value) return false
  const module = activeModule.value
  taxonomySaving.value = true
  try {
    await action(module)
    await refreshTaxonomy(module)
    if (activeModule.value === module) await loadTaxonomy()
    return true
  } catch (cause) { error(errorMessage(cause)); return false }
  finally { taxonomySaving.value = false }
}

/** 每个分类名下挂着多少软件。侧边栏计数已经算过一遍，直接借用 */
const categoryCount = computed(
  () => activeModule.value==='project' ? new Map(taxonomyCategories.value.map(c=>[c.name,project.items.filter(i=>i.category===c.name).length])) : new Map(taxonomyStore.value.counts.categories.map((c) => [c.name, c.count]))
)

const visibleTags = computed(() => {
  if (tagFilter.value === 'ai') return tags.value.filter((t) => t.source === 'ai')
  // 只挂着 0～1 个条目的标签就是碎片：留着只会让标签栏越来越长
  if (tagFilter.value === 'fragment') return tags.value.filter((t) => t.usage_count <= 1)
  return tags.value
})

const TAG_SOURCE_META: Record<Tag['source'], { label: string; tone: 'muted' | 'accent' | 'success' }> = {
  ai: { get label() { return tr("AI 待确认") }, tone: 'muted' },
  user: { get label() { return tr("自建") }, tone: 'accent' },
  confirmed: { get label() { return tr("已确认") }, tone: 'success' }
}

async function saveCategory(c: Category, patch: Partial<Category>): Promise<boolean> {
  return mutateTaxonomy(module => window.baoyi.categories.upsert(plain({ ...c, ...patch }), module))
}

async function onCategoryField(c: Category, field: 'name' | 'description' | 'icon', e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const value = input.value.trim()
  if (value === c[field] || (field === 'name' && !value)) { input.value = c[field]; return }
  if (!await saveCategory(c, { [field]: value }) && input.value.trim() === value) input.value = c[field]
}

async function addCategory(): Promise<void> {
  const name = newCategory.value.trim()
  if (!name) return
  if (taxonomyCategories.value.some((c) => c.name === name)) {
    toast(tr("已经有同名分类了"))
    return
  }
  const max = taxonomyCategories.value.reduce((n, c) => Math.max(n, c.sort_order), 0)
  await mutateTaxonomy(module => window.baoyi.categories.upsert({ id: '', name, description: '', icon: 'box', sort_order: max + 1 }, module))
  newCategory.value = ''
}

async function shiftCategory(id: string, delta: number): Promise<void> {
  await mutateTaxonomy(() => window.baoyi.categories.move(id, delta))
}

async function dropCategory(c: Category): Promise<void> {
  const n = categoryCount.value.get(c.name) ?? 0
  const warn = n > 0 ? tr("\n名下 {p0} 个条目会归入「其他」。", {p0: (n)}) : ''
  if (!(await confirmDialog({ title: tr('删除分类「{p0}」？', {p0: c.name}), message: tr("{p0}仅调整库内分类，不会删除任何本地文件。", {p0: (warn ? warn.trim() + '\n' : '')}), confirmText: tr('删除分类'), tone: 'danger' }))) return
  await mutateTaxonomy(() => window.baoyi.categories.remove(c.id))
}

async function addTag(): Promise<void> {
  const name = newTag.value.trim()
  if (!name) return
  await mutateTaxonomy(module => window.baoyi.tags.create(name, module))
  newTag.value = ''
}

function onTagRename(t: Tag, e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim()
  if (!value || value === t.name) return
  void mutateTaxonomy(() => window.baoyi.tags.rename(t.id, value))
}

async function dropTag(t: Tag): Promise<void> {
  const warn = t.usage_count > 0 ? tr("\n{p0} 个条目会失去这个标签。", {p0: (t.usage_count)}) : ''
  if (!(await confirmDialog({ title: tr('删除标签「{p0}」？', {p0: t.name}), message: warn ? warn.trim() : tr("删除后相关条目将移除该标签，本地文件不受影响。"), confirmText: tr('删除标签'), tone: 'danger' }))) return
  await mutateTaxonomy(() => window.baoyi.tags.remove(t.id))
  mergePick.value = mergePick.value.filter((id) => id !== t.id)
  await refreshTaxonomy()
}

function toggleMerge(id: number): void {
  mergePick.value = mergePick.value.includes(id)
    ? mergePick.value.filter((x) => x !== id)
    : [...mergePick.value, id]
}

/** 勾中的这些并进目标标签，条目上的引用一并替换 */
async function doMerge(): Promise<void> {
  const into = mergeInto.value
  const from = mergePick.value.filter((id) => id !== into)
  if (into == null || from.length === 0) {
    toast(tr("先勾选要合并的标签，再选一个目标"))
    return
  }
  const target = tags.value.find((t) => t.id === into)?.name ?? ''
  const names = tags.value.filter((t) => from.includes(t.id)).map((t) => t.name)
  if (!(await confirmDialog({ title: tr('合并标签至「{p0}」？', {p0: target}), message: tr("将把「{p0}」并入「{p1}」，相关条目上的标签引用会一并更新。", {p0: (names.join('、')), p1: (target)}), confirmText: tr('确认合并') }))) return

  if (!await mutateTaxonomy(() => window.baoyi.tags.merge(from, into))) return
  mergePick.value = []
  mergeInto.value = null
  await refreshTaxonomy()
  success(tr("已并入「{p0}」", {p0: (target)}))
}

onMounted(loadTaxonomy)
watch(activeModule, () => { newCategory.value=''; newTag.value=''; mergePick.value=[]; mergeInto.value=null; void loadTaxonomy() })
const props = defineProps<{ section: 'categories' | 'tags' }>()
const tab = computed(() => props.section)
</script>

<template>
<fieldset  class="taxonomy-fields" :disabled="taxonomyLoading || taxonomySaving">
<p v-if="taxonomyLoading" class="hint" role="status">{{ $t("正在读取当前模块…") }}</p>
<section v-if="tab === 'categories'" class="panel">
  <div class="sec-head">
    <h2>{{ $t("分类") }}</h2>
    <span class="hint">{{ $t("{p0} 个", {p0: (taxonomyCategories.length)}) }}</span>
  </div>
  <p class="sec-desc">{{ $t("分类按") }}<b>{{ $t("用途") }}</b>{{ $t("分 —— 回答的是「我现在要干这件事，该开哪个」， 而不是「它属于哪一行」。这份列表和每条的说明会原样注入识别 prompt， 所以描述写得越准，AI 归类越稳。") }}</p>

  <ul class="cats">
    <li v-for="(c, i) in taxonomyCategories" :key="c.id">
      <div class="cats__line">
        <div class="cats__move">
          <button :disabled="i === 0" :title="$t('上移')" @click="shiftCategory(c.id, -1)">
            <ChevronUp :size="13" />
          </button>
          <button
            :disabled="i === taxonomyCategories.length - 1"
            :title="$t('下移')"
            @click="shiftCategory(c.id, 1)"
          >
            <ChevronDown :size="13" />
          </button>
        </div>
        <input
          class="input"
          :value="c.name"
          :placeholder="$t('分类名')"
          spellcheck="false"
          @blur="onCategoryField(c, 'name', $event)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <span class="cats__n">{{ categoryCount.get(c.name) ?? 0 }}</span>
        <button class="btn btn--subtle" :title="$t('删除')" @click="dropCategory(c)">
          <Trash2 :size="14" />
        </button>
      </div>
      <div class="cats__line cats__line--sub">
        <input
          class="input"
          :value="c.description"
          :placeholder="$t('一句话说明这个分类装什么（会喂给 AI）')"
          spellcheck="false"
          @blur="onCategoryField(c, 'description', $event)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <input
          class="input input--icon mono"
          :value="c.icon"
          :placeholder="$t('图标名')"
          spellcheck="false"
          @blur="onCategoryField(c, 'icon', $event)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
      </div>
    </li>
  </ul>

  <div class="row row--gap">
    <input
      v-model="newCategory"
      class="input"
      :placeholder="$t('新分类名')"
      spellcheck="false"
      @keydown.enter="addCategory"
    />
    <button class="btn btn--ghost" :disabled="!newCategory.trim()" @click="addCategory">
      <Plus :size="14" />{{ $t("添加") }}</button>
  </div>
  <p class="hint hint--block">{{ $t("图标填 Lucide 名称。内置了 {p0}，填别的会退回通用图标。", {p0: (ICON_NAMES.join('、'))}) }}</p>
</section>

<VideoTaxonomySettings v-if="tab === 'tags' && activeModule === 'video'" :key="taxonomyLoaded" section="tags" :hentai="false" @updated="loadTaxonomy" />
<section v-if="tab === 'tags'" class="panel">
  <div class="sec-head">
    <h2>{{ activeModule === 'video' ? $t('识别标签池（影视通用）') : $t('标签') }}</h2>
    <span class="hint">{{ $t("{p0} 个", {p0: (tags.length)}) }}</span>
  </div>
  <p v-if="activeModule === 'video'" class="sec-desc">{{ $t("在此预设识别时优先使用的标签。沿用原有共享标签池：改名、合并或删除会更新全部影视作品中的同名通用标签，包含里番。只修改某个区域时，使用上方影视标签或左侧里番标签。") }}</p>
  <p v-else class="sec-desc">{{ $t("标签描述") }}<b>{{ $t("特征") }}</b>{{ $t("（便携、开源、CLI），用途交给分类，两边说同一件事就是浪费。 只有「自建」和「已确认」的会作为标签池注入 prompt —— AI 自己造的词不进池， 否则它造一个新词下一轮就当既成事实继续用，标签只会越长越碎。") }}</p>

  <div class="row">
    <div class="segmented">
      <button :class="{ on: tagFilter === 'all' }" @click="tagFilter = 'all'">{{ $t("全部") }}</button>
      <button :class="{ on: tagFilter === 'ai' }" @click="tagFilter = 'ai'">{{ $t("AI 未确认") }}</button>
      <button :class="{ on: tagFilter === 'fragment' }" @click="tagFilter = 'fragment'">{{ $t("碎片（≤1）") }}</button>
    </div>
  </div>

  <ul v-if="visibleTags.length" class="tags">
    <li v-for="t in visibleTags" :key="t.id">
      <input
        type="checkbox"
        :checked="mergePick.includes(t.id)"
        :title="$t('勾选后可合并')"
        @change="toggleMerge(t.id)"
      />
      <input
        class="input"
        :value="t.name"
        spellcheck="false"
        @blur="onTagRename(t, $event)"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <TagBadge :label="TAG_SOURCE_META[t.source].label" :tone="TAG_SOURCE_META[t.source].tone" />
      <span class="tags__n">{{ t.usage_count }}</span>
      <button class="btn btn--subtle" :title="$t('删除')" @click="dropTag(t)">
        <Trash2 :size="14" />
      </button>
    </li>
  </ul>
  <p v-else class="empty-line">
    {{ tagFilter === 'all' ? $t('还没有任何标签，识别几个目录之后就有了。') : $t('这个筛选下没有标签。') }}
  </p>

  <div v-if="mergePick.length > 0" class="row row--gap">
    <span class="hint">{{ $t("已选 {p0} 个，并入", {p0: (mergePick.length)}) }}</span>
    <select v-model.number="mergeInto" class="input input--pick">
      <option :value="null">{{ $t("选择目标标签") }}</option>
      <option v-for="t in tags" :key="t.id" :value="t.id">{{ t.name }}</option>
    </select>
    <button class="btn btn--ghost" :disabled="mergeInto == null" @click="doMerge">
      <Merge :size="14" />{{ $t("合并") }}</button>
  </div>

  <div class="row row--gap">
    <input
      v-model="newTag"
      class="input"
      :placeholder="$t('新标签名')"
      spellcheck="false"
      @keydown.enter="addTag"
    />
    <button class="btn btn--ghost" :disabled="!newTag.trim()" @click="addTag">
      <Plus :size="14" />{{ $t("添加") }}</button>
  </div>
</section>
        </fieldset>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
.taxonomy-fields{border:0;padding:0;margin:0;min-width:0}

.input--icon {
  width: 150px;
  flex: none;
}

.input--pick {
  width: 180px;
  flex: none;
}

/* ------------------------------ 分类列表 ------------------------------ */
.cats,
.tags {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cats li {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.cats__line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cats__line--sub {
  padding-left: 28px;
}

.cats__move {
  display: flex;
  flex-direction: column;
  flex: none;
}

.cats__move button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 15px;
  color: var(--text-faint);
  transition: color var(--t-fast) ease;
}

.cats__move button:hover:not(:disabled) {
  color: var(--accent);
}

.cats__move button:disabled {
  opacity: 0.3;
  cursor: default;
}

.cats__n,
.tags__n {
  flex: none;
  min-width: 26px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.tags {
  margin-top: 12px;
}

.tags li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.tags li input[type='checkbox'] {
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}
</style>
