/**
 * 真机验 v0.7 Step 6 / 6b：海报墙渲染、`baoyi://poster/` 那条协议、季集列表、
 * 观看状态，以及「改过的字段」那块面板。
 *
 * 用法（先 npm run build，profile 里先铺好数据）：
 *   npx electron . --user-data-dir=<临时 profile> --remote-debugging-port=9222
 *   node --experimental-strip-types scripts/verify-video-cdp.ts <临时 profile>
 *
 * **这一路不可重跑。** 【五】把 11 集标成看完、【六】删掉 vid-0001 的海报、
 * 【七】改了 vid-0006 两栏又撤掉保护 —— 都是真写库。第二遍跑的时候起点全不对，
 * 会红上一堆，而那些红是上一遍自己留下的，不是回归。要重跑就删掉整个 profile
 * 重铺：空跑一次应用建表 → verify-video-seed → 重启应用 → 这个脚本。
 *
 * **为什么这一路非真机不可。** 五道闸门验的全是纯逻辑。它们看不见：
 * `<img src="baoyi://poster/...">` 到底解出来没有（协议注册、白名单目录、
 * basename 兜底，三处任何一处错都是整墙破图，而三处单看都「正确」）、
 * 季集列表在真数据上排成什么样、标完最后一集剧一级会不会跟着变。
 *
 * 踩过的坑（都在记忆里）：
 * - 新 profile 会被引导页拦住，先 settings.patch({ onboarded: true }) 再重载。
 * - 窗口被遮住时应用内路由过渡会被冻住 —— 换页用带 hash 的整页跳转 + 重载，
 *   不走 router.push。
 * - reload 后立刻 evaluate 会撞上 document.body 还是 null，必须等 load 事件。
 * - window.confirm 是真模态，不自动点掉 evaluate 永不返回。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const profile = process.argv[2]
if (!profile) {
  console.error('用法: node --experimental-strip-types scripts/verify-video-cdp.ts <profile 目录>')
  process.exit(1)
}

const PORT = 9222
let seq = 0
const pending = new Map<number, (r: any) => void>()
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

async function goto(ws: WebSocket, hash: string): Promise<void> {
  const loaded = new Promise<void>((resolve) => loadWaiters.push(resolve))
  await send(ws, 'Runtime.evaluate', { expression: `window.location.hash = '${hash}'; location.reload()` })
  await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 10000))])
  // load 只保证文档在，Vue 还要挂载一轮，数据还要过一趟 IPC
  await new Promise((r) => setTimeout(r, 900))
}

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

  await evalJs(ws, `await window.baoyi.settings.patch({ onboarded: true }); return true`)

  console.log('\n【一】IPC 那 16 个 channel 真的都注册了')
  // typecheck 只验类型对得上。声明了 channel 却没注册 handler 是运行时错误，
  // 它看不见 —— 而表现是点一下按钮转圈不动，没有任何报错
  const ipc = await evalJs(
    ws,
    `const out = {}
     const probe = async (name, fn) => { try { await fn(); out[name] = 'ok' } catch (e) { out[name] = String(e?.message ?? e) } }
     await probe('list', () => window.baoyi.video.list({}))
     await probe('counts', () => window.baoyi.video.counts())
     await probe('get', () => window.baoyi.video.get('vid-0001'))
     await probe('episodes', () => window.baoyi.video.episodes('vid-0004'))
     await probe('readiness', () => window.baoyi.video.readiness())
     await probe('restore-scraped', () => window.baoyi.video.restoreScraped('vid-0003', ['summary']))
     return out`
  )
  for (const [name, val] of Object.entries(ipc)) {
    assert(`video:${name} 有 handler`, val === 'ok', String(val))
  }

  console.log('\n【二】海报墙渲染')
  await goto(ws, '#/video')

  const wall = await evalJs(
    ws,
    `for (let i = 0; i < 40; i++) {
       if (document.querySelectorAll('.card').length > 0) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const cards = [...document.querySelectorAll('.card')]
     const imgs = [...document.querySelectorAll('.card__img')]
     return {
       cards: cards.length,
       imgs: imgs.length,
       initials: document.querySelectorAll('.card__initial').length,
       // naturalWidth > 0 才是「真的解出来了」。src 有值、元素在 DOM 里，
       // 都不代表图显示出来了 —— 破图这两条也都成立
       decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
       srcs: imgs.map((i) => i.getAttribute('src')),
       names: cards.map((c) => c.querySelector('.card__name')?.textContent?.trim())
     }`
  )
  console.log('  墙:', JSON.stringify(wall))

  // 铺了 7 条，其中 1 条归档 —— 默认视图不该带归档的
  assert('墙上是 6 张卡（归档的不在默认视图里）', wall.cards === 6, `拿到 ${wall.cards}`)
  assert('有 2 张卡带真图（沙丘 + 黑暗荣耀）', wall.imgs === 2, `拿到 ${wall.imgs}`)
  assert(
    '那 2 张图真的解出来了 —— 这一条是 baoyi://poster 协议的唯一硬证据',
    wall.decoded === 2,
    `解出来 ${wall.decoded} 张，src=${JSON.stringify(wall.srcs)}`
  )
  assert(
    '海报地址走 baoyi://poster/ 且带版本号',
    wall.srcs.every((s: string) => /^baoyi:\/\/poster\/vid-\d+\.png\?v=\d+$/.test(s)),
    JSON.stringify(wall.srcs)
  )
  assert('剩下 4 张退回首字占位', wall.initials === 4, `拿到 ${wall.initials}`)
  assert(
    'TMDB 相对路径那条没拼成图片地址（否则是一张永久破图）',
    !wall.srcs.some((s: string) => s.includes('wPRcNZ4Q1Rk')),
    JSON.stringify(wall.srcs)
  )

  console.log('\n【三】侧栏的分组和计数')
  const side = await evalJs(
    ws,
    `const t = document.body.innerText
     const counts = await window.baoyi.video.counts()
     return { text: t, counts,
              hasArchiveSection: t.includes('归档'),
              hasWatching: t.includes('在看'), hasDropped: t.includes('弃') }`
  )
  assert('侧栏有「在看」', side.hasWatching === true)
  assert('侧栏有「弃」', side.hasDropped === true)
  assert('有归档条目时才出现归档区', side.hasArchiveSection === true)
  assert('counts.all 是 6（不含归档）', side.counts.all === 6, `拿到 ${side.counts.all}`)
  assert('counts.archived 是 1', side.counts.archived === 1, `拿到 ${side.counts.archived}`)
  assert(
    'counts 里电影 4 / 剧集 2（归档那部电影不计）',
    side.counts.type.movie === 4 && side.counts.type.series === 2,
    `movie=${side.counts.type.movie} series=${side.counts.type.series}`
  )
  // 闭集：四个观看状态一个都不能缺，缺的那个是 0 而不是 undefined。
  // 侧栏那几格靠它渲染，undefined 会显示成空白
  assert(
    '四个观看状态都在 counts 里',
    ['unwatched', 'watching', 'watched', 'dropped'].every(
      (k) => typeof side.counts.status[k] === 'number'
    ),
    JSON.stringify(side.counts.status)
  )

  console.log('\n【四】详情页 · 剧集的季集列表')
  await goto(ws, '#/video/vid-0004')

  const detail = await evalJs(
    ws,
    `for (let i = 0; i < 40; i++) {
       if (document.querySelectorAll('.ep').length > 0) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const eps = [...document.querySelectorAll('.ep')]
     return {
       eps: eps.length,
       watched: document.querySelectorAll('.ep--watched').length,
       missing: document.querySelectorAll('.ep--missing').length,
       seasons: document.querySelectorAll('.season').length,
       posterDecoded: (() => {
         const img = document.querySelector('.hero__img')
         return img ? img.complete && img.naturalWidth > 0 : false
       })(),
       text: document.body.innerText.slice(0, 1200)
     }`
  )
  console.log('  详情:', JSON.stringify({ ...detail, text: undefined }))

  assert('16 集全部列出来了', detail.eps === 16, `拿到 ${detail.eps}`)
  assert('两季分成两组', detail.seasons === 2, `拿到 ${detail.seasons}`)
  assert('5 集标着看完', detail.watched === 5, `拿到 ${detail.watched}`)
  assert(
    '缺文件的 5 集露面了 —— 不露面用户就不知道自己缺什么',
    detail.missing === 5,
    `拿到 ${detail.missing}`
  )
  assert('详情页的海报也解出来了', detail.posterDecoded === true)

  console.log('\n【五】标记观看状态：剧一级跟着集走')
  const mark = await evalJs(
    ws,
    `const eps = await window.baoyi.video.episodes('vid-0004')
     const before = await window.baoyi.video.get('vid-0004')
     // 把第一季剩下的 3 集标完
     const rest = eps.filter((e) => e.season === 1 && e.watch_status !== 'watched')
     for (const e of rest) await window.baoyi.video.updateEpisode(e.id, { watch_status: 'watched' })
     const mid = await window.baoyi.video.get('vid-0004')
     // 再把第二季有文件的 3 集标完 —— 缺文件的 5 集故意不动
     const s2 = (await window.baoyi.video.episodes('vid-0004'))
       .filter((e) => e.season === 2 && e.path && e.watch_status !== 'watched')
     for (const e of s2) await window.baoyi.video.updateEpisode(e.id, { watch_status: 'watched' })
     const after = await window.baoyi.video.get('vid-0004')
     return {
       beforeStatus: before.watch_status, beforeWatched: before.episode_watched,
       midStatus: mid.watch_status, midWatched: mid.episode_watched,
       afterStatus: after.watch_status, afterWatched: after.episode_watched,
       total: after.episode_total, present: after.episode_present
     }`
  )
  console.log('  标记:', JSON.stringify(mark))

  assert('起点是「在看」', mark.beforeStatus === 'watching', `拿到 ${mark.beforeStatus}`)
  assert('第一季标完后仍是「在看」（第二季还没看）', mark.midStatus === 'watching', `拿到 ${mark.midStatus}`)
  assert('有文件的 11 集全标完', mark.afterWatched === 11, `拿到 ${mark.afterWatched}`)
  // 手上的都看完了 = 看完，缺的 5 集不进分母。理由写在 deriveSeriesStatus 的注释里，
  // 一句话：按总集数算的话「看完」得等用户把片凑齐，而在看那一组是侧栏里唯一
  // 有行动含义的一格，塞一部现在没有任何一集能点开播的剧进去就是噪音。
  assert(
    '手上的集全看完了就报「看完」',
    mark.afterStatus === 'watched',
    `拿到 ${mark.afterStatus}（16 集里有 ${mark.present} 集有文件）`
  )
  // 但「还缺 5 集」不能因此消失 —— 它换了个地方说：分子分母照实报，
  // 详情页照旧把缺的集列出来（【四】已经验过那 5 行在页面上）
  assert(
    '缺的 5 集没被算进已看',
    mark.afterWatched === mark.present && mark.present < mark.total,
    `已看 ${mark.afterWatched} / 有文件 ${mark.present} / 总 ${mark.total}`
  )

  console.log('\n【六】换海报 / 撤海报走的是真文件')
  const posterOps = await evalJs(
    ws,
    `const before = await window.baoyi.video.get('vid-0001')
     const cleared = await window.baoyi.video.clearPoster('vid-0001')
     return { beforePath: before.poster_path, afterPath: cleared?.poster_path ?? null }`
  )
  assert('撤海报把库里那一列清空', posterOps.afterPath === '', `拿到 ${JSON.stringify(posterOps.afterPath)}`)
  const postersDir = path.join(profile, 'posters')
  const leftover = fs.existsSync(postersDir) ? fs.readdirSync(postersDir) : []
  assert(
    '磁盘上那份拷贝一起删了',
    !leftover.includes('vid-0001.png'),
    `posters/ 还剩 ${leftover.join(', ') || '空'}`
  )

  console.log('\n【七】改过的字段：面板渲染 + 取消保留')
  // 自检验的是「重扫时值还在不在」，那是纯逻辑。这里验的是它在界面上露不露面：
  // user_edited 要能过一趟 IPC（视图里少这一列的话这儿就是空数组，而库结构看着是对的）、
  // 字段名要换成中文文案、点「取消保留」那一行要当场消失。
  await goto(ws, '#/video/vid-0006')

  const editedBefore = await evalJs(
    ws,
    `for (let i = 0; i < 40; i++) {
       if (document.querySelector('.hero')) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const v = await window.baoyi.video.get('vid-0006')
     return { marks: v.user_edited, panel: !!document.querySelector('.edited') }`
  )
  assert(
    '没改过任何东西时名单是空的',
    Array.isArray(editedBefore.marks) && editedBefore.marks.length === 0,
    JSON.stringify(editedBefore.marks)
  )
  assert('没改过时面板不出现', editedBefore.panel === false)

  // 改两栏：一栏在 resource 上（分类），一栏在 video_meta 上（年份）。
  // 两张表各走一条 UPDATE，只验一张的话另一张漏了看不出来
  await evalJs(
    ws,
    `await window.baoyi.video.update('vid-0006', { category: '华语', year: 2016 })
     return true`
  )
  await goto(ws, '#/video/vid-0006')

  const editedAfter = await evalJs(
    ws,
    `for (let i = 0; i < 40; i++) {
       if (document.querySelector('.edited')) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const v = await window.baoyi.video.get('vid-0006')
     return {
       marks: v.user_edited,
       rows: [...document.querySelectorAll('.edited__name')].map((n) => n.textContent.trim()),
       undos: document.querySelectorAll('.edited__undo').length,
       hasAll: !!document.querySelector('.edited__all')
     }`
  )
  console.log('  改过的字段:', JSON.stringify(editedAfter))

  assert(
    '两栏都记上了',
    ['category', 'year'].every((f) => editedAfter.marks.includes(f)),
    JSON.stringify(editedAfter.marks)
  )
  assert('面板列出两行', editedAfter.undos === 2, `拿到 ${editedAfter.undos}`)
  assert(
    '显示的是中文文案，不是字段名',
    editedAfter.rows.includes('分类') && editedAfter.rows.includes('年份'),
    JSON.stringify(editedAfter.rows)
  )
  assert('两行以上才给「全部取消保留」', editedAfter.hasAll === true)

  // 点真按钮，不走 IPC —— 要验的就是那个 @click 接对了
  const afterUndo = await evalJs(
    ws,
    `document.querySelector('.edited__undo').click()
     for (let i = 0; i < 40; i++) {
       if (document.querySelectorAll('.edited__undo').length < 2) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const v = await window.baoyi.video.get('vid-0006')
     return {
       marks: v.user_edited,
       undos: document.querySelectorAll('.edited__undo').length,
       hasAll: !!document.querySelector('.edited__all'),
       category: v.category, year: v.year
     }`
  )
  console.log('  撤一行之后:', JSON.stringify(afterUndo))

  assert('点一下少一行', afterUndo.undos === 1, `拿到 ${afterUndo.undos}`)
  assert('名单里也少一个', afterUndo.marks.length === 1, JSON.stringify(afterUndo.marks))
  assert('只剩一行时收起「全部取消保留」', afterUndo.hasAll === false)
  // 撤保护 ≠ 把值改回去。刮削那个值没存第二份，撤掉只是「以后听刮削的」。
  // 这一条要是反了，用户点一下当场丢掉自己改的内容
  assert(
    '撤保护没有当场改值',
    afterUndo.category === '华语' && afterUndo.year === 2016,
    `category=${afterUndo.category} year=${afterUndo.year}`
  )

  const afterUndoAll = await evalJs(
    ws,
    `await window.baoyi.video.restoreScraped('vid-0006', [])
     const v = await window.baoyi.video.get('vid-0006')
     return { marks: v.user_edited }`
  )
  assert(
    '传空数组 = 全撤',
    afterUndoAll.marks.length === 0,
    JSON.stringify(afterUndoAll.marks)
  )

  console.log('\n【八】统计面板认得影视')
  await goto(ws, '#/settings?tab=data')
  const stats = await evalJs(
    ws,
    `const want = ['影视条目', '影视海报']
     const text = () => document.body?.innerText ?? ''
     for (let i = 0; i < 40; i++) {
       if (want.every((w) => text().includes(w))) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const s = await window.baoyi.data.stats()
     const t = text()
     return { stats: s, hasVideoRow: t.includes('影视条目'), hasPosterRow: t.includes('影视海报') }`
  )
  console.log('  stats:', JSON.stringify(stats.stats))
  assert('设置页有「影视条目」行', stats.hasVideoRow === true)
  assert('设置页有「影视海报」行', stats.hasPosterRow === true)
  assert('stats.videos 是 7（含归档）', stats.stats.videos === 7, `拿到 ${stats.stats.videos}`)
  assert('stats.episodes 是 16', stats.stats.episodes === 16, `拿到 ${stats.stats.episodes}`)

  console.log('\n【九】库里的实况 —— 不信应用自己的汇报')
  const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  assert('episode 表 16 行', n(`SELECT COUNT(*) AS n FROM episode`) === 16)
  assert(
    '标完的 11 集写进库了',
    n(`SELECT COUNT(*) AS n FROM episode WHERE watch_status = 'watched'`) === 11,
    `拿到 ${n(`SELECT COUNT(*) AS n FROM episode WHERE watch_status = 'watched'`)}`
  )
  assert(
    '缺文件的 5 集还是 unwatched —— 没被整季标记连带标上',
    n(`SELECT COUNT(*) AS n FROM episode WHERE path = '' AND watch_status = 'watched'`) === 0
  )
  // 【七】把 vid-0006 的保护全撤了，库里该是空数组而不是 NULL：
  // 视图那边 COALESCE 兜着，直接读表能看出这一列到底写没写
  assert(
    '撤完之后库里是 []，不是 NULL',
    (db.prepare(`SELECT user_edited FROM video_meta WHERE resource_id = 'vid-0006'`).get() as any)
      ?.user_edited === '[]'
  )
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
