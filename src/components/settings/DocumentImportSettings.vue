<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref } from 'vue'
import { workspace } from '@/utils/workspace-api'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentImportSuggestion, DocumentScan } from '@/types/workspace'
const store = useDocumentsStore()
const preview = ref<(DocumentScan & { token: string; categoryId: string }) | null>(null)
const selected = ref<string[]>([]), choices = ref<Record<string, string>>({}), suggestions = ref<Record<string, DocumentImportSuggestion>>({})
const category = ref(''), busy = ref(false), error = ref(''), message = ref('')
async function run(action: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; message.value = ''; try { await action() } catch (cause) { error.value = errorMessage(cause) } finally { busy.value = false } }
async function scan(directory: boolean) { await run(async () => {
  const result = await workspace.documents.prepareImport(directory, category.value || undefined)
  if (!result) return
  preview.value = result; suggestions.value = {}
  selected.value = result.items.filter(item => !item.existing).map(item => item.path)
  choices.value = Object.fromEntries(result.items.map(item => [item.path, category.value || result.categoryId || item.suggestedCategoryId || 'reading_other']))
}) }
async function analyze() { await run(async () => {
  if (!preview.value) return
  const failures: string[] = []
  for (const [index, path] of [...selected.value].entries()) {
    message.value = `正在识别 ${index + 1} / ${selected.value.length}`
    try { const result = await workspace.documents.analyzeImport(preview.value.token, path); suggestions.value[path] = result; choices.value[path] = result.categoryId }
    catch (cause) { failures.push(path + '：' + errorMessage(cause)) }
  }
  message.value = '识别结束，请核对分类、作者和标签后导入。'; error.value = failures.join('；')
}) }
async function confirmImport() { await run(async () => {
  if (!preview.value) return
  const result = await workspace.documents.confirmImport(preview.value.token, [...selected.value], '', undefined, undefined,
    selected.value.map(path => ({ path, categoryId: choices.value[path], ...(suggestions.value[path] ? { name: suggestions.value[path].name, author: suggestions.value[path].author, tags: [...suggestions.value[path].tags] } : {}) })))
  await store.refresh(); preview.value = null; selected.value = []; message.value = `已导入 ${result.imported} 份资料`+(result.insightStatus?'；'+result.insightStatus:''); error.value = result.errors.join('；')
}) }
</script>
<template>
  <section class="ws-card ws-form">
    <h3>扫描与识别</h3><p class="ws-muted">扫描本地文件后预览导入。可单独运行 Agent 识别所选资料，识别建议在确认后写入。</p>
    <label>此次导入分类<select v-model="category" :disabled="busy"><option value="">根据文件初步识别</option><option v-for="row in store.categories" :key="row.id" :value="row.id">{{ row.submodule === 'reading' ? '阅读' : '资料' }} · {{ row.name }}</option></select></label>
    <div class="ws-toolbar"><button class="ws-button" :disabled="busy" @click="scan(false)">选择文件</button><button class="ws-button" :disabled="busy" @click="scan(true)">扫描目录</button></div>
    <template v-if="preview">
      <p>找到 {{ preview.items.length }} 份，已选 {{ selected.length }} 份</p><p v-for="warning in preview.warnings" :key="warning" class="ws-muted">{{ warning }}</p>
      <div class="scan-list"><article v-for="item in preview.items" :key="item.path">
        <label><input v-model="selected" type="checkbox" :value="item.path" :disabled="busy || item.existing" /><span>{{ item.path }}{{ item.existing ? '（已入库）' : '' }}</span></label>
        <select v-model="choices[item.path]" :disabled="busy || item.existing" aria-label="导入分类"><option v-for="row in store.categories" :key="row.id" :value="row.id">{{ row.name }}</option></select>
        <div v-if="suggestions[item.path]" class="suggestion"><label>名称<input v-model="suggestions[item.path].name" :disabled="busy" /></label><label>作者<input v-model="suggestions[item.path].author" :disabled="busy" /></label><label>标签<input :value="suggestions[item.path].tags.join('、')" :disabled="busy" @change="suggestions[item.path].tags = ($event.target as HTMLInputElement).value.split(/[、,，]/).map(tag => tag.trim()).filter(Boolean)" /></label></div>
      </article></div>
      <div class="ws-toolbar"><button class="ws-button" :disabled="busy || !selected.length" @click="analyze">Agent 识别所选</button><button class="ws-button primary" :disabled="busy || !selected.length" @click="confirmImport">确认导入所选</button><button class="ws-button" :disabled="busy" @click="preview = null">取消导入</button></div>
    </template>
    <p v-if="error" class="ws-error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
<style scoped>.scan-list{max-height:460px;overflow:auto}.scan-list article{padding:12px 0;border-bottom:1px solid var(--divider)}.scan-list article>label{display:flex;gap:8px;align-items:center;overflow-wrap:anywhere}.scan-list select{margin-top:8px}.suggestion{margin-top:8px}</style>
