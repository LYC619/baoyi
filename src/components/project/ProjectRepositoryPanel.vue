<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { errorMessage } from '@/utils'
import { computed, ref, watch } from 'vue'
import type { ProjectSession } from '@/types/project'
const props = defineProps<{ session: ProjectSession; busy: boolean }>()
const emit = defineEmits<{ updated: [session: ProjectSession]; working: [value: boolean] }>()
const choice = ref(''), working = ref(false), error = ref('')
const blocked = computed(() => props.session.repository && props.session.repository.status !== 'ready')
const paused = computed(() => props.session.workflow?.state === 'paused')
const scanReasons: Record<string, string> = { get directory_limit() { return tr("目录数量达到上限") }, get depth_limit() { return tr("目录深度达到上限") }, get candidate_limit() { return tr("候选数量达到上限") }, get unreadable() { return tr("部分目录无法读取") } }
const reasons = computed(() => props.session.repository?.scan?.reasons.map(reason => scanReasons[reason] || reason).join('、'))
watch(() => JSON.stringify([props.session.id, props.session.repository?.status, props.session.repository?.candidates]), () => {
  choice.value = props.session.repository?.repoPath ?? props.session.repository?.candidates[0] ?? ''
  error.value = ''
}, { immediate: true })
async function continueReview(select: boolean) {
  if (props.busy || working.value) return
  working.value = true; emit('working', true); error.value = ''
  const id = props.session.id
  try {
    if (select) emit('updated', await window.baoyi.project.selectRepository(id, choice.value.trim()))
    if (paused.value) emit('updated', await window.baoyi.project.resumeOrganize(id))
  } catch (cause) { error.value = errorMessage(cause) }
  finally { working.value = false; emit('working', false) }
}
</script>
<template>
  <section v-if="blocked || paused" class="repository-panel" :aria-label="$t('项目整理续接')" :aria-busy="working">
    <template v-if="blocked">
      <strong>{{ $t("需要确认 Git 仓库") }}</strong>
      <p>{{ session.repository?.message }}</p>
      <p v-if="session.repository?.scan && !session.repository.scan.complete">{{ $t("已检查 {p0} 个目录；{p1}。候选列表可能不完整，可填写已知目录。", {p0: (session.repository.scan.visited), p1: (reasons)}) }}</p>
      <label>{{ $t("仓库子目录（相对于项目目录）") }}<input v-model="choice" :list="'repository-options-' + session.id" :placeholder="$t('例如 app/backend；根目录请留空')" :disabled="busy || working" />
      </label>
      <datalist :id="'repository-options-' + session.id"><option v-for="path in session.repository?.candidates" :key="path" :value="path" /></datalist>
      <button type="button" class="pj-button pj-primary" :disabled="busy || working" @click="continueReview(true)">{{ working ? $t('正在检查仓库…') : paused ? $t('使用此仓库并继续整理') : $t('使用此仓库') }}</button>
    </template>
    <template v-else>
      <p>{{ $t("整理进度已保存，可从本次会话继续。") }}</p>
      <button type="button" class="pj-button pj-primary" :disabled="busy || working" @click="continueReview(false)">{{ $t("继续整理") }}</button>
    </template>
    <p v-if="error" class="pj-error" role="alert">{{ $systemMessage(error) }}</p>
  </section>
</template>
<style scoped>
.repository-panel{padding:16px 22px;border-bottom:1px solid var(--divider);background:var(--active-surface);font-size:13px}.repository-panel p{line-height:1.7;overflow-wrap:anywhere}.repository-panel label{display:grid;gap:7px;margin-bottom:12px}.repository-panel input{width:100%;min-width:0}.repository-panel .pj-error{margin-bottom:0}
</style>
