<script setup lang="ts">
/**
 * 最近的搜索调用记录。从识别日志的 web_search 事件里现取，不新建表 ——
 * 每一次搜索本来就完整记在那里了，再存一份就有两个会不一致的真相。
 * 代价是时间只精确到「所属那次识别」这一级。原先长在设置页「搜索服务」里，
 * 实测第四轮挪进顶部「日志」面板，和识别日志放一起。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import type { SearchCallRecord } from '@/types'
import { errorMessage, searchCalls } from '@/utils'

const props = withDefaults(defineProps<{ limit?: number; resourceKind?: string }>(), { limit: 20 })
let revision = 0
const calls = ref<SearchCallRecord[]>([])
const loading = ref(false)
const loadError = ref('')

const STATUS_META: Record<SearchCallRecord['status'], { label: string; tone: 'success' | 'warning' | 'muted' }> = {
  ok: { label: '成功', tone: 'success' },
  empty: { label: '无结果', tone: 'muted' },
  timeout: { label: '超时', tone: 'warning' },
  failed: { label: '失败', tone: 'warning' }
}

function callTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load(): Promise<void> {
  const request = ++revision
  loading.value = true
  loadError.value = ''
  calls.value = []
  try {
    const logs = await window.baoyi.logs.list({ limit: 100, resource_kind: props.resourceKind })
    if (request === revision) calls.value = searchCalls(logs, props.limit)
  }
  catch (cause) { if (request === revision) { calls.value = []; loadError.value = errorMessage(cause) } }
  finally { if (request === revision) loading.value = false }
}
onMounted(load)
watch(() => [props.limit, props.resourceKind], load)
onBeforeUnmount(() => { revision++ })
defineExpose({ reload: load })
</script>

<template>
  <section class="search-calls" aria-label="搜索调用记录">
    <div class="search-calls__head">
      <h3>最近搜索调用</h3>
      <button type="button" class="btn btn--subtle" :disabled="loading" @click="load">刷新</button>
    </div>
    <p class="search-calls__desc">
      最近 {{ limit }} 次 <span class="mono">web_search</span> 调用，从识别日志里提取 ——
      时间精确到「哪一次识别」，同一次识别里的几次搜索共用一个时间戳。清空识别日志会连带清掉它。
    </p>
    <p v-if="loadError" class="search-calls__empty" role="alert">读取失败：{{ loadError }}</p>
    <ul v-else-if="calls.length" class="calls">
      <li v-for="(c, i) in calls" :key="i">
        <span class="calls__time mono">{{ callTime(c.at) }}</span>
        <span class="calls__q truncate" :title="c.query">{{ c.query }}</span>
        <span class="calls__from truncate" :title="c.label">{{ c.label }}</span>
        <span class="calls__ms mono">{{ c.ms > 0 ? `${(c.ms / 1000).toFixed(1)}s` : '—' }}</span>
        <TagBadge :label="STATUS_META[c.status].label" :tone="STATUS_META[c.status].tone" />
      </li>
    </ul>
    <p v-else class="search-calls__empty">{{ loading ? '读取中…' : '还没有搜索调用记录。开启搜索并跑一次识别之后，认不出来的条目会触发它。' }}</p>
  </section>
</template>

<style scoped>
.search-calls { display: grid; gap: 8px; }
.search-calls__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.search-calls__head h3 { font-size: var(--fs-body); font-weight: 500; }
.search-calls__desc, .search-calls__empty { font-size: var(--fs-tag); line-height: 1.7; color: var(--text-faint); }
.calls { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.calls li { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: var(--radius-tag); background: var(--bg-main); border: 1px solid var(--divider); font-size: var(--fs-tag); }
.calls__time { flex: none; font-size: 11px; color: var(--text-faint); }
.calls__q { flex: 1; min-width: 0; color: var(--text-main); }
.calls__from { flex: none; max-width: 26%; color: var(--text-faint); font-size: 11px; }
.calls__ms { flex: none; width: 44px; text-align: right; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
</style>
