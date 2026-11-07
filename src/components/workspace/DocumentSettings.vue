<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import {
  Plus,
  Pencil,
  ArrowUp,
  ArrowDown,
  FolderPlus,
  Folder,
  FolderSync,
  RefreshCw,
  CheckCircle,
  History,
  Undo2
} from 'lucide-vue-next'
import ModulePreferences from './ModulePreferences.vue'
import DocumentInsightSettings from './DocumentInsightSettings.vue'
import DocumentImportSettings from '@/components/settings/DocumentImportSettings.vue'
import DocumentTagDialog from './DocumentTagDialog.vue'
import RecycleBin from './RecycleBin.vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { useDocumentsStore } from '@/stores/documents'
import { workspace, plain } from '@/utils/workspace-api'
import type {
  DocumentCategory,
  DocumentCustomGroup,
  DocumentSubmodule,
  DocumentOrganizePreview,
  DocumentOrganizeResult
} from '@/types/workspace'
import '@/styles/workspace.css'

const store = useDocumentsStore()
const props = withDefaults(defineProps<{ section?: string }>(), { section: 'scan' })
const tab = computed(() => props.section)
const tagCategory = ref('')
const tagsBusy = ref(false)
const tagSelection = ref<string[]>([])
const categoryItems = computed(() => store.items.filter(item => item.type === tagCategory.value))
watch(tagCategory, () => { tagSelection.value = [] })
const categoryTags = computed(() => [...new Set(store.items.filter(item => item.type === tagCategory.value).flatMap(item => item.tags))].sort())
watch(() => store.categories, rows => { if (!rows.some(row => row.id === tagCategory.value)) tagCategory.value = rows[0]?.id || '' }, { immediate: true })
const currentSubmodule = ref<DocumentSubmodule>('reading')
const busy = ref(false)
const error = ref('')

// Category form
const categoryForm = ref<(Omit<DocumentCategory, 'id'> & { id?: string }) | null>(null)
const removingCategory = ref<DocumentCategory | null>(null)
const transferTarget = ref('')

// Custom group form
const groupForm = ref<{ id?: string; submodule: DocumentSubmodule; categoryId?: string; name: string; sortOrder?: number } | null>(null)
const removingGroup = ref<DocumentCustomGroup | null>(null)

onMounted(() => void store.refresh())

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    await store.refresh()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

const behaviorLabels: Record<string, string> = {
  reading: '阅读资料',
  certificate: '证书 / 凭证',
  contract: '合同 / 协议',
  other: '普通档案',
}

const filteredCategories = computed(() =>
  store.categories.filter(c => c.submodule === currentSubmodule.value)
)

const filteredCustomGroups = computed(() =>
  store.customGroups.filter(g => g.submodule === currentSubmodule.value)
)

function editCategory(category?: DocumentCategory) {
  categoryForm.value = category
    ? { ...category }
    : {
        submodule: currentSubmodule.value,
        name: '',
        description: '',
        behavior: currentSubmodule.value === 'reading' ? 'reading' : 'other',
        order: filteredCategories.value.length,
      }
}

async function saveCategory() {
  if (!categoryForm.value) return
  await run(async () => {
    await workspace.documents.saveCategory(plain(categoryForm.value!))
    categoryForm.value = null
  })
}

async function moveCategory(category: DocumentCategory, delta: number) {
  const list = filteredCategories.value
  const index = list.findIndex(c => c.id === category.id)
  const other = list[index + delta]
  if (!other) return
  await run(async () => {
    await workspace.documents.saveCategory({ ...plain(other), order: category.order })
    await workspace.documents.saveCategory({ ...plain(category), order: other.order })
  })
}

function promptRemoveCategory(category: DocumentCategory) {
  removingCategory.value = category
  const fallback = filteredCategories.value.find(c => c.id !== category.id)
  transferTarget.value = fallback ? fallback.id : (currentSubmodule.value === 'archive' ? 'archive_other' : 'reading_other')
}

async function confirmRemoveCategory() {
  if (!removingCategory.value) return
  await run(async () => {
    await workspace.documents.removeCategory(removingCategory.value!.id, transferTarget.value)
    removingCategory.value = null
  })
}

function editGroup(group?: DocumentCustomGroup) {
  groupForm.value = group
    ? { id: group.id, submodule: group.submodule, categoryId: group.categoryId, name: group.name, sortOrder: group.sortOrder }
    : { submodule: currentSubmodule.value, categoryId: filteredCategories.value[0]?.id || (currentSubmodule.value === 'archive' ? 'archive_other' : 'novel'), name: '', sortOrder: filteredCustomGroups.value.length }
}

async function saveGroup() {
  if (!groupForm.value) return
  await run(async () => {
    await store.saveCustomGroup(plain(groupForm.value!))
    groupForm.value = null
  })
}

async function moveGroup(group: DocumentCustomGroup, delta: number) {
  const list = filteredCustomGroups.value
  const index = list.findIndex(g => g.id === group.id)
  const other = list[index + delta]
  if (!other) return
  await run(async () => {
    await store.saveCustomGroup({ ...group, sortOrder: other.sortOrder })
    await store.saveCustomGroup({ ...other, sortOrder: group.sortOrder })
  })
}

function promptRemoveGroup(group: DocumentCustomGroup) {
  removingGroup.value = group
}

async function confirmRemoveGroup() {
  if (!removingGroup.value) return
  await run(async () => {
    await store.removeCustomGroup(removingGroup.value!.id)
    removingGroup.value = null
  })
}

// Organize state & methods
const organizeRoot = ref('')
const organizeMode = ref<'move' | 'copy'>('move')
const organizeUseGroups = ref(true)
const organizeSubmodule = ref<'all' | 'reading' | 'archive'>('all')
const organizePreview = ref<DocumentOrganizePreview | null>(null)
const organizeResult = ref<DocumentOrganizeResult | null>(null)
const previewSignature = ref('')
const organizeSignature = computed(() => JSON.stringify([organizeRoot.value, organizeMode.value, organizeSubmodule.value, organizeUseGroups.value]))
const organizeLoading = ref(false)
const showHistory = ref(false)
const historyList = ref<any[]>([])

async function pickOrganizeRoot() {
  const picked = await workspace.documents.pickDirectory()
  if (picked) {
    organizeRoot.value = picked
    if (organizePreview.value) {
      await generatePreview()
    }
  }
}

async function generatePreview() {
  if (!organizeRoot.value) return
  organizeLoading.value = true
  error.value = ''
  try {
    const signature = organizeSignature.value
    const result = await workspace.documents.previewOrganize({
      rootDir: organizeRoot.value,
      mode: organizeMode.value,
      submodule: organizeSubmodule.value === 'all' ? undefined : organizeSubmodule.value,
      useCustomGroups: organizeUseGroups.value
    })
    if (signature === organizeSignature.value) { organizePreview.value = result; previewSignature.value = signature }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    organizeLoading.value = false
  }
}

async function executeOrganize() {
  if (!organizePreview.value || previewSignature.value !== organizeSignature.value) { error.value = '整理选项已变化，请重新生成预览'; return }
  organizeLoading.value = true
  error.value = ''
  try {
    const res = await workspace.documents.executeOrganize({
      rootDir: organizeRoot.value,
      mode: organizeMode.value,
      submodule: organizeSubmodule.value === 'all' ? undefined : organizeSubmodule.value,
      useCustomGroups: organizeUseGroups.value
    })
    organizeResult.value = res
    await store.refresh()
    await generatePreview()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    organizeLoading.value = false
  }
}

async function loadHistory() {
  historyList.value = await workspace.documents.organizeHistory()
  showHistory.value = true
}

async function undoOrganize(id: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await workspace.documents.undoOrganize(id)
    if (res.undone) {
      await store.refresh()
      historyList.value = await workspace.documents.organizeHistory()
      if (organizePreview.value) await generatePreview()
    } else {
      error.value = res.reason || '撤销未成功'
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    try { historyList.value = await workspace.documents.organizeHistory() }
    catch (e) { error.value ||= (e as Error).message }
    finally { busy.value = false }
  }
}

async function recoverOrganize(id: string) {
  if (busy.value) return
  await run(async () => {
    try { await workspace.files.recover(id) }
    finally { historyList.value = await workspace.documents.organizeHistory() }
    if (organizePreview.value) await generatePreview()
  })
}
</script>

<template>
  <section class="ws document-settings">
    <p v-if="error || store.error" class="ws-error" role="alert">{{ error || store.error }}</p>

    <!-- Tab 1: General & Assistant -->
    <div v-if="tab === 'scan' || tab === 'reader'" class="settings-subpage">
      <DocumentImportSettings v-if="tab === 'scan'" />
      <ModulePreferences :key="tab" module="document" :section="tab" />
      <DocumentInsightSettings />
    </div>

    <!-- Tab 2: Categories & Custom Groups -->
    <div v-else-if="tab === 'categories' || tab === 'groups'" class="settings-subpage">
      <!-- Submodule Toggle -->
      <div class="submodule-switcher" role="tablist" aria-label="子模块切换">
        <button
          type="button"
          :class="{ active: currentSubmodule === 'reading' }"
          @click="currentSubmodule = 'reading'"
        >
          📖 阅读（书架类）
        </button>
        <button
          type="button"
          :class="{ active: currentSubmodule === 'archive' }"
          @click="currentSubmodule = 'archive'"
        >
          🗂️ 资料（档案类）
        </button>
      </div>

      <!-- Categories Section -->
      <section v-if="tab === 'categories'" class="settings-card">
        <header class="card-header">
          <div>
            <h3>{{ currentSubmodule === 'reading' ? '阅读分类' : '资料分类' }}</h3>
            <p class="ws-muted">
              {{ currentSubmodule === 'reading'
                ? '小说、书籍与论文等读物分类。决定阅读进度、摘录与章节索引呈现。'
                : '证书、简历、合同等档案分类。决定有效期、相关方与用途凭据呈现。'
              }}
            </p>
          </div>
          <button class="ws-button" :disabled="busy" @click="editCategory()">
            <Plus :size="15" />新增分类
          </button>
        </header>

        <article
          v-for="(category, index) in filteredCategories"
          :key="category.id"
          class="item-row"
        >
          <div class="row-order">
            <button
              class="ws-icon"
              :disabled="busy || index === 0"
              :aria-label="'上移 ' + category.name"
              @click="moveCategory(category, -1)"
            >
              <ArrowUp :size="13" />
            </button>
            <button
              class="ws-icon"
              :disabled="busy || index === filteredCategories.length - 1"
              :aria-label="'下移 ' + category.name"
              @click="moveCategory(category, 1)"
            >
              <ArrowDown :size="13" />
            </button>
          </div>
          <div class="row-info">
            <div class="row-title">
              <strong>{{ category.name }}</strong>
              <span class="ws-badge">{{ behaviorLabels[category.behavior] || category.behavior }}</span>
              <small class="ws-muted">{{ store.items.filter(d => d.type === category.id).length }} 份</small>
            </div>
            <p class="ws-muted">{{ category.description || '尚未填写分类说明' }}</p>
          </div>
          <div class="row-actions">
            <button class="ws-icon" :aria-label="'编辑 ' + category.name" :disabled="busy" @click="editCategory(category)">
              <Pencil :size="15" />
            </button>
            <button
              v-if="category.id !== 'archive_other' && category.id !== 'reading_other' && category.id !== 'other'"
              class="ws-button"
              :aria-label="'删除 ' + category.name"
              :disabled="busy"
              @click="promptRemoveCategory(category)"
            >
              删除
            </button>
          </div>
        </article>
      </section>

      <!-- Custom Groups Section -->
      <section v-if="tab === 'groups'" class="settings-card">
        <header class="card-header">
          <div>
            <h3>{{ currentSubmodule === 'reading' ? '阅读自定义分组' : '资料自定义分组' }}</h3>
            <p class="ws-muted">独立于分类的主题分组（如“科幻小说”、“前端进阶”或“工作档案”），方便侧边栏快速筛选。</p>
          </div>
          <button class="ws-button" :disabled="busy" @click="editGroup()">
            <FolderPlus :size="15" />新增分组
          </button>
        </header>

        <div v-if="!filteredCustomGroups.length" class="empty-hint ws-muted">
          暂无自定义分组，点击上方按钮创建。
        </div>

        <article
          v-for="(group, index) in filteredCustomGroups"
          :key="group.id"
          class="item-row"
        >
          <div class="row-order">
            <button
              class="ws-icon"
              :disabled="busy || index === 0"
              :aria-label="'上移 ' + group.name"
              @click="moveGroup(group, -1)"
            >
              <ArrowUp :size="13" />
            </button>
            <button
              class="ws-icon"
              :disabled="busy || index === filteredCustomGroups.length - 1"
              :aria-label="'下移 ' + group.name"
              @click="moveGroup(group, 1)"
            >
              <ArrowDown :size="13" />
            </button>
          </div>
          <div class="row-info">
            <div class="row-title">
              <strong>{{ group.name }}</strong>
              <span v-if="group.categoryId" class="ws-badge">{{ store.categories.find(c => c.id === group.categoryId)?.name }}</span>
              <small class="ws-muted">{{ store.items.filter(d => d.customGroupId === group.id).length }} 份资料</small>
            </div>
          </div>
          <div class="row-actions">
            <button class="ws-icon" :aria-label="'编辑 ' + group.name" :disabled="busy" @click="editGroup(group)">
              <Pencil :size="15" />
            </button>
            <button class="ws-button" :aria-label="'删除 ' + group.name" :disabled="busy" @click="promptRemoveGroup(group)">
              删除
            </button>
          </div>
        </article>
      </section>
    </div>

    <!-- Tab 3: Storage & Recycling -->
    <div v-else-if="tab === 'organize'" class="settings-subpage">
      <ModulePreferences module="document" section="organize" />
      <section class="settings-card">
        <header class="card-header">
          <div>
            <h3>文库归档整理</h3>
            <p class="ws-muted">
              依据“子模块 / 分类 / 可选分组”将散落文件规范化整理至指定目标目录。移动前提供完整变更预览与冲突检查。
            </p>
          </div>
          <button class="ws-button" type="button" @click="loadHistory()">
            <History :size="15" />整理历史与撤销
          </button>
        </header>

        <div class="organize-controls">
          <div class="form-row">
            <label class="form-label">目标根目录</label>
            <div class="input-with-button">
              <input
                v-model="organizeRoot"
                type="text"
                placeholder="请选择或输入整理目标文件夹绝对路径"
                class="ws-input"
              />
              <button class="ws-button" type="button" :disabled="organizeLoading" @click="pickOrganizeRoot">
                <Folder :size="15" />浏览...
              </button>
            </div>
          </div>

          <div class="form-row-grid">
            <div>
              <label class="form-label">整理方式</label>
              <div class="radio-group">
                <label class="radio-label">
                  <input v-model="organizeMode" type="radio" value="move" @change="organizePreview && generatePreview()" />
                  移动文件（原文件移至目标，更新索引）
                </label>
                <label class="radio-label">
                  <input v-model="organizeMode" type="radio" value="copy" @change="organizePreview && generatePreview()" />
                  复制文件（在目标处建立副本）
                </label>
              </div>
            </div>

            <div>
              <label class="form-label">筛选子模块</label>
              <select v-model="organizeSubmodule" class="ws-select" @change="organizePreview && generatePreview()">
                <option value="all">全部子模块（阅读与资料）</option>
                <option value="reading">仅阅读模块</option>
                <option value="archive">仅资料模块</option>
              </select>
            </div>
          </div>

          <div class="form-row checkbox-row">
            <label class="checkbox-label">
              <input v-model="organizeUseGroups" type="checkbox" @change="organizePreview && generatePreview()" />
              按自定义分组建立子文件夹（路径：<code>根目录/子模块/分类/主分组/文件名</code>；未勾选或未分组落入分类目录）
            </label>
          </div>

          <div class="organize-actions">
            <button
              class="ws-button ws-button--primary"
              type="button"
              :disabled="!organizeRoot || organizeLoading"
              @click="generatePreview"
            >
              <RefreshCw :size="15" :class="{ 'spin-icon': organizeLoading }" />
              生成整理预览
            </button>
          </div>
        </div>

        <!-- Result summary -->
        <div v-if="organizeResult" class="organize-result-summary">
          <CheckCircle :size="18" class="text-success" />
          <span>
            本次整理完成：成功 {{ organizeResult.succeeded }} 项，跳过 {{ organizeResult.skipped }} 项，失败 {{ organizeResult.failed }} 项。
          </span>
        </div>

        <!-- Preview Table -->
        <div v-if="organizePreview" class="organize-preview-box">
          <div class="preview-header">
            <h4>
              整理预览清单（共 {{ organizePreview.total }} 项）
            </h4>
            <div class="preview-stats">
              <span class="stat-pill ready">待整理: {{ organizePreview.ready }}</span>
              <span class="stat-pill skip">已在目标: {{ organizePreview.skip }}</span>
              <span v-if="organizePreview.conflict" class="stat-pill conflict">冲突: {{ organizePreview.conflict }}</span>
              <span v-if="organizePreview.missing" class="stat-pill missing">缺失: {{ organizePreview.missing }}</span>
            </div>
          </div>

          <div class="preview-table-wrapper">
            <table class="preview-table">
              <thead>
                <tr>
                  <th>资料名称</th>
                  <th>所属结构</th>
                  <th>当前位置</th>
                  <th>目标路径</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in organizePreview.items" :key="item.id" :class="'row-' + item.status">
                  <td class="cell-name" :title="item.name"><strong>{{ item.name }}</strong></td>
                  <td class="cell-struct">
                    {{ item.submodule === 'archive' ? '资料' : '阅读' }} / {{ item.categoryName }}
                    <template v-if="item.groupName"> / {{ item.groupName }}</template>
                  </td>
                  <td class="cell-path" :title="item.source"><small>{{ item.source }}</small></td>
                  <td class="cell-path" :title="item.destination"><small>{{ item.destination }}</small></td>
                  <td class="cell-status">
                    <span class="status-badge" :class="'badge-' + item.status">
                      {{ item.status === 'ready' ? '可整理' : item.status === 'skip' ? '已在目标' : item.status === 'conflict' ? '冲突' : '缺失' }}
                    </span>
                    <small v-if="item.reason" class="ws-muted block-hint">{{ item.reason }}</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <footer class="preview-footer">
            <span class="ws-muted">
              移动操作将复制文件并严格比对校验码，确保数据一致后再清理源文件。
            </span>
            <button
              class="ws-button ws-button--primary"
              type="button"
              :disabled="organizePreview.ready === 0 || organizeLoading || previewSignature !== organizeSignature"
              @click="executeOrganize"
            >
              <FolderSync :size="16" />
              执行整理（{{ organizePreview.ready }} 项待处理）
            </button>
          </footer>
        </div>
      </section>

      <!-- Recycle bin -->
      <RecycleBin />
    </div>

    <section v-if="tab === 'tags'" class="settings-card ws-form">
      <h3>分类标签</h3><p class="ws-muted">标签按分类独立管理，重命名与删除只影响当前分类。</p>
      <label>选择分类<select v-model="tagCategory" :disabled="tagsBusy"><option v-for="category in store.categories" :key="category.id" :value="category.id">{{ category.submodule === 'reading' ? '阅读' : '资料' }} · {{ category.name }}</option></select></label>
      <DocumentTagDialog v-if="tagCategory" :key="tagCategory + ':' + (tagSelection.length ? 'batch' : 'manage')" embedded @busy="tagsBusy = $event" :category-id="tagCategory" :category-name="store.categories.find(row => row.id === tagCategory)?.name" :available-tags="categoryTags" :items="categoryItems.filter(item => tagSelection.includes(item.id))" @close="tagSelection = []" @updated="store.refresh()" />
      <h3>选择资料以添加标签</h3><p class="ws-muted">未选择资料时管理已有标签；选择后可追加、替换或移除所选资料的标签。</p>
      <div class="tag-documents"><label v-for="item in categoryItems" :key="item.id"><input v-model="tagSelection" :disabled="tagsBusy" type="checkbox" :value="item.id" />{{ item.name }}</label></div>
    </section>

    <!-- History Dialog -->
    <ProjectDialog
      v-if="showHistory"
      title="文件整理与操作历史"
      @close="showHistory = false"
    >
      <div class="organize-history-dialog">
        <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
        <p v-if="!historyList.length" class="ws-muted empty-hint">暂无文件移动或复制记录。</p>
        <div v-else class="history-list">
          <article v-for="op in historyList" :key="op.id" class="history-item">
            <div class="history-item-main">
              <div class="history-item-title">
                <strong>{{ op.mode === 'move' ? '移动' : op.mode === 'copy' ? '复制' : '关联' }}</strong>
                <span class="ws-badge" :class="{ 'ws-badge--undone': op.undone }">
                  {{ op.undoPending ? '撤销待完成' : op.undone ? '已撤销' : op.state === 'done' ? '已完成' : op.state === 'attention' ? '需处理' : '操作未完成' }}
                </span>
                <small class="ws-muted">{{ new Date(op.createdAt).toLocaleString() }}</small>
              </div>
              <div class="history-paths">
                <div><span class="ws-muted">源：</span><small>{{ op.source }}</small></div>
                <div><span class="ws-muted">目标：</span><small>{{ op.destination }}</small></div>
                <div v-if="op.error" class="ws-error"><small>{{ op.error }}</small></div>
              </div>
            </div>
            <div v-if="op.undoPending || (op.state !== 'done' && !op.undone)" class="history-item-actions">
              <button class="ws-button" type="button" :disabled="busy" @click="recoverOrganize(op.id)">
                <RefreshCw :size="14" />{{ op.undoPending ? '继续完成撤销' : '核验并恢复' }}
              </button>
            </div>
            <div v-if="op.mode === 'move' && op.state === 'done' && !op.undone" class="history-item-actions">
              <button class="ws-button" type="button" :disabled="busy" @click="undoOrganize(op.id)">
                <Undo2 :size="14" />撤销移动
              </button>
            </div>
          </article>
        </div>
      </div>
    </ProjectDialog>

    <!-- Category Dialog -->
    <ProjectDialog
      v-if="categoryForm"
      :title="categoryForm.id ? '编辑分类' : '新增分类'"
      :busy="busy"
      @close="categoryForm = null"
    >
      <form id="category-form" class="ws ws-form" @submit.prevent="saveCategory">
        <p v-if="error" class="ws-error">{{ error }}</p>
        <label>
          分类所属
          <select v-model="categoryForm.submodule" :disabled="!!categoryForm.id" aria-label="分类所属子模块">
            <option value="reading">阅读（书架类）</option>
            <option value="archive">资料（档案类）</option>
          </select>
        </label>
        <label>
          分类名称
          <input v-model="categoryForm.name" maxlength="100" required placeholder="如：科幻、证件凭据" />
        </label>
        <label>
          分类说明
          <textarea v-model="categoryForm.description" maxlength="2000" placeholder="哪些内容适合放在这里？助手推测时会参考此说明。" />
        </label>
        <label>
          资料用途
          <select v-model="categoryForm.behavior" aria-label="资料用途">
            <option v-for="(label, value) in behaviorLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
      </form>
      <template #footer>
        <div class="ws">
          <button class="ws-button primary" form="category-form" type="submit" :disabled="busy">保存分类</button>
        </div>
      </template>
    </ProjectDialog>

    <!-- Remove Category Dialog -->
    <ProjectDialog
      v-if="removingCategory"
      title="删除分类"
      :busy="busy"
      @close="removingCategory = null"
    >
      <div class="ws ws-form">
        <p>删除“{{ removingCategory.name }}”分类，不会删除资料或源文件。成员将转入下方目标分类，标注与引用保持不变。</p>
        <p v-if="error" class="ws-error">{{ error }}</p>
        <label>
          转移到
          <select v-model="transferTarget" aria-label="转移到分类">
            <option
              v-for="cat in filteredCategories.filter(c => c.id !== removingCategory?.id)"
              :key="cat.id"
              :value="cat.id"
            >
              {{ cat.name }}
            </option>
          </select>
        </label>
      </div>
      <template #footer>
        <div class="ws">
          <button class="ws-button danger" :disabled="busy" @click="confirmRemoveCategory">
            转移资料并删除分类
          </button>
        </div>
      </template>
    </ProjectDialog>

    <!-- Custom Group Dialog -->
    <ProjectDialog
      v-if="groupForm"
      :title="groupForm.id ? '编辑分组' : '新增分组'"
      :busy="busy"
      @close="groupForm = null"
    >
      <form id="group-form" class="ws ws-form" @submit.prevent="saveGroup">
        <p v-if="error" class="ws-error">{{ error }}</p>
        <label>
          所属分类
          <select v-model="groupForm.categoryId" required :disabled="busy || !!groupForm.id">
            <option v-for="cat in filteredCategories" :key="cat.id" :value="cat.id">{{ cat.name }}</option>
          </select>
        </label>
        <label>
          分组名称
          <input v-model="groupForm.name" maxlength="100" required placeholder="如：科幻经典、入职材料" />
        </label>
      </form>
      <template #footer>
        <div class="ws">
          <button class="ws-button primary" form="group-form" type="submit" :disabled="busy">保存分组</button>
        </div>
      </template>
    </ProjectDialog>

    <!-- Remove Group Dialog -->
    <ProjectDialog
      v-if="removingGroup"
      title="删除分组"
      :busy="busy"
      @close="removingGroup = null"
    >
      <div class="ws ws-form">
        <p>确定要删除分组“{{ removingGroup.name }}”吗？分组下的资料将保留，仅解除该分组关联。</p>
        <p v-if="error" class="ws-error">{{ error }}</p>
      </div>
      <template #footer>
        <div class="ws">
          <button class="ws-button danger" :disabled="busy" @click="confirmRemoveGroup">
            删除分组
          </button>
        </div>
      </template>
    </ProjectDialog>
  </section>
</template>

<style scoped>
.tag-documents{max-height:280px;overflow:auto}.tag-documents label{display:flex;gap:8px;padding:6px 0}

.document-settings {
  padding: 8px 0;
}

.settings-subtabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--divider);
  margin-bottom: 20px;
}

.settings-subtabs button {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.settings-subtabs button:hover {
  color: var(--text);
}

.settings-subtabs button.active {
  color: var(--primary, #3b82f6);
  border-bottom-color: var(--primary, #3b82f6);
}

.settings-subpage {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.submodule-switcher {
  display: flex;
  gap: 10px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
  padding: 4px;
  border-radius: 8px;
  width: fit-content;
}

.submodule-switcher button {
  background: transparent;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  color: var(--text-muted);
  transition: all 0.15s ease;
}

.submodule-switcher button.active {
  background: var(--bg-card, #fff);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.settings-card {
  border: 1px solid var(--divider);
  border-radius: 8px;
  padding: 20px;
  background: var(--bg-card, transparent);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.card-header h3 {
  margin: 0 0 4px 0;
  font-size: 15px;
}

.card-header p {
  margin: 0;
  font-size: 13px;
}

.item-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 0;
  border-top: 1px solid var(--divider);
}

.row-order {
  display: flex;
  flex-direction: column;
}

.row-info {
  flex: 1;
  min-width: 0;
}

.row-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-title strong {
  font-size: 14px;
}

.row-info p {
  margin: 4px 0 0 0;
  font-size: 12px;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.empty-hint {
  padding: 20px 0;
  text-align: center;
  font-size: 13px;
}

.organize-controls {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 16px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
}

.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button input {
  flex: 1;
}

.form-row-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.radio-label, .checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.checkbox-row {
  background: var(--bg-hover, rgba(0, 0, 0, 0.02));
  padding: 10px;
  border-radius: 6px;
}

.organize-actions {
  display: flex;
  justify-content: flex-start;
  margin-top: 6px;
}

.spin-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.organize-result-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 14px;
  border-radius: 6px;
  background: rgba(16, 185, 129, 0.1);
  color: var(--text);
  font-size: 13px;
}

.organize-preview-box {
  margin-top: 20px;
  border-top: 1px solid var(--divider);
  padding-top: 16px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.preview-stats {
  display: flex;
  gap: 8px;
}

.stat-pill {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--bg-hover, #eee);
}

.stat-pill.ready { background: rgba(16, 185, 129, 0.15); color: #059669; }
.stat-pill.skip { background: rgba(156, 163, 175, 0.15); color: #6b7280; }
.stat-pill.conflict { background: rgba(245, 158, 11, 0.15); color: #d97706; }
.stat-pill.missing { background: rgba(239, 68, 68, 0.15); color: #dc2626; }

.preview-table-wrapper {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--divider);
  border-radius: 6px;
}

.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.preview-table th, .preview-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--divider);
}

.preview-table th {
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
  position: sticky;
  top: 0;
  font-weight: 500;
  z-index: 1;
}

.cell-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-struct {
  white-space: nowrap;
}

.cell-path {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.badge-ready { background: rgba(16, 185, 129, 0.15); color: #059669; }
.badge-skip { background: rgba(156, 163, 175, 0.15); color: #6b7280; }
.badge-conflict { background: rgba(245, 158, 11, 0.15); color: #d97706; }
.badge-missing { background: rgba(239, 68, 68, 0.15); color: #dc2626; }

.block-hint {
  display: block;
  font-size: 10px;
}

.preview-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 14px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 400px;
  overflow-y: auto;
}

.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
}

.history-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.history-paths div {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 440px;
}
</style>
