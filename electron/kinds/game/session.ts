/**
 * 游玩时长的记账。
 *
 * 只管「一次游玩结束时该往库里写什么」，不碰进程 —— spawn、监听退出、应用退出前
 * 收尾那些都在 service.ts 里。分开是为了让这一层能被自检驱动：时长累加、状态翻转、
 * 最短时长门槛这几条规则是这个模块唯一有判断的地方，它们必须验得到。
 *
 * 刻意**不建 sessions 表**：单次游玩的历史现在没有任何界面要读，为它开一张表
 * 就得把 SCHEMA 6 推到 7 并写迁移和回滚 —— 为一个还没有消费者的数据付这个代价
 * 不划算。总时长和上次游玩落在 game_meta 已有的两列上，这一版不动库结构。
 */

import type { PlayStatus } from '../../../src/types'
import type { SqlDb } from '../../services/schema.ts'

/**
 * 一次游玩至少要够这么久才计入总时长。
 *
 * 很多游戏是「启动器 exe 拉起真正的游戏本体然后自己退出」——
 * Steam 的、育碧的、还有一大票 RPG Maker 的一键启动脚本都这样。那种情况下我们
 * 监听到的退出发生在两三秒内，把它当成「玩了 3 秒」记进总时长，累积几十次之后
 * 这个数字就成了一句假话。宁可少记，也不能记错：时长是给用户回头看的账。
 *
 * 60 秒这个值取的是「真的进游戏看了一眼」和「启动器一闪而过」之间那道线。
 */
export const MIN_SESSION_SEC = 60

export interface SessionOutcome {
  /** 这次实际经过的秒数，原样报出来，不做门槛过滤 */
  elapsed_sec: number
  /** 是否计入了总时长 */
  counted: boolean
  /** 累加之后的总时长 */
  total_playtime_sec: number
  /** 有没有发生 unplayed → playing 的翻转 */
  status_changed: boolean
  play_status: PlayStatus
  /** 给界面直接显示的一句话 */
  message: string
}

/** 把毫秒换算成秒，向下取整。负数（系统时钟被往回调过）按 0 算 */
export function elapsedSeconds(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.floor((endedAt - startedAt) / 1000))
}

/**
 * 一次游玩结束，记账。
 *
 * 三件事分开判断，因为它们的成立条件不一样：
 *
 *   总时长   够门槛才加 —— 见 MIN_SESSION_SEC
 *   上次游玩 一律更新 —— 用户确实在这个时刻启动过它，哪怕只开了三秒
 *   游玩状态 只做 unplayed → playing 这**一个**方向的翻转
 *
 * 状态只翻这一次的理由：「想玩 → 在玩」是启动这个动作能推出来的唯一结论。
 * 玩完算不算「通关」、放下算不算「搁置」，只有用户自己知道，程序猜不出来 ——
 * 猜错了他还得回来改回去，比不猜更麻烦。
 */
export function endSession(d: SqlDb, id: string, elapsedSec: number): SessionOutcome | null {
  const row = d
    .prepare(
      `SELECT total_playtime_sec AS total, play_status AS status
         FROM game_meta WHERE resource_id = ?`
    )
    .get(id) as { total?: number; status?: string } | undefined
  // 游玩过程中条目被移除了。不补一行回去：那会让删掉的游戏自己长回来
  if (!row) return null

  const before = Number(row.total) || 0
  const status = (row.status as PlayStatus) ?? 'unplayed'
  const counted = elapsedSec >= MIN_SESSION_SEC
  const total = counted ? before + elapsedSec : before
  const next: PlayStatus = status === 'unplayed' ? 'playing' : status

  d.prepare(
    `UPDATE game_meta
        SET total_playtime_sec = ?, last_played_at = ?, play_status = ?
      WHERE resource_id = ?`
  ).run(total, Date.now(), next, id)

  return {
    elapsed_sec: elapsedSec,
    counted,
    total_playtime_sec: total,
    status_changed: next !== status,
    play_status: next,
    message: sessionMessage(elapsedSec, counted)
  }
}

/**
 * 结束时那句话。
 *
 * 没计入时不说「已记录 0 分钟」，而是说清为什么 —— 用户看到「游戏刚开就关了」
 * 会去想「哦是启动器」，看到「已记录 0 分钟」只会觉得这个功能是坏的。
 */
function sessionMessage(elapsedSec: number, counted: boolean): string {
  if (counted) return `本次游玩 ${describeDuration(elapsedSec)}`
  return `这次只运行了 ${elapsedSec} 秒，没计入时长 —— 如果是启动器拉起了游戏本体，抱一跟不到那个进程`
}

/** 时长的口语化说法。utils 里那个 formatPlaytime 在渲染进程，主进程用不了 */
function describeDuration(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}
