/**
 * 识别链路的计时日志。v0.8.1 查「点开始识别界面就卡死」时加的，查完留着 ——
 * 这类阻塞只在真机真数据上出现，下次再犯没有这些数字就得从零重来一遍。
 *
 * 默认闭嘴：正常跑一次识别有几百次 PE 读取和几十次工具调用，全打出来会把
 * 主进程日志冲掉，本身也是一笔开销。要看就带上环境变量：
 *   $env:BAOYI_TIMING = '1'; npx electron .
 *
 * 阈值那一层是给「开着也不吵」用的：只有慢过 SLOW_MS 的才出声，
 * 所以排查时可以整程开着，日志里剩下的都是可疑的那几条。
 */

const ON = process.env.BAOYI_TIMING === '1'

/** 超过这个毫秒数才打 —— 快的那些没有信息量 */
const SLOW_MS = 50

export const timingOn = ON

/**
 * 同步段计时。阻塞主进程的就是这一类，所以它是这套日志的主力。
 *
 * 不用 console.time/timeEnd：那对 API 靠字符串标签配对，同一个标签并发
 * 重入就会互相顶掉（识别是并发跑的），而且拿不到毫秒数做阈值过滤。
 */
export function timeSync<T>(label: string, fn: () => T): T {
  if (!ON) return fn()
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - t0
    if (ms >= SLOW_MS) console.log(`[timing] ${label} ${ms.toFixed(1)}ms`)
  }
}

/** 异步段计时。异步慢不会让窗口失去响应，但会让识别整体变慢 */
export async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!ON) return fn()
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    const ms = performance.now() - t0
    if (ms >= SLOW_MS) console.log(`[timing] ${label} ${ms.toFixed(1)}ms`)
  }
}

/**
 * IPC 推送的频率和数据量。查「渲染进程被 IPC 洪泛冲垮」用的。
 *
 * 按秒聚合而不是每条一行：单条推送本身几乎从不是问题，问题是「一秒内几百条」
 * 或者「一条几 MB」，这两个都只有聚合起来才看得见。每条都打反而会让主进程
 * 自己变慢，把要查的现象搅浑。
 */
const ipcWindow = { sec: 0, count: 0, bytes: 0, top: '' }

export function countIpcSend(channel: string, payload: unknown): void {
  if (!ON) return
  // 估算就够：要的是数量级，JSON.stringify 一次比真正的结构化克隆便宜
  let bytes = 0
  try {
    bytes = JSON.stringify(payload)?.length ?? 0
  } catch {
    bytes = 0
  }
  const sec = Math.floor(performance.now() / 1000)
  if (sec !== ipcWindow.sec) {
    if (ipcWindow.count > 0) {
      console.log(
        `[ipc] 上一秒 ${ipcWindow.count} 条 / ${(ipcWindow.bytes / 1024).toFixed(1)}KB，最大一条 ${ipcWindow.top}`
      )
    }
    ipcWindow.sec = sec
    ipcWindow.count = 0
    ipcWindow.bytes = 0
    ipcWindow.top = ''
  }
  ipcWindow.count++
  ipcWindow.bytes += bytes
  if (bytes >= 64 * 1024) ipcWindow.top = `${channel} ${(bytes / 1024).toFixed(1)}KB`
}

/**
 * 主进程心跳。判「是主进程被卡住还是渲染进程被卡住」全靠它：
 * 心跳断了就是主进程的事件循环被同步代码占死了（Windows 的「未响应」正是这么来的），
 * 心跳不断而界面不动，就该去查渲染进程。
 *
 * 打的是「实际间隔」而不是「第几次」：定时器被同步代码推迟多久，一眼就看出来。
 */
export function startHeartbeat(intervalMs = 100): () => void {
  if (!ON) return () => {}
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const drift = now - last - intervalMs
    last = now
    // 只在明显被推迟时出声，否则每 100ms 一行会把日志刷没
    if (drift >= SLOW_MS) console.log(`[heartbeat] 迟到 ${drift.toFixed(0)}ms —— 主进程被同步代码占住了`)
  }, intervalMs)
  timer.unref?.()
  console.log('[heartbeat] 开始，间隔 ' + intervalMs + 'ms')
  return () => clearInterval(timer)
}
