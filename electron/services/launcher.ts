import { shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getSoftware, recordLaunch } from './database'
import type { SoftwareItem } from '../../src/types'

/**
 * 把渲染进程传来的启动端路径核对回条目自己的 launchers 列表。
 * 渲染进程不可信 —— 只允许启动这个条目登记过的 exe，传别的一律退回默认启动端。
 */
function resolveTarget(item: SoftwareItem, launcherPath?: string): string {
  if (launcherPath) {
    const wanted = launcherPath.toLowerCase()
    const matched = item.launchers.find((l) => l.path.toLowerCase() === wanted)
    if (matched) return matched.path
  }
  return item.launchers.find((l) => l.is_default)?.path ?? item.exe_path
}

/**
 * 启动软件并记录使用。
 * 用 spawn 而不是 shell.openPath，是为了把工作目录设成 exe 所在目录 ——
 * 绿色软件普遍依赖同目录的配置和 dll，cwd 不对会直接启动失败。
 */
export async function launchSoftware(id: string, launcherPath?: string): Promise<boolean> {
  const item = getSoftware(id)
  if (!item) return false

  const target = resolveTarget(item, launcherPath)
  if (!fs.existsSync(target)) return false

  try {
    const child = spawn(target, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(target),
      windowsHide: false
    })
    child.on('error', () => {
      // 需要提权等场景 spawn 会失败，交给系统 shell 兜底
      void shell.openPath(target)
    })
    child.unref()
  } catch {
    const err = await shell.openPath(target)
    if (err) return false
  }

  recordLaunch(id)
  return true
}

export function revealInFolder(id: string, launcherPath?: string): void {
  const item = getSoftware(id)
  if (item) shell.showItemInFolder(resolveTarget(item, launcherPath))
}
