/**
 * agent 的路径信任边界。
 *
 * 工具参数由模型生成，不可信 —— 所有落到文件系统上的路径都必须先过这里。
 * 单独成文件有两个原因：一是它不该依赖 electron / 数据库，二是它是唯一
 * 值得单独验证的安全逻辑（见 scripts/agent-selfcheck.ts）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 归一化到可比较的形式：解析真实路径、去掉结尾分隔符、转小写 */
export function canonical(p: string): string {
  const resolved = path.resolve(p)
  let real = resolved
  try {
    // 走一次 realpath，避免 junction / 符号链接绕过白名单
    real = fs.realpathSync.native(resolved)
  } catch {
    /* 路径还不存在或权限不足，退回字面量比较 */
  }
  return real.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * target 是否落在 root 之内（root 自身算在内）。
 * 必须按分隔符边界比较，否则 C:\Tools 会把 C:\Tools2 也算进去。
 */
export function isInside(root: string, target: string): boolean {
  const r = canonical(root)
  const t = canonical(target)
  if (t === r) return true
  return t.startsWith(`${r}\\`) || t.startsWith(`${r}/`)
}

/**
 * 把模型给的路径解析成绝对路径，并确认它落在白名单内。
 * 越界时抛出的文字会原样回灌给模型，所以要写清楚边界在哪。
 */
export function resolveInside(roots: string[], raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('path 参数不能为空')
  }
  const target = path.resolve(raw.trim())
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(
      `路径越界：${target} 不在允许访问的目录内。你只能访问 ${roots.join('、')} 之下的路径。`
    )
  }
  return target
}
