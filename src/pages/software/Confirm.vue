<script setup lang="ts">
/**
 * 识别结果确认面板。
 *
 * agent 给出的中文名、分类、标签都可能是错的，而错到库里以后没人会回头改 ——
 * 所以识别完先落在 pending_software，用户在这里过一遍才成为条目。
 * 改动是随手存的（失焦即写），中途关掉窗口不会丢；没处理完的下次进来还在。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Check, Layers, Loader2, X } from 'lucide-vue-next'
import AppIcon from '@/components/ui/AppIcon.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useToast } from '@/composables/useToast'
import { useCategoriesStore } from '@/stores/categories'
import { useSoftwareStore } from '@/stores/software'
import { compareVersions, plain, versionOf } from '@/utils'
import type { MoveRisk, PendingItem } from '@/types'

const router = useRouter()
const store = useSoftwareStore()
const categories = useCategoriesStore()
const { success, error, toast } = useToast()

const items = ref<PendingItem[]>([])
const selected = ref<string[]>([])
const loading = ref(true)
const busy = ref(false)

/**
 * 同一软件的多个版本目录。
 *
 * CC Switch 的 v3.16.1 和 v3.16.5 是两个目录，扫描器把它们拆成两个识别单元，
 * agent 也就如实报了两条 —— 没人做错什么，但用户不会想在卡片墙上留两张同名卡片。
 * 按 name_en 认（那是官方原名，agent 被要求原样填），中文名太容易有出入。
 */
function dupeKey(item: PendingItem): string {
  return item.name_en.trim().toLowerCase()
}

/** name_en 相同、条数大于 1 的那些组，按组内版本号从新到旧排好 */
const versionGroups = computed(() => {
  const map = new Map<string, PendingItem[]>()
  for (const it of items.value) {
    const key = dupeKey(it)
    if (!key) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(it)
  }
  return [...map.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({
      key,
      name: list[0].name_en,
      list: [...list].sort(
        (a, b) => compareVersions(versionOf(b), versionOf(a)) || b.created_at - a.created_at
      )
    }))
})

/**
 * 多版本组里不是最新的那些 —— 默认不勾。
 *
 * 只是不勾，不删：版本号可能认错（目录名里没写版本、或者写在别的位置），
 * 而「少收录一个用户其实想留的旧版」比「悄悄删掉」轻得多。全选按钮照样能全带上。
 */
const staleIds = computed(
  () => new Set(versionGroups.value.flatMap((g) => g.list.slice(1).map((i) => i.id)))
)

async function load(first = false): Promise<void> {
  items.value = await window.baoyi.pending.list()
  // 已经不在列表里的选中项要跟着清掉，否则「确认已选」会带上幽灵 id
  const alive = new Set(items.value.map((i) => i.id))
  selected.value = first
    ? items.value.filter((i) => !staleIds.value.has(i.id)).map((i) => i.id)
    : selected.value.filter((id) => alive.has(id))
}

onMounted(async () => {
  try {
    await Promise.all([load(true), categories.load()])
  } finally {
    loading.value = false
  }
})

/**
 * 分区块展示。多版本的那几组单独提到最前面 —— 它们分散在不同的来源目录里，
 * 混在目录分组里用户根本发现不了自己要在两条同名条目之间做选择。
 * 其余按来源目录分：一个目录里的东西放一起看，比一长条列表容易判断。
 */
const groups = computed(() => {
  const out: Array<{ key: string; title: string; dupe: boolean; list: PendingItem[] }> = []
  const grouped = new Set<string>()

  for (const g of versionGroups.value) {
    out.push({ key: `dupe:${g.key}`, title: `${g.name} —— ${g.list.length} 个版本`, dupe: true, list: g.list })
    for (const it of g.list) grouped.add(it.id)
  }

  const byDir = new Map<string, PendingItem[]>()
  for (const it of items.value) {
    if (grouped.has(it.id)) continue
    const key = it.source_dir || '（未知目录）'
    if (!byDir.has(key)) byDir.set(key, [])
    byDir.get(key)!.push(it)
  }
  for (const [dir, list] of byDir) out.push({ key: `dir:${dir}`, title: dir, dupe: false, list })

  return out
})

/** 版本号显示用。认不出来就用 PE 的 version 字段顶上 */
function versionLabel(item: PendingItem): string {
  const v = versionOf(item)
  return v.length > 0 ? v.join('.') : item.version || '版本未知'
}

const allSelected = computed(
  () => items.value.length > 0 && selected.value.length === items.value.length
)

function toggle(id: string): void {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : items.value.map((i) => i.id)
}

/** 分类下拉：现有分类，外加 AI 提的那个新分类（它还不在表里） */
function categoryOptions(item: PendingItem): string[] {
  const names = categories.list.map((c) => c.name)
  return item.category && !names.includes(item.category) ? [item.category, ...names] : names
}

async function patch(item: PendingItem, p: Partial<PendingItem>): Promise<void> {
  const updated = await window.baoyi.pending.update(item.id, plain(p))
  if (!updated) return
  const i = items.value.findIndex((x) => x.id === item.id)
  if (i >= 0) items.value[i] = updated
}

function editText(item: PendingItem, field: 'name_zh' | 'name_en' | 'summary', e: Event): void {
  const value = (e.target as HTMLInputElement).value.trim()
  if (value === item[field]) return
  void patch(item, { [field]: value })
}

function editTags(item: PendingItem, e: Event): void {
  const tags = (e.target as HTMLInputElement).value
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5)
  if (tags.join(' ') === item.tags.join(' ')) return
  void patch(item, { tags })
}

/**
 * is_portable 是三态的（是 / 否 / 还没判断），而 <select> 的值只能是字符串，
 * 所以在这一层做映射而不是把 null 塞进 :value —— 那会让「未判断」渲染成空白选项。
 */
function portableValue(item: PendingItem): 'yes' | 'no' | 'unknown' {
  return item.is_portable === null ? 'unknown' : item.is_portable ? 'yes' : 'no'
}

function setPortable(item: PendingItem, raw: string): void {
  void patch(item, { is_portable: raw === 'yes' ? true : raw === 'no' ? false : null })
}

/**
 * 这一条按现在的判断会走剪切还是链接。
 * 和 organize/plan.ts 的 defaultAction 是同一条规则 —— 写两遍是因为这里只是给用户
 * 一个即时预览，真正的方案由主进程算（渲染进程说的不算）。规则改了要同时改两处。
 */
function planOf(item: PendingItem): 'move' | 'link' {
  if (item.is_portable === true) return 'move'
  return item.move_risk === 'safe' ? 'move' : 'link'
}

async function confirm(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    toast('先勾选要确认的条目')
    return
  }
  busy.value = true
  try {
    const r = await window.baoyi.pending.confirm(plain(ids))
    await Promise.all([load(), categories.load(), store.reload()])
    const extra = [
      r.categories.length ? `新建分类「${r.categories.join('、')}」` : '',
      r.tags.length ? `${r.tags.length} 个标签入池` : ''
    ].filter(Boolean)
    success(`已收录 ${r.registered} 个软件${extra.length ? `，${extra.join('，')}` : ''}`)
    if (items.value.length === 0) void router.push({ name: 'home' })
  } catch (err) {
    error(`写入失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy.value = false
  }
}

async function skip(ids: string[], ask: boolean): Promise<void> {
  if (ids.length === 0) return
  if (
    ask &&
    !window.confirm(
      `把选中的 ${ids.length} 个程序标记为不注册？\n它们会进入忽略名单，下次扫描不再出现。\n（名单可以在设置 → 扫描与识别里清空）`
    )
  ) {
    return
  }
  busy.value = true
  try {
    const n = await window.baoyi.pending.skip(plain(ids))
    await Promise.all([load(), store.refreshCounts()])
    toast(`已标记 ${n} 个为不注册`)
    if (items.value.length === 0) void router.push({ name: 'home' })
  } finally {
    busy.value = false
  }
}

function confirmAll(): void {
  if (!window.confirm(`按 AI 的判断直接收录全部 ${items.value.length} 个条目？`)) return
  void confirm(items.value.map((i) => i.id))
}
</script>

<template>
  <div class="confirm">
    <header class="head">
      <button class="btn btn--subtle" @click="router.push({ name: 'home' })">
        <ArrowLeft :size="16" />
        稍后再说
      </button>
      <h1>确认识别结果</h1>
      <span class="head__count">{{ items.length }}</span>
    </header>

    <div class="body">
      <p v-if="loading" class="state">载入中…</p>

      <div v-else-if="items.length === 0" class="state">
        <h2>没有待确认的条目</h2>
        <p>识别完的软件会先停在这里，等你过目之后才进入卡片墙。</p>
        <button class="btn btn--ghost" @click="router.push({ name: 'home' })">返回卡片墙</button>
      </div>

      <template v-else>
        <p class="intro">
          下面是 AI 识别出来但还没入库的条目。名字、说明、分类、标签都可以直接改 ——
          改完失焦就存，不用先点保存。带
          <TagBadge label="新分类" tone="warning" /> 或
          <TagBadge label="新标签" tone="warning" /> 的是 AI 自己造的词，确认后才会进入体系。
        </p>

        <!--
          多版本提示。默认已经替用户勾好了最新那个，这条只是说明「为什么有两条同名的」，
          以及「旧的那条没被勾上不是漏了」。
        -->
        <div v-if="versionGroups.length > 0" class="warn">
          <Layers :size="15" />
          <span>
            有 {{ versionGroups.length }} 个软件存在多个版本目录，建议只保留最新版。
            已默认只勾选版本号最大的那一条，旧版留着没勾 —— 想全留就点左下角「全选」。
          </span>
        </div>

        <section v-for="g in groups" :key="g.key" class="group" :class="{ 'group--dupe': g.dupe }">
          <h2 class="group__dir mono truncate" :title="g.title">
            <Layers v-if="g.dupe" :size="13" />
            {{ g.title }}
          </h2>

          <article
            v-for="(it, idx) in g.list"
            :key="it.id"
            class="row"
            :class="{ on: selected.includes(it.id), 'row--stale': g.dupe && idx > 0 }"
          >
            <label class="row__pick">
              <input type="checkbox" :checked="selected.includes(it.id)" @change="toggle(it.id)" />
            </label>

            <AppIcon :item="it" :size="40" />

            <div class="row__main">
              <div class="row__names">
                <input
                  class="input input--name"
                  :value="it.name_zh"
                  placeholder="中文名称"
                  spellcheck="false"
                  @blur="editText(it, 'name_zh', $event)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <input
                  class="input input--en"
                  :value="it.name_en"
                  placeholder="英文原名"
                  spellcheck="false"
                  @blur="editText(it, 'name_en', $event)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
              </div>

              <div v-if="g.dupe" class="row__ver">
                <TagBadge
                  :label="idx === 0 ? `最新 ${versionLabel(it)}` : `旧版 ${versionLabel(it)}`"
                  :tone="idx === 0 ? 'success' : 'warning'"
                />
                <span class="hint">{{ it.source_dir }}</span>
              </div>

              <input
                class="input"
                :value="it.summary"
                placeholder="一句话说明"
                spellcheck="false"
                @blur="editText(it, 'summary', $event)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />

              <div class="row__meta">
                <select
                  class="select"
                  :value="it.category"
                  @change="patch(it, { category: ($event.target as HTMLSelectElement).value })"
                >
                  <option v-for="c in categoryOptions(it)" :key="c" :value="c">{{ c }}</option>
                </select>
                <TagBadge v-if="it.new_category" label="新分类" tone="warning" />

                <input
                  class="input input--tags"
                  :value="it.tags.join('、')"
                  placeholder="标签，用顿号分隔"
                  spellcheck="false"
                  @blur="editTags(it, $event)"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <TagBadge
                  v-for="t in it.new_tags"
                  :key="t"
                  :label="`新：${t}`"
                  tone="warning"
                />
              </div>

              <p class="row__path mono truncate" :title="it.exe_path">{{ it.exe_path }}</p>

              <!--
                这两个字段决定整理时敢不敢搬它的目录，判错的后果是搬完软件跑不起来 ——
                所以放在确认面板里让用户复核，而不是直接信 AI。
              -->
              <div class="row__move">
                <label class="pick" title="绿色软件可以整体移动到整理目录下">
                  <span class="pick__label">绿色软件</span>
                  <select
                    class="select select--sm"
                    :value="portableValue(it)"
                    @change="setPortable(it, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="unknown">未判断</option>
                    <option value="yes">是</option>
                    <option value="no">否</option>
                  </select>
                </label>

                <label class="pick" title="安装版挪走可能会坏，抱一会据此决定是剪切还是只做链接">
                  <span class="pick__label">移动风险</span>
                  <select
                    class="select select--sm"
                    :value="it.move_risk"
                    @change="patch(it, { move_risk: ($event.target as HTMLSelectElement).value as MoveRisk })"
                  >
                    <option value="unknown">未知（只做链接）</option>
                    <option value="safe">可安全移动</option>
                    <option value="risky">有风险（只做链接）</option>
                  </select>
                </label>

                <span class="row__plan" :class="{ 'row__plan--link': planOf(it) === 'link' }">
                  {{ planOf(it) === 'move' ? '整理时：剪切移动' : '整理时：创建链接' }}
                </span>
              </div>
            </div>

            <div class="row__ops">
              <button class="btn btn--ghost" :disabled="busy" title="收录这一条" @click="confirm([it.id])">
                <Check :size="14" />
                确认
              </button>
              <button
                class="btn btn--subtle"
                :disabled="busy"
                title="不收录，并记入忽略名单"
                @click="skip([it.id], false)"
              >
                <X :size="14" />
                不注册
              </button>
            </div>
          </article>
        </section>
      </template>
    </div>

    <footer v-if="!loading && items.length > 0" class="bar">
      <label class="bar__all">
        <input type="checkbox" :checked="allSelected" @change="toggleAll" />
        全选
      </label>
      <span class="bar__count">已选 {{ selected.length }} / {{ items.length }}</span>

      <div class="bar__ops">
        <button
          class="btn btn--subtle"
          :disabled="busy || selected.length === 0"
          @click="skip(selected, true)"
        >
          不注册已选
        </button>
        <button class="btn btn--ghost" :disabled="busy" @click="confirmAll">全部确认</button>
        <button
          class="btn btn--primary"
          :disabled="busy || selected.length === 0"
          @click="confirm(selected)"
        >
          <Loader2 v-if="busy" :size="14" class="spin" />
          确认已选（{{ selected.length }}）
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.confirm {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head h1 {
  font-size: var(--fs-title);
  font-weight: 500;
}

.head__count {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 28px;
}

.body > * {
  width: 100%;
  max-width: 940px;
  margin: 0 auto;
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 300px;
  color: var(--text-sub);
  text-align: center;
}

.state h2 {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 400;
}

.state p {
  font-size: var(--fs-body);
  color: var(--text-faint);
}

.intro {
  font-size: var(--fs-tag);
  line-height: 2;
  color: var(--text-faint);
  margin-bottom: 16px;
}

.warn {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border-radius: var(--radius-input);
  background: var(--warning-bg);
  color: var(--warning);
  font-size: var(--fs-tag);
  line-height: 1.8;
}

.warn svg {
  flex: none;
  margin-top: 3px;
}

.group {
  margin-bottom: 20px;
}

.group__dir {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-weight: 400;
  margin-bottom: 8px;
  padding-left: 2px;
}

/* 多版本组整体框起来：用户要在框里的几条之间做一次选择，边界得看得见 */
.group--dupe {
  padding: 10px 12px 2px;
  border-radius: var(--radius-card);
  border: 1px dashed color-mix(in srgb, var(--warning) 45%, transparent);
}

.group--dupe .group__dir {
  color: var(--warning);
  font-family: inherit;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  margin-bottom: 8px;
  border-radius: var(--radius-card);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
  transition: border-color var(--t-fast) ease;
}

.row.on {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

/* 旧版压淡，但不隐藏 —— 版本号可能认错，用户得能看清再决定 */
.row--stale {
  opacity: 0.72;
}
.row--stale:hover {
  opacity: 1;
}

.row__ver {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.row__ver .hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-tag);
  font-family: var(--font-mono);
  color: var(--text-faint);
}

.row__pick {
  display: flex;
  align-items: center;
  height: 40px;
  cursor: pointer;
}

.row__pick input,
.bar__all input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

.row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row__names {
  display: flex;
  gap: 8px;
}

.input--name {
  flex: 1;
  font-size: var(--fs-card-title);
}

.input--en {
  width: 200px;
  flex: none;
  color: var(--text-sub);
}

.row__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.select {
  height: 32px;
  flex: none;
  padding: 0 8px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

.input--tags {
  flex: 1;
  min-width: 180px;
}

.row__path {
  color: var(--text-faint);
}

/* 绿色软件 / 移动风险这一排：它决定整理时的动作，所以要能一眼看出结论 */
.row__move {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--divider);
}

.pick {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.pick__label {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}

.select--sm {
  height: 26px;
  font-size: var(--fs-tag);
}

.row__plan {
  margin-left: auto;
  font-size: var(--fs-tag);
  color: var(--success);
  white-space: nowrap;
}

.row__plan--link {
  color: var(--text-faint);
}

.row__ops {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row__ops .btn {
  height: 30px;
  padding: 0 10px;
  font-size: var(--fs-tag);
}

/* 条目多的时候操作栏要一直够得着，所以钉在底部 */
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 24px;
  background: var(--bg-side);
  border-top: 1px solid var(--divider);
}

.bar__all {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
  cursor: pointer;
}

.bar__count {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.bar__ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
