<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { errorMessage } from '@/utils'
import { latestOnly, STALE } from '@/composables/latestOnly'
import { onMounted, ref, watch } from 'vue'
import { useFloatingDock } from '@/composables/useFloatingDock'
import { Play, Square, Terminal, FolderOpen, Plus, Pencil, RotateCcw, ShieldOff, ExternalLink } from 'lucide-vue-next'
import ProjectDialog from './ProjectDialog.vue'
import { useProjectLaunch } from '@/composables/useProjectLaunch'
import type { ProjectApplication } from '@/types/project'
import type { ProjectLaunchProfile, ProjectLaunchInput } from '@/types/project-launch'

const launcher = useProjectLaunch()
const { item, seed, runs, active, preview, showRuns, error, busy } = launcher
const projectApi = window.baoyi.project
const api = projectApi.launch
const applications = ref<ProjectApplication[]>([])
const profiles = ref<ProjectLaunchProfile[]>([])
const projectNames = ref<Record<string, string>>({})
const editing = ref<ProjectLaunchInput | null>(null)
const argsText = ref('')
const remember = ref(true)
const loading = ref(false)

const readProfiles = latestOnly((id?: string) =>
  id ? Promise.all([api.profiles(id), projectApi.applications()]) : Promise.resolve(null)
)

async function refreshProjectNames() {
  try {
    const list = await projectApi.list()
    const map: Record<string, string> = {}
    for (const p of list) map[p.id] = p.name
    projectNames.value = map
  } catch {
    /* best-effort */
  }
}

onMounted(() => {
  void launcher.initialize()
  void refreshProjectNames()
})
watch(() => item.value?.id, () => {
  editing.value = null
  profiles.value = []
  applications.value = []
  void load()
})
watch(showRuns, (open) => {
  if (open) void refreshProjectNames()
})
watch(seed, (value) => { if (value) edit(value) })
watch(preview, () => { remember.value = true })

async function load() {
  loading.value = true
  try {
    const value = await readProfiles(item.value?.id)
    if (value === STALE) return
    if (value) {
      const [result, apps] = value
      profiles.value = result
      applications.value = apps
    }
  } catch (e) {
    error.value = errorMessage(e)
  }
  loading.value = false
}

function edit(value?: ProjectLaunchInput | ProjectLaunchProfile) {
  editing.value = value
    ? {
        ...(value.id ? { id: value.id, revision: value.revision } : {}),
        name: value.name,
        kind: value.kind,
        command: value.command,
        args: [...value.args],
        cwd: value.cwd,
        source: value.source,
        sourceRef: value.sourceRef,
        port: value.port,
        url: value.url,
        enabled: value.enabled
      }
    : { name: '', kind: 'script', command: '', args: [], cwd: '', source: 'manual', sourceRef: '', port: null, url: '', enabled: true }
  argsText.value = editing.value.args.join('\n')
  error.value = ''
}

async function act(fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await fn() } catch (e) { error.value = errorMessage(e) } finally { busy.value = false }
}

async function save() {
  if (!item.value || !editing.value) return
  const id = item.value.id
  const input = {
    ...editing.value,
    args: argsText.value ? argsText.value.split(/\r?\n/) : [],
    port: editing.value.port === null || String(editing.value.port) === '' ? null : Number(editing.value.port)
  }
  await act(async () => {
    await api.save(id, input)
    editing.value = null
    seed.value = null
    await load()
  })
}

async function chooseProgram() {
  const target = await projectApi.pickPath(false)
  if (target && editing.value) editing.value.command = target
}

async function openApplication(application: ProjectApplication) {
  if (!item.value) return
  const id = item.value.id
  await act(async () => {
    if (!application.available && !(await projectApi.selectApplication(application.id))) return
    await projectApi.openApplication(id, application.id)
    await load()
  })
}

const copyDirectory = () => window.baoyi.app.copyText(item.value!.path)
const labels = { get starting() { return tr('正在启动') }, get running() { return tr('运行中') }, get stopping() { return tr('正在停止') }, get exited() { return tr('已退出') }, get failed() { return tr('运行失败') }, get interrupted() { return tr('上次中断') } }
const chip = ref<HTMLElement>()
const dockStyle = useFloatingDock('project', chip, () => !!active.value.length || showRuns.value, 0)
</script>
<template>
  <button ref="chip" v-if="active.length||showRuns" class="project-run-chip" :style="dockStyle" @click="showRuns=true"><Terminal :size="16"/>{{active.length?$t('{p0} 个项目命令运行中', {p0: active.length}):$t('项目运行记录')}}</button>
  <ProjectDialog v-if="item&&!preview" :title="item.name+$t(' · 启动')" :busy="busy" wide @close="item=null">
    <p v-if="error" class="pj-error" role="alert">{{$systemMessage(error)}}</p>
    <template v-if="editing">
      <form id="project-launch-form" class="launch-form" @submit.prevent="save">
        <label>{{ $t("显示名称") }}<input v-model="editing.name" maxlength="160" required :placeholder="$t('如 前端开发、文档预览')"/></label>
        <label>{{ $t("用途") }}<select v-model="editing.kind"><option value="script">{{ $t("托管命令") }}</option><option value="preview">{{ $t("本机预览地址") }}</option></select></label>
        <template v-if="editing.kind!=='preview'"><label>{{ $t("可执行程序") }}<div class="launch-row"><input v-model="editing.command" :placeholder="$t('如 npm、node 或 C:\\…\\程序.exe')" required/><button class="pj-button" type="button" @click="chooseProgram">{{ $t("选择文件") }}</button></div></label><label>{{ $t("启动参数") }}<small>{{ $t("每行一个参数，空格和引号按原样传入") }}</small><textarea v-model="argsText" rows="3" placeholder="run&#10;dev"/></label><label>{{ $t("工作目录") }}<small>{{ $t("相对于项目，留空使用项目根目录") }}</small><input v-model="editing.cwd" :placeholder="$t('如 frontend')"/></label><label>{{ $t("命令来源文件") }}<small>{{ $t("修改后会重新确认") }}</small><input v-model="editing.sourceRef" :disabled="editing.source==='entry'" :placeholder="$t('如 package.json 或 scripts/start.js')"/></label></template>
        <div class="launch-row"><label>{{ $t("预览端口") }}<input v-model="editing.port" type="number" min="1" max="65535" :placeholder="$t('从日志自动识别')"/></label><label>{{ $t("预览地址") }}<input v-model="editing.url" placeholder="http://127.0.0.1:5173/"/></label></div><label class="launch-check"><input v-model="editing.enabled" type="checkbox"/>{{ $t("启用此配置") }}</label>
        <div class="launch-row"><button class="pj-button" type="button" @click="editing=null;seed=null">{{ $t("返回") }}</button><button class="pj-button pj-primary" type="submit" :disabled="busy">{{ $t("保存启动配置") }}</button></div>
      </form>
    </template>
    <template v-else>
      <div class="launch-apps"><strong>{{ $t("打开应用") }}</strong><button v-for="application in applications" :key="application.id" class="pj-button" :disabled="busy" :title="application.path||$t('选择已安装的应用')" @click="openApplication(application)">{{application.available?application.name:$t('选择 ')+application.name}}</button><button class="pj-button" @click="act(copyDirectory)">{{ $t("复制目录") }}</button></div>
      <div class="launch-row"><button class="pj-button" @click="act(()=>projectApi.reveal(item!.id))"><FolderOpen :size="15"/>{{ $t("打开文件夹") }}</button><button class="pj-button" @click="act(()=>projectApi.openTerminal(item!.id))"><Terminal :size="15"/>{{ $t("独立终端") }}</button><button class="pj-button" @click="act(()=>projectApi.open(item!.id))">{{ $t("默认入口") }}</button><button class="pj-button" @click="edit()"><Plus :size="15"/>{{ $t("添加配置") }}</button></div>
      <p v-if="loading" role="status">{{ $t("正在载入启动菜单…") }}</p><p v-else-if="!profiles.length" class="pj-muted">{{ $t("还没有常用命令。可在工作区概览发现脚本后加入，也可直接添加。") }}</p>
      <article v-for="profile in profiles" :key="profile.id" class="launch-profile"><div><strong>{{profile.name}}</strong><small>{{profile.cwd||$t('项目根目录')}} · {{profile.sourceRef||$t('手动配置')}}{{!profile.enabled?$t(' · 已停用'):''}}</small><code>{{profile.kind==='preview'?profile.url||$t('端口 {p0}', {p0: profile.port}):[profile.command,...profile.args].join(' ')}}</code></div><button class="pj-icon" :aria-label="$t('编辑 ')+profile.name" @click="edit(profile)"><Pencil :size="15"/></button><button v-if="profile.trusted" class="pj-icon" :aria-label="$t('撤销信任 ')+profile.name" @click="act(async()=>{await api.revoke(item!.id,profile.id);await load()})"><ShieldOff :size="15"/></button><button class="pj-button" :disabled="busy||!profile.enabled" @click="launcher.start(item!.id,profile.id)"><Play :size="14"/>{{profile.kind==='preview'?$t('打开'):$t('运行')}}</button><button class="pj-icon" :aria-label="$t('移除 ')+profile.name" @click="act(async()=>{await api.remove(item!.id,profile.id,profile.revision);await load()})">×</button></article>
    </template>
  </ProjectDialog>
  <ProjectDialog v-if="preview" :title="$t('确认运行项目命令')" :busy="busy" wide @close="preview=null">
    <p v-if="error" class="pj-error" role="alert">{{$systemMessage(error)}}</p><p>{{ $t("将以你当前的 Windows 权限运行以下命令。脚本可以访问文件和网络，请确认来源可信。") }}</p><dl class="launch-facts"><dt>{{ $t("项目") }}</dt><dd>{{preview.root}}</dd><dt>{{ $t("工作目录") }}</dt><dd>{{preview.cwd}}</dd><dt>{{ $t("可执行程序") }}</dt><dd>{{preview.command}}</dd><dt>{{ $t("参数") }}</dt><dd><pre>{{JSON.stringify(preview.args,null,2)}}</pre></dd></dl><details v-if="preview.sourceText"><summary>{{ $t("查看来源 · {p0}", {p0: (preview.profile.sourceRef)}) }}</summary><pre class="source-text">{{preview.sourceText}}</pre></details><label class="launch-check"><input v-model="remember" type="checkbox"/>{{ $t("记住此配置；脚本、路径或参数变化后重新确认") }}</label><p class="pj-muted">{{ $t("不会安装依赖。关闭运行面板或切换模块后，命令会继续运行。") }}</p>
    <template #footer><button class="pj-button" :disabled="busy" @click="preview=null">{{ $t("返回") }}</button><button class="pj-button pj-primary" :disabled="busy" @click="launcher.confirm(remember)"><Play :size="15"/>{{ $t("确认运行") }}</button></template>
  </ProjectDialog>
  <ProjectDialog v-if="showRuns&&!preview&&!item" :title="$t('项目运行')" wide @close="showRuns=false">
    <p class="pj-muted">{{ $t("Esc 关闭面板，命令继续运行。停止只作用于本次启动的进程。") }}</p><p v-if="error" class="pj-error" role="alert">{{$systemMessage(error)}}</p><p v-if="!runs.length">{{ $t("还没有运行记录。") }}</p>
    <article v-for="run in runs.slice(0,40)" :key="run.id" class="run-item"><header><span v-if="projectNames[run.projectId]" class="run-project-badge">{{projectNames[run.projectId]}}</span><strong>{{run.profileName}}</strong><span>{{labels[run.status]}}</span><small>{{new Date(run.startedAt).toLocaleString($locale)}}</small></header><p v-if="run.error" class="pj-error">{{$systemMessage(run.error)}}</p><pre class="run-output">{{run.lines.join('\n')||$t('等待命令输出…')}}</pre><div class="launch-row"><button v-if="run.status==='running'&&run.previewUrl" class="pj-button" @click="act(()=>api.openPreview(run.projectId,run.profileId,run.id))"><ExternalLink :size="14"/>{{ $t("打开预览") }}</button><button v-if="['starting','running','stopping'].includes(run.status)" class="pj-button" :disabled="busy||run.status==='stopping'" @click="act(()=>api.stop(run.id))"><Square :size="14"/>{{run.status==='stopping'?$t('正在停止…'):$t('停止')}}</button><button v-else class="pj-button" :disabled="busy" @click="launcher.start(run.projectId,run.profileId)"><RotateCcw :size="14"/>{{ $t("重跑命令") }}</button><button v-if="projectNames[run.projectId]" class="pj-button" @click="act(()=>projectApi.openTerminal(run.projectId))"><Terminal :size="14"/>{{ $t("终端") }}</button><details><summary>{{ $t("诊断") }}</summary><small>{{ $t("运行 {p0} · PID {p1} · 退出码 {p2}", {p0: (run.id), p1: (run.pid||'—'), p2: (run.exitCode??'—')}) }}</small></details></div></article>
  </ProjectDialog>
</template>
<style scoped>
.launch-apps{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.launch-apps>strong{font-size:12px;color:var(--text-sub);margin-right:8px}
.run-project-badge{padding:2px 7px;border-radius:var(--radius-tag);background:var(--tag-bg);color:var(--tag-text);font-size:11px}
.project-run-chip{position:fixed;right:var(--dock-right,24px);bottom:var(--dock-bottom,20px);z-index:80;display:flex;align-items:center;gap:8px;padding:11px 16px;border:1px solid var(--divider);border-radius:10px;background:var(--bg-card);box-shadow:0 3px 18px #0002;color:var(--text-main);font-size:12px}.launch-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.launch-form{display:grid;gap:16px}.launch-form label{display:block;font-size:13px}.launch-form input:not([type=checkbox]),.launch-form select,.launch-form textarea{box-sizing:border-box;display:block;width:100%;margin-top:6px;padding:9px;border:1px solid var(--divider);border-radius:6px;background:var(--bg-card);color:var(--text-main);font:inherit}.launch-form small{color:var(--text-faint);font-size:11px}.launch-form .launch-row>label{flex:1;min-width:180px}.launch-form .launch-row>input{flex:1;min-width:180px}.launch-check{display:flex!important;align-items:center;gap:8px;margin:16px 0;font-size:12px}.launch-profile{display:flex;gap:9px;align-items:center;border-top:1px solid var(--divider);padding:18px 0}.launch-profile>div{flex:1;min-width:0}.launch-profile strong,.run-item strong{font-size:14px}.launch-profile small,.launch-profile code{display:block;color:var(--text-sub);overflow-wrap:anywhere;font-size:12px;margin-top:6px}.launch-facts{display:grid;grid-template-columns:90px 1fr;font-size:12px;gap:10px}.launch-facts dd{margin:0;overflow-wrap:anywhere}.launch-facts pre{margin:0;white-space:pre-wrap}.source-text{max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12px}.run-item{padding:18px 0;border-top:1px solid var(--divider)}.run-item header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.run-item header span:not(.run-project-badge){font-size:12px;color:var(--accent)}.run-item header small{margin-left:auto;color:var(--text-faint);font-size:11px}.run-output{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;padding:12px;border:1px solid var(--divider);border-radius:6px;background:var(--hover-surface)}.run-item details{font-size:11px;color:var(--text-faint)}@media(max-width:800px){.launch-profile{flex-wrap:wrap}.launch-profile>div{flex-basis:100%}}
</style>
