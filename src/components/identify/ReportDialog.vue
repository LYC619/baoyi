<script setup lang="ts">
/**
 * 一轮识别的汇总报告。
 *
 * 逐条日志回答「这个目录为什么这样判断」，这一页回答「这一轮整体怎么样」——
 * 跑了多少、哪些没成、花了多少 token、搜索额度用掉几次。内容全部由已有的
 * 识别结果汇总而来，不额外消耗任何 token。
 */
import { computed } from 'vue'
import { AlertTriangle, CheckCircle2, Globe, MinusCircle, X } from 'lucide-vue-next'
import type { IdentifyLogStatus, IdentifyReport } from '@/types'
import { formatDate } from '@/utils'

const props = defineProps<{ report: IdentifyReport }>()
defineEmits<{ (e: 'close'): void }>()

const STATUS_META: Record<IdentifyLogStatus, { label: string; icon: any; tone: string }> = {
  success: { label: '成功', icon: CheckCircle2, tone: 'ok' },
  skipped: { label: '跳过', icon: MinusCircle, tone: 'warn' },
  failed: { label: '失败', icon: AlertTriangle, tone: 'bad' }
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${formatDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const seconds = computed(() => (props.report.duration_ms / 1000).toFixed(1))

/** 没成的那些单独列一遍。翻完整表找失败项，条目一多就找不着了 */
const troubles = computed(() =>
  props.report.entries.filter((e) => e.status !== 'success')
)
</script>

<template>
  <div class="mask" @click.self="$emit('close')">
    <section class="dialog">
      <header class="dialog__head">
        <h2>识别汇总报告</h2>
        <span class="dialog__time mono">{{ stamp(report.created_at) }}</span>
        <button class="btn btn--subtle" title="关闭" @click="$emit('close')">
          <X :size="16" />
        </button>
      </header>

      <div class="dialog__body">
        <ul class="tally">
          <li><b>{{ report.processed }}</b><span>处理目录</span></li>
          <li class="tally--ok"><b>{{ report.registered }}</b><span>识别出条目</span></li>
          <li class="tally--warn"><b>{{ report.skipped }}</b><span>跳过</span></li>
          <li class="tally--bad"><b>{{ report.failed }}</b><span>失败</span></li>
          <li><b>{{ seconds }}s</b><span>总耗时</span></li>
          <li><b>{{ report.tokens.toLocaleString() }}</b><span>Tokens</span></li>
        </ul>

        <p class="line">
          <Globe :size="14" />
          <template v-if="report.searches > 0">
            本轮共联网搜索 <b>{{ report.searches }}</b> 次。搜索按次计费的服务商可据此对账 ——
            逐次记录在「设置 → 搜索服务 → 最近调用日志」。
          </template>
          <template v-else>
            本轮没有用到联网搜索，全靠本地文件信息和模型自身知识判断。
          </template>
        </p>

        <template v-if="troubles.length > 0">
          <h3 class="sub">没识别出来的 {{ troubles.length }} 个</h3>
          <ul class="reasons">
            <li v-for="(e, i) in troubles" :key="`t${i}`" :class="`reasons--${STATUS_META[e.status].tone}`">
              <component :is="STATUS_META[e.status].icon" :size="13" />
              <span class="reasons__name truncate" :title="e.dir">{{ e.label }}</span>
              <span class="reasons__why">{{ e.note || STATUS_META[e.status].label }}</span>
            </li>
          </ul>
        </template>

        <h3 class="sub">逐条摘要</h3>
        <ul class="rows">
          <li v-for="(e, i) in report.entries" :key="i" :class="`rows--${STATUS_META[e.status].tone}`">
            <component :is="STATUS_META[e.status].icon" :size="13" class="rows__icon" />
            <span class="rows__name truncate" :title="e.dir">{{ e.label }}</span>
            <span class="rows__cost mono">{{ e.rounds }} 轮</span>
            <span class="rows__cost mono">{{ e.tokens.toLocaleString() }} tk</span>
            <span class="rows__cost mono" :class="{ 'rows__cost--on': e.searches > 0 }">
              {{ e.searches > 0 ? `搜索 ${e.searches}` : '—' }}
            </span>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 32px;
  background: rgb(0 0 0 / 45%);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  max-height: 100%;
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  border: 1px solid var(--divider);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}

.dialog__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--divider);
}

.dialog__head h2 {
  font-size: 15px;
  font-weight: 500;
}

.dialog__time {
  font-size: 11px;
  color: var(--text-faint);
  margin-right: auto;
}

.dialog__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.tally {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
  gap: 8px;
  margin: 0 0 14px;
  padding: 0;
}

.tally li {
  padding: 10px;
  border-radius: var(--radius-input);
  background: var(--bg-main);
  border: 1px solid var(--divider);
  text-align: center;
}

.tally b {
  display: block;
  font-size: 17px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.tally span {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-faint);
}

.tally--ok b {
  color: var(--success);
}
.tally--warn b {
  color: var(--warning);
}
.tally--bad b {
  color: var(--danger);
}

.line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--fs-tag);
  line-height: 1.8;
  color: var(--text-sub);
}

.line svg {
  flex: none;
  margin-top: 4px;
  color: var(--text-faint);
}

.sub {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
  margin: 16px 0 8px;
}

.reasons,
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.reasons li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-tag);
  background: var(--bg-main);
  font-size: var(--fs-tag);
  line-height: 1.7;
}

.reasons svg {
  flex: none;
  align-self: center;
}

.reasons--warn svg {
  color: var(--warning);
}
.reasons--bad svg {
  color: var(--danger);
}

.reasons__name {
  flex: none;
  max-width: 36%;
  color: var(--text-main);
}

.reasons__why {
  flex: 1;
  min-width: 0;
  color: var(--text-faint);
  word-break: break-word;
}

.rows li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: var(--radius-tag);
  border-left: 2px solid var(--text-faint);
  background: var(--bg-main);
  font-size: var(--fs-tag);
}

.rows--ok {
  border-left-color: var(--success);
}
.rows--warn {
  border-left-color: var(--warning);
}
.rows--bad {
  border-left-color: var(--danger);
}

.rows__icon {
  flex: none;
  color: var(--text-faint);
}
.rows--ok .rows__icon {
  color: var(--success);
}
.rows--warn .rows__icon {
  color: var(--warning);
}
.rows--bad .rows__icon {
  color: var(--danger);
}

.rows__name {
  flex: 1;
  min-width: 0;
  color: var(--text-main);
}

.rows__cost {
  flex: none;
  width: 72px;
  text-align: right;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.rows__cost--on {
  color: var(--accent);
}
</style>
