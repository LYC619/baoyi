<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { workspace } from '@/utils/workspace-api'
import type { DocumentProjectReference } from '@/types/workspace'
import type { ProjectItem } from '@/types/project'
const props = defineProps<{
  documentId: string
  annotationId: string
  references: DocumentProjectReference[]
}>()
const emit = defineEmits<{ changed: [] }>()
const route = useRoute(),
  router = useRouter(),
  opened = ref(false),
  loading = ref(false),
  busy = ref(''),
  error = ref(''),
  search = ref(''),
  archived = ref(false),
  projects = ref<ProjectItem[]>([])
const trigger = ref<HTMLButtonElement>(),
  input = ref<HTMLInputElement>()
let alive = true,
  revision = 0
const filtered = computed(() =>
  projects.value.filter(
    (p) =>
      (archived.value || p.state !== 'archived') &&
      p.name.toLowerCase().includes(search.value.toLowerCase()),
  ),
)
const linked = computed(() => [
  ...new Map(props.references.map((r) => [r.projectId, r])).values(),
])
async function open() {
  opened.value = true
  loading.value = true
  error.value = ''
  const run = ++revision
  try {
    const result = await window.baoyi.project.list()
    if (alive && run === revision) projects.value = result
  } catch (e) {
    if (alive && run === revision) error.value = errorMessage(e)
  } finally {
    if (alive && run === revision) loading.value = false
  }
  await nextTick()
  if (alive) input.value?.focus()
}
function close() {
  opened.value = false
  trigger.value?.focus()
}
async function add(project: Pick<ProjectItem, 'id'>) {
  if (busy.value) return
  busy.value = project.id
  error.value = ''
  try {
    await workspace.links.add(
      'project',
      project.id,
      props.documentId,
      props.annotationId,
    )
    if (alive) {
      emit('changed')
      close()
    }
  } catch (e) {
    if (alive) error.value = errorMessage(e)
  } finally {
    if (alive) busy.value = ''
  }
}
function go(reference: DocumentProjectReference) {
  void router.push({
    path: '/project/' + reference.projectId,
    query: { from: route.fullPath },
  })
}
onBeforeUnmount(() => {
  alive = false
  revision++
})
</script>
<template>
  <div class="annotation-project-links" @click.stop @keydown.stop>
    <div v-if="linked.length" class="annotation-linked-projects">
      <button
        v-for="reference in linked"
        :key="reference.projectId"
        class="ws-badge linked-project"
        :title="
          references
            .filter((r) => r.projectId === reference.projectId)
            .map((r) =>
              r.ownerType === 'event' ? $t('项目事件引用') : $t('项目直接引用'),
            )
            .join(' · ')
        "
        @click="go(reference)"
      >{{ $t("已引用 → {p0}", {p0: (reference.projectName)}) }}
      </button>
    </div>
    <button
      ref="trigger"
      class="ws-button annotation-link-trigger"
      :aria-label="$t('引用到项目')"
      :aria-expanded="opened"
      @click="opened ? close() : open()"
    >{{ $t("引用到项目") }}<span aria-hidden="true">▾</span>
    </button>
    <section
      v-if="opened"
      class="annotation-project-picker"
      :aria-label="$t('选择引用项目')"
      @keydown.esc.stop="close"
    >
      <header>
        <strong>{{ $t("引用到项目") }}</strong
        ><button class="ws-icon" :aria-label="$t('关闭项目选择器')" @click="close">
          ×
        </button>
      </header>
      <input
        ref="input"
        v-model="search"
        type="search"
        :aria-label="$t('搜索引用项目')"
        :placeholder="$t('搜索项目名称…')"
      />
      <label class="archived-toggle"
        ><input v-model="archived" type="checkbox" />{{ $t("显示归档项目") }}</label
      >
      <p v-if="error" class="ws-error" role="alert">{{ $systemMessage(error) }}</p>
      <p v-if="loading" class="ws-muted" role="status">{{ $t("正在读取项目…") }}</p>
      <div v-else class="picker-projects">
        <button
          v-for="project in filtered"
          :key="project.id"
          class="picker-project"
          :disabled="!!busy"
          @click="add(project)"
        >
          {{ project.name
          }}<small>{{
            busy === project.id
              ? $t('正在引用…')
              : linked.some((r) => r.projectId === project.id)
                ? $t('已关联')
                : project.state === 'archived'
                  ? $t('已归档')
                  : ''
          }}</small>
        </button>
        <p v-if="!filtered.length" class="ws-muted">
          {{ projects.length ? $t('没有匹配的项目') : $t('还没有项目') }}
        </p>
        <button
          v-if="!projects.length"
          class="ws-button"
          @click="router.push('/project')"
        >{{ $t("前往项目模块") }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.annotation-project-links {
  position: relative;
  margin-top: 12px;
  cursor: default;
}
.annotation-linked-projects {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.linked-project {
  color: var(--accent);
  background: var(--ws-tint);
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
}
.annotation-link-trigger {
  padding: 4px 8px;
  font-size: 11px;
}
.annotation-project-picker {
  margin-top: 8px;
  background: var(--ws-paper);
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 10px;
  box-shadow: 0 3px 10px #0001;
}
.annotation-project-picker header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.archived-toggle {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: var(--text-sub);
  margin-top: 8px;
}
.picker-projects {
  max-height: 220px;
  overflow: auto;
}
.picker-project {
  display: flex;
  justify-content: space-between;
  gap: 7px;
  width: 100%;
  text-align: left;
  padding: 9px 3px;
  overflow-wrap: anywhere;
  border-bottom: 1px solid var(--divider);
  font-size: 12px;
  color: var(--text-main);
}
.picker-project:hover {
  background: var(--ws-tint);
}
.picker-project small {
  color: var(--text-sub);
  font-size: 10px;
  flex: none;
}
</style>
