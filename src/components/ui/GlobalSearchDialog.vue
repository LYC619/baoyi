<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowUpRight, CornerDownLeft, Search as SearchIcon, X } from 'lucide-vue-next'
import { latestOnly, STALE } from '@/composables/latestOnly'
import { useGlobalSearch } from '@/composables/useGlobalSearch'
import { errorMessage } from '@/utils'
import type { ArchiveSource } from '@/types/archive'

const { open, seed, closeGlobalSearch } = useGlobalSearch()
const route = useRoute()
const router = useRouter()

const dialogEl = ref<HTMLDialogElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const kindFilter = ref('')
const results = ref<ArchiveSource[]>([])
const activeIndex = ref(0)
const loading = ref(false)
const searchError = ref('')

const KIND_OPTIONS = [
  { key: '', get label() { return tr("全部") } },
  { key: 'software', get label() { return tr("软件") } },
  { key: 'game', get label() { return tr("游戏") } },
  { key: 'video', get label() { return tr("影视与音频") } },
  { key: 'image', get label() { return tr("图片与漫画") } },
  { key: 'document', get label() { return tr("文库") } },
  { key: 'project', get label() { return tr("项目") } },
  { key: 'personal', get label() { return tr("个人") } }
] as const

const KIND_LABELS: Record<string, string> = {
  get software() { return tr('软件') },
  get game() { return tr('游戏') },
  get video() { return tr('影视 / 音频') },
  get image() { return tr('图片 / 漫画') },
  get document() { return tr('文库') },
  get project() { return tr('项目') },
  get personal() { return tr('个人') }
}

const PERSONAL_SUBTYPE_LABELS: Record<string, string> = {
  get profile() { return tr('个人概览') },
  get skill() { return tr('技能') },
  get asset() { return tr('背包') },
  get metric() { return tr('状态指标') },
  get measurement() { return tr('状态记录') },
  get experience() { return tr('奖项与经历') },
  get todo() { return tr('待办') }
}

const runSearch = latestOnly((q: string, kind: string) =>
  window.baoyi.app.globalSearch(q, kind ? [kind] : undefined, 24)
)

async function refreshResults(): Promise<void> {
  loading.value = true
  searchError.value = ''
  try {
    const items = await runSearch(query.value.trim(), kindFilter.value)
    if (items === STALE) return
    results.value = items
    activeIndex.value = 0
  } catch (err) {
    searchError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

watch([query, kindFilter], () => {
  if (!open.value) return
  void refreshResults()
})

watch(open, async (isOpen) => {
  const el = dialogEl.value
  if (!el) return
  if (isOpen) {
    query.value = seed.value
    seed.value = ''
    if (!el.open) el.showModal()
    void refreshResults()
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  } else if (el.open) {
    el.close()
  }
})

function onClose(): void {
  if (dialogEl.value) dialogEl.value.returnValue = ''
  closeGlobalSearch()
}

function itemBadge(item: ArchiveSource): string {
  if (item.kind === 'personal' && item.subtype) {
    return PERSONAL_SUBTYPE_LABELS[item.subtype] || tr("个人")
  }
  return KIND_LABELS[item.kind] || item.kind
}

function targetRoute(item: ArchiveSource) {
  const fromPath = route.fullPath
  if (item.kind === 'personal') {
    const section =
      item.subtype === 'measurement' || item.subtype === 'metric'
        ? 'state'
        : item.subtype && ['skill', 'asset', 'experience', 'todo'].includes(item.subtype)
          ? item.subtype
          : 'overview'
    return {
      path: '/personal',
      query: {
        section,
        ...(section === 'skill' || section === 'asset' ? { record: item.id } : {}),
        ...(route.path !== '/personal' ? { from: fromPath } : {})
      }
    }
  }
  const base = item.kind === 'software' ? '/detail' : `/${item.kind}`
  const destPath = `${base}/${encodeURIComponent(item.id)}`
  return {
    path: destPath,
    query: route.path === destPath ? {} : { from: fromPath }
  }
}

async function selectItem(item: ArchiveSource | undefined): Promise<void> {
  if (!item) return
  closeGlobalSearch()
  await router.push(targetRoute(item))
}

function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (results.value.length > 0) {
      activeIndex.value = (activeIndex.value + 1) % results.value.length
      scrollActiveIntoView()
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (results.value.length > 0) {
      activeIndex.value = (activeIndex.value - 1 + results.value.length) % results.value.length
      scrollActiveIntoView()
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void selectItem(results.value[activeIndex.value])
  }
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    dialogEl.value?.querySelector<HTMLElement>('.gs-row.on')?.scrollIntoView({ block: 'nearest' })
  })
}

const emptyText = computed(() =>
  query.value.trim() ? tr("没有找到匹配的条目，试试换个关键词或切回「全部」") : tr("还没有可展示的收藏记录")
)

onMounted(() => {
  const el = dialogEl.value
  if (!el) return
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e: PointerEvent, d: HTMLDialogElement) => {
      const r = d.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }
    let pressedOutside = false
    el.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, el)
    })
    el.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, el)) el.close()
    })
  }
})
</script>

<template>
  <dialog
    ref="dialogEl"
    class="global-search-dialog"
    closedby="any"
    aria-labelledby="global-search-title"
    @close="onClose"
  >
    <div class="gs-head">
      <h2 id="global-search-title">{{ $t("全局搜索跳转") }}</h2>
      <span class="gs-hint">{{ $t("上下键切换 · 回车直达 · Esc 关闭") }}</span>
      <button type="button" class="gs-close" :aria-label="$t('关闭全局搜索')" @click="closeGlobalSearch">
        <X :size="16" />
      </button>
    </div>

    <search class="gs-search">
      <form class="gs-form" @submit.prevent="selectItem(results[activeIndex])">
        <label for="global-search-input" class="visually-hidden">{{ $t("搜索全部模块内容") }}</label>
        <div class="gs-input-wrap">
          <SearchIcon :size="17" class="gs-icon" />
          <input
            id="global-search-input"
            ref="inputEl"
            v-model="query"
            type="search"
            name="q"
            class="gs-input"
            :placeholder="$t('输入名称、作者、标签、路径或备注，跨全部模块直达…')"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            autocomplete="off"
            enterkeyhint="go"
            @keydown="onInputKeydown"
          />
        </div>
        <div class="gs-filters" role="group" :aria-label="$t('按模块筛选')">
          <button
            v-for="opt in KIND_OPTIONS"
            :key="opt.key"
            type="button"
            class="gs-pill"
            :class="{ on: kindFilter === opt.key }"
            @click="kindFilter = opt.key; inputEl?.focus()"
          >
            {{ opt.label }}
          </button>
        </div>
      </form>
    </search>

    <p v-if="searchError" class="gs-error" role="alert">{{ searchError }}</p>

    <div class="gs-list" role="listbox" :aria-label="query.trim() ? $t('搜索结果') : $t('最近更新')">
      <div v-if="!query.trim() && results.length" class="gs-section-label">{{ $t("最近更新与浏览") }}</div>
      <button
        v-for="(item, idx) in results"
        :key="item.kind + ':' + item.id"
        type="button"
        role="option"
        :aria-selected="idx === activeIndex"
        class="gs-row"
        :class="{ on: idx === activeIndex }"
        @mouseenter="activeIndex = idx"
        @click="selectItem(item)"
      >
        <span class="gs-badge">{{ itemBadge(item) }}</span>
        <span class="gs-main">
          <strong>{{ item.name }}</strong>
          <small v-if="item.summary || item.path">{{ item.summary || item.path }}</small>
        </span>
        <span v-if="item.tags?.length" class="gs-tags">
          <em v-for="t in item.tags.slice(0, 2)" :key="t">{{ t }}</em>
        </span>
        <CornerDownLeft v-if="idx === activeIndex" :size="14" class="gs-enter" />
        <ArrowUpRight v-else :size="14" class="gs-enter gs-enter--dim" />
      </button>
      <p v-if="!loading && !results.length" class="gs-empty">{{ emptyText }}</p>
    </div>
  </dialog>
</template>

<style scoped>
.global-search-dialog {
  width: min(680px, calc(100vw - 32px));
  max-height: min(620px, calc(100vh - 72px));
  margin: 9vh auto auto;
  padding: 0;
  border: 1px solid var(--divider-strong);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  color: var(--text-main);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}

.global-search-dialog[open] {
  display: flex;
  flex-direction: column;
}

.global-search-dialog:modal {
  overscroll-behavior: contain;
}

.global-search-dialog::backdrop {
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  overflow: hidden;
  overscroll-behavior: contain;
}

.visually-hidden {
  position: absolute;
  clip-path: inset(50%);
  overflow: hidden;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  white-space: nowrap;
}

.gs-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px 8px;
}

.gs-head h2 {
  font-size: var(--fs-body);
  font-weight: 600;
  margin: 0;
}

.gs-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}

.gs-close {
  display: inline-grid;
  place-items: center;
  min-inline-size: 26px;
  min-block-size: 26px;
  border-radius: var(--radius-btn);
  color: var(--text-sub);
}

.gs-close:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

.gs-search {
  display: block;
  padding: 0 16px 12px;
  border-bottom: 1px solid var(--divider);
}

.gs-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gs-input-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  height: 42px;
  border-radius: var(--radius-input);
  border: 1px solid var(--divider-strong);
  background: var(--bg-main);
}

.gs-input-wrap:focus-within {
  border-color: var(--accent);
}

.gs-icon {
  flex: none;
  color: var(--text-faint);
}

.gs-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-main);
  font-size: 14px;
  outline: none;
}

.gs-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.gs-pill {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-sub);
  background: var(--hover-surface);
  transition: background var(--t-fast) ease, color var(--t-fast) ease;
}

.gs-pill:hover {
  color: var(--text-main);
}

.gs-pill.on {
  background: var(--active-surface);
  color: var(--accent);
  font-weight: 500;
}

.gs-error {
  margin: 8px 16px 0;
  padding: 8px 12px;
  border-radius: var(--radius-btn);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  font-size: 12px;
}

.gs-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gs-section-label {
  padding: 4px 10px 6px;
  font-size: 11px;
  color: var(--text-faint);
}

.gs-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border-radius: var(--radius-btn);
  text-align: left;
  color: var(--text-main);
}

.gs-row.on,
.gs-row:hover {
  background: var(--active-surface);
}

.gs-badge {
  flex: none;
  padding: 2px 7px;
  border-radius: var(--radius-tag);
  font-size: 11px;
  color: var(--text-sub);
  background: var(--hover-surface);
}

.gs-row.on .gs-badge {
  color: var(--accent);
}

.gs-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gs-main strong {
  font-size: var(--fs-body);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-main small {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-tags {
  flex: none;
  display: flex;
  gap: 4px;
}

.gs-tags em {
  font-style: normal;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-tag);
  color: var(--text-faint);
  border: 1px solid var(--divider);
}

.gs-enter {
  flex: none;
  color: var(--accent);
}

.gs-enter--dim {
  color: var(--text-faint);
  opacity: 0.45;
}

.gs-empty {
  padding: 36px 16px;
  text-align: center;
  font-size: var(--fs-body);
  color: var(--text-faint);
}
</style>
