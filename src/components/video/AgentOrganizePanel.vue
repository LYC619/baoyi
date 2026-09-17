<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Bot, Loader2, X } from 'lucide-vue-next'
import { useVideoAgentOrganize } from '@/composables/useVideoAgentOrganize'
import OrganizePreview from './OrganizePreview.vue'
const session = useVideoAgentOrganize()
const { works, plan, result, actions, groupIds, busy, error, progress, analysisLog } = session
const dialog = ref<HTMLDialogElement | null>(null)
const canRun = computed(() => !!plan.value && !busy.value && !result.value && (groupIds.value.length || plan.value.actions.artwork || plan.value.actions.metadata))
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="agent-organize" aria-labelledby="agent-organize-title" @cancel.prevent="session.open.value = false">
    <header><div><h2 id="agent-organize-title"><Bot :size="20" />Agent 整理</h2><p>处理已选的 {{ works.length }} 部作品。先核对计划，再执行。</p></div><button aria-label="关闭 Agent 整理" @click="session.open.value = false"><X :size="19" /></button></header>
    <div class="agent-organize__body">
      <fieldset :disabled="!!busy || !!plan"><legend>让 Agent 做什么</legend>
        <label><input v-model="actions.merge" type="checkbox" />把同系列的单集合并成合集<span>核对片名和集数，保留每集的资料与观看进度。</span></label>
        <label><input v-model="actions.artwork" type="checkbox" />刮削缺失封面<span>优先使用已有来源；找不到来源时让 Agent 检查，已有封面保留。</span></label>
        <label><input v-model="actions.metadata" type="checkbox" />补充缺失简介、标签和来源<span>保留已填写的资料。</span></label>
        <label v-if="actions.merge" class="file-transfer">文件整理<select v-model="actions.transfer"><option value="none">保留文件位置</option><option value="move">移动到整理根目录 / 合集名</option><option value="copy">复制到整理根目录 / 合集名</option></select></label>
      </fieldset>
      <p v-if="error" class="agent-error" role="alert">{{ error }}</p>
      <p v-if="busy" class="agent-progress" role="status"><Loader2 :size="15" class="spin" />{{ progress?.current }} {{ progress?.message || (busy === 'prepare' ? '正在生成整理建议…' : '正在处理…') }}</p>
      <template v-if="plan">
        <div class="agent-plan-heading"><h3>整理预览</h3><span>{{ plan.groups.length }} 个建议合集 · {{ plan.tokens.toLocaleString() }} tokens</span></div>
        <div v-if="plan.warnings.length" class="agent-warnings" role="status">
          <strong>{{ plan.groupingStatus === 'failed' ? '分组分析未完成' : '已保留有效分组，以下建议未采纳' }}</strong>
          <ul><li v-for="(warning, index) in plan.warnings" :key="index">{{ warning }}</li></ul>
          <p>可重新生成预览。补封面、补资料仍按勾选范围执行。</p>
        </div>
        <p v-else-if="plan.actions.merge && !plan.groups.length" class="agent-note">{{ plan.groupingStatus === 'no-candidates' ? '未找到片名和集数明确的同系列单集，已有合集不参与单集合并。' : 'Agent 未建议合并这些作品，原作品会保持独立。' }}</p>
        <section v-for="group in plan.groups" :key="group.id" class="agent-group">
          <label><input v-model="groupIds" type="checkbox" :value="group.id" :disabled="!!busy || !!result || !(plan.actions.transfer === 'none' ? group.preview.canMerge : group.preview.canOrganize)" /><strong>{{ group.title }}</strong><span>{{ group.resourceIds.length }} 部作品</span></label><p>{{ group.reason }}</p>
          <ul><li v-for="work in group.preview.works" :key="work.resourceId">{{ work.name }}</li></ul>
          <details><summary>查看各集、文件去向与冲突</summary><OrganizePreview :preview="group.preview" :file-names="{}" :copy-files="plan.actions.transfer !== 'none'" :without-season="works.filter(work => group.resourceIds.includes(work.id)).every(work => work.category === '里番')" disabled /></details>
        </section>
        <p v-if="plan.actions.artwork || plan.actions.metadata" class="agent-note">确认后，为这 {{ plan.works.length }} 部所选作品{{ plan.actions.artwork ? '补封面' : '' }}{{ plan.actions.artwork && plan.actions.metadata ? '、' : '' }}{{ plan.actions.metadata ? '补资料' : '' }}。合并后的各集仍分别处理。</p>
      </template>
      <details v-if="plan?.log || analysisLog" class="agent-log"><summary>分析日志</summary><pre>{{ plan?.log || analysisLog }}</pre></details>
      <section v-if="result" class="agent-results" aria-label="Agent 整理结果"><h3>{{ result.cancelled ? '已停止，已完成的结果保留' : '处理结果' }}</h3><ul><li v-for="(outcome, index) in result.outcomes" :key="index"><strong>{{ outcome.title }}</strong><p :class="{ 'agent-error': !outcome.ok }">{{ outcome.message }}</p></li></ul></section>
    </div>
    <footer><button v-if="busy" class="btn btn--ghost" @click="session.cancel">停止后续处理</button><button v-if="plan && !busy" class="btn btn--ghost" @click="session.reset">重新选择操作</button><button v-if="plan?.warnings.length && !busy && !result" class="btn btn--ghost" @click="session.prepare">重新生成预览</button><button v-if="!plan" class="btn btn--primary" :disabled="!!busy || !works.length || !actions.merge && !actions.artwork && !actions.metadata" @click="session.prepare">生成整理预览</button><button v-else-if="!result" class="btn btn--primary" :disabled="!canRun" @click="session.run">确认执行所选操作</button><button v-else class="btn btn--primary" @click="session.open.value = false">完成</button></footer>
  </dialog></Teleport>
</template>
<style scoped>
.agent-warnings{margin:14px 0;padding:12px 14px;border:1px solid var(--divider);border-left:3px solid var(--accent);border-radius:6px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}.agent-warnings ul{padding-left:20px;margin:6px 0}.agent-warnings p{color:var(--text-sub)}
.agent-organize{width:min(840px,calc(100vw - 36px));max-height:calc(100dvh - 40px);margin:auto;padding:0;border:1px solid var(--divider);border-radius:12px;background:var(--bg-main);color:var(--text-main);box-shadow:var(--shadow-pop);display:flex;flex-direction:column}.agent-organize::backdrop{background:rgb(0 0 0 / .58)}header{display:flex;justify-content:space-between;gap:15px;padding:22px 24px 15px;border-bottom:1px solid var(--divider)}h2{display:flex;gap:9px;align-items:center;font-size:18px;font-weight:600}header p{margin-top:7px;font-size:12px;color:var(--text-sub)}header button{padding:5px;color:var(--text-sub)}.agent-organize__body{padding:20px 24px;overflow:auto;min-height:0}fieldset{border:0;padding:0;margin:0 0 20px;display:grid;gap:13px}legend{font-size:13px;margin-bottom:12px}fieldset label{display:grid;grid-template-columns:17px 1fr;gap:4px 9px;font-size:13px}fieldset input{grid-row:1 / 3;margin-top:2px;accent-color:var(--accent)}fieldset label span{font-size:12px;color:var(--text-sub);line-height:1.6}fieldset .file-transfer{display:flex;align-items:center;gap:12px}select{padding:7px;border:1px solid var(--divider);border-radius:5px;background:var(--bg-card);color:var(--text-main);font-size:12px}.agent-plan-heading{display:flex;align-items:center;justify-content:space-between;margin:20px 0 12px}h3{font-size:14px}.agent-plan-heading span,.agent-note,.agent-group p,.agent-group li{color:var(--text-sub);font-size:12px;line-height:1.7}.agent-group{padding:14px 16px;margin:12px 0;border:1px solid var(--divider);border-radius:8px;background:var(--bg-card)}.agent-group>label{display:flex;align-items:center;gap:8px;font-size:14px}.agent-group label span{margin-left:auto;font-size:12px;color:var(--text-sub)}.agent-group p{margin-top:6px}.agent-group>ul{padding-left:21px;margin:9px 0}.agent-group details,.agent-log{margin-top:13px;font-size:12px;color:var(--text-sub)}summary{cursor:pointer;min-height:26px}.agent-log pre{padding:12px;background:var(--bg-card);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:11px}.agent-error{color:var(--danger);font-size:12px;line-height:1.65}.agent-progress{display:flex;gap:8px;align-items:center;color:var(--text-sub);font-size:12px;line-height:1.7}.agent-results{margin-top:18px}.agent-results ul{list-style:none;padding:0}.agent-results li{padding:10px 0;border-bottom:1px solid var(--divider);font-size:12px;line-height:1.7}footer{display:flex;justify-content:flex-end;gap:9px;padding:15px 24px;border-top:1px solid var(--divider)}.agent-organize :is(input,button,select,summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}.spin{flex:none;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
