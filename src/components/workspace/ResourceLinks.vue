<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
import { latestOnly, STALE } from '@/composables/latestOnly'
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Plus, Link2, Search as SearchIcon, X } from 'lucide-vue-next'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import ProjectFiles from './ProjectFiles.vue'
import { workspace, openResource, kindLabels } from '@/utils/workspace-api'
import type { LinkOwner, ResourceLink, ResourceOption, DocumentAnnotation } from '@/types/workspace'

const props = defineProps<{ owner: LinkOwner; id: string; title?: string }>()
const displayTitle = computed(() => props.title ?? tr('相关实践与资源'))

const router = useRouter()
const route = useRoute()
const rows = ref<ResourceLink[]>([])
const options = ref<ResourceOption[]>([])
const show = ref(false)
const selected = ref('')
const annotation = ref('')
const annotations = ref<DocumentAnnotation[]>([])
const query = ref('')
const filterInput = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')

const readLinks = latestOnly((owner: LinkOwner, id: string) => workspace.links.list(owner, id))
const readAnnotations = latestOnly((id: string | null) =>
  id ? workspace.documents.annotations(id) : Promise.resolve([])
)

const linkedIds = computed(() => new Set(rows.value.map((r) => r.resourceId).filter(Boolean)))

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return options.value
    .filter(
      (r) =>
        r.id !== props.id &&
        (!needle || `${r.name} ${kindLabels[r.kind] || r.kind} ${r.path || ''}`.toLowerCase().includes(needle))
    )
    .slice(0, 200)
})

async function load() {
  try {
    const value = await readLinks(props.owner, props.id)
    if (value !== STALE) rows.value = value
  } catch (e) {
    error.value = errorMessage(e)
  }
}

function closeDialog() {
  void readAnnotations(null)
  show.value = false
  selected.value = ''
  annotation.value = ''
  annotations.value = []
}

watch(
  () => [props.owner, props.id],
  () => {
    rows.value = []
    closeDialog()
    error.value = ''
    void load()
  },
  { immediate: true }
)

const unsubscribe = workspace.onChanged(() => void load())
onBeforeUnmount(() => {
  void readAnnotations(null)
  unsubscribe()
})

async function start() {
  error.value = ''
  void readAnnotations(null)
  try {
    options.value = await workspace.links.resources()
    selected.value = ''
    annotation.value = ''
    annotations.value = []
    query.value = ''
    show.value = true
    await nextTick()
    filterInput.value?.focus()
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function saveResourceLink(resourceId: string, annotationId?: string) {
  if (busy.value || !resourceId) return
  void readAnnotations(null)
  busy.value = true
  error.value = ''
  try {
    await workspace.links.add(props.owner, props.id, resourceId, annotationId || undefined)
    await load()
    closeDialog()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function clickCandidate(item: ResourceOption) {
  if (busy.value) return
  error.value = ''
  if (item.kind !== 'document') {
    selected.value = ''
    annotation.value = ''
    annotations.value = []
    await saveResourceLink(item.id)
    return
  }
  selected.value = item.id
  annotation.value = ''
  annotations.value = []
  try {
    const docNotes = await readAnnotations(item.id)
    if (docNotes === STALE || !show.value || selected.value !== item.id) return
    annotations.value = docNotes
    if (!docNotes.length) {
      await saveResourceLink(item.id)
    }
  } catch (e) {
    if (show.value && selected.value === item.id) error.value = errorMessage(e)
  }
}

function add() {
  return saveResourceLink(selected.value, annotation.value)
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Enter' && filtered.value.length) {
    event.preventDefault()
    void clickCandidate(filtered.value[0])
  }
}

async function remove(row: ResourceLink) {
  if (
    !(await confirmDialog({
      title: tr('解除这条关联？'),
      message: tr("仅解除引用关系，原资料、本地文件与所属记录均会保留。"),
      confirmText: tr('解除关联')
    }))
  )
    return
  try {
    await workspace.links.remove(props.owner, props.id, row.id)
    await load()
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function open(row: ResourceLink) {
  try {
    const q = { ...route.query }
    delete q.from
    const clean = router.resolve({ path: route.path, query: q }).fullPath || route.path
    await openResource(router, row, clean)
  } catch (e) {
    error.value = errorMessage(e)
  }
}
</script>
<template>
  <section class="ws-links">
    <header class="ws-section-head">
      <h3>{{ displayTitle }} <span class="ws-muted">{{ rows.length }}</span></h3>
      <div class="ws-links-actions">
        <ProjectFiles v-if="owner === 'project'" :project-id="id" inline />
        <button class="ws-button" :aria-label="$t('添加') + displayTitle" @click="start"><Plus :size="15" />{{ $t("添加关联") }}</button>
      </div>
    </header>
    <p v-if="error && !show" class="ws-error" role="alert">{{ $systemMessage(error) }}</p>
    <p v-if="!rows.length" class="ws-muted">{{ $t("关联项目、文库资料、软件或摘录，随时从这里直接跳转。") }}</p>
    <div v-else class="ws-link-grid">
      <article v-for="row in rows" :key="row.id" class="ws-link">
        <Link2 :size="15" />
        <button class="ws-link-main" @click="open(row)">
          <strong>{{ row.name }}</strong>
          <small>{{ kindLabels[row.kind] || row.kind }}<template v-if="row.missing">{{ $t("· 原文件或索引暂不可用") }}</template></small>
          <p v-if="row.quote" class="ws-pre">{{ row.quote }}</p>
        </button>
        <button class="ws-icon" :aria-label="$t('移除关联 ') + row.name" @click="remove(row)"><X :size="14" /></button>
      </article>
    </div>

    <ProjectDialog v-if="show" :title="$t('关联资源')" :busy="busy" @close="closeDialog">
      <div class="ws ws-form">
        <p v-if="error" class="ws-error" role="alert">{{ $systemMessage(error) }}</p>
        <search class="ws-candidate-search">
          <SearchIcon :size="15" />
          <input
            ref="filterInput"
            v-model="query"
            type="search"
            :aria-label="$t('搜索可关联资源')"
            :placeholder="$t('输入名称或类型筛选，点击条目直接关联…')"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            @keydown="onSearchKeydown"
          />
        </search>
        <div class="ws-candidate-list" role="listbox" :aria-label="$t('选择关联资源')">
          <p v-if="!filtered.length" class="ws-muted">{{ $t("没有匹配的条目，试试其他关键词。") }}</p>
          <div
            v-for="r in filtered"
            :key="r.id"
            class="ws-candidate-row"
            :class="{ selected: selected === r.id }"
          >
            <button
              type="button"
              class="ws-candidate-main"
              :disabled="busy"
              @click="clickCandidate(r)"
            >
              <span class="ws-badge">{{ kindLabels[r.kind] || r.kind }}</span>
              <strong>{{ r.name }}</strong>
              <small v-if="linkedIds.has(r.id)" class="ws-muted">{{ $t("已关联") }}</small>
            </button>
            <button
              type="button"
              class="ws-button"
              :disabled="busy"
              @click="saveResourceLink(r.id)"
            >{{ $t("直接关联") }}</button>
          </div>
        </div>
        <label v-if="selected && annotations.length">{{ $t("摘录或书签（可选）") }}<select v-model="annotation" :aria-label="$t('选择关联摘录')">
            <option value="">{{ $t("关联整份资料") }}</option>
            <option v-for="a in annotations" :key="a.id" :value="a.id">{{ $t("第 {p0} 页/段 · {p1}", {p0: (a.location.page), p1: ((a.quote || a.note || $t('书签')).slice(0, 70))}) }}
            </option>
          </select>
        </label>
        <p class="ws-muted">{{ $t("点击条目即可一步建立关联；若文库资料含书签或摘录，可进一步指定具体段落。") }}</p>
      </div>
      <template v-if="selected && annotations.length" #footer>
        <div class="ws">
          <button class="ws-button primary" :disabled="busy || !selected" @click="add">{{ $t("保存关联") }}</button>
        </div>
      </template>
    </ProjectDialog>
  </section>
</template>
<style scoped>
.ws-links { margin-bottom: 20px; padding: 14px 16px; border: 1px solid var(--divider); border-radius: 8px; background: var(--bg-card); }
.ws-links-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ws-link-grid { display: grid; gap: 6px; margin-top: 8px; }
.ws-candidate-search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--divider); border-radius: 6px; background: var(--bg-main); }
.ws-candidate-search input { flex: 1; border: 0; background: transparent; padding: 9px 0; outline: none; color: var(--text-main); font: inherit; }
.ws-candidate-list { max-height: 260px; overflow-y: auto; border: 1px solid var(--divider); border-radius: 7px; padding: 4px; background: var(--bg-main); display: grid; gap: 2px; }
.ws-candidate-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; }
.ws-candidate-row:hover, .ws-candidate-row.selected { background: var(--active-surface); }
.ws-candidate-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; text-align: left; padding: 6px 4px; color: var(--text-main); }
.ws-candidate-main strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; font-size: 13px; }
</style>
