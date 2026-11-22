<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref, watch, onBeforeUnmount } from 'vue'
import { workspace } from '@/utils/workspace-api'
import ProjectDialog from '@/components/project/ProjectDialog.vue'

const props = defineProps<{ projectId: string; inline?: boolean }>()
const choice = ref<Awaited<ReturnType<typeof workspace.files.choose>>>(null)
const preview = ref<Awaited<ReturnType<typeof workspace.files.preview>> | null>(null)
const mode = ref<'link' | 'copy' | 'move'>('link')
const target = ref<'project' | 'library'>('project')
const name = ref('')
const busy = ref(false)
const error = ref('')
const pending = ref<Awaited<ReturnType<typeof workspace.files.operations>>>([])

let revision = 0
async function refresh() {
  const run = ++revision
  try {
    const value = await workspace.files.operations(props.projectId)
    if (run === revision) pending.value = value
  } catch (e) {
    if (run === revision) error.value = errorMessage(e)
  }
}

watch(() => props.projectId, () => {
  choice.value = null
  void refresh()
}, { immediate: true })

const unsubscribe = workspace.onChanged(() => void refresh())
onBeforeUnmount(() => { revision++; unsubscribe() })
watch([mode, target, name], () => { preview.value = null })

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}

async function choose() {
  await run(async () => {
    choice.value = await workspace.files.choose(props.projectId)
    preview.value = null
    mode.value = 'link'
    target.value = 'project'
    name.value = choice.value?.source.split(/[\\/]/).pop() || ''
  })
}

async function check() {
  await run(async () => {
    if (choice.value) preview.value = await workspace.files.preview(choice.value.token, mode.value, target.value, name.value)
  })
}

async function confirm() {
  await run(async () => {
    if (preview.value) {
      await workspace.files.confirm(preview.value.token)
      choice.value = null
      preview.value = null
      await refresh()
    }
  })
}

async function directLink() {
  await run(async () => {
    if (!choice.value) return
    const planned = await workspace.files.preview(choice.value.token, 'link', target.value, name.value)
    await workspace.files.confirm(planned.token)
    choice.value = null
    preview.value = null
    await refresh()
  })
}
</script>
<template>
  <div class="project-files" :class="{ inline }">
    <button class="ws-button" :disabled="busy" @click="choose">选择电脑文件</button>
    <p v-if="error && !choice" class="ws-error" role="alert">{{ error }}</p>
    <article v-for="op in pending" :key="op.id" class="ws-card">
      <p>文件操作需要处理：{{ op.source }}</p>
      <p class="ws-muted">{{ op.error }} · {{ op.destination }}</p>
      <button class="ws-button" :disabled="busy" @click="run(async () => { await workspace.files.recover(op.id); await refresh() })">核验并恢复</button>
    </article>
    <ProjectDialog v-if="choice" title="关联电脑文件" :busy="busy" @close="choice = null">
      <div class="ws ws-form">
        <p class="file-path">{{ choice.source }}</p>
        <label>处理方式<select v-model="mode"><option value="link">仅链接原位置</option><option value="copy">复制文件</option><option value="move">移动文件</option></select></label>
        <template v-if="mode !== 'link'">
          <label>保存位置<select v-model="target"><option value="project">项目目录</option><option value="library">资料数据目录</option></select></label>
          <label>目标文件名<input v-model="name" /></label>
        </template>
        <p class="ws-muted">{{ mode === 'link' ? '文件保留在原位置，登记后直接关联到此项目。' : mode === 'copy' ? '保留原文件，新增一个共用资料信息和标注的副本。' : '校验目标文件后移除原位置文件，现有资料关联和标注随资料保留。' }}</p>
        <div v-if="preview" class="ws-card file-preview">
          <p>来源：{{ preview.source }}</p>
          <p>目标：{{ preview.destination }}</p>
          <p>{{ preview.size.toLocaleString() }} 字节</p>
        </div>
        <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      </div>
      <template #footer>
        <div class="ws ws-footer-row">
          <template v-if="!preview">
            <button v-if="mode === 'link'" class="ws-button primary" :disabled="busy" @click="directLink">直接关联原文件</button>
            <button class="ws-button" :class="{ primary: mode !== 'link' }" :disabled="busy" @click="check">预览文件操作</button>
          </template>
          <button v-else class="ws-button primary" :disabled="busy" @click="confirm">确认{{ mode === 'link' ? '链接' : mode === 'copy' ? '复制' : '移动' }}并关联</button>
        </div>
      </template>
    </ProjectDialog>
  </div>
</template>
<style scoped>
.project-files { margin: 12px 0; }
.project-files.inline { margin: 0; display: inline-flex; flex-direction: column; }
.ws-footer-row { display: flex; gap: 8px; flex-wrap: wrap; }
.file-path, .file-preview p { overflow-wrap: anywhere; }
</style>
