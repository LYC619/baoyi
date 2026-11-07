<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { HardDrive, RefreshCw } from 'lucide-vue-next'
import { formatBytes } from '@/utils'
import type { StorageUsage } from '@/types/storage'

const props = defineProps<{ refreshKey: number }>()
const usage = ref<StorageUsage | null>(null), loading = ref(false), clearing = ref(false), error = ref(''), notice = ref('')
let revision = 0
async function refresh() {
  if (clearing.value) return
  const token = ++revision; loading.value = true; error.value = ''
  try { const value = await window.baoyi.data.storageUsage(); if (token === revision) usage.value = value }
  catch (cause) { if (token === revision) error.value = (cause as Error).message }
  finally { if (token === revision) loading.value = false }
}
async function clear() {
  const token = ++revision; clearing.value = true; error.value = ''; notice.value = ''
  try {
    const result = await window.baoyi.data.clearBrowserCache()
    if (token === revision) {
      usage.value = result.usage; error.value = result.warnings.join('；')
      notice.value = `已清理 ${formatBytes(result.reclaimedBytes)} 浏览缓存，登录状态和资料文件保留`
    }
  } catch (cause) { if (token === revision) error.value = (cause as Error).message }
  finally { if (token === revision) clearing.value = false }
}
watch(() => props.refreshKey, refresh)
onMounted(refresh)
onUnmounted(() => { revision++ })
</script>
<template>
  <section class="storage-usage panel" aria-label="数据占用">
    <header><h2 class="sec-head"><HardDrive :size="19" />数据占用</h2><button class="btn btn--subtle" aria-label="刷新数据占用" :disabled="loading || clearing" @click="refresh"><RefreshCw :size="15" /></button></header>
    <p class="sec-desc">这里统计整个应用数据目录。你的软件、视频、图片和文档原文件仍保存在各自的资源目录中。</p>
    <template v-if="usage">
      <p class="storage-total"><strong>{{ formatBytes(usage.totalBytes) }}</strong><span>应用数据合计 · {{ usage.files.toLocaleString() }} 个文件</span></p>
      <dl class="storage-items"><template v-for="item in usage.items" :key="item.category"><dt>{{ item.label }}</dt><dd>{{ formatBytes(item.bytes) }}</dd></template></dl>
      <p v-for="warning in usage.warnings" :key="warning" class="storage-error">{{ warning }}</p>
    </template><p v-else-if="loading" role="status">正在统计目录占用…</p>
    <div class="row"><button class="btn btn--ghost" :disabled="loading || clearing" @click="clear">{{ clearing ? '正在清理浏览缓存…' : '清理浏览缓存' }}</button></div>
    <p class="hint hint--block">清理网页和脚本缓存，保留登录状态、站点数据、下载、海报和快照。下次打开网页时会重新获取所需内容；单个浏览会话的网页磁盘缓存预算为 64 MiB。</p>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" class="storage-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.storage-usage header{display:flex;align-items:center;gap:12px}.storage-usage h2{display:flex;align-items:center;gap:9px;margin-right:auto}.storage-total{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:18px 0}.storage-total strong{font-size:24px;font-variant-numeric:tabular-nums}.storage-total span{font-size:12px;color:var(--text-sub)}.storage-items{display:grid;grid-template-columns:minmax(150px,1fr) auto;gap:10px 24px;max-width:540px;margin:18px 0 24px;font-size:13px}.storage-items dt{color:var(--text-sub)}.storage-items dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}.storage-error{color:var(--danger);overflow-wrap:anywhere}
</style>
