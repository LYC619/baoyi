<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowUpRight, Link2, Plus, Search as SearchIcon, Sparkles } from 'lucide-vue-next'
import { latestOnly, STALE } from '@/composables/latestOnly'
import { useArchiveAssistant } from '@/composables/useArchiveAssistant'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import type { LinkOwner } from '@/types/workspace'

interface BacklinkEntry {
  ownerType: LinkOwner
  ownerId: string
  name: string
  projectId?: string
}

interface LinkTargetOption {
  key: string
  ownerType: LinkOwner
  ownerId: string
  groupLabel: string
  name: string
}

const OWNER_LABEL: Record<LinkOwner, string> = {
  get project() { return tr('项目') },
  get event() { return tr('项目日志') },
  get skill() { return tr('技能') },
  get experience() { return tr('经历') },
  get asset() { return tr('背包') }
}

const props = defineProps<{
  resourceId: string
}>()

const route = useRoute()
const router = useRouter()
const assistant = useArchiveAssistant()
const { success, error: toastError } = useToast()

const backlinks = ref<BacklinkEntry[]>([])
const pickerOpen = ref(false)
const loadingOptions = ref(false)
const saving = ref(false)
const filterText = ref('')
const filterInput = ref<HTMLInputElement>()
const targetOptions = ref<LinkTargetOption[]>([])

const hasWorkspaceApi = typeof window !== 'undefined' && !!window.baoyi?.workspace?.links

const readBacklinks = latestOnly((id: string) =>
  hasWorkspaceApi ? window.baoyi.workspace.links.backlinks(id) : Promise.resolve([] as BacklinkEntry[])
)

async function loadBacklinks(): Promise<void> {
  if (!props.resourceId || !hasWorkspaceApi) return
  try {
    const rows = await readBacklinks(props.resourceId)
    if (rows !== STALE) backlinks.value = rows
  } catch (cause) {
    toastError(errorMessage(cause))
  }
}

watch(
  () => props.resourceId,
  () => {
    backlinks.value = []
    pickerOpen.value = false
    void loadBacklinks()
  },
  { immediate: true }
)

const offWorkspace = hasWorkspaceApi ? window.baoyi.workspace.onChanged(() => void loadBacklinks()) : null
onBeforeUnmount(() => {
  offWorkspace?.()
})

const existingSet = computed(
  () => new Set(backlinks.value.map((b) => `${b.ownerType}:${b.ownerId}`))
)

const unlinkedTargets = computed(() =>
  targetOptions.value.filter((opt) => !existingSet.value.has(opt.key))
)

const filteredTargets = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  return unlinkedTargets.value.filter(
    (opt) => !q || `${opt.groupLabel} ${opt.name}`.toLowerCase().includes(q)
  )
})

async function togglePicker(): Promise<void> {
  if (pickerOpen.value) {
    pickerOpen.value = false
    return
  }
  pickerOpen.value = true
  filterText.value = ''
  if (!hasWorkspaceApi) return
  loadingOptions.value = true
  try {
    const [projects, personal] = await Promise.all([
      window.baoyi.project.list(),
      window.baoyi.workspace.personal.list()
    ])
    const opts: LinkTargetOption[] = []
    for (const p of projects) {
      if (p.state === 'archived') continue
      opts.push({
        key: `project:${p.id}`,
        ownerType: 'project',
        ownerId: p.id,
        get groupLabel() { return tr("项目") },
        name: p.name
      })
    }
    for (const r of personal) {
      if (r.kind !== 'skill' && r.kind !== 'experience' && r.kind !== 'asset') continue
      opts.push({
        key: `${r.kind}:${r.id}`,
        ownerType: r.kind,
        ownerId: r.id,
        groupLabel: tr("个人 · {p0}", {p0: (OWNER_LABEL[r.kind])}),
        name: r.name
      })
    }
    targetOptions.value = opts
    await nextTick()
    filterInput.value?.focus()
  } catch (cause) {
    toastError(errorMessage(cause))
  } finally {
    loadingOptions.value = false
  }
}

async function addLinkTarget(chosen?: LinkTargetOption): Promise<void> {
  const target = chosen ?? filteredTargets.value[0]
  if (!target || saving.value || !hasWorkspaceApi) return
  saving.value = true
  try {
    await window.baoyi.workspace.links.add(target.ownerType, target.ownerId, props.resourceId)
    success(tr("已关联到「{p0}」", {p0: (target.name)}))
    pickerOpen.value = false
    await loadBacklinks()
  } catch (cause) {
    toastError(errorMessage(cause))
  } finally {
    saving.value = false
  }
}

function onFilterKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter' && filteredTargets.value.length) {
    event.preventDefault()
    void addLinkTarget(filteredTargets.value[0])
  } else if (event.key === 'Escape') {
    event.preventDefault()
    pickerOpen.value = false
  }
}

function cleanReturnFrom(): string {
  const nextQuery = { ...route.query }
  delete nextQuery.from
  const resolved = router.resolve({ path: route.path, query: nextQuery })
  return resolved.fullPath || route.path
}

function jumpToOwner(b: BacklinkEntry): void {
  const target =
    b.ownerType === 'project'
      ? `/project/${encodeURIComponent(b.ownerId)}`
      : b.ownerType === 'event' && b.projectId
        ? `/project/${encodeURIComponent(b.projectId)}`
        : `/personal`
  const query: Record<string, string> = { from: cleanReturnFrom() }
  if (b.ownerType === 'event') {
    query.tab = 'timeline'
    query.event = b.ownerId
  } else if (b.ownerType !== 'project') {
    query.section = b.ownerType
    query.record = b.ownerId
  }
  void router.push({ path: target, query })
}

function askAssistant(): void {
  void assistant.show(undefined, [props.resourceId])
}
</script>

<template>
  <section class="backlinks-panel" :aria-label="$t('关联的项目与个人记录')">
    <header class="backlinks-panel__head">
      <div class="backlinks-panel__title">
        <Link2 :size="15" />
        <h2>{{ $t("关联的项目与个人记录") }}</h2>
        <span v-if="backlinks.length" class="backlinks-panel__count">{{ backlinks.length }}</span>
      </div>
      <div class="backlinks-panel__actions">
        <button type="button" class="btn btn--subtle btn--sm" @click="askAssistant">
          <Sparkles :size="13" />{{ $t("交给归档助理") }}</button>
        <button type="button" class="btn btn--ghost btn--sm" @click="togglePicker">
          <Plus :size="13" />{{ pickerOpen ? $t('收起') : $t('添加关联') }}
        </button>
      </div>
    </header>

    <div v-if="pickerOpen" class="backlinks-picker">
      <template v-if="loadingOptions">
        <p class="backlinks-panel__empty">{{ $t("正在读取可关联的项目与个人记录…") }}</p>
      </template>
      <template v-else-if="!targetOptions.length">
        <p class="backlinks-panel__empty">{{ $t("暂无进行中的项目或个人技能/经历/背包记录，可先前往「项目」或「个人」建立。") }}</p>
      </template>
      <template v-else-if="!unlinkedTargets.length">
        <p class="backlinks-panel__empty">{{ $t("当前可关联的项目与个人记录均已建立关联。") }}</p>
      </template>
      <div v-else class="backlinks-picker__body">
        <search class="backlinks-picker__search">
          <SearchIcon :size="14" />
          <input
            ref="filterInput"
            v-model="filterText"
            type="search"
            :placeholder="$t('输入关键词筛选，点击下方条目直接关联（回车关联首项）…')"
            :aria-label="$t('筛选关联目标')"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            @keydown="onFilterKeydown"
          />
        </search>
        <div v-if="filteredTargets.length" class="backlinks-picker__candidates">
          <button
            v-for="opt in filteredTargets"
            :key="opt.key"
            type="button"
            class="backlinks-candidate"
            :disabled="saving"
            @click="addLinkTarget(opt)"
          >
            <span class="backlinks-candidate__kind">{{ opt.groupLabel }}</span>
            <span class="backlinks-candidate__name">{{ opt.name }}</span>
          </button>
        </div>
        <p v-else class="backlinks-panel__empty">{{ $t("没有匹配的关联目标") }}</p>
      </div>
    </div>

    <div v-if="backlinks.length" class="backlinks-list">
      <button
        v-for="b in backlinks"
        :key="`${b.ownerType}:${b.ownerId}`"
        type="button"
        class="backlink-chip"
        @click="jumpToOwner(b)"
      >
        <span class="backlink-chip__kind">{{ OWNER_LABEL[b.ownerType] }}</span>
        <span class="backlink-chip__name">{{ b.name }}</span>
        <ArrowUpRight :size="13" class="backlink-chip__arrow" />
      </button>
    </div>
    <p v-else-if="!pickerOpen" class="backlinks-panel__empty">{{ $t("尚未关联项目或个人记录。可以把当前条目挂到相关项目、技能或背包记录里，方便来回查看。") }}</p>
  </section>
</template>

<style scoped>
.backlinks-panel {
  padding: 16px 18px;
  border-radius: var(--radius-card);
  border: 1px solid var(--card-border, var(--divider));
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.backlinks-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.backlinks-panel__title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-sub);
}

.backlinks-panel__title h2 {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}

.backlinks-panel__count {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: var(--fs-micro);
  background: var(--tag-bg);
  color: var(--tag-text);
  font-variant-numeric: tabular-nums;
}

.backlinks-panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.btn--sm {
  height: 28px;
  padding: 0 10px;
  font-size: var(--fs-tag);
}

.backlinks-picker {
  padding: 10px 12px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
}

.backlinks-picker__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.backlinks-picker__search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 32px;
  border-radius: var(--radius-input);
  border: 1px solid var(--divider);
  background: var(--bg-card);
  color: var(--text-faint);
}

.backlinks-picker__search input {
  flex: 1;
  min-inline-size: 0;
  border: 0;
  background: transparent;
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-tag);
  outline: none;
}

.backlinks-picker__candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
}

.backlinks-candidate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--divider);
  background: var(--bg-card);
  color: var(--text-main);
  font-size: var(--fs-tag);
  cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}

.backlinks-candidate:hover,
.backlinks-candidate:focus-visible {
  border-color: var(--accent);
  background: var(--active-surface);
}

.backlinks-candidate__kind {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--accent-ink, var(--accent));
}

.backlinks-candidate__name {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backlinks-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.backlink-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--divider);
  background: var(--hover-surface);
  color: var(--text-main);
  font-size: var(--fs-tag);
  cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}

.backlink-chip:hover,
.backlink-chip:focus-visible {
  border-color: var(--accent);
  background: var(--active-surface);
}

.backlink-chip__kind {
  flex: none;
  color: var(--accent-ink, var(--accent));
  font-size: var(--fs-micro);
}

.backlink-chip__name {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backlink-chip__arrow {
  flex: none;
  color: var(--text-faint);
}

.backlinks-panel__empty {
  margin: 0;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.65;
}
</style>
