/**
 * 真机验「恢复出厂清所有 kind」+「统计带上封面」。
 *
 * 用法（先 npm run build，再另开一个窗口起应用）：
 *   npx electron . --user-data-dir=<临时 profile> --remote-debugging-port=9222
 *   node --experimental-strip-types scripts/verify-reset-cdp.ts <临时 profile>
 *
 * 为什么必须真机：resetData / dataStats 在 services/database.ts 里，绑死 electron +
 * better-sqlite3，selfcheck 那条路进不来。
 *
 * 几个踩过的坑（都在 v0.6 记录里）：
 * - 新 profile 会被引导页拦住，先 settings.patch({ onboarded: true }) 再重载。
 * - window.confirm 是真模态，不自动点掉 Runtime.evaluate 永不返回 —— 挂
 *   Page.javascriptDialogOpening 自动确认。
 * - 窗口被遮住时应用内路由过渡会被冻住，所以换页用带 hash 的整页 loadURL 式跳转 + 重载。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const profile = process.argv[2]
if (!profile) {
  console.error('用法: node --experimental-strip-types scripts/verify-reset-cdp.ts <profile 目录>')
  process.exit(1)
}

const PORT = 9222
let seq = 0
const pending = new Map<number, (r: any) => void>()
/** 等 Page.loadEventFired 的人。reload 后立刻 evaluate 会撞上 document.body 还是 null */
const loadWaiters: (() => void)[] = []

function connect(): Promise<WebSocket> {
  return new Promise(async (resolve, reject) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
    if (!res) return reject(new Error(`连不上 CDP :${PORT} —— 应用起来了吗？`))
    const targets = (await res.json()) as any[]
    const page = targets.find((t) => t.type === 'page')
    if (!page) return reject(new Error('没找到 page target'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e: any) => reject(new Error(`WS 连接失败: ${e?.message ?? e}`))
    ws.onmessage = (ev: any) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        // 模态对话框：不点掉的话上一条 evaluate 永远不返回
        void send(ws, 'Page.handleJavaScriptDialog', { accept: true })
      } else if (msg.method === 'Page.loadEventFired') {
        loadWaiters.splice(0).forEach((fn) => fn())
      }
    }
  })
}

function send(ws: WebSocket, method: string, params: any = {}): Promise<any> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/**
 * 重载并等到 load 事件。
 *
 * 不等就 evaluate 的话，代码会在旧文档拆掉、新文档还没建起来的那一瞬间执行，
 * document.body 是 null —— 第一版驱动就这么挂的，报的是「读 null 的 innerText」，
 * 看起来像页面坏了，其实是驱动抢跑。
 */
async function reloadAndWait(ws: WebSocket): Promise<void> {
  const loaded = new Promise<void>((resolve) => loadWaiters.push(resolve))
  await send(ws, 'Page.reload', { ignoreCache: false })
  await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 10000))])
  // load 只保证文档在，Vue 还要挂载一轮
  await new Promise((r) => setTimeout(r, 600))
}

/** 在渲染进程里跑一段 async 代码，把返回值原样带回来 */
async function evalJs(ws: WebSocket, expr: string): Promise<any> {
  const r = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(`页面里抛了：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  }
  return r.result?.value
}

const results: { name: string; ok: boolean; detail: string }[] = []
function assert(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

async function main(): Promise<void> {
const ws = await connect()
await send(ws, 'Page.enable')
await send(ws, 'Runtime.enable')

// 新 profile 会停在引导页，先把 onboarded 拍上再重载
await evalJs(ws, `await window.baoyi.settings.patch({ onboarded: true }); return true`)
await reloadAndWait(ws)

console.log('\n【一】统计面板要认得游戏和封面')
const before = await evalJs(ws, `return await window.baoyi.data.stats()`)
console.log('  reset 前 stats:', JSON.stringify(before))

assert('software 计数正确', before.software === 3, `拿到 ${before.software}，期望 3`)
assert('games 计数正确', before.games === 2, `拿到 ${before.games}，期望 2`)
assert('units 计数正确', before.units === 4, `拿到 ${before.units}，期望 4`)
assert('icons 数到磁盘上那 5 个', before.icons === 5, `拿到 ${before.icons}，期望 5`)
assert('covers 数到磁盘上那 2 个', before.covers === 2, `拿到 ${before.covers}，期望 2`)
assert('coverBytes 不是 0', before.coverBytes === 8192, `拿到 ${before.coverBytes}，期望 8192`)
assert('iconBytes 不是 0', before.iconBytes === 5120, `拿到 ${before.iconBytes}，期望 5120`)

console.log('\n【二】设置页真的把新那几行渲染出来了')
// 两件事：
// 1. 窗口被遮住时应用内路由过渡会冻住 —— 用带 query 的整页跳转，不走 router.push。
// 2. 统计面板在「数据管理」Tab 下，默认 Tab 是「扫描与识别」。tab 由 route.query.tab
//    决定，所以 ?tab=data 一次到位。第一版驱动漏了这条，只看到 297 字符的首屏。
await evalJs(ws, `window.location.hash = '#/settings?tab=data'; return true`)
await reloadAndWait(ws)

// 固定 sleep 会赌运气，改成轮询等文案出现（最多 8 秒）
const panel = await evalJs(
  ws,
  `const want = ['游戏条目', '游戏封面', '封面占用']
   const text = () => document.body?.innerText ?? ''
   for (let i = 0; i < 40; i++) {
     if (want.every((w) => text().includes(w))) break
     await new Promise((r) => setTimeout(r, 200))
   }
   const t = text()
   return { hasGameRow: t.includes('游戏条目'), hasCoverRow: t.includes('游戏封面'),
            hasCoverBytes: t.includes('封面占用'), hash: location.hash, len: t.length }`
)
assert('设置页有「游戏条目」行', panel.hasGameRow === true, JSON.stringify(panel))
assert('设置页有「游戏封面」行', panel.hasCoverRow === true)
assert('设置页有「封面占用」行', panel.hasCoverBytes === true)

console.log('\n【三】恢复出厂要把游戏一起清掉')
const reset = await evalJs(ws, `return await window.baoyi.data.reset('all')`)
console.log('  reset 返回:', JSON.stringify(reset.summary))

const s = reset.summary
assert('summary 报了清掉 3 个软件', s.software === 3, `拿到 ${s.software}`)
assert('summary 报了清掉 2 个游戏', s.games === 2, `拿到 ${s.games}（v0.6 这里会是 undefined）`)
assert('summary 报了清掉 5 个图标', s.icons === 5, `拿到 ${s.icons}`)
assert('summary 报了清掉 2 个封面', s.covers === 2, `拿到 ${s.covers}`)
assert('summary 报了留下 2 条存档备份', s.saveBackupsKept === 2, `拿到 ${s.saveBackupsKept}`)
assert('settingsCleared 为真（mode=all）', s.settingsCleared === true, `拿到 ${s.settingsCleared}`)

const after = await evalJs(ws, `return await window.baoyi.data.stats()`)
console.log('  reset 后 stats:', JSON.stringify(after))
assert('清完软件为 0', after.software === 0, `拿到 ${after.software}`)
assert('清完游戏为 0 —— 这是这一版要修的那个 bug', after.games === 0, `拿到 ${after.games}`)
assert('清完扫描单元为 0', after.units === 0, `拿到 ${after.units}`)
assert('清完图标为 0', after.icons === 0, `拿到 ${after.icons}`)
assert('清完封面为 0', after.covers === 0, `拿到 ${after.covers}`)

console.log('\n【四】磁盘和库的实况 —— 不信应用自己的汇报，直接去看')
const iconsDir = path.join(profile, 'icons')
const coversDir = path.join(profile, 'covers')
const ls = (d: string) => { try { return fs.readdirSync(d) } catch { return [] } }

assert('icons 目录空了', ls(iconsDir).length === 0, `还剩 ${ls(iconsDir).join(', ') || '空'}`)
assert('covers 目录空了', ls(coversDir).length === 0, `还剩 ${ls(coversDir).join(', ') || '空'}`)

// 备份文件是真资产，一个都不该少
const backupRoot = path.join(profile, '假备份')
const backupFiles = ['backup-0', 'backup-1'].map((d) => path.join(backupRoot, d, 'save1.dat'))
assert(
  '存档备份文件一个没动',
  backupFiles.every((f) => fs.existsSync(f)),
  backupFiles.map((f) => `${path.basename(path.dirname(f))}=${fs.existsSync(f)}`).join(' ')
)

const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
assert('save_backups 记录还在', n(`SELECT COUNT(*) AS n FROM save_backups`) === 2)
assert('resource 表清空了', n(`SELECT COUNT(*) AS n FROM resource`) === 0)
assert('game_meta 跟着级联清了', n(`SELECT COUNT(*) AS n FROM game_meta`) === 0)
assert('software_meta 跟着级联清了', n(`SELECT COUNT(*) AS n FROM software_meta`) === 0)
assert('identify_logs 清了', n(`SELECT COUNT(*) AS n FROM identify_logs`) === 0)
db.close()

const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length} 通过，${bad.length} 失败`)
ws.close()
if (bad.length) {
  for (const b of bad) console.log(`  ✗ ${b.name} ${b.detail}`)
  process.exit(1)
}
}

main().catch((err) => {
  console.error(`驱动挂了：${err?.message ?? err}`)
  process.exit(1)
})
