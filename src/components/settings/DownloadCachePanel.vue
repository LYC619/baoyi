<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { errorMessage, formatBytes } from '@/utils'
import type { VideoDownloadCache } from '@/types/video-workflow'
const settings = useSettingsStore()
const rows = ref<VideoDownloadCache[]>([]), busy = ref(false), message = ref('')
const frameCache=ref<{bytes:number;items:number;limit:number}|null>(null)
let revision = 0
async function refresh() {
  const current = ++revision; busy.value = true
  try { const [result,cache] = await Promise.all([window.baoyi.video.downloadCaches(),window.baoyi.video.preview.frameCache()]); if (current === revision){rows.value=result;frameCache.value=cache} }
  catch (error) { if (current === revision) message.value = errorMessage(error) }
  finally { if (current === revision) busy.value = false }
}
async function clear(row: VideoDownloadCache) {
  busy.value = true; message.value = ''; const current = revision
  try {
    const result = await window.baoyi.video.clearDownloadCache(row.jobId)
    if (current === revision && result.cleared) message.value = `已清理 ${formatBytes(result.bytes)} 下载缓存`
  } catch (error) { if (current === revision) message.value = errorMessage(error) }
  finally { if (current === revision) await refresh() }
}
async function reveal(row: VideoDownloadCache) {
  try { if (!await window.baoyi.video.revealDownloadJob(row.jobId)) message.value = '保存目录不可访问' }
  catch (error) { message.value = errorMessage(error) }
}
async function clearFrames(){busy.value=true;message.value='';try{await window.baoyi.video.preview.clearFrames();message.value='视频预览缓存已清理，原视频与观看记录保留'}catch(error){message.value=errorMessage(error)}finally{await refresh()}}
watch(() => settings.settings.hide_hentai, () => { rows.value = []; message.value = ''; void refresh() }, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { revision++ })
</script>
<template>
  <section class="panel download-cache-panel">
    <div class="cache-heading"><h2>下载缓存</h2><button class="btn btn--subtle" :disabled="busy" @click="refresh">{{ busy ? '正在检查…' : '刷新缓存清单' }}</button></div>
    <p>中断后保留分片供重试校验，下载成功后自动清理。需要释放空间时，可清理已停止任务的缓存，完整视频与资料库条目会保留。</p>
    <p>清单按现有下载记录查找，不会扫描整个磁盘。移除下载记录前，请先检查是否有待清理缓存。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <article v-if="frameCache" class="cache-row"><div><strong>视频代表帧</strong><span>{{frameCache.items}} 项 · {{formatBytes(frameCache.bytes)}} / {{formatBytes(frameCache.limit)}}</span></div><p>悬停后按需生成，达到上限清理最久未使用的预览。关闭试看后可清理全部，下次浏览时重新生成。</p><button class="btn btn--subtle" :disabled="busy||!frameCache.items" @click="clearFrames">清理视频预览缓存</button></article>
    <p v-if="!rows.length && !busy">当前下载记录没有残留缓存。</p>
    <article v-for="row in rows" :key="row.jobId" class="cache-row">
      <div><strong>{{ row.title }}</strong><span>{{ formatBytes(row.bytes) }}<template v-if="row.directories.length"> · {{ row.directories.length }} 个缓存目录</template></span></div>
      <p class="cache-path">{{ row.directory }}</p>
      <p v-if="row.reason">{{ row.reason }}</p>
      <div class="cache-actions"><button class="btn btn--subtle" :disabled="busy" @click="reveal(row)">打开保存目录</button><button class="btn btn--subtle" :disabled="busy || !row.canClear" @click="clear(row)">清理缓存…</button></div>
    </article>
  </section>
</template>
<style scoped>
.download-cache-panel{padding:22px;margin-top:20px}.cache-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.download-cache-panel h2{font-size:16px}.download-cache-panel p,.cache-row span{color:var(--text-sub);font-size:13px;line-height:1.7}.cache-row{border-top:1px solid var(--border);padding:16px 0}.cache-row>div{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.cache-row strong{font-size:14px}.cache-path{overflow-wrap:anywhere}.cache-actions{margin-top:8px}
</style>
