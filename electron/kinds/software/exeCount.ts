/**
 * 递归数一个目录下有多少 exe。
 *
 * **单独成一个文件的理由是它曾经有两份。** scanPlan.ts 里一份异步的，tools.ts 里
 * 一份同步的（`fs.readdirSync` 递归）。同步那份就是「软件识别时界面卡死」的原因：
 * 主进程持有窗口消息循环，agent 每调一次 list_directory 就要对最多 120 个子目录
 * 各跑一遍同步下钻，最坏 36 万次目录项访问全压在主线程上，Windows 直接画出
 * 「抱一 未响应」。异步那份早就修好了，同步那份没人动 —— 一模一样的遍历留两份，
 * 修一份不算修。所以这里只留这一份，**且不提供任何同步版本**。
 *
 * 只读文件系统，不碰数据库、不碰 Electron，所以 selfcheck 能拿真实临时目录树跑它。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface CountOptions {
  /** 最深下钻几层。0 = 只数当前这一层 */
  maxDepth: number
  /** 数到这么多个 exe 就停手 */
  maxExes?: number
  /**
   * 访问过这么多个目录项就停手。防止在超大目录树里空转 ——
   * 光靠 maxExes 挡不住「十万个文件、一个 exe 都没有」那种目录
   */
  maxEntries?: number
  /** 返回 true 的目录不进去 */
  skip?: (name: string) => boolean
  onDir?: (dir: string) => void
  /** 返回 true 时立刻收手 */
  cancelled?: () => boolean
}

export interface CountResult {
  count: number
  /** 撞上了某个上限或被取消。此时 count 是下界，不是准确值 */
  truncated: boolean
  /** 实际访问过的目录项数。调用方拿它在多次调用之间共享总预算 */
  visited: number
}

/**
 * 每走过这么多个目录让出一次事件循环。
 *
 * `fsp.readdir` 本身就是异步的、每个目录都会让出一次，所以这个让出是给「目录多但
 * 每个都很小」那种形状兜底的 —— 那种情况下 readdir 大多能从缓存立刻返回，
 * 微任务连成一片，消息循环照样挤不进去。
 */
const YIELD_EVERY = 32

export async function countExes(root: string, opts: CountOptions): Promise<CountResult> {
  const maxExes = opts.maxExes ?? Number.POSITIVE_INFINITY
  const maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY

  let count = 0
  let visited = 0
  let truncated = false
  let walked = 0

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length > 0) {
    if (opts.cancelled?.()) return { count, truncated: true, visited }
    if (count >= maxExes || visited >= maxEntries) return { count, truncated: true, visited }

    const { dir, depth } = stack.pop()!
    opts.onDir?.(dir)

    if (++walked % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r))

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 权限不足 / 目录已消失，跳过即可
    }

    for (const entry of entries) {
      if (opts.cancelled?.()) return { count, truncated: true, visited }
      if (++visited >= maxEntries) {
        truncated = true
        break
      }
      if (entry.isDirectory()) {
        if (depth >= opts.maxDepth) continue
        if (opts.skip?.(entry.name)) continue
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') {
        if (++count >= maxExes) {
          truncated = true
          break
        }
      }
    }
  }

  return { count, truncated, visited }
}
