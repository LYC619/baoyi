<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref, computed, watch } from 'vue'
import { Tag, Trash2, Check } from 'lucide-vue-next'
import { workspace } from '@/utils/workspace-api'
import type {
  DocumentItem,
  DocumentCategory,
  DocumentCustomGroup,
  DocumentBatchRemoval,
  DocumentPatch,
} from '@/types/workspace'
import DocumentGroupSelect from './DocumentGroupSelect.vue'
import DocumentTagDialog from './DocumentTagDialog.vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import {useDocumentInsights} from '@/composables/useDocumentInsights'
const insightQueue=useDocumentInsights()

const props = withDefaults(
  defineProps<{
    items: DocumentItem[]
    categories: DocumentCategory[]
    groups: DocumentCustomGroup[]
    availableTags?: string[]
  }>(),
  {
    availableTags: () => [],
  }
)

const emit = defineEmits<{
  updated: []
  removed: []
  failure: [message: string]
}>()

const category = ref('')
const group = ref('')
const setGroup = ref(false)
const showTagDialog = ref(false)
const busy = ref(false)
const error = ref('')
const message = ref('')
const deleting = ref(false)
const withFiles = ref(false)
const preview = ref<DocumentBatchRemoval | null>(null)

const submodule = computed(
  () =>
    props.categories.find(c => c.id === category.value)?.submodule ||
    props.items[0]?.submodule ||
    'reading'
)
const activeCategoryId = computed(() => category.value || props.items[0]?.type || '')
const categoryName = computed(() => props.categories.find(c => c.id === activeCategoryId.value)?.name || '')
const mixed = computed(() => !category.value && props.items.some(i => i.submodule !== submodule.value))

const computedAvailableTags = computed(() => {
  if (props.availableTags && props.availableTags.length > 0) return props.availableTags
  return [...new Set(props.items.flatMap(i => i.tags))]
})

watch(
  [() => props.items.map(i => i.id).join(','), withFiles],
  () => (preview.value = null)
)
watch(submodule, () => (group.value = ''))
watch(mixed, value => {
  if (value) setGroup.value = false
})

async function run(fn: () => Promise<void>) {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function apply() {
  await run(async () => {
    const failures: string[] = []
    let count = 0
    for (const item of props.items) {
      const patch: DocumentPatch = {}
      if (category.value && category.value !== item.type) patch.type = category.value
      if (setGroup.value && group.value !== item.customGroupId) patch.customGroupId = group.value
      if (!Object.keys(patch).length) continue
      try {
        await workspace.documents.update(item.id, patch)
        count++
      } catch (e) {
        failures.push(`${item.name}：${errorMessage(e)}`)
      }
    }
    emit('updated')
    message.value = `已更新 ${count} 份资料`
    if (failures.length) error.value = failures.join('\n')
  })
}

async function check() {
  await run(async () => {
    preview.value = await workspace.recycle.previewBatch(
      props.items.map(i => i.id),
      withFiles.value
    )
  })
}

async function remove() {
  await run(async () => {
    if (!preview.value) return
    const result = await workspace.recycle.confirmBatch(preview.value.token)
    preview.value = null
    if (result.errors.length) {
      error.value = result.errors.join('\n')
      emit('failure', error.value)
      emit('updated')
    } else {
      deleting.value = false
      emit('removed')
    }
  })
}
</script>

<template>
  <section class="document-bulk-toolbar" aria-label="批量管理资料">
    <div class="bulk-inner">
      <div class="bulk-info">
        <span class="count-badge">已选 <strong>{{ items.length }}</strong> 份</span>
      </div>

      <div class="bulk-actions">
        <button class="ws-button bulk-btn" :disabled="busy||items.length>20" @click="insightQueue.open(items.map(item=>item.id))">精读所选（最多 20 份）</button>
        <!-- Category Selector -->
        <div class="bulk-control">
          <span class="control-label">分类</span>
          <select v-model="category" aria-label="批量设置分类" :disabled="busy">
            <option value="">保持原分类</option>
            <optgroup
              v-for="sub in (['reading', 'archive'] as const)"
              :key="sub"
              :label="sub === 'reading' ? '阅读' : '资料'"
            >
              <option
                v-for="cat in categories.filter(c => c.submodule === sub)"
                :key="cat.id"
                :value="cat.id"
              >
                {{ cat.name }}
              </option>
            </optgroup>
          </select>
        </div>

        <!-- Custom Group Selector -->
        <div class="bulk-control">
          <label class="group-toggle">
            <input v-model="setGroup" type="checkbox" :disabled="busy || mixed" />
            <span>设置分组</span>
          </label>
          <DocumentGroupSelect
            v-if="setGroup && !mixed"
            v-model="group"
            :submodule="submodule"
            :category-id="activeCategoryId"
            :groups="groups"
            :disabled="busy"
            @created="emit('updated')"
          />
          <small v-if="mixed" class="ws-muted">跨模块需先选分类</small>
        </div>

        <!-- Tag Management Sub-interface Button -->
        <button
          type="button"
          class="ws-button bulk-btn"
          :disabled="busy"
          @click="showTagDialog = true"
        >
          <Tag :size="14" /> 批量设置标签…
        </button>

        <div class="action-divider"></div>

        <!-- Apply Button -->
        <button
          type="button"
          class="ws-button primary bulk-btn"
          :disabled="busy || (!category && !setGroup)"
          @click="apply"
        >
          <Check :size="14" /> 应用修改
        </button>

        <!-- Delete Selected Button -->
        <button
          type="button"
          class="ws-button danger bulk-btn"
          :disabled="busy"
          @click="deleting = true; error = ''"
        >
          <Trash2 :size="14" /> 删除所选
        </button>
      </div>
    </div>

    <p v-if="message" class="bulk-status" role="status">{{ message }}</p>
    <p v-if="error && !deleting" class="ws-error bulk-status" role="alert">{{ error }}</p>

    <!-- Tag Management Dialog -->
    <DocumentTagDialog
      v-if="showTagDialog"
      :items="items"
      :available-tags="computedAvailableTags"
      :category-id="activeCategoryId"
      :category-name="categoryName"
      @close="showTagDialog = false"
      @updated="emit('updated')"
    />

    <!-- Batch Removal Dialog -->
    <ProjectDialog
      v-if="deleting"
      title="批量删除资料"
      :busy="busy"
      @close="deleting = false; preview = null"
    >
      <div class="ws ws-form">
        <p>已选择 {{ items.length }} 份资料。默认仅从抱一文库中移除索引，原文件、书签、摘录和项目引用快照安全保留。</p>
        <label class="check">
          <input v-model="withFiles" type="checkbox" :disabled="busy" />
          同时删除源文件（移入资料回收站）
        </label>
        <template v-if="withFiles">
          <p class="ws-muted">
            将每份资料已登记且可用的源文件移到资料目录下的“回收站”，一个自然月后清理，也可自行恢复或清空。
          </p>
          <button
            class="ws-button"
            type="button"
            :disabled="busy"
            @click="run(async () => { await workspace.preferences.chooseDataDirectory(); preview = null })"
          >
            选择资料数据目录
          </button>
        </template>
        <div v-if="preview" class="batch-preview">
          <div v-for="item in preview.items" :key="item.id">
            <strong>{{ item.name }}</strong>
            <p v-if="!item.files.length" class="ws-muted">仅移除索引</p>
            <p v-for="file in item.files" :key="file.source" class="ws-path">
              {{ file.source }} → {{ file.stored }}
            </p>
          </div>
        </div>
        <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      </div>
      <template #footer>
        <div class="ws">
          <button v-if="!preview" class="ws-button" type="button" :disabled="busy" @click="check">
            预览删除范围
          </button>
          <button
            v-else
            class="ws-button danger"
            type="button"
            :disabled="busy"
            @click="remove"
          >
            {{ withFiles ? '确认移入回收站' : '确认仅移除索引' }}
          </button>
        </div>
      </template>
    </ProjectDialog>
  </section>
</template>

<style scoped>
.document-bulk-toolbar {
  margin: 10px 0;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.bulk-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.bulk-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.count-badge {
  font-size: 13px;
  color: var(--text-main);
}

.count-badge strong {
  color: var(--accent);
}

.bulk-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.bulk-control {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.control-label {
  font-size: 12px;
  color: var(--text-sub);
}

.bulk-control select {
  min-width: 110px;
  padding: 4px 8px;
  font-size: 12px;
}

.group-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-sub);
}

.bulk-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 5px 10px;
}

.action-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
}

.bulk-status {
  margin-top: 8px;
  font-size: 12px;
}

.batch-preview {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  background: var(--bg-side);
}

.batch-preview > div {
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}

.batch-preview > div:last-child {
  border-bottom: none;
}
</style>
