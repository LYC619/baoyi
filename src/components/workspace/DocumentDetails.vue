<script setup lang="ts">
import { errorMessage } from '@/utils'
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { BookOpen, Star, ExternalLink, FolderOpen } from 'lucide-vue-next'
import { workspace } from '@/utils/workspace-api'
import type { DocumentItem, DocumentCategory, DocumentCustomGroup, DocumentPatch } from '@/types/workspace'
import DocumentCover from './DocumentCover.vue'
import DocumentProgress from './DocumentProgress.vue'
import DocumentGroupSelect from './DocumentGroupSelect.vue'
import DocumentInsightPanel from './DocumentInsightPanel.vue'

const props = defineProps<{ item: DocumentItem; categories: DocumentCategory[]; groups: DocumentCustomGroup[] }>()
const emit = defineEmits<{ open: []; updated: [] }>()
const draft = ref({ name: '', author: '', counterpart: '', issuedOn: '', expiresOn: '', notes: '', tags: '' })
const error = ref(''), saving = ref(false), saved = ref(false)
const isArchive = computed(() => props.item.submodule === 'archive')
const canReadInline = computed(() => ['pdf', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg'].includes(props.item.format))
let queue = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.item.id,
  () => {
    draft.value = {
      name: props.item.name,
      author: props.item.author,
      counterpart: props.item.counterpart || '',
      issuedOn: props.item.issuedOn || '',
      expiresOn: props.item.expiresOn || '',
      notes: props.item.notes,
      tags: props.item.tags.join('，'),
    }
    error.value = ''
  },
  { immediate: true }
)
watch(
  () => props.item.tags.join('，'),
  (value) => {
    if (document.activeElement?.getAttribute('aria-label') !== '资料标签') draft.value.tags = value
  }
)

function save(patch: DocumentPatch) {
  const id = props.item.id
  saving.value = true
  saved.value = false
  queue = queue
    .then(async () => {
      try {
        await workspace.documents.update(id, patch)
        error.value = ''
        emit('updated')
        saved.value = true
        clearTimeout(timer)
        timer = setTimeout(() => (saved.value = false), 1800)
      } catch (e) {
        error.value = errorMessage(e)
      }
    })
    .finally(() => (saving.value = false))
}

function saveField(key: 'name' | 'author' | 'counterpart' | 'issuedOn' | 'expiresOn' | 'notes' | 'tags') {
  if (key === 'tags') {
    const tags = [...new Set(draft.value.tags.split(/[,，;；\n]/).map((t) => t.trim()).filter(Boolean))]
    if (JSON.stringify(tags) !== JSON.stringify(props.item.tags)) save({ tags })
  } else if (draft.value[key] !== (props.item[key] || '')) {
    save({ [key]: draft.value[key] })
  }
}

async function action(kind: 'open' | 'reveal' | 'relocate') {
  try {
    await workspace.documents[kind](props.item.id)
    if (kind === 'relocate') emit('updated')
  } catch (e) {
    error.value = errorMessage(e)
  }
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="document-details-fields">
    <DocumentCover :item="item" size="detail" />
    <input
      v-model="draft.name"
      class="detail-title"
      aria-label="资料标题"
      @blur="saveField('name')"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
    />
    <div class="detail-meta-row">
      <select :value="item.type" aria-label="资料分类" @change="save({ type: ($event.target as HTMLSelectElement).value })">
        <optgroup v-for="sub in (['reading', 'archive'] as const)" :key="sub" :label="sub === 'reading' ? '阅读' : '资料'">
          <option v-for="cat in categories.filter((c) => c.submodule === sub)" :key="cat.id" :value="cat.id">{{ cat.name }}</option>
        </optgroup>
      </select>
      <input
        v-if="!isArchive"
        v-model="draft.author"
        aria-label="资料作者"
        placeholder="作者"
        @blur="saveField('author')"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <input
        v-else
        v-model="draft.counterpart"
        aria-label="相关方或颁发机构"
        placeholder="颁发机构或相关方"
        @blur="saveField('counterpart')"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
    </div>
    <div v-if="isArchive" class="detail-dates-row">
      <label>
        签发 / 签订日期
        <input v-model="draft.issuedOn" type="date" aria-label="签发或签订日期" @change="saveField('issuedOn')" />
      </label>
      <label>
        有效期至
        <input v-model="draft.expiresOn" type="date" aria-label="有效期至" @change="saveField('expiresOn')" />
      </label>
    </div>
    <div class="detail-actions">
      <button v-if="canReadInline" class="ws-button primary" @click="emit('open')">
        <BookOpen :size="16" />{{ isArchive ? '查看资料' : '阅读' }}
      </button>
      <button v-else class="ws-button primary" :disabled="!item.available" @click="action('open')">
        <ExternalLink :size="16" />外部程序打开
      </button>
      <button
        class="ws-icon"
        :title="item.favorite ? '取消收藏' : '收藏'"
        :aria-label="item.favorite ? '取消收藏' : '收藏'"
        :aria-pressed="!!item.favorite"
        @click="save({ favorite: !item.favorite })"
      >
        <Star :size="17" :fill="item.favorite ? 'currentColor' : 'none'" />
      </button>
      <button v-if="canReadInline" class="ws-icon" title="用外部应用打开" aria-label="用外部应用打开" @click="action('open')">
        <ExternalLink :size="17" />
      </button>
      <button class="ws-icon" title="在文件夹中显示" aria-label="在文件夹中显示" @click="action('reveal')">
        <FolderOpen :size="17" />
      </button>
    </div>
    <DocumentProgress v-if="item.readable" :item="item" />
    <DocumentInsightPanel :id="item.id" :categories="categories" @updated="emit('updated')" />
    <button v-if="!item.available" class="ws-button" @click="action('relocate')">重新定位</button>
    <label>
      分组
      <DocumentGroupSelect
        :model-value="item.customGroupId || ''"
        :submodule="item.submodule || 'reading'"
        :category-id="item.type"
        :groups="groups"
        @update:model-value="save({ customGroupId: $event })"
        @created="emit('updated')"
      />
    </label>
    <label>
      标签
      <input
        v-model="draft.tags"
        aria-label="资料标签"
        placeholder="用逗号分隔标签"
        @blur="saveField('tags')"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
    </label>
    <label>
      备注
      <textarea v-model="draft.notes" aria-label="资料备注" placeholder="添加备注…" rows="3" @blur="saveField('notes')" />
    </label>
    <small class="save-state" role="status">{{ saving ? '正在保存…' : saved ? '已保存' : '' }}</small>
    <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.document-details-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.detail-title {
  font-size: 18px !important;
  font-weight: 650;
  background: transparent !important;
  border-color: transparent !important;
  padding: 3px 0 !important;
  width: 100%;
}
.detail-title:focus {
  border-color: var(--accent) !important;
}
.detail-meta-row,
.detail-dates-row {
  display: grid;
  grid-template-columns: minmax(85px, 1fr) minmax(100px, 1.4fr);
  gap: 8px;
}
.detail-dates-row {
  grid-template-columns: 1fr 1fr;
}
.detail-meta-row input,
.detail-meta-row select,
.detail-dates-row input {
  width: 100%;
  min-width: 0;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.detail-actions .primary {
  flex: 1;
  justify-content: center;
}
.document-details-fields label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-sub);
}
textarea {
  resize: vertical;
}
.save-state {
  min-height: 15px;
  color: var(--text-muted);
}
</style>
