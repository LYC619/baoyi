<script setup lang="ts">
import { errorMessage } from '@/utils'
import { computed, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { parseProxyInput, serializeProxyInput } from '../../../electron/services/network/proxy-rules'
import type { DiscoverySourceSummary } from '@/types/video-discovery'
import { onlineProbeMessage } from '@/utils/online-probe'
import '@/styles/workspace.css'
const settings = useSettingsStore(), api = window.baoyi.video.discovery
const rule = ref(settings.settings.video_online_proxy ?? 'system://'), url = ref('https://javdb.com/'), status = ref(''), error = ref(''), busy = ref(false)
const sources = ref<DiscoverySourceSummary[]>([])
const activity = ref(''), probeProblem = ref(false)
const unsaved = computed(() => {
  try {return serializeProxyInput(parseProxyInput(rule.value)) !== serializeProxyInput(parseProxyInput(settings.settings.video_online_proxy ?? 'system://'))}
  catch { return true /* 无法解析的代理规则仍需保存校验。 */ }
})
onMounted(async () => { try { sources.value = (await api.sources()).filter(source => source.online); if (sources.value[0]) url.value = sources.value[0].homeUrl } catch (cause) { error.value = errorMessage(cause) } })
async function run(action: () => Promise<void>, label = '正在处理…') { if (busy.value) return; busy.value = true; activity.value = label; error.value = ''; status.value = ''; probeProblem.value = false; try { await action() } catch (cause) { error.value = errorMessage(cause) } finally { busy.value = false; activity.value = '' } }
async function save() { await run(async () => { const normalized = serializeProxyInput(parseProxyInput(rule.value)); await settings.patch({ video_online_proxy: normalized }); rule.value = normalized; status.value = '已保存，后续在线来源、网页和下载请求使用此配置。' }) }
async function routeStatus() {if(unsaved.value)return;await run(async()=>{const result=await api.online.networkStatus(url.value);status.value=`已保存配置的路由：${result.resolved}。此结果表示代理配置，不代表网站已连通。`},'正在读取已保存配置的路由…')}
async function probe() {if(unsaved.value)return;await run(async()=>{const result=await api.online.probe(url.value);status.value=onlineProbeMessage(result);probeProblem.value=result.outcome!=='response_received'},'正在检查网页响应，最多等待约 15 秒…')}
</script>
<template>
  <section class="ws ws-card ws-form" :aria-busy="busy">
    <h2>找视频 · 网站与代理</h2><p class="ws-muted">控制在线来源列表、详情、封面、在线播放来源与下载，以及「打开网页」窗口。Hanime 使用下方里番区的独立代理配置。</p>
    <label>代理规则<input v-model="rule" placeholder="system://" :disabled="busy" /></label>
    <div class="ws-toolbar"><button class="ws-button" :disabled="busy" @click="rule = 'system://'">系统代理</button><button class="ws-button" :disabled="busy" @click="rule = ''">直连</button><button class="ws-button" :disabled="busy" @click="rule = settings.settings.proxy">复制 Hanime 代理</button></div>
    <p class="ws-muted">system:// 跟随系统；留空直连；自定义代理可填 http://127.0.0.1:端口 或 socks5://127.0.0.1:端口。</p>
    <button class="ws-button primary" :disabled="busy" @click="save">保存代理</button>
    <p v-if="unsaved" class="ws-muted" role="status">代理规则尚未保存。请先保存，再检查网页；检查使用已保存的配置。</p>
    <label>检查已保存配置的目标网址<input v-model="url" :disabled="busy" /></label>
    <p v-if="error" class="ws-error" role="alert">{{ error }}</p><p v-if="busy || status" :class="{'ws-error':probeProblem}" role="status" aria-live="polite">{{ busy ? activity : status }}</p>
    <button class="ws-button" :disabled="busy || unsaved" @click="routeStatus">查看生效路由</button>
    <button class="ws-button" :disabled="busy || unsaved" @click="probe">检查网页响应</button>
    <h3>已接入网站</h3><p class="ws-muted">若网站要求验证，打开对应来源网页完成验证，再返回「找视频」重试详情。来源页与详情读取共享验证会话。</p>
    <div v-for="source in sources" :key="source.id" class="source-row"><div><strong>{{ source.name }}</strong><small>{{ source.homeUrl }}</small></div><button class="ws-button" :disabled="busy" @click="run(async () => { await api.open(source.id) })">打开来源网页</button></div>
    <p v-if="!sources.length" class="ws-muted">尚未接入在线来源，可从影视「找视频」添加网址。</p>
  </section>
</template>
<style scoped>h2{font-size:18px;margin:0}.source-row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0}.source-row small{display:block;overflow-wrap:anywhere;color:var(--text-faint)}</style>
