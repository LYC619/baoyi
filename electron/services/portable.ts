/**
 * 绿色版模式的接线：把 `userData` 指到 exe 旁边的 `data/`。
 *
 * **为什么改一处就够**：库文件、`icons/`、`covers/`、`posters/`、`save-backups/`
 * 以及设置页那个「打开数据目录」全都是从 `app.getPath('userData')` 算出来的
 * （见 `database.ts`），所以重定向那一个键就等于把整份数据搬走。要是哪天有人绕过
 * `getPath` 直接拼 `%APPDATA%`，绿色版就会开始漏东西 —— 那种漏法很安静，
 * 表现是「删了文件夹还剩残留」。
 *
 * **调用时机是硬要求**：必须在 `app.requestSingleInstanceLock()` 和任何一次
 * `getSettings()` 之前。前者的锁文件就在 userData 里（晚了会先在旧位置建锁），
 * 后者会顺手把库开在旧位置。所以 `main.ts` 里它排在最顶上，不在 `whenReady` 里。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { decidePortable, type PortableDecision } from './portable-rules'

let decision: PortableDecision | null = null

/** 目录可写吗 —— 真去写一个临时文件试，不看权限位（Windows 上权限位不作数） */
function canWrite(dir: string): boolean {
  try {
    const probe = path.join(dir, `.baoyi-write-probe-${process.pid}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 认标记文件，认到就把 userData 指过去。返回这次的判定，供日志和 IPC 用。
 *
 * 只跑一次；重复调用直接返回上次的结果（`setPath` 调两遍不出错，但日志会翻倍）。
 */
export function initPortable(): PortableDecision {
  if (decision) return decision

  const exeDir = path.dirname(process.execPath)
  decision = decidePortable(app.isPackaged, exeDir, fs.existsSync, canWrite, path.join)

  if (decision.portable) {
    fs.mkdirSync(decision.dataDir, { recursive: true })
    app.setPath('userData', decision.dataDir)
    console.log(`[绿色版] 数据目录：${decision.dataDir}`)
  } else if (app.isPackaged) {
    console.log(`[绿色版] 未启用 —— ${decision.reason}`)
  }

  return decision
}

/** 这次启动是不是绿色版。设置页要显示，所以得能问 */
export function isPortable(): boolean {
  return decision?.portable === true
}
