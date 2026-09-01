/**
 * 真机验「点开始识别，界面不会卡死」。
 *
 * v0.8.0 上的现象是点完「开始识别」，Windows 弹「抱一 未响应」，但后台结果照进库。
 * 根因是 readPeInfo 里 resedit 的版本资源解析在某个真实 exe 上同步死循环
 * （见 electron/kinds/software/peReader.ts 的注释），主进程停摆 → 窗口消息循环停摆。
 *
 * 用法（先 npm run build，profile 里要有配好 API Key 的库）：
 *   $env:BAOYI_TIMING='1'; npx electron . --user-data-dir=<profile> --remote-debugging-port=9222
 *   node --experimental-strip-types scripts/verify-identify-cdp.ts <profile>
 *
 * **判据不是「识别成功了几个」，是「主进程有没有停摆超过 5 秒」。**
 * Windows 判未响应看的就是消息循环，所以这里拿 `app:info` 的 IPC 往返当代理指标：
 * 渲染进程 → 主进程 → 渲染进程走一圈，主进程被同步代码占死时它必然回不来。
 * 光看识别结果验不到这个 —— 上一版就是这么漏过去的：结果确实进库了，界面照样卡死。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const profile = process.argv[2]
if (!profile) {
  console.error('用法: node --experimental-strip-types scripts/verify-identify-cdp.ts <profile 目录>')
  process.exit(1)
}

/** Windows 判「未响应」的门槛是 5 秒，闸门就设在这 */
const HANG_MS = 5000
/** 往返探针的间隔。比 100ms 的心跳稀，够密到不会漏掉一次几秒的停摆 */
const PROBE_MS = 300
/** 整轮识别的上限。9 个目录的量级，超了就是真出事了 */
const RUN_LIMIT_MS = 30 * 60 * 1000

const PORT = 9222
let seq = 0
const pending = new Map<number, (r: any) => void>()

async function connect(): Promise<WebSocket> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
  if (!res) throw new Error(`连不上 CDP :${PORT} —— 应用起来了吗？`)
  const page = ((await res.json()) as any[]).find((t) => t.type === 'page')
  if (!page) throw new Error('没找到 page target')
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e: any) => reject(new Error(`WS 连接失败: ${e?.message ?? e}`))
    ws.onmessage = (ev: any) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        void send(ws, 'Page.handleJavaScriptDialog', { accept: true })
      }
    }
  })
}

function send(ws: WebSocket, method: string, params: any = {}, timeoutMs = 30000): Promise<any> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 在页面里跑一段，拿返回值。awaitPromise 让它等 IPC 真的回来。 */
async function evaluate(ws: WebSocket, expr: string, timeoutMs = 30000): Promise<any> {
  const msg = await send(
    ws,
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    timeoutMs
  )
  const r = msg.result
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result?.value
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const ws = await connect()
  await send(ws, 'Runtime.enable')
  await send(ws, 'Page.enable')

  // 桥没挂上就 evaluate 会报 undefined，看起来像 API 没了，其实是驱动抢跑
  for (let i = 0; i < 60; i++) {
    if (await evaluate(ws, 'typeof window.baoyi === "object"')) break
    await sleep(500)
  }

  const units = await evaluate(ws, 'window.baoyi.scan.units()')
  const todo = units.filter((u: any) => u.status === 'pending')
  console.log(`待识别 ${todo.length} 个目录：`)
  for (const u of todo) console.log(`  ${u.dir}（${u.exe_count} 个 exe）`)
  if (todo.length === 0) {
    console.error('没有待识别目录，这一轮验不到东西 —— 先把 profile 里的库铺好')
    process.exit(1)
  }

  // 不能 await 着它：一轮要好几分钟，那条 CDP 请求会先超时。
  // 扔到 window 上自己跑，驱动这边一边探活一边轮询状态。
  await evaluate(
    ws,
    `window.__v = { done: false, result: null, err: '' };
     window.baoyi.ai.complete()
       .then((r) => { window.__v.result = r; window.__v.done = true })
       .catch((e) => { window.__v.err = String(e && e.message || e); window.__v.done = true });
     true`
  )
  console.log('\n已触发「开始识别」，开始探活……\n')

  const t0 = Date.now()
  let worst = 0
  let worstAt = 0
  let samples = 0
  let hung = false
  let result: any = null
  let err = ''

  while (Date.now() - t0 < RUN_LIMIT_MS) {
    const p0 = Date.now()
    let rtt: number
    try {
      // 一次往返：渲染进程发 IPC → 主进程同步返回 → 渲染进程收到。
      // 主进程被同步代码占死时，这个 promise 永远不 resolve。
      await evaluate(ws, 'window.baoyi.app.info().then(() => true)', HANG_MS + 2000)
      rtt = Date.now() - p0
    } catch {
      rtt = Date.now() - p0
      hung = true
    }
    samples++
    if (rtt > worst) {
      worst = rtt
      worstAt = Math.round((Date.now() - t0) / 1000)
    }
    if (rtt >= HANG_MS) {
      console.log(`  ✗ 第 ${Math.round((Date.now() - t0) / 1000)}s：IPC 往返 ${rtt}ms —— 主进程停摆了`)
      hung = true
    }

    const v = await evaluate(ws, 'window.__v').catch(() => null)
    if (v?.done) {
      result = v.result
      err = v.err
      break
    }
    if (samples % 20 === 0) {
      const cur = await evaluate(ws, 'window.__v && window.__v.done').catch(() => null)
      console.log(`  … 第 ${Math.round((Date.now() - t0) / 1000)}s，至今最慢往返 ${worst}ms，识别${cur ? '已' : '未'}结束`)
    }
    await sleep(PROBE_MS)
  }

  const elapsed = Math.round((Date.now() - t0) / 1000)
  console.log(`\n———— 结果 ————`)
  console.log(`识别耗时：${elapsed}s，探活 ${samples} 次`)
  console.log(`IPC 往返最慢：${worst}ms（第 ${worstAt}s）`)
  if (err) console.log(`识别报错：${err}`)
  if (result) {
    console.log(
      `识别产出：处理 ${result.processed}，注册 ${result.registered}，跳过 ${result.skipped}，失败 ${result.failed}，${result.tokens} tokens`
    )
  } else if (!err) {
    console.log('识别在上限内没结束')
  }

  // 库里对一遍：界面不卡是一半，结果真进库了是另一半。
  // 应用还开着（WAL 模式），只读打开偶尔会被 -shm 挡住，读不到不算验证失败
  const dbFile = path.join(profile, 'baoyi.db')
  if (fs.existsSync(dbFile)) {
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true })
      for (const r of db.prepare('select status, count(*) n from scan_units group by status').all()) {
        console.log(`  scan_units ${r.status}: ${r.n}`)
      }
      const p = db.prepare('select count(*) n from pending_software').get() as any
      console.log(`  pending_software: ${p.n} 条待确认`)
      db.close()
    } catch (e) {
      console.log(`  （库读不到：${(e as Error).message}，应用关掉后再查）`)
    }
  }

  const ok = !hung && worst < HANG_MS && Boolean(result) && !err
  console.log(`\n${ok ? '通过' : '未通过'}：主进程${hung || worst >= HANG_MS ? '有' : '没有'}停摆超过 ${HANG_MS}ms`)
  process.exit(ok ? 0 : 1)
}

void main().catch((e) => {
  console.error('驱动出错：', e.message)
  process.exit(1)
})
