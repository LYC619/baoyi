<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
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
  try { await action(); await load() } catch (cause) { error.value = errorMessage(cause) } finally { busy.value = false }
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
  if (!(await confirmDialog({ title: tr('删除分类「{p0}」？', {p0: group.name}), message: tr("作品记录与本地原文件均会保留，并归回未分类。"), confirmText: tr('删除分类'), tone: 'danger' }))) return
  await run(async () => { await api.removeGroup(group.id); if (store.query.groupId === group.id) store.query.groupId = undefined })
}
async function changeTag(from: string, to: string | null) {
  if (to !== null && (!to.trim() || to.trim() === from)) return
  if (!(await confirmDialog({ title: to === null ? tr("移除标签「{p0}」？", {p0: (from)}) : tr("重命名标签「{p0}」？", {p0: (from)}), message: to === null ? tr("将从图片库所有作品上移除该标签，本地文件不受影响。") : tr("将改为「{p0}」，同名标签会自动合并。", {p0: (to.trim())}), confirmText: to === null ? tr("移除标签") : tr("确认修改"), tone: to === null ? 'danger' : 'default' }))) return
  await run(async () => { const count = await api.renameTag(from, to); message.value = tr("已更新 {p0} 个作品", {p0: (count)}); if (store.query.tag === from) store.query.tag = to?.trim() || undefined })
}
async function rescan() {
  const ids = [...selected.value]
  await run(async () => {
    let updated = 0; const failures: string[] = []
    for (const id of ids) { try { await api.rescan(id); updated++ } catch (cause) { failures.push((store.items.find(item => item.id === id)?.name || id) + '：' + errorMessage(cause)) } }
    message.value = tr("已重扫 {p0} 个作品", {p0: (updated)}); error.value = failures.join('；')
  })
}
</script>

<template>
  <section class="ws image-settings">
    <div class="ws-toolbar"><label>{{ $t("图片类型") }}<select v-model="type" :aria-label="$t('图片类型')" :disabled="busy"><option value="comic">{{ $t("漫画") }}</option><option value="photo">{{ $t("照片") }}</option><option value="misc">{{ $t("杂图") }}</option></select></label></div>
    <p v-if="error || store.error" class="ws-error" role="alert">{{ error || store.error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section v-if="section === 'scan' || section === 'organize' || section === 'tags'" class="ws-card">
      <h2>{{ section === 'scan' ? $t('扫描与识别') : section === 'organize' ? $t('目录整理') : $t('标签') }}</h2>
      <p class="ws-muted">{{ section === 'scan' ? $t('扫描目录或 ZIP／CBZ，按文件顺序识别相册、漫画章节和页码。已有作品可重新扫描，更新新增或缺失页面。') : section === 'organize' ? $t('选择作品后指定目标目录，可按分类建立子目录。移动前显示路径预览，同名目录不会覆盖。') : $t('重命名或删除标签会同步更新图片库中的作品；也可向选中的作品添加标签。') }}</p>
      <p v-if="section==='scan'&&type!=='comic'" class="ws-muted">{{ $t("已导入的本地文件夹自动更新：放入、替换或移除图片后，等待文件稳定即可显示；启动时也会补扫。软件关闭期间无需保持运行。磁盘离线时保留索引；新文件夹仍需先导入。") }}</p>
      <template v-if="section === 'tags'">
        <div v-for="tag in tags" :key="tag.name" class="manage-row">
          <input :value="tag.name" :aria-label="$t('重命名标签 {p0}', {p0: tag.name})" :disabled="busy" @change="changeTag(tag.name, ($event.target as HTMLInputElement).value)" />
          <small>{{ $t("{p0} 个作品", {p0: (tag.count)}) }}</small><button class="ws-button" :disabled="busy" @click="changeTag(tag.name, null)">{{ $t("删除") }}</button>
        </div>
        <p v-if="!tags.length" class="ws-muted">{{ $t("暂无标签，可先选择作品再添加。") }}</p>
      </template>
      <div class="ws-toolbar">
        <button v-if="section === 'scan'" class="ws-button" :disabled="busy" @click="importing = true">{{ $t("扫描并导入") }}</button>
        <button class="ws-button" :disabled="busy" @click="selected = items.map(item => item.id)">{{ $t("全选当前类型") }}</button>
        <button class="ws-button" :disabled="busy" @click="selected = []">{{ $t("清空选择") }}</button>
      </div>
      <div class="item-list">
        <label v-for="item in items" :key="item.id"><input v-model="selected" type="checkbox" :value="item.id" :disabled="busy" /><span>{{ item.name }}<small>{{ item.path }}</small></span></label>
        <p v-if="!items.length" class="ws-muted">{{ $t("当前类型还没有作品。") }}</p>
      </div>
      <div class="ws-toolbar">
        <button v-if="section === 'scan'" class="ws-button primary" :disabled="busy || !selected.length" @click="rescan">{{ $t("重新扫描所选（{p0}）", {p0: (selected.length)}) }}</button>
        <template v-else-if="section === 'organize'"><label><input v-model="byCategory" type="checkbox" :disabled="busy" />{{ $t("按分类存放（沿用已记住的目录）") }}</label><label v-if="byCategory"><input v-model="chooseTarget" type="checkbox" :disabled="busy" />{{ $t("重新选择目标根目录") }}</label><button class="ws-button primary" :disabled="busy || !selected.length" @click="run(async () => { const result = await api.move([...selected], byCategory, chooseTarget); if (result) message = $t('已移动 {p0} 项。{p1}', {p0: result.moved, p1: result.warnings.join('；')}) })">{{ $t("预览并移动") }}</button></template>
        <template v-else><input v-model="newTag" maxlength="60" :placeholder="$t('新标签')" :aria-label="$t('新标签')" :disabled="busy" /><button class="ws-button primary" :disabled="busy || !selected.length || !newTag.trim()" @click="run(async () => { await api.bulkUpdate([...selected], { tags: { mode: 'add', values: [newTag.trim()] } }); newTag = ''; message = $t('已添加标签') })">{{ $t("添加到所选作品") }}</button></template>
      </div>
    </section>
    <section v-else-if="section === 'categories'" class="ws-card">
      <h2>{{ $t("图片分类") }}</h2><p class="ws-muted">{{ $t("漫画、照片和杂图各自管理分类，允许同名。隐藏分类会同时隐藏其内容；修改分类名会保留原存放目录。目录留空时，首次整理后自动记住。") }}</p>
      <div v-for="(group, index) in groups" :key="group.id" class="manage-row">
        <button class="ws-button" :disabled="busy || index === 0" :aria-label="$t('上移分类')" @click="reorder(group, -1)">↑</button>
        <button class="ws-button" :disabled="busy || index === groups.length - 1" :aria-label="$t('下移分类')" @click="reorder(group, 1)">↓</button>
        <input :value="group.name" :aria-label="$t('分类 {p0}', {p0: group.name})" :disabled="busy" @change="saveGroup(group, ($event.target as HTMLInputElement).value)" />
        <input :value="group.directory" :aria-label="$t('存放目录 {p0}', {p0: group.name})" :placeholder="$t('存放目录（首次整理后记住）')" :disabled="busy" @change="run(async()=>{await api.saveGroup({...group,directory:($event.target as HTMLInputElement).value.trim()})})" />
        <label><input type="checkbox" :checked="group.hidden" :disabled="busy" @change="run(async () => { await api.saveGroup({ ...group, hidden: !group.hidden }) })" />{{ $t("隐藏") }}</label>
        <button class="ws-button" :disabled="busy" @click="removeGroup(group)">{{ $t("删除") }}</button>
      </div>
      <div class="ws-toolbar"><input v-model="newGroup" :placeholder="$t('新分类名称')" :aria-label="$t('新分类名称')" maxlength="80" /><button class="ws-button" :disabled="busy || !newGroup.trim()" @click="saveGroup()">{{ $t("新增分类") }}</button></div>
    </section>
    <section v-else-if="section === 'reader'" class="ws-card ws-form">
      <template v-if="type!=='comic'"><h2>{{ $t("照片与杂图浏览") }}</h2><PhotoViewControls :view="photoView"/><p class="ws-muted">{{ $t("当前类型单独记住展示方式。组合按文件夹展示，单张可直接浏览；自适配保留原比例，按文件夹分组时各组独立排列。") }}</p></template>
      <h2>{{ $t("默认阅读偏好") }}</h2><p class="ws-muted">{{ $t("用于尚未单独定制的作品。作品内保存的阅读偏好继续优先使用。") }}</p>
      <label>{{ $t("翻页方式") }}<select v-model="preferences.mode"><option value="single">{{ $t("单页") }}</option><option value="double">{{ $t("双页") }}</option><option value="scroll">{{ $t("连续滚动") }}</option></select></label>
      <label>{{ $t("阅读方向") }}<select v-model="preferences.direction"><option value="ltr">{{ $t("从左向右") }}</option><option value="rtl">{{ $t("从右向左") }}</option></select></label>
      <label>{{ $t("适应方式") }}<select v-model="preferences.fit"><option value="screen">{{ $t("适应屏幕") }}</option><option value="width">{{ $t("适应宽度") }}</option><option value="original">{{ $t("原始大小") }}</option></select></label>
      <label><input v-model="preferences.coverSingle" type="checkbox" />{{ $t("封面单独显示") }}</label>
      <button class="ws-button primary" :disabled="busy" @click="run(async () => { preferences = await api.preferences(JSON.parse(JSON.stringify(preferences))); message = $t('阅读偏好已保存') })">{{ $t("保存阅读偏好") }}</button>
    </section>
    <ImageImportDialog v-if="importing" :type="type" @close="importing = false; load()" />
  </section>
</template>

<style scoped>
.image-settings h2{font-size:18px;margin:0 0 12px}.manage-row{display:flex;gap:8px;align-items:center;margin:12px 0}.manage-row>input{min-width:0;flex:1}.manage-row small{color:var(--text-faint)}.item-list{max-height:320px;overflow:auto;margin:16px 0}.item-list>label{display:flex;gap:10px;padding:8px 0;align-items:center}.item-list span{min-width:0}.item-list small{display:block;overflow-wrap:anywhere;color:var(--text-faint)}
</style>
