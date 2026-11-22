<script setup lang="ts">
import { ref, watch } from 'vue'
import { errorMessage } from '@/utils'
import { workspace } from '@/utils/workspace-api'
import type {
  DocumentCategory,
  DocumentImportSuggestion,
  DocumentScan,
  DocumentSubmodule
} from '@/types/workspace'
import ProjectDialog from '@/components/project/ProjectDialog.vue'

const props = defineProps<{
  preview: DocumentScan & { token: string; categoryId: string }
  categories: DocumentCategory[]
  defaultCategory: string
  submodule: DocumentSubmodule
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'imported', payload: { insightStatus: string; errors: string[] }): void
}>()

const busy = ref(false)
const error = ref('')
const fallback = props.submodule === 'reading' ? 'reading_other' : 'archive_other'
const importCategoryId = ref(props.defaultCategory || props.preview.categoryId || fallback)
const selectedPaths = ref<string[]>(
  props.preview.items.filter((i) => !i.existing).map((i) => i.path)
)
const importChoices = ref<Record<string, string>>(
  Object.fromEntries(
    props.preview.items.map((i) => [
      i.path,
      props.defaultCategory || props.preview.categoryId || i.suggestedCategoryId || importCategoryId.value
    ])
  )
)

const agentImport = ref(false)
const analyzing = ref(false)
const analysisAttempted = ref(false)
const stopAnalysis = ref(false)
const analysisStatus = ref('')
const suggestions = ref<Record<string, DocumentImportSuggestion>>({})

watch(selectedPaths, () => {
  analysisAttempted.value = false
})

function applyImportCategory() {
  for (const file of selectedPaths.value) {
    importChoices.value[file] = importCategoryId.value
  }
}

async function analyzeImport() {
  if (analyzing.value) return
  analyzing.value = true
  stopAnalysis.value = false
  error.value = ''
  const token = props.preview.token
  const paths = [...selectedPaths.value]
  const failures: string[] = []
  try {
    for (const [index, path] of paths.entries()) {
      if (stopAnalysis.value) break
      analysisStatus.value = `正在识别 ${index + 1} / ${paths.length}`
      try {
        const result = await workspace.documents.analyzeImport(token, path)
        if (props.preview.token !== token) return
        suggestions.value[path] = result
        importChoices.value[path] = result.categoryId
      } catch (e) {
        failures.push(`${path.split(/[\\/]/).pop()}：${errorMessage(e)}`)
      }
    }
    analysisStatus.value = `已识别 ${Object.keys(suggestions.value).length} 份，可修改建议后导入。`
    error.value = failures.join('\n')
  } finally {
    analyzing.value = false
    analysisAttempted.value = true
  }
}

async function importFiles() {
  if (agentImport.value && !analysisAttempted.value) {
    await analyzeImport()
    return
  }
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await workspace.documents.confirmImport(
      props.preview.token,
      [...selectedPaths.value],
      '',
      undefined,
      undefined,
      selectedPaths.value.map((path) => ({
        path,
        categoryId: importChoices.value[path] || importCategoryId.value,
        ...(agentImport.value && suggestions.value[path]
          ? {
              name: suggestions.value[path].name,
              author: suggestions.value[path].author,
              tags: [...suggestions.value[path].tags]
            }
          : {})
      }))
    )
    emit('imported', { insightStatus: result.insightStatus || '', errors: result.errors })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ProjectDialog
    title="导入资料预览"
    wide
    :busy="busy || analyzing"
    @close="emit('close')"
  >
    <div class="ws">
      <p class="ws-muted">已找到 {{ preview.items.length }} 份资料，已登记的文件会自动跳过。</p>
      <p v-for="warning in preview.warnings" :key="warning" class="ws-notice">{{ warning }}</p>
      <p v-if="error" class="ws-error">{{ error }}</p>

      <p class="ws-notice">请确认每份资料的分类，也可选择当前模块的“其他”。</p>
      <div class="import-agent-options">
        <label>
          <input v-model="agentImport" type="checkbox" :disabled="busy || analyzing" />
          智能辅助识别分类、作者和标签
        </label>
        <template v-if="agentImport">
          <button
            type="button"
            class="ws-button"
            :disabled="busy || analyzing || !selectedPaths.length"
            @click="analyzeImport"
          >
            {{ Object.keys(suggestions).length ? '重新识别' : '识别所选' }}
          </button>
          <button v-if="analyzing" type="button" class="ws-button" @click="stopAnalysis = true">
            {{ stopAnalysis ? '当前文件结束后停止' : '停止后续识别' }}
          </button>
          <p class="ws-muted">使用资料模块配置的模型；识别结果可修改后登记。识别失败时仍可手动导入。</p>
          <p v-if="analysisStatus" role="status">{{ analysisStatus }}</p>
        </template>
      </div>

      <div class="import-batch">
        <select v-model="importCategoryId" aria-label="批量导入分类">
          <optgroup
            v-for="sub in ['reading', 'archive'] as const"
            :key="sub"
            :label="sub === 'reading' ? '阅读' : '资料'"
          >
            <option
              v-for="cat in categories.filter((c) => c.submodule === sub)"
              :key="cat.id"
              :value="cat.id"
            >
              {{ cat.name }}
            </option>
          </optgroup>
        </select>
        <button type="button" class="ws-button" @click="applyImportCategory">应用到所选</button>
      </div>

      <div class="document-import">
        <div v-for="candidate in preview.items" :key="candidate.path" class="import-candidate">
          <input
            v-model="selectedPaths"
            type="checkbox"
            :value="candidate.path"
            :disabled="candidate.existing || busy || analyzing"
            :aria-label="'导入 ' + candidate.name"
          />
          <span>
            <strong>{{ candidate.name }}</strong>
            <small>{{ candidate.existing ? '已登记' : '' }}</small>
            <span v-if="candidate.suggestedSubmodule" class="ws-badge suggestion-badge">
              推测：{{ candidate.suggestedSubmodule === 'archive' ? '资料' : '阅读' }}
              {{ candidate.suggestedReason ? `· ${candidate.suggestedReason}` : '' }}
            </span>
            <span class="ws-path">{{ candidate.path }}</span>
            <div v-if="agentImport && suggestions[candidate.path]" class="import-metadata">
              <label>
                标题
                <input
                  v-model="suggestions[candidate.path].name"
                  :aria-label="'识别标题 ' + candidate.name"
                  :disabled="busy || analyzing"
                />
              </label>
              <label>
                作者
                <input
                  v-model="suggestions[candidate.path].author"
                  :aria-label="'识别作者 ' + candidate.name"
                  :disabled="busy || analyzing"
                />
              </label>
              <label>
                标签
                <input
                  :value="suggestions[candidate.path].tags.join('，')"
                  :aria-label="'识别标签 ' + candidate.name"
                  :disabled="busy || analyzing"
                  @change="
                    suggestions[candidate.path].tags = ($event.target as HTMLInputElement).value
                      .split(/[,，;；]/)
                      .map((t) => t.trim())
                      .filter(Boolean)
                  "
                />
              </label>
              <small>{{ suggestions[candidate.path].reason }}</small>
            </div>
          </span>
          <select
            v-model="importChoices[candidate.path]"
            :aria-label="'归类 ' + candidate.name"
            :disabled="candidate.existing || busy"
          >
            <optgroup
              v-for="sub in ['reading', 'archive'] as const"
              :key="sub"
              :label="sub === 'reading' ? '阅读' : '资料'"
            >
              <option
                v-for="cat in categories.filter((c) => c.submodule === sub)"
                :key="cat.id"
                :value="cat.id"
              >
                {{ cat.name }}
              </option>
            </optgroup>
          </select>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="ws">
        <button
          type="button"
          class="ws-button primary"
          :disabled="busy || analyzing || !selectedPaths.length"
          @click="importFiles"
        >
          {{ agentImport && !analysisAttempted ? '识别并预览所选' : '导入所选' }} {{ selectedPaths.length }} 份资料
        </button>
      </div>
    </template>
  </ProjectDialog>
</template>

<style scoped>
.import-agent-options {
  padding: 12px 0;
}
.import-agent-options > label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.import-metadata {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin: 8px 0;
}
.import-metadata label {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 4px;
}
.import-metadata label:first-child,
.import-metadata small {
  grid-column: 1 / -1;
}
.import-batch {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.document-import {
  max-height: 50vh;
  overflow: auto;
  margin-top: 12px;
}
.document-import .import-candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--divider);
}
.import-candidate > span {
  flex: 1;
  min-width: 0;
}
.import-candidate select {
  max-width: 200px;
}
.document-import .ws-path {
  display: block;
}
.document-import input {
  flex: none;
}
.document-import small {
  color: var(--accent);
}
.suggestion-badge {
  display: inline-block;
  margin-left: 6px;
  font-size: 11px;
  background: var(--hover-surface);
  color: var(--accent);
}
@media (max-width: 860px) {
  .import-candidate {
    flex-wrap: wrap;
  }
}
</style>
