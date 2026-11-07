<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { workspace, plain } from '@/utils/workspace-api'
import { type DocumentItem, type DocumentPatch, type DocumentSubmodule } from '@/types/workspace'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{ item: DocumentItem }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const store = useDocumentsStore()

const currentSubmodule = ref<DocumentSubmodule | ''>(props.item.submodule || '')
const form = ref<DocumentPatch>({
  name: props.item.name,
  type: props.item.type,
  submodule: currentSubmodule.value || null,
  customGroupId: props.item.customGroupId || '',
  author: props.item.author,
  counterpart: props.item.counterpart,
  issuedOn: props.item.issuedOn,
  expiresOn: props.item.expiresOn,
  notes: props.item.notes,
  readState: props.item.readState,
})
const tags = ref(props.item.tags.join('，'))
const busy = ref(false)
const error = ref('')

const availableCategories = computed(() =>
  store.categories.filter(c => c.submodule === currentSubmodule.value)
)
const availableCustomGroups = computed(() =>
  store.customGroups.filter(g => g.submodule === currentSubmodule.value)
)
const behavior = computed(() =>
  store.categories.find(c => c.id === form.value.type)?.behavior || props.item.behavior
)

watch(currentSubmodule, (sub) => {
  form.value.submodule = sub || null
  if (sub && !availableCategories.value.some(c => c.id === form.value.type)) {
    form.value.type = sub === 'archive' ? 'archive_other' : 'reading_other'
  }
  if (form.value.customGroupId && !availableCustomGroups.value.some(g => g.id === form.value.customGroupId)) {
    form.value.customGroupId = ''
  }
})

onMounted(() => void store.refresh())

async function save() {
  busy.value = true
  error.value = ''
  try {
    const patch: DocumentPatch = {
      ...form.value,
      submodule: currentSubmodule.value || null,
      customGroupId: form.value.customGroupId || '',
      tags: tags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    }
    // A pending item keeps its existing category hint until explicitly classified.
    if (!currentSubmodule.value) delete patch.type
    await workspace.documents.update(props.item.id, plain(patch))
    emit('saved')
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ProjectDialog title="编辑资料" :busy="busy" @close="emit('close')">
    <form id="document-edit" class="ws ws-form" @submit.prevent="save">
      <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      <label>
        所属子模块
        <select v-model="currentSubmodule" aria-label="所属子模块">
          <option value="">待归类（稍后选择）</option>
          <option value="reading">阅读（书架类：小说、书籍、论文）</option>
          <option value="archive">资料（档案类：证书、证件、合同）</option>
        </select>
      </label>
      <label>
        资料名称
        <input v-model="form.name" required maxlength="300" />
      </label>
      <div v-if="currentSubmodule" class="ws-two">
        <label>
          资料分类
          <select v-model="form.type" aria-label="资料分类">
            <option v-for="category in availableCategories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
        </label>
        <label>
          自定义分组
          <select v-model="form.customGroupId" aria-label="自定义分组">
            <option value="">不指定分组</option>
            <option v-for="group in availableCustomGroups" :key="group.id" :value="group.id">
              {{ group.name }}
            </option>
          </select>
        </label>
      </div>
      <label v-if="currentSubmodule === 'reading'">
        作者
        <input v-model="form.author" maxlength="300" />
      </label>
      <label v-else>
        {{ behavior === 'certificate' ? '颁发机构' : '相关方' }}
        <input v-model="form.counterpart" maxlength="300" />
      </label>
      <div class="ws-two">
        <label>
          取得 / 发布日期
          <input v-model="form.issuedOn" type="date" />
        </label>
        <label>
          有效期至
          <input v-model="form.expiresOn" type="date" />
        </label>
      </div>
      <label v-if="currentSubmodule === 'reading'">
        阅读状态
        <select v-model="form.readState" aria-label="阅读状态">
          <option value="unread">未读</option>
          <option value="reading">在读</option>
          <option value="read">已读</option>
        </select>
      </label>
      <label>
        标签
        <input v-model="tags" placeholder="用逗号分隔" />
      </label>
      <label>
        备注
        <textarea v-model="form.notes" maxlength="20000" />
      </label>
    </form>
    <template #footer>
      <div class="ws">
        <button class="ws-button primary" type="submit" form="document-edit" :disabled="busy">
          保存资料
        </button>
      </div>
    </template>
  </ProjectDialog>
</template>
