import { errorMessage } from '@/utils'
import { computed, ref } from 'vue'
import type { ProjectItem, ProjectScript } from '@/types/project'
import type { ProjectLaunchInput, ProjectLaunchPreview, ProjectRun } from '@/types/project-launch'

const item = ref<ProjectItem | null>(null)
const seed = ref<ProjectLaunchInput | null>(null)
const runs = ref<ProjectRun[]>([])
const preview = ref<ProjectLaunchPreview | null>(null)
const showRuns = ref(false)
const error = ref('')
const busy = ref(false)
let subscribed = false

const active = computed(() => runs.value.filter((r) => ['starting', 'running', 'stopping'].includes(r.status)))
const api = () => window.baoyi.project.launch

async function initialize() {
  if (subscribed) return
  subscribed = true
  api().onRun((run) => {
    runs.value = [run, ...runs.value.filter((r) => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt)
  })
  try {
    const loaded = await api().runs()
    const known = new Set(runs.value.map((r) => r.id))
    runs.value = [...runs.value, ...loaded.filter((r) => !known.has(r.id))].sort((a, b) => b.startedAt - a.startedAt)
  } catch (e) {
    error.value = errorMessage(e)
  }
}

function open(value: ProjectItem, script?: ProjectScript) {
  item.value = value
  error.value = ''
  preview.value = null
  const parts = script?.runCommand?.split(' ') || []
  seed.value = script
    ? {
        name: script.name,
        kind: 'script',
        command: parts.shift() || '',
        args: parts,
        cwd: script.cwd,
        source: 'discovered',
        sourceRef: script.source,
        port: null,
        url: '',
        enabled: true
      }
    : null
}

async function openById(id: string, script?: ProjectScript) {
  try {
    const value = await window.baoyi.project.get(id)
    if (value) open(value, script)
  } catch (e) {
    error.value = errorMessage(e)
    showRuns.value = true
  }
}

async function start(projectId: string, profileId: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const plan = await api().preview(projectId, profileId)
    if (plan.profile.kind === 'preview') {
      await api().openPreview(projectId, profileId)
      return
    }
    if (plan.trusted) {
      await api().start(projectId, profileId)
      item.value = null
      showRuns.value = true
    } else {
      preview.value = plan
    }
  } catch (e) {
    error.value = errorMessage(e)
    showRuns.value = !item.value
  } finally {
    busy.value = false
  }
}

async function runScript(projectId: string, script: ProjectScript) {
  if (!script.runCommand || busy.value) return
  const parts = script.runCommand.trim().split(/\s+/)
  const command = parts.shift() || ''
  if (!command) return
  error.value = ''
  try {
    const existing = await api().profiles(projectId)
    const normalizedCwd = script.cwd === '.' ? '' : script.cwd
    let target = existing.find(
      (p) =>
        p.enabled &&
        p.kind === 'script' &&
        p.command === command &&
        JSON.stringify(p.args) === JSON.stringify(parts) &&
        (p.cwd || '') === normalizedCwd
    )
    if (!target) {
      target = await api().save(projectId, {
        name: script.name,
        kind: 'script',
        command,
        args: parts,
        cwd: normalizedCwd,
        source: 'discovered',
        sourceRef: script.source,
        port: null,
        url: '',
        enabled: true
      })
    }
    await start(projectId, target.id)
  } catch (e) {
    error.value = errorMessage(e)
    showRuns.value = true
  }
}

async function confirm(remember: boolean) {
  const plan = preview.value
  if (!plan || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api().start(plan.profile.projectId, plan.profile.id, { stamp: plan.stamp, remember })
    preview.value = null
    item.value = null
    showRuns.value = true
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

function last(id: string) {
  return runs.value.find((run) => run.projectId === id)
}

function activeFor(id: string) {
  return active.value.filter((run) => run.projectId === id)
}

async function rerun(value: ProjectItem) {
  const run = last(value.id)
  if (run) await start(value.id, run.profileId)
  else open(value)
}

export function useProjectLaunch() {
  return {
    item,
    seed,
    runs,
    active,
    preview,
    showRuns,
    error,
    busy,
    initialize,
    open,
    openById,
    start,
    runScript,
    confirm,
    last,
    activeFor,
    rerun
  }
}
