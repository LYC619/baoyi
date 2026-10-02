<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ArrowUpRight, Globe, Pencil, Plus, Trash2, X } from 'lucide-vue-next'
import type { WebBrowserSource } from '@/types/web-browser'
import { pendingWebAddress } from '@/composables/useVideoDiscovery'
import type { DiscoverySourceSummary } from '@/types/video-discovery'
const emit = defineEmits<{ connected: [source: DiscoverySourceSummary] }>()
const api = window.baoyi.video.discovery.web
const address = ref(''), name = ref(''), editingId = ref(''), error = ref(''), notice = ref(''), busy = ref(false)
const sources = ref<WebBrowserSource[]>([]), input = ref<HTMLInputElement | null>(null)
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await action() } catch (cause) { error.value = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause) }
  finally { busy.value = false }
}
async function open(url = address.value) { await run(async () => { address.value = await api.open(url) }) }
async function connect() { await run(async () => { emit('connected', await window.baoyi.video.discovery.online.connect(address.value)) }) }
async function save() {
  await run(async () => {
    const saved = await api.save({ ...(editingId.value ? { id: editingId.value } : {}), name: name.value, url: address.value })
    address.value = saved.url; sources.value = await api.list(); editingId.value = ''; name.value = ''; notice.value = '网页来源已保存'
  })
}
function edit(source: WebBrowserSource) {
  editingId.value = source.id; address.value = source.url; name.value = source.name; error.value = ''; notice.value = ''; input.value?.focus()
}
function cancelEdit() { editingId.value = ''; name.value = ''; notice.value = '' }
function remove(source: WebBrowserSource) {
  void run(async () => { await api.remove(source.id); sources.value = await api.list(); if (editingId.value === source.id) cancelEdit(); notice.value = '网页来源已移除' })
}
function host(url: string) { try { return new URL(url).host } catch { return url } }
async function takePending(value: string | null) {
  if (value === null) return
  address.value = value; editingId.value = ''; name.value = ''; pendingWebAddress.value = null
  await nextTick(); input.value?.focus(); input.value?.select()
}
watch(pendingWebAddress, takePending)
onMounted(() => { void run(async () => { sources.value = await api.list() }); void takePending(pendingWebAddress.value) })
</script>
<template>
  <section class="web-entry" aria-label="在线网页入口">
    <div class="web-intro"><div class="web-symbol"><Globe :size="28" :stroke-width="1.2" /></div><h2>从一个网址开始</h2><p>将支持的网页接入海报墙，在这里浏览、收藏和观看。<br />JAVDB 的列表 / 搜索 / 排行页可直接接入；喜欢的作品可下载保存，并选择登记到本地影视库。</p></div>
    <form class="web-address-form" @submit.prevent="connect()">
      <label for="web-address">网页地址</label>
      <div class="web-address-row"><input id="web-address" ref="input" v-model="address" class="input" type="text" inputmode="url" autocomplete="url" maxlength="4000" placeholder="https://javdb.com/search?q=..." :disabled="busy" /><button class="btn btn--primary" type="submit" :disabled="busy || !address.trim()">{{ busy ? '正在处理…' : '接入海报墙' }}<Globe :size="16" /></button></div>
      <p class="web-footnote">支持 JAVDB 地址（列表 / 搜索 / 排行页），以及含公开 VideoObject 资料的网页；能否内播和下载取决于来源是否提供直接视频文件。</p>
      <button class="btn btn--ghost" type="button" :disabled="busy || !address.trim()" @click="open()">打开网页<ArrowUpRight :size="16" /></button>
      <div class="web-save-row"><input v-model="name" class="input" aria-label="来源名称（可选）" placeholder="来源名称（可选）" maxlength="100" :disabled="busy" /><button class="btn btn--subtle" type="button" :disabled="busy || !address.trim()" @click="save"><Plus v-if="!editingId" :size="15" />{{ editingId ? '保存修改' : '保存为来源' }}</button><button v-if="editingId" class="btn btn--ghost" type="button" :disabled="busy" @click="cancelEdit"><X :size="14" />取消编辑</button></div>
    </form>
    <p v-if="error" class="web-error" role="alert">{{ error }}</p><p v-else-if="notice" class="web-notice" role="status">{{ notice }}</p>
    <section class="saved-websites" aria-label="已保存的网页来源"><div class="web-section-head"><h3>网页来源</h3><span>{{ sources.length }} 个</span></div>
      <div v-if="sources.length" class="web-source-grid"><article v-for="source in sources" :key="source.id" class="web-source-card">
        <button class="web-source-open" :aria-label="'打开 ' + source.name" :disabled="busy" @click="open(source.url)"><Globe :size="20" :stroke-width="1.3" /><span><strong>{{ source.name }}</strong><small>{{ host(source.url) }}</small></span><ArrowUpRight :size="15" /></button>
        <div class="web-source-tools"><button class="btn btn--ghost" :aria-label="'编辑 ' + source.name" :disabled="busy" @click="edit(source)"><Pencil :size="13" /></button><button class="btn btn--ghost" :aria-label="'移除 ' + source.name" :disabled="busy" @click="remove(source)"><Trash2 :size="13" /></button></div>
      </article></div>
      <p v-else class="web-source-empty">保存常用网址后，它们会显示在这里。</p>
    </section>
    <p class="web-footnote">未适配的网页可用“打开网页”浏览。保存网址后，也可通过编辑地址再次接入海报墙。</p>
  </section>
</template>
<style scoped>
.web-entry { max-width: 920px; padding: 18px 0 35px; }.web-intro { padding: 14px 0 28px; }.web-symbol { color: var(--accent); margin-bottom: 23px; }.web-intro h2 { font-family: var(--font-display); font-size: 34px; font-weight: 500; line-height: 1.5; }.web-intro p { color: var(--text-sub); font-size: 13px; line-height: 1.9; margin-top: 12px; }
.web-address-form { padding: 23px; background: var(--bg-card); border: 1px solid var(--divider); border-radius: 10px; }.web-address-form > label { font-size: 12px; color: var(--text-sub); display: block; margin-bottom: 10px; }.web-address-row { display: flex; gap: 12px; }.web-address-row input { flex: 1; min-width: 0; min-height: 44px; }.web-address-row button { flex-shrink: 0; }.web-save-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }.web-save-row input { min-width: 160px; width: 250px; max-width: 100%; font-size: 12px; }.web-save-row .btn { font-size: 12px; }
.web-error,.web-notice { margin-top: 14px; padding: 11px 13px; border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }.web-error { background: var(--danger-bg); color: var(--danger); }.web-notice { color: var(--text-sub); background: var(--bg-card); }
.saved-websites { margin-top: 40px; }.web-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; }.web-section-head h3 { font-size: 14px; font-weight: 500; }.web-section-head span { color: var(--text-faint); font-size: 11px; }.web-source-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }.web-source-card { border: 1px solid var(--divider); background: var(--bg-card); border-radius: 8px; display: flex; align-items: center; padding-right: 8px; min-width: 0; }.web-source-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 13px; padding: 18px 14px; background: transparent; color: var(--text-sub); border: 0; text-align: left; cursor: pointer; }.web-source-open > span { flex: 1; min-width: 0; }.web-source-open strong { display: block; font-size: 13px; color: var(--text-main); overflow-wrap: anywhere; font-weight: 500; }.web-source-open small { display: block; font-size: 11px; color: var(--text-faint); margin-top: 7px; overflow-wrap: anywhere; }.web-source-open:hover { color: var(--accent); }.web-source-tools { display: flex; gap: 1px; }.web-source-tools button { padding: 6px; }.web-source-empty { padding: 26px 18px; color: var(--text-faint); font-size: 12px; border: 1px dashed var(--divider); border-radius: 8px; }.web-footnote { font-size: 11px; color: var(--text-faint); margin-top: 24px; line-height: 1.8; }
@media(max-width: 760px) { .web-intro h2 { font-size: 28px; }.web-address-form { padding: 16px; }.web-address-row { flex-wrap: wrap; }.web-address-row input { flex-basis: 100%; }.web-save-row input { width: 100%; }.web-source-grid { grid-template-columns: 1fr; } }
</style>
