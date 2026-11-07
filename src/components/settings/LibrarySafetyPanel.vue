<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Database, FolderOpen, RefreshCw, ShieldCheck } from 'lucide-vue-next'
import type { LibrarySafetyInfo } from '@/types/library-snapshot'
import { formatBytes } from '@/utils'
const props = defineProps<{ refreshKey: number }>()
const emit = defineEmits<{ 'storage-changed': [] }>()
const info = ref<LibrarySafetyInfo | null>(null), loading = ref(false), action = ref(''), error = ref(''), notice = ref('')
const busy = computed(() => action.value !== '')
let revision = 0
async function refresh() {
  const token = ++revision; loading.value = true; error.value = ''
  try { const result = await window.baoyi.data.snapshotInfo(); if (token === revision) info.value = result }
  catch (cause) { if (token === revision) error.value = (cause as Error).message }
  finally { if (token === revision) loading.value = false }
}
async function create() {
  action.value = 'create'; error.value = ''; notice.value = ''
  try { await window.baoyi.data.createSnapshot(); notice.value = '数据库快照已创建，创建校验通过'; await refresh(); emit('storage-changed') }
  catch (cause) { error.value = (cause as Error).message }
  finally { action.value = '' }
}
async function archive() {
  action.value = 'archive'; error.value = ''; notice.value = ''
  try {
    const result = await window.baoyi.data.archiveSnapshots()
    await refresh(); emit('storage-changed')
    notice.value = `已压缩 ${result.archived} 份旧快照，释放 ${formatBytes(result.reclaimedBytes)}；全部恢复点保留`
    error.value = result.warnings.join('；')
  } catch (cause) { error.value = (cause as Error).message }
  finally { action.value = '' }
}
async function exportSnapshot(id: string) {
  action.value = 'export'; error.value = ''; notice.value = ''
  try { const result = await window.baoyi.data.exportSnapshot(id); if (result) notice.value = '已导出并核对原始摘要：' + result.file }
  catch (cause) { error.value = (cause as Error).message }
  finally { action.value = '' }
}
async function open() { try { await window.baoyi.data.openSnapshotDir() } catch (cause) { error.value = (cause as Error).message } }
const stateLabel = (state: string) => state === 'available' ? '文件存在' : state === 'missing' ? '文件缺失' : '文件已变化'
const time = (value: number) => new Date(value).toLocaleString()
watch(() => props.refreshKey, refresh)
onMounted(refresh)
</script>
<template>
  <section class="library-safety" aria-label="资料库保护">
    <header><h2><ShieldCheck :size="19" />资料库保护</h2><button class="btn btn--subtle" aria-label="刷新快照信息" title="刷新快照信息" :disabled="loading||busy" @click="refresh"><RefreshCw :size="16" /></button><button class="btn btn--subtle" aria-label="打开快照目录" title="打开快照目录" :disabled="busy" @click="open"><FolderOpen :size="16" /></button><button class="btn btn--ghost" :disabled="busy||loading" @click="create"><Database :size="15" />{{ action==='create'?'正在创建快照':'创建数据库快照' }}</button></header>
    <p v-if="error" class="safety-error" role="alert">{{ error }}</p><p v-if="notice" class="safety-notice" role="status">{{ notice }}</p>
    <template v-if="info">
      <dl class="safety-facts"><dt>程序版本</dt><dd>v{{ info.version }}</dd><dt>资料库结构</dt><dd>{{ info.schema }}</dd><dt>数据库文件</dt><dd class="mono">{{ info.database }}</dd><dt>快照目录</dt><dd class="mono">{{ info.inventory.directory }}</dd><dt>快照内容</dt><dd>数据库与本机设置 · 不含资源文件</dd><dt>历史备份</dt><dd>旧版备份 {{ info.inventory.legacyBackups }} 份 · 恢复前快照 {{ info.inventory.recoveryBackups }} 份</dd></dl>
      <div aria-label="最近元数据备份" class="last-export"><h3>最近元数据备份</h3><template v-if="info.lastExport"><span class="mono export-path">{{ info.lastExport.file }}</span><p>{{ time(info.lastExport.createdAt) }} · {{ formatBytes(info.lastExport.size) }} · {{ stateLabel(info.lastExport.state) }}</p></template><p v-else>暂无导出记录</p></div>
      <div class="snapshot-heading"><h3>数据库快照</h3><span>{{ info.inventory.total }} 份<span v-if="info.inventory.total>info.inventory.snapshots.length"> · 显示最近 {{ info.inventory.snapshots.length }} 份</span></span><button class="btn btn--subtle" :disabled="busy||loading" @click="archive">{{ action==='archive'?'正在压缩旧快照…':'压缩旧升级快照' }}</button></div>
      <p class="safety-notice">保留最近 3 份升级快照和手动快照的原始数据库，较早升级快照在启动后无损压缩。全部快照均可导出为原始数据库；请使用新的文件名。</p>
      <div v-if="info.inventory.snapshots.length" class="snapshot-table"><table><thead><tr><th>创建时间</th><th>来源</th><th>版本 / 结构</th><th>实际占用</th><th>创建校验</th><th>当前文件</th><th>导出</th></tr></thead><tbody><tr v-for="snapshot in info.inventory.snapshots" :key="snapshot.id" :title="snapshot.file"><td>{{ time(snapshot.createdAt) }}</td><td>{{ snapshot.reason==='upgrade'?'升级前':'手动' }}</td><td>{{ snapshot.fromVersion||'未记录' }} → {{ snapshot.targetVersion }}<br /><span>结构 {{ snapshot.fromSchema }} → {{ snapshot.targetSchema }}</span></td><td>{{ formatBytes(snapshot.storedSize ?? snapshot.size) }}<br v-if="snapshot.compression" /><span v-if="snapshot.compression">已压缩 · 原始 {{ formatBytes(snapshot.size) }}</span></td><td :title="`SHA-256: ${snapshot.sha256}`">通过</td><td :class="{unavailable:snapshot.state!=='available'}">{{ stateLabel(snapshot.state) }}</td><td><button class="btn btn--subtle" :disabled="busy||loading||snapshot.state!=='available'" @click="exportSnapshot(snapshot.id)">导出数据库</button></td></tr></tbody></table></div>
      <p v-else class="safety-empty">暂无数据库快照</p>
      <p v-for="warning in info.inventory.warnings" :key="warning" class="safety-error">{{ warning }}</p>
    </template><p v-else-if="loading" class="safety-empty">正在读取资料库信息</p>
  </section>
</template>
<style scoped>
.snapshot-heading{flex-wrap:wrap}.snapshot-heading button{margin-left:auto}.safety-notice{overflow-wrap:anywhere}
.library-safety{border-top:1px solid var(--divider);padding:24px 0;margin:8px 0 30px;min-width:0;font-size:13px}.library-safety header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:20px}.library-safety h2{font-size:17px;font-weight:600;display:flex;align-items:center;gap:9px;margin:0 auto 0 0}.library-safety h3{font-size:13px;font-weight:600;margin:0 0 10px}.library-safety header .btn--subtle{width:32px;height:32px;flex:none;padding:7px}.safety-facts{display:grid;grid-template-columns:105px minmax(0,1fr);gap:11px 15px;line-height:1.65;margin:0 0 24px}.safety-facts dt{color:var(--text-sub)}.safety-facts dd{margin:0;min-width:0;overflow-wrap:anywhere}.last-export{padding:16px 0;border-top:1px solid var(--divider);border-bottom:1px solid var(--divider);margin-bottom:22px}.last-export p{color:var(--text-sub);margin:8px 0 0;font-size:12px}.export-path{display:block;overflow-wrap:anywhere;line-height:1.7}.snapshot-heading{display:flex;align-items:baseline;gap:10px}.snapshot-heading>span{font-size:12px;color:var(--text-sub)}.snapshot-table{overflow-x:auto;width:100%;max-width:100%}.snapshot-table table{width:100%;border-collapse:collapse;font-size:12px;min-width:570px}.snapshot-table th{color:var(--text-sub);font-weight:400;text-align:left;white-space:nowrap}.snapshot-table td,.snapshot-table th{padding:10px 12px 10px 0;border-bottom:1px solid var(--divider);line-height:1.6}.snapshot-table td:first-child{width:140px;font-variant-numeric:tabular-nums}.snapshot-table td:nth-child(3){max-width:200px;overflow-wrap:anywhere}.snapshot-table td span{color:var(--text-sub)}.safety-error,.unavailable{color:var(--danger)}.safety-error{overflow-wrap:anywhere;line-height:1.7}.safety-notice{color:var(--text-sub);line-height:1.6}.safety-empty{color:var(--text-sub);margin:12px 0}.library-safety .mono{font-size:12px}@media(max-width:1050px){.safety-facts{grid-template-columns:90px minmax(0,1fr);gap:10px}.library-safety header{gap:6px}.library-safety h2{font-size:16px}}
</style>
