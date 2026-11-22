<script setup lang="ts">
import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
import { ref, computed, watch } from 'vue'
import { Plus, Check, X, Tag } from 'lucide-vue-next'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { workspace } from '@/utils/workspace-api'
import type { DocumentItem, DocumentPatch } from '@/types/workspace'

const props = withDefaults(
  defineProps<{
    items?: DocumentItem[]
    availableTags?: string[]
    categoryName?: string
    categoryId?: string
    embedded?: boolean
  }>(),
  {
    items: () => [],
    availableTags: () => [],
    categoryName: '',
    categoryId: '',
    embedded: false,
  }
)

const emit = defineEmits<{
  close: []
  updated: []
  busy: [value: boolean]
}>()

const isBatch = computed(() => props.items && props.items.length > 0)
const mode = ref<'add' | 'replace' | 'remove'>('add')
const selectedTags = ref<string[]>([])
const newTagInput = ref('')
const busy = ref(false)
watch(busy, value => emit('busy', value), { flush: 'sync' })
const error = ref('')
const message = ref('')

// Renaming/editing a category tag (when in category management mode)
const editingTag = ref('')
const renameInput = ref('')

function toggleTag(tag: string) {
  if (selectedTags.value.includes(tag)) {
    selectedTags.value = selectedTags.value.filter(t => t !== tag)
  } else {
    selectedTags.value.push(tag)
  }
}

function addTag() {
  const input = newTagInput.value.trim()
  if (!input) return
  const tags = input.split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean)
  for (const t of tags) {
    if (!selectedTags.value.includes(t)) {
      selectedTags.value.push(t)
    }
  }
  newTagInput.value = ''
}

function removeSelected(tag: string) {
  selectedTags.value = selectedTags.value.filter(t => t !== tag)
}

async function applyBatch() {
  if (busy.value || !props.items.length) return
  if (!selectedTags.value.length && mode.value !== 'replace') {
    error.value = '请至少选择或输入一个标签'
    return
  }
  busy.value = true
  error.value = ''
  message.value = ''
  const failures: string[] = []
  let count = 0
  const tagsToApply = [...selectedTags.value]
  const action = mode.value
  const items = props.items.map(item => ({ ...item, tags: [...item.tags] }))
  const stateTags = ['未读', '在读', '已读']
  const hasState = tagsToApply.some(t => stateTags.includes(t))

  try {
    for (const item of items) {
      const patch: DocumentPatch = {}
      if (action === 'replace') {
        patch.tags = [...tagsToApply]
      } else if (action === 'add') {
        const kept = item.tags.filter(t => !hasState || !stateTags.includes(t))
        patch.tags = [...new Set([...kept, ...tagsToApply])]
      } else if (action === 'remove') {
        patch.tags = item.tags.filter(t => !tagsToApply.includes(t))
      }

      try {
        await workspace.documents.update(item.id, patch)
        count++
      } catch (e) {
        failures.push(`${item.name}：${errorMessage(e)}`)
      }
    }
    message.value = `已更新 ${count} 份资料${failures.length ? `，${failures.length} 份失败` : ''}`
    if (count) emit('updated')
    if (failures.length) error.value = failures.join('\n')
    else emit('close')
  } finally {
    busy.value = false
  }
}

async function renameCategoryTag(oldTag: string) {
  if (busy.value) return
  const categoryId = props.categoryId
  const newName = renameInput.value.trim()
  if (!newName || newName === oldTag) {
    editingTag.value = ''
    return
  }
  busy.value = true
  error.value = ''
  try {
    const allDocs = await workspace.documents.list()
    const targetDocs = allDocs.filter(d => (!categoryId || d.type === categoryId) && d.tags.includes(oldTag))
    for (const doc of targetDocs) {
      const updated = doc.tags.map(t => (t === oldTag ? newName : t))
      await workspace.documents.update(doc.id, { tags: [...new Set(updated)] })
    }
    editingTag.value = ''
    renameInput.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    emit('updated')
    busy.value = false
  }
}

async function deleteCategoryTag(tag: string) {
  if (busy.value) return
  const categoryId = props.categoryId
  if (!(await confirmDialog({ title: `移除标签「${tag}」？`, message: `将从当前${props.categoryName ? '「' + props.categoryName + '」' : ''}所有资料记录中移除该标签，本地原文件不受影响。`, confirmText: '移除标签', tone: 'danger' }))) return
  busy.value = true
  error.value = ''
  try {
    const allDocs = await workspace.documents.list()
    const targetDocs = allDocs.filter(d => (!categoryId || d.type === categoryId) && d.tags.includes(tag))
    for (const doc of targetDocs) {
      const updated = doc.tags.filter(t => t !== tag)
      await workspace.documents.update(doc.id, { tags: updated })
    }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    emit('updated')
    busy.value = false
  }
}
</script>

<template>
  <component
    :is="embedded ? 'div' : ProjectDialog"
    :title="isBatch ? `批量设置标签 · 已选 ${items.length} 份` : `${categoryName || '分类'}标签管理`"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="document-tag-dialog ws ws-form">
      <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>

      <!-- Batch Mode Options -->
      <div v-if="isBatch" class="tag-mode-switch">
        <label class="mode-option" :class="{ active: mode === 'add' }">
          <input v-model="mode" type="radio" value="add" :disabled="busy" />
          <span>追加标签</span>
          <small>在原标签基础上添加选中标签</small>
        </label>
        <label class="mode-option" :class="{ active: mode === 'replace' }">
          <input v-model="mode" type="radio" value="replace" :disabled="busy" />
          <span>替换全部</span>
          <small>清空原标签，设置为选中标签</small>
        </label>
        <label class="mode-option" :class="{ active: mode === 'remove' }">
          <input v-model="mode" type="radio" value="remove" :disabled="busy" />
          <span>移除标签</span>
          <small>从所选资料中剔除选中标签</small>
        </label>
      </div>

      <!-- Add New Tag Input -->
      <div v-if="isBatch" class="tag-add-bar">
        <div class="input-wrap">
          <Tag :size="16" class="tag-input-icon" />
          <input
            v-model="newTagInput"
            placeholder="输入新标签（按回车或点击添加）"
            maxlength="60"
            :disabled="busy"
            @keydown.enter.prevent="addTag"
          />
        </div>
        <button class="ws-button" type="button" :disabled="busy || !newTagInput.trim()" @click="addTag">
          <Plus :size="15" /> 添加
        </button>
      </div>

      <!-- Selected Tags Preview (Batch Mode) -->
      <div v-if="isBatch && selectedTags.length > 0" class="tag-section">
        <div class="section-label">待应用的标签（已选 {{ selectedTags.length }} 个）：</div>
        <div class="tag-cloud">
          <span
            v-for="tag in selectedTags"
            :key="tag"
            class="tag-pill-bubble active"
          >
            {{ tag }}
            <button type="button" class="tag-remove-btn" :disabled="busy" @click="removeSelected(tag)">
              <X :size="13" />
            </button>
          </span>
        </div>
      </div>

      <!-- Available / Existing Tags -->
      <div class="tag-section">
        <div class="section-label">
          {{ isBatch ? '点击快速选择当前分类已有标签：' : '当前分类已有标签列表：' }}
        </div>
        <div v-if="availableTags.length === 0" class="ws-muted empty-tags-hint">
          {{ isBatch ? '暂无已有标签，可在上方输入新建。' : '暂无已有标签，可选中资料后添加。' }}
        </div>
        <div v-else class="tag-cloud">
          <template v-if="isBatch">
            <button
              v-for="tag in availableTags"
              :key="tag"
              type="button"
              class="tag-pill-bubble"
              :class="{ active: selectedTags.includes(tag) }"
              :disabled="busy"
              @click="toggleTag(tag)"
            >
              <Check v-if="selectedTags.includes(tag)" :size="13" class="tag-check-icon" />
              {{ tag }}
            </button>
          </template>
          <template v-else>
            <div
              v-for="tag in availableTags"
              :key="tag"
              class="category-tag-row"
            >
              <template v-if="editingTag === tag">
                <input
                  v-model="renameInput"
                  class="rename-input"
                  maxlength="60"
                  :disabled="busy"
                  @keydown.enter.prevent="renameCategoryTag(tag)"
                  @keydown.esc="editingTag = ''"
                />
                <button class="ws-button primary small" :disabled="busy" @click="renameCategoryTag(tag)">保存</button>
                <button class="ws-button small" :disabled="busy" @click="editingTag = ''">取消</button>
              </template>
              <template v-else>
                <span class="category-tag-label">{{ tag }}</span>
                <button
                  class="ws-button ghost small"
                  title="重命名该标签"
                  :disabled="busy"
                  @click="editingTag = tag; renameInput = tag"
                >
                  重命名
                </button>
                <button
                  class="ws-button danger ghost small"
                  title="从全部分类资料中移除该标签"
                  :disabled="busy"
                  @click="deleteCategoryTag(tag)"
                >
                  删除
                </button>
              </template>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div v-if="embedded && isBatch" class="ws tag-dialog-footer">
      <button class="ws-button" :disabled="busy" @click="emit('close')">取消选择</button>
      <button class="ws-button primary" :disabled="busy || (!selectedTags.length && mode !== 'replace')" @click="applyBatch">应用到 {{ items.length }} 份资料</button>
    </div>
    <template #footer>
      <div class="ws tag-dialog-footer">
        <button class="ws-button" type="button" :disabled="busy" @click="emit('close')">
          {{ isBatch ? '取消' : '关闭' }}
        </button>
        <button
          v-if="isBatch"
          class="ws-button primary"
          type="button"
          :disabled="busy || (!selectedTags.length && mode !== 'replace')"
          @click="applyBatch"
        >
          应用到 {{ items.length }} 份资料
        </button>
      </div>
    </template>
  </component>
</template>

<style scoped>
.document-tag-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  max-width: 580px;
}

.tag-mode-switch {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.mode-option {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-option input {
  display: none;
}

.mode-option span {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-main);
}

.mode-option small {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 3px;
}

.mode-option.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.mode-option.active span {
  color: var(--accent);
}

.tag-add-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  position: relative;
}

.tag-input-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.input-wrap input {
  width: 100%;
  padding-left: 32px;
}

.tag-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-sub);
}

.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  max-height: 180px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
}

.tag-pill-bubble {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: 9999px;
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-main);
  transition: all 0.15s ease;
  user-select: none;
}

.tag-pill-bubble:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.tag-pill-bubble.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.tag-check-icon {
  margin-right: -2px;
}

.tag-remove-btn {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 0;
  margin-left: 2px;
  opacity: 0.8;
}

.tag-remove-btn:hover {
  opacity: 1;
}

.empty-tags-hint {
  font-size: 12px;
  padding: 8px;
}

.category-tag-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.category-tag-label {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
}

.rename-input {
  flex: 1;
  padding: 3px 8px;
  font-size: 13px;
}

.small {
  padding: 3px 8px !important;
  font-size: 11px !important;
}

.tag-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  width: 100%;
}
</style>
