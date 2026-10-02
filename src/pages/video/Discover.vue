<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Globe, Plus, Search, Heart, Play, Download, RefreshCw, Film, FolderOpen, Trash2, Upload } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { pendingDiscoveryDownload, pendingWebAddress } from '@/composables/useVideoDiscovery'
import type { DiscoveryCard, DiscoveryMark, DiscoverySourceSummary } from '@/types/video-discovery'
import DiscoveryPoster from '@/components/video/DiscoveryPoster.vue'
import DiscoveryDetail from '@/components/video/DiscoveryDetail.vue'
import DiscoveryPlayer from '@/components/video/DiscoveryPlayer.vue'
import DownloadPanel from '@/components/video/DownloadPanel.vue'
import WebSourceEntry from '@/components/video/WebSourceEntry.vue'
const router = useRouter(), settings = useSettingsStore(), api = window.baoyi.video.discovery
const sources = ref<DiscoverySourceSummary[]>([]), sourceId = ref(''), cards = ref<DiscoveryCard[]>([])
const query = ref(''), tag = ref(''), board = ref(''), status = ref('all'), sort = ref('source'), limit = ref(60)
const error = ref(''), busy = ref(false), importing = ref(false), marking = ref(false), removing = ref(false)
const selected = ref<DiscoveryCard | null>(null), download = pendingDiscoveryDownload
const playing = ref<DiscoveryCard | null>(null), onlineBusy = ref(false), detailBusy = ref(false)
const source = computed(() => sources.value.find(value => value.id === sourceId.value))
const tags = computed(() => [...new Set(cards.value.flatMap(card => card.entry.tags))].sort())
const boards = computed(() => [...new Set(cards.value.flatMap(card => card.entry.rankings.map(rank => rank.name + (rank.period ? ' · ' + rank.period : ''))))].sort())
const searchKey = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[\s_—–-]+/g, '')
const filtered = computed(() => {
  const needle = searchKey(query.value)
  const results = cards.value.filter(card => (!needle || searchKey([card.entry.title, card.entry.code, ...card.entry.tags].join(' ')).includes(needle))
    && (!tag.value || card.entry.tags.includes(tag.value))
    && (!board.value || card.entry.rankings.some(rank => rank.name + (rank.period ? ' · ' + rank.period : '') === board.value))
    && (status.value === 'all' || status.value === 'favorite' && card.mark.favorite || status.value === 'watched' && card.mark.watched || status.value === 'local' && card.resourceId || status.value === 'downloadable' && card.entry.downloads.length))
  if (sort.value === 'year') results.sort((a, b) => b.entry.year - a.entry.year)
  if (sort.value === 'title') results.sort((a, b) => a.entry.title.localeCompare(b.entry.title, 'zh'))
  if (sort.value === 'rating') results.sort((a, b) => (b.entry.rating ? b.entry.rating.value / b.entry.rating.scale : -1) - (a.entry.rating ? a.entry.rating.value / a.entry.rating.scale : -1))
  return results
})
let round = 0, libraryUnsubscribe: (() => void) | undefined
let detailRound = 0
let markQueue = Promise.resolve()
async function loadSources(prefer = sourceId.value) {
  sources.value = await api.sources()
  sourceId.value = sources.value.some(item => item.id === prefer) ? prefer : ''
}
async function loadEntries() {
  const version = ++round; selected.value = null; playing.value = null; detailBusy.value = false; removing.value = false; cards.value = []; error.value = ''
  query.value = ''; tag.value = ''; board.value = ''; status.value = 'all'; limit.value = 60
  if (!source.value) { busy.value = false; return }
  busy.value = true
  try { const values = await api.entries(sourceId.value); if (round === version) cards.value = values }
  catch (cause) { if (round === version) error.value = String(cause instanceof Error ? cause.message : cause) }
  finally { if (round === version) busy.value = false }
}
watch(sourceId, loadEntries)
watch(download, value => { if (value) { playing.value = null; selected.value = null } })
watch(pendingWebAddress, value => { if (value !== null) { sourceId.value = ''; selected.value = null; download.value = null } })
watch([query, tag, board, status, sort], () => { limit.value = 60 })
async function importSource() {
  importing.value = true; error.value = ''
  try { const result = await api.importSource(); if (result) { await loadSources(result.id); await loadEntries() } }
  catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause) }
  finally { importing.value = false }
}
async function action(run: () => Promise<unknown>) {
  error.value = ''
  try { await run() } catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause) }
}
function mark(card: DiscoveryCard, patch: Partial<DiscoveryMark>) {
  const id = sourceId.value
  marking.value = true
  markQueue = markQueue.then(async () => {
    try { const result = await api.mark({ sourceId: id, entryId: card.entry.id }, patch); card.mark = result }
    catch (cause) { error.value = String(cause instanceof Error ? cause.message : cause) }
  }).finally(() => { marking.value = false })
}
async function connected(result: DiscoverySourceSummary) { await action(async () => { await loadSources(result.id) }) }
async function updateOnline(mode: 'refresh' | 'next') {
  if (onlineBusy.value) return
  const id = sourceId.value; onlineBusy.value = true; error.value = ''
  try {
    await api.online[mode](id)
    const summaries = await api.sources(), values = await api.entries(id)
    sources.value = summaries
    if (sourceId.value === id) cards.value = values
  } catch (cause) { if (sourceId.value === id) error.value = String(cause instanceof Error ? cause.message : cause) }
  finally { onlineBusy.value = false }
}
async function enrich(card: DiscoveryCard) {
  if (!source.value?.online) return
  const id = sourceId.value, version = round, request = ++detailRound
  detailBusy.value = true; error.value = ''
  try {
    const updated = await api.online.detail({ sourceId: id, entryId: card.entry.id })
    if (version === round) { card.entry = updated.entry; card.resourceId = updated.resourceId }
  } catch (cause) { if (version === round && request === detailRound) error.value = String(cause instanceof Error ? cause.message : cause) }
  finally { if (version === round && request === detailRound) detailBusy.value = false }
}
function showDetail(card: DiscoveryCard) { playing.value = null; selected.value = card; void enrich(card) }
async function save(card: DiscoveryCard) {
  const id = sourceId.value
  if (source.value?.online && !card.entry.downloads.length) {
    selected.value = card; await enrich(card)
    if (selected.value !== card || sourceId.value !== id) return
  }
  // JAVDB 资料站没有下载文件，但可以在线解析片源后下载入库。
  const canOnline = source.value?.online?.adapter === 'javdb' && !!card.entry.code
  if (!card.entry.downloads.length && !canOnline) return
  selected.value = null; playing.value = null; download.value = { sourceId: id, entryId: card.entry.id }
}
function open(card?: DiscoveryCard, mode: 'page' | 'play' = 'page') {
  if (mode === 'play' && card) {
    if (card.entry.mediaUrl) { selected.value = null; playing.value = card; void enrich(card); return }
    // 资料站（如 JAVDB）只给番号，没有可内播文件：按番号去在线播放站搜索页。
    if (card.entry.code && source.value?.online) { void action(() => api.playExternal({ sourceId: sourceId.value, entryId: card.entry.id })); return }
  }
  void action(() => api.open(sourceId.value, card?.entry.id, mode))
}
function openLegacy() { void action(() => window.baoyi.hanimeBrowser.open()) }
async function remove() { await action(async () => { await api.removeSource(sourceId.value); await loadSources(); await loadEntries() }) }
async function refreshLocal() {
  const id = sourceId.value
  if (!source.value) return
  try {
    const values = await api.entries(id)
    if (sourceId.value !== id) return
    for (const card of cards.value) card.resourceId = values.find(value => value.entry.id === card.entry.id)?.resourceId || ''
  } catch { /* A removed source is handled by the next explicit refresh. */ }
}
onMounted(async () => {
  await action(() => loadSources(download.value?.sourceId))
  libraryUnsubscribe = window.baoyi.video.onLibraryChanged(() => { void refreshLocal() })
})
onBeforeUnmount(() => { round++; libraryUnsubscribe?.() })
</script>
<template>
  <div class="discovery-page">
    <aside class="discovery-sidebar">
      <button class="btn btn--ghost back" @click="router.push({ name: 'video-home' })"><ArrowLeft :size="16" />本地影视库</button>
      <button :class="['source-row', { active: sourceId === '' }]" :aria-pressed="sourceId === ''" @click="sourceId = ''"><Globe :size="16" /><span>在线浏览</span><small>网址</small></button>
      <template v-for="group in [{ title: '在线来源', online: true }, { title: '导入目录', online: false }]" :key="group.title">
        <div class="source-heading" style="margin-top: 20px"><span>{{ group.title }}</span></div>
        <nav :aria-label="group.title"><button v-for="item in sources.filter(value => !!value.online === group.online)" :key="item.id" :class="['source-row', { active: sourceId === item.id }]" :aria-pressed="sourceId === item.id" @click="sourceId = item.id"><Globe :size="16" /><span>{{ item.name }}</span><small>{{ item.count }}</small></button></nav>
      </template>
      <button v-if="!settings.settings.hide_hentai" :class="['source-row', { active: sourceId === 'legacy-hanime' }]" :aria-pressed="sourceId === 'legacy-hanime'" @click="sourceId = 'legacy-hanime'"><Globe :size="16" /><span>Hanime</span><small>站内浏览</small></button>
      <div class="source-sidebar-bottom"><p>支持的网页可接入海报墙。<br />已有作品清单可在下方导入。</p><button class="btn btn--subtle" :disabled="importing" @click="importSource"><Plus :size="15" />{{ importing ? '正在导入…' : '导入来源目录' }}</button></div>
    </aside>
    <main class="discovery-main">
      <header class="discovery-head"><div><p class="eyebrow">发现 · 选择 · 保存</p><h1>{{ source?.name || (sourceId === 'legacy-hanime' ? 'Hanime' : '找视频') }}</h1><p class="head-description">{{ source ? source.count + ' 部作品 · 目录保存在本地' : '从一个来源开始浏览，留下值得再看的作品。' }}</p></div>
        <div v-if="source" class="header-actions"><button class="btn btn--ghost" :disabled="busy || onlineBusy" @click="source.online ? updateOnline('refresh') : loadEntries()"><RefreshCw :size="15" />{{ source.online ? '刷新来源' : '刷新视图' }}</button><button class="btn btn--subtle" :disabled="!source.homeUrl" @click="open()"><Globe :size="15" />来源主页</button><button class="icon-action" title="导出来源目录" aria-label="导出来源目录" @click="action(() => api.exportSource(sourceId))"><Upload :size="17" /></button><button class="icon-action" title="移除来源" aria-label="移除来源" :disabled="onlineBusy" @click="removing = !removing"><Trash2 :size="17" /></button></div>
      </header>
      <p v-if="error" class="discovery-error" role="alert">{{ error }}</p>
      <div v-if="removing" class="remove-confirm"><p>移除“{{ source?.name }}”及其个人标记？已下载的文件和本地作品会保留。</p><button class="btn btn--subtle" @click="removing = false">取消</button><button class="btn btn--danger" @click="remove">确认移除来源</button></div>
      <template v-if="source">
        <div class="discovery-filters"><label class="discovery-search"><Search :size="17" /><input v-model="query" aria-label="搜索作品" placeholder="搜索标题、编号或标签" /></label>
          <select v-model="tag" class="select" aria-label="按标签筛选"><option value="">全部标签</option><option v-for="value in tags" :key="value">{{ value }}</option></select>
          <select v-model="board" class="select" aria-label="按榜单筛选"><option value="">全部榜单</option><option v-for="value in boards" :key="value">{{ value }}</option></select>
          <select v-model="sort" class="select" aria-label="作品排序"><option value="source">来源顺序</option><option value="year">发行年份</option><option value="rating">来源评分</option><option value="title">作品名称</option></select>
        </div>
        <div class="wall-toolbar"><div class="status-tabs" role="group" aria-label="作品范围"><button v-for="item in [['all', '全部'], ['favorite', '收藏'], ['watched', '看过'], ['local', '本地已有'], ['downloadable', '可下载']]" :key="item[0]" :class="{ active: status === item[0] }" :aria-pressed="status === item[0]" @click="status = item[0]">{{ item[1] }}</button></div><span>{{ filtered.length }} 部作品</span></div>
        <div v-if="busy" class="discovery-empty" role="status">正在读取来源目录…</div>
        <div v-else-if="!filtered.length" class="discovery-empty"><Film :size="38" :stroke-width="1" /><h2>{{ cards.length ? '没有符合条件的作品' : '这个来源还没有作品' }}</h2><p>{{ cards.length ? '试试其他关键词或筛选条件。' : '重新导入更新后的来源目录即可。' }}</p></div>
        <div v-else class="discovery-wall">
          <article v-for="card in filtered.slice(0, limit)" :key="sourceId + ':' + card.entry.id" class="discovery-card">
            <button class="poster-button" :aria-label="'查看 ' + card.entry.title" @click="showDetail(card)"><DiscoveryPoster :source-id="sourceId" :entry-id="card.entry.id" :title="card.entry.title" :cover-url="card.entry.coverUrl"><span v-if="card.entry.rankings.length" class="ranking-badge" :title="card.entry.rankings[0].name + ' · ' + card.entry.rankings[0].source">#{{ card.entry.rankings[0].position }} {{ card.entry.rankings[0].name }}</span><span v-if="card.resourceId" class="local-badge"><FolderOpen :size="11" />本地</span></DiscoveryPoster></button>
            <div class="card-title"><button @click="showDetail(card)">{{ card.entry.title }}</button><button class="favorite-button" :aria-label="(card.mark.favorite ? '取消收藏 ' : '收藏 ') + card.entry.title" :aria-pressed="card.mark.favorite" :disabled="marking" @click="mark(card, { favorite: !card.mark.favorite })"><Heart :size="16" :fill="card.mark.favorite ? 'currentColor' : 'none'" /></button></div>
            <p class="card-subtitle"><span>{{ card.entry.code || card.entry.year || '作品' }}</span><span v-if="card.entry.rating">{{ Number(card.entry.rating.value.toFixed(1)) }} / {{ card.entry.rating.scale }}</span><span v-else-if="card.mark.watched">已看过</span></p>
            <div class="card-actions"><button :disabled="!card.entry.mediaUrl && !card.entry.playUrl && !card.entry.pageUrl && !(card.entry.code && source.online)" @click="open(card, 'play')"><Play :size="12" />观看</button><button :disabled="!source.online && !card.entry.downloads.length" :title="card.entry.downloads.length ? '选择画质和保存位置' : source.online ? '读取详情中的可下载文件' : '来源未提供下载文件'" @click="save(card)"><Download :size="12" />下载保存</button></div>
          </article>
        </div>
        <button v-if="filtered.length > limit" class="btn btn--subtle load-more" @click="limit += 60">继续浏览 · 还有 {{ filtered.length - limit }} 部</button>
        <button v-if="source.online?.nextPageUrl" class="btn btn--subtle load-more" :disabled="onlineBusy" @click="updateOnline('next')">读取下一页</button>
        <p v-if="onlineBusy" class="head-description" role="status">正在读取网页，已有资料会保留…</p>
      </template>
      <div v-else-if="sourceId === 'legacy-hanime'" class="discovery-empty legacy-source"><Globe :size="42" :stroke-width="1" /><h2>在站点中浏览</h2><p>沿用现有浏览窗口。选好后，使用窗口菜单“下载当前视频”保存。</p><button class="btn btn--primary" @click="openLegacy">打开 Hanime</button></div>
      <WebSourceEntry v-else @connected="connected" />
    </main>
    <DiscoveryDetail v-if="selected && source && !download && !playing" :key="sourceId + selected.entry.id" :source-id="sourceId" :source-name="source.name" :card="selected" :busy="marking" :loading="detailBusy" :error="error" @close="selected = null" @mark="mark(selected!, $event)" @play="open(selected!, 'play')" @page="open(selected!)" @download="save(selected!)" @local="router.push({ name: 'video-detail', params: { id: selected!.resourceId } })" />
    <DiscoveryPlayer v-if="playing && !download" :key="sourceId + playing.entry.id" :card="playing" :busy="detailBusy" :error="error" @close="playing = null" @download="save(playing!)" @page="open(playing!, 'page')" />
    <DownloadPanel v-if="download" :key="JSON.stringify(download)" :discovery="download" @close="download = null" />
  </div>
</template>
<style scoped>
.discovery-page { display: flex; height: 100%; min-height: 0; overflow: hidden; color: var(--text-main); }
.discovery-sidebar { width: 212px; flex-shrink: 0; padding: 20px 12px; border-right: 1px solid var(--divider); background: var(--bg-side); display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }.back { align-self: flex-start; margin-bottom: 26px; }
.source-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 10px; font-size: 11px; color: var(--text-faint); letter-spacing: 2px; }.icon-action { padding: 6px; display: inline-flex; background: transparent; border: 0; color: var(--text-sub); border-radius: 5px; cursor: pointer; }.icon-action:hover { background: var(--hover-surface); color: var(--text-main); }
.source-row { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px; border: 0; background: transparent; color: var(--text-sub); cursor: pointer; border-radius: 7px; text-align: left; }.source-row span { flex: 1; overflow-wrap: anywhere; }.source-row small { font-size: 10px; color: var(--text-faint); }.source-row.active { background: var(--active-surface); color: var(--text-main); }.source-sidebar-bottom { margin-top: auto; padding: 30px 8px 4px; }.source-sidebar-bottom p { font-size: 11px; color: var(--text-faint); line-height: 1.9; margin-bottom: 13px; }
.discovery-main { flex: 1; min-width: 0; overflow-y: auto; padding: 30px 32px 60px; }.discovery-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 26px; }.eyebrow { font-size: 10px; letter-spacing: 3px; color: var(--text-faint); margin-bottom: 8px; } h1 { font-family: var(--font-display); font-size: 31px; font-weight: 500; }.head-description { color: var(--text-sub); font-size: 12px; margin-top: 10px; }.header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.discovery-filters { display: flex; gap: 10px; flex-wrap: wrap; }.discovery-search { display: flex; align-items: center; flex: 1; min-width: 200px; gap: 10px; height: 38px; padding: 0 12px; background: var(--bg-card); border: 1px solid var(--divider); border-radius: 7px; color: var(--text-sub); }.discovery-search input { flex: 1; min-width: 0; background: transparent; color: var(--text-main); border: 0; outline: 0; }.discovery-search:focus-within { border-color: var(--accent); }.discovery-filters .select { max-width: 210px; padding: 8px 10px; background: var(--bg-card); color: var(--text-main); border: 1px solid var(--divider); border-radius: 7px; }
.wall-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 15px; margin: 22px 0; color: var(--text-faint); font-size: 11px; }.status-tabs { display: flex; gap: 18px; flex-wrap: wrap; }.status-tabs button { background: transparent; border: 0; color: var(--text-sub); padding: 7px 0; border-bottom: 2px solid transparent; cursor: pointer; font-size: 12px; }.status-tabs button.active { color: var(--text-main); border-bottom-color: var(--accent); }
.discovery-wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 27px 20px; }.discovery-card { min-width: 0; }.poster-button { display: block; padding: 0; width: 100%; border: 0; background: transparent; cursor: pointer; text-align: left; border-radius: 8px; transition: transform 150ms; }.poster-button:hover { transform: translateY(-3px); }.ranking-badge { position: absolute; top: 9px; left: 8px; right: 8px; width: fit-content; max-width: calc(100% - 16px); padding: 5px 7px; background: #171721e8; color: #ead7a3; border: 1px solid #bfa36655; font-size: 10px; border-radius: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }.local-badge { position: absolute; left: 8px; bottom: 8px; background: #162b24e8; color: #bbebd2; padding: 4px 6px; font-size: 10px; display: flex; align-items: center; gap: 5px; border-radius: 4px; }
.card-title { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; }.card-title > button:first-child { flex: 1; text-align: left; font-size: 13px; line-height: 1.6; color: var(--text-main); border: 0; padding: 0; background: transparent; cursor: pointer; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }.favorite-button { padding: 3px 0 3px 5px; border: 0; background: transparent; color: var(--text-faint); cursor: pointer; }.favorite-button[aria-pressed=true] { color: var(--accent); }
.card-subtitle { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--text-faint); margin-top: 5px; min-height: 17px; }.card-subtitle span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }.card-actions { display: flex; gap: 14px; margin-top: 7px; }.card-actions button { display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--text-sub); background: transparent; border: 0; padding: 5px 0; cursor: pointer; }.card-actions button:hover:not(:disabled) { color: var(--accent); }button:disabled { opacity: .45; cursor: default; }
.discovery-empty { min-height: 300px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 18px; text-align: center; color: var(--text-sub); padding: 35px; }.discovery-empty h2 { font-family: var(--font-display); font-size: 24px; font-weight: 400; color: var(--text-main); }.discovery-empty p { font-size: 12px; line-height: 2; max-width: 440px; }.welcome { min-height: 55vh; }.load-more { display: block; margin: 32px auto 0; }.discovery-error { padding: 12px 15px; margin-bottom: 18px; background: var(--danger-bg); color: var(--danger); border-radius: 7px; font-size: 12px; overflow-wrap: anywhere; }.remove-confirm { padding: 15px; margin-bottom: 16px; background: var(--bg-card); border: 1px solid var(--divider); border-radius: 8px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }.remove-confirm p { flex: 1; min-width: 200px; font-size: 12px; }
@media(max-width: 1000px) { .discovery-main { padding: 24px 20px; }.discovery-sidebar { width: 180px; }.discovery-head { align-items: flex-start; flex-direction: column; }.discovery-wall { gap: 22px 14px; } }
@media(max-width: 700px) { .discovery-sidebar { width: 145px; padding: 16px 7px; }.source-row { gap: 6px; }.source-row small { display: none; }.discovery-wall { grid-template-columns: repeat(auto-fill, minmax(125px, 1fr)); }.discovery-main { padding: 20px 15px; }.status-tabs { gap: 12px; } }
</style>
