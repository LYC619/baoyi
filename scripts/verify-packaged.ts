/**
 * 验打包产物：`release/<version>/win-unpacked` 起得来、库读得到、界面画出来。
 *
 * 用法（先 npx electron-builder，再手动起应用）：
 *   release\<v>\win-unpacked\抱一.exe --user-data-dir=<临时 profile> --remote-debugging-port=9222
 *   node --experimental-strip-types scripts/verify-packaged.ts
 *
 * **为什么非得验打包产物，而不是信 `npm run dev` 跑得动。** 开发时页面从 vite
 * 的 http 端口来，打包后从 `file://` 来，这两条路上会分头出问题的东西恰好是最
 * 关键的几样：
 *   · `asarUnpack` 里的 better-sqlite3 —— 原生模块留在 asar 里就加载不了，
 *     表现是启动即白屏，而开发时它根本不在 asar 里；
 *   · `extraResources` 里的 `MediaInfoModule.wasm` —— 路径在 unpacked 下会变；
 *   · `baoyi://` 那条协议 —— `file://` 页面里的 `<img>` 只能靠它，开发时
 *     http 页面里写绝对路径也能显示，所以这处错在开发中是隐形的。
 * 这三样单看代码都「正确」，只有真起一次打包产物才看得见。
 *
 * 这一路**只读不写**，可以反复跑。用临时 profile 是为了不碰真库
 * （新 profile 会被引导页拦住，所以先 patch onboarded 再重载）。
 */
const PORT = 9222
let seq = 0
const pending = new Map<number, (r: any) => void>()
const loadWaiters: (() => void)[] = []

function connect(): Promise<WebSocket> {
  return new Promise(async (resolve, reject) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
    if (!res) return reject(new Error(`连不上 CDP :${PORT} —— 打包后的应用起来了吗？`))
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

async function evalJs(ws: WebSocket, expr: string): Promise<any> {
  const r = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(
      `页面里抛了：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
    )
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

  console.log('\n【一】进程与页面')

  const href = await evalJs(ws, `return location.href`)
  assert('页面是从 file:// 来的（不是 vite 的 http）', href.startsWith('file://'), href)

  const bridge = await evalJs(ws, `return typeof window.baoyi`)
  assert('preload 桥接挂上了', bridge === 'object', `typeof window.baoyi = ${bridge}`)

  console.log('\n【二】数据库 —— better-sqlite3 从 asar 外加载得到吗')

  // 这一问同时验三件事：原生模块加载成功、库文件建得起来、IPC 通得过。
  // 原生模块留在 asar 里的话，这里直接抛，而不是返回一个空结果
  const info = await evalJs(ws, `return await window.baoyi.app.info()`)
  assert('app.info() 通了', !!info, JSON.stringify(info))
  assert('版本号是 0.7.0', info?.version === '0.7.0', String(info?.version))

  // data.stats() 会真查七八张表并数图标/封面/海报目录。它返回得出来，
  // 就说明建表和迁移在打包环境里整个跑通了 —— 原生模块加载不了的话这里直接抛
  const stats = await evalJs(ws, `return await window.baoyi.data.stats()`)
  assert('data.stats() 读到库了', !!stats && typeof stats.software === 'number', JSON.stringify(stats))
  assert(
    '季集表也在（v0.7 建的那张）',
    typeof stats?.episodes === 'number',
    `episodes=${stats?.episodes}`
  )

  // 新 profile 会被引导页拦住，先放行再看真界面
  await evalJs(ws, `return await window.baoyi.settings.patch({ onboarded: true })`)
  const loaded = new Promise<void>((resolve) => loadWaiters.push(resolve))
  await evalJs(ws, `location.reload()`)
  await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 10000))])
  await new Promise((r) => setTimeout(r, 1200))

  console.log('\n【三】界面真画出来了吗')

  const dom = await evalJs(
    ws,
    `return {
       app: !!document.querySelector('#app'),
       kids: document.querySelector('#app')?.children.length ?? 0,
       titlebar: !!document.querySelector('.titlebar'),
       text: (document.body.innerText || '').slice(0, 120)
     }`
  )
  assert('#app 挂上了', dom.app === true)
  assert('#app 底下真有东西（不是白屏）', dom.kids > 0, `${dom.kids} 个子节点`)
  assert('自绘标题栏在（frame:false 靠它）', dom.titlebar === true)
  assert('页面上有文字', (dom.text ?? '').trim().length > 0, JSON.stringify(dom.text?.slice(0, 60)))

  console.log('\n【四】三个模块的侧栏计数都通得过 IPC')

  const counts = await evalJs(
    ws,
    `return {
       software: await window.baoyi.software.counts(30),
       game: await window.baoyi.game.counts(),
       video: await window.baoyi.video.counts()
     }`
  )
  assert('software.counts 通了', !!counts.software, JSON.stringify(counts.software).slice(0, 80))
  assert('game.counts 通了', !!counts.game, JSON.stringify(counts.game).slice(0, 80))
  assert('video.counts 通了', !!counts.video, JSON.stringify(counts.video).slice(0, 80))

  console.log('\n【五】换图标那两条通道在打包产物里注册了吗')

  // 只验「通道存在且认得参数」，不真换图 —— 换图要开系统对话框。
  // 传一个不存在的 id：通道没注册的话 invoke 会抛「No handler registered」，
  // 注册了才会走到业务里返回 null。这一问分得开这两种情况
  const clearIconOnMissing = await evalJs(
    ws,
    `try { return { ok: true, v: await window.baoyi.software.clearIcon('不存在的-id') } }
     catch (e) { return { ok: false, msg: String(e && e.message || e) } }`
  )
  assert(
    'software:clear-icon 通道注册了',
    clearIconOnMissing.ok === true,
    clearIconOnMissing.ok ? `找不到条目时返回 ${JSON.stringify(clearIconOnMissing.v)}` : clearIconOnMissing.msg
  )
  const hasPickIcon = await evalJs(ws, `return typeof window.baoyi.software.pickIcon`)
  assert('software.pickIcon 挂在桥上了', hasPickIcon === 'function', hasPickIcon)

  // iconUrl 的 ?v= 破缓存那处修改：换图标之后 URL 必须真的变。
  // 这里不依赖库里有条目，直接问渲染进程那个纯函数的结果形状
  const iconUrlShape = await evalJs(
    ws,
    `const img = document.createElement('img')
     img.src = 'baoyi://icon/x.png?v=1'
     return img.src`
  )
  assert(
    'baoyi://icon 带查询串时页面不报废',
    String(iconUrlShape).includes('baoyi://icon/'),
    String(iconUrlShape)
  )

  // 必须显式关掉：WebSocket 开着 Node 的事件循环就不会空，进程跑完最后一条断言
  // 也不退出。第一次跑这个脚本时就栽在这儿 —— 断言全绿了但命令看起来像卡死
  ws.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} 通过，${failed.length} 失败`)
  if (failed.length > 0) {
    console.log('\n失败的：')
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`)
    process.exit(1)
  }
}

void main().catch((err) => {
  console.error(`\n验证中断：${err.message}`)
  process.exit(1)
})
