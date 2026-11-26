<script setup lang="ts">
import type {DocumentItem} from '@/types/workspace'
import {useDocumentInsights} from '@/composables/useDocumentInsights'
defineProps<{item:DocumentItem;expanded?:boolean;disabled?:boolean}>()
const queue=useDocumentInsights()
const emit=defineEmits<{open:[]}>()
</script>
<template>
  <div class="insight-summary" @click.stop>
    <button v-if="item.insight" class="insight-excerpt" :disabled="disabled" @click="emit('open')"><span>{{item.insight.coreValue}}</span><small>{{ $t("{p0} · 3 条精要", {p0: (item.insight.userEdited?$t('人工修订'):$t('已生成'))}) }}</small></button>
    <ol v-if="expanded&&item.insight"><li v-for="(text,index) in item.insight.conclusions" :key="index">{{text||$t('证据不足')}}</li></ol>
    <button v-if="!item.insight" class="insight-start" :disabled="disabled||queue.busy.value" @click="queue.open([item.id])">{{queue.active.value.some(run=>run.documentId===item.id)?$t('提炼中…'):$t('精读归档')}}</button>
  </div>
</template>
<style scoped>
.insight-summary{margin-top:10px;min-width:0}.insight-excerpt{background:transparent;border:0;text-align:left;padding:0;cursor:pointer;width:100%;color:var(--text-main)}.insight-excerpt span{font-size:12px;line-height:1.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.insight-excerpt small{display:block;margin-top:4px;color:var(--text-muted);font-size:11px}.insight-start{background:transparent;border:0;padding:3px 0;color:var(--accent);font-size:12px;cursor:pointer}ol{margin:9px 0 0;padding-left:20px;font-size:12px;line-height:1.8;color:var(--text-sub)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
