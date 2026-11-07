<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PhotoViewControls from '@/components/image/PhotoViewControls.vue'
import { usePhotoView } from '@/composables/usePhotoView'
import { useImageStore } from '@/stores/image'
import ImageImportDialog from '@/components/image/ImageImportDialog.vue'
import { DEFAULT_IMAGE_PREFERENCES } from '@/utils/image-preferences'
import type { ImageGroup, ImagePreferences, ImageType } from '@/types/image'
import '@/styles/workspace.css'
import '@/components/image/image.css'

defineProps<{ section: string }>()
const store = useImageStore(), api = window.baoyi.image
const type = ref<ImageType>(store.query.type||'comic'), importing = ref(false), busy = ref(false), error = ref(''), message = ref('')
const selected = ref<string[]>([]), byCategory = ref(true), chooseTarget=ref(false), newGroup = ref(''), newTag = ref('')
const groups=computed(()=>store.groups.filter(g=>g.type===type.value)),photoView=usePhotoView(type)
watch(type,()=>{selected.value=[];message.value='';error.value=''})
const preferences = ref<ImagePreferences>({ ...DEFAULT_IMAGE_PREFERENCES })
const tags = ref<Array<{ name: string; count: number }>>([])
const items = computed(() => store.items.filter(item => item.type === type.value))
async function load() { await store.refresh(); tags.value = await api.tagCounts() }
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await action(); await load() } catch (cause) { error.value = (cause as Error).message } finally { busy.value = false }
}
onMounted(() => void run(async () => { preferences.value = await api.preferences() }))
async function saveGroup(group?: ImageGroup, name?: string) {
  await run(async () => { await api.saveGroup({ ...group, type:type.value, name: (name ?? newGroup.value).trim() }); newGroup.value = '' })
}
async function reorder(group: ImageGroup, delta: number) {
  const other = groups.value[groups.value.findIndex(row => row.id === group.id) + delta]
  if (!other) return
  await run(async () => {
    await api.saveGroup({ ...other, sortOrder: group.sortOrder })
    await api.saveGroup({ ...group, sortOrder: other.sortOrder })
  })
}
async function removeGroup(group: ImageGroup) {
  if (!confirm(`删除分类「${group.name}」？作品保留并回到未分类。`)) return
  await run(async () => { await api.removeGroup(group.id); if (store.query.groupId === group.id) store.query.groupId = undefined })
}
async function changeTag(from: string, to: string | null) {
  if (to !== null && (!to.trim() || to.trim() === from)) return
  if (!confirm(to === null ? `从图片库所有作品移除「${from}」标签？` : `将图片库的「${from}」改为「${to.trim()}」？同名标签会合并。`)) return
  await run(async () => { const count = await api.renameTag(from, to); message.value = `已更新 ${count} 个作品`; if (store.query.tag === from) store.query.tag = to?.trim() || undefined })
}
async function rescan() {
  const ids = [...selected.value]
  await run(async () => {
    let updated = 0; const failures: string[] = []
    for (const id of ids) { try { await api.rescan(id); updated++ } catch (cause) { failures.push((store.items.find(item => item.id === id)?.name || id) + '：' + (cause as Error).message) } }
    message.value = `已重扫 ${updated} 个作品`; error.value = failures.join('；')
  })
}
</script>

<template>
  <section class="ws image-settings">
    <div class="ws-toolbar"><label>图片类型 <select v-model="type" aria-label="图片类型" :disabled="busy"><option value="comic">漫画</option><option value="photo">照片</option><option value="misc">杂图</option></select></label></div>
    <p v-if="error || store.error" class="ws-error" role="alert">{{ error || store.error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section v-if="section === 'scan' || section === 'organize' || section === 'tags'" class="ws-card">
      <h2>{{ section === 'scan' ? '扫描与识别' : section === 'organize' ? '目录整理' : '标签' }}</h2>
      <p class="ws-muted">{{ section === 'scan' ? '扫描目录或 ZIP／CBZ，按文件顺序识别相册、漫画章节和页码。已有作品可重新扫描，更新新增或缺失页面。' : section === 'organize' ? '选择作品后指定目标目录，可按分类建立子目录。移动前显示路径预览，同名目录不会覆盖。' : '重命名或删除标签会同步更新图片库中的作品；也可向选中的作品添加标签。' }}</p>
      <p v-if="section==='scan'&&type!=='comic'" class="ws-muted">已导入的本地文件夹自动更新：放入、替换或移除图片后，等待文件稳定即可显示；启动时也会补扫。软件关闭期间无需保持运行。磁盘离线时保留索引；新文件夹仍需先导入。</p>
      <template v-if="section === 'tags'">
        <div v-for="tag in tags" :key="tag.name" class="manage-row">
          <input :value="tag.name" :aria-label="`重命名标签 ${tag.name}`" :disabled="busy" @change="changeTag(tag.name, ($event.target as HTMLInputElement).value)" />
          <small>{{ tag.count }} 个作品</small><button class="ws-button" :disabled="busy" @click="changeTag(tag.name, null)">删除</button>
        </div>
        <p v-if="!tags.length" class="ws-muted">暂无标签，可先选择作品再添加。</p>
      </template>
      <div class="ws-toolbar">
        <button v-if="section === 'scan'" class="ws-button" :disabled="busy" @click="importing = true">扫描并导入</button>
        <button class="ws-button" :disabled="busy" @click="selected = items.map(item => item.id)">全选当前类型</button>
        <button class="ws-button" :disabled="busy" @click="selected = []">清空选择</button>
      </div>
      <div class="item-list">
        <label v-for="item in items" :key="item.id"><input v-model="selected" type="checkbox" :value="item.id" :disabled="busy" /><span>{{ item.name }}<small>{{ item.path }}</small></span></label>
        <p v-if="!items.length" class="ws-muted">当前类型还没有作品。</p>
      </div>
      <div class="ws-toolbar">
        <button v-if="section === 'scan'" class="ws-button primary" :disabled="busy || !selected.length" @click="rescan">重新扫描所选（{{ selected.length }}）</button>
        <template v-else-if="section === 'organize'"><label><input v-model="byCategory" type="checkbox" :disabled="busy" />按分类存放（沿用已记住的目录）</label><label v-if="byCategory"><input v-model="chooseTarget" type="checkbox" :disabled="busy" />重新选择目标根目录</label><button class="ws-button primary" :disabled="busy || !selected.length" @click="run(async () => { const result = await api.move([...selected], byCategory, chooseTarget); if (result) message = `已移动 ${result.moved} 项。${result.warnings.join('；')}` })">预览并移动</button></template>
        <template v-else><input v-model="newTag" maxlength="60" placeholder="新标签" aria-label="新标签" :disabled="busy" /><button class="ws-button primary" :disabled="busy || !selected.length || !newTag.trim()" @click="run(async () => { await api.bulkUpdate([...selected], { tags: { mode: 'add', values: [newTag.trim()] } }); newTag = ''; message = '已添加标签' })">添加到所选作品</button></template>
      </div>
    </section>
    <section v-else-if="section === 'categories'" class="ws-card">
      <h2>图片分类</h2><p class="ws-muted">漫画、照片和杂图各自管理分类，允许同名。隐藏分类会同时隐藏其内容；修改分类名会保留原存放目录。目录留空时，首次整理后自动记住。</p>
      <div v-for="(group, index) in groups" :key="group.id" class="manage-row">
        <button class="ws-button" :disabled="busy || index === 0" aria-label="上移分类" @click="reorder(group, -1)">↑</button>
        <button class="ws-button" :disabled="busy || index === groups.length - 1" aria-label="下移分类" @click="reorder(group, 1)">↓</button>
        <input :value="group.name" :aria-label="`分类 ${group.name}`" :disabled="busy" @change="saveGroup(group, ($event.target as HTMLInputElement).value)" />
        <input :value="group.directory" :aria-label="`存放目录 ${group.name}`" placeholder="存放目录（首次整理后记住）" :disabled="busy" @change="run(async()=>{await api.saveGroup({...group,directory:($event.target as HTMLInputElement).value.trim()})})" />
        <label><input type="checkbox" :checked="group.hidden" :disabled="busy" @change="run(async () => { await api.saveGroup({ ...group, hidden: !group.hidden }) })" />隐藏</label>
        <button class="ws-button" :disabled="busy" @click="removeGroup(group)">删除</button>
      </div>
      <div class="ws-toolbar"><input v-model="newGroup" placeholder="新分类名称" aria-label="新分类名称" maxlength="80" /><button class="ws-button" :disabled="busy || !newGroup.trim()" @click="saveGroup()">新增分类</button></div>
    </section>
    <section v-else-if="section === 'reader'" class="ws-card ws-form">
      <template v-if="type!=='comic'"><h2>照片与杂图浏览</h2><PhotoViewControls :view="photoView"/><p class="ws-muted">当前类型单独记住展示方式。组合按文件夹展示，单张可直接浏览；自适配保留原比例，按文件夹分组时各组独立排列。</p></template>
      <h2>默认阅读偏好</h2><p class="ws-muted">用于尚未单独定制的作品。作品内保存的阅读偏好继续优先使用。</p>
      <label>翻页方式<select v-model="preferences.mode"><option value="single">单页</option><option value="double">双页</option><option value="scroll">连续滚动</option></select></label>
      <label>阅读方向<select v-model="preferences.direction"><option value="ltr">从左向右</option><option value="rtl">从右向左</option></select></label>
      <label>适应方式<select v-model="preferences.fit"><option value="screen">适应屏幕</option><option value="width">适应宽度</option><option value="original">原始大小</option></select></label>
      <label><input v-model="preferences.coverSingle" type="checkbox" />封面单独显示</label>
      <button class="ws-button primary" :disabled="busy" @click="run(async () => { preferences = await api.preferences(JSON.parse(JSON.stringify(preferences))); message = '阅读偏好已保存' })">保存阅读偏好</button>
    </section>
    <ImageImportDialog v-if="importing" :type="type" @close="importing = false; load()" />
  </section>
</template>

<style scoped>
.image-settings h2{font-size:18px;margin:0 0 12px}.manage-row{display:flex;gap:8px;align-items:center;margin:12px 0}.manage-row>input{min-width:0;flex:1}.manage-row small{color:var(--text-faint)}.item-list{max-height:320px;overflow:auto;margin:16px 0}.item-list>label{display:flex;gap:10px;padding:8px 0;align-items:center}.item-list span{min-width:0}.item-list small{display:block;overflow-wrap:anywhere;color:var(--text-faint)}
</style>
