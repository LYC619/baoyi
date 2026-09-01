/**
 * 真机验 v0.7 Step 6 / 6b / 7：海报墙渲染、`baoyi://poster/` 那条协议、季集列表、
 * 观看状态、「改过的字段」那块面板，以及播放和字幕。
 * v0.8 加了【十】：里番那一格、hanime 按钮、点标签筛选。
 *
 * 用法（先 npm run build，profile 里先铺好数据）：
 *   npx electron . --user-data-dir=<临时 profile> --remote-debugging-port=9222
 *   node --experimental-strip-types scripts/verify-video-cdp.ts <临时 profile>
 *
 * **这一路不可重跑。** 【六】把 11 集标成看完、【七】删掉 vid-0001 的海报、
 * 【八】改了 vid-0006 两栏又撤掉保护、【十一】把 vid-0008 从未看推成在看 —— 都是真
 * 写库。第二遍跑的时候起点全不对，会红上一堆，而那些红是上一遍自己留下的，不是
 * 回归。要重跑就删掉整个 profile
 * 重铺：空跑一次应用建表 → verify-video-seed → 重启应用 → 这个脚本。
 *
 * 顺序上有两处是绑死的，挪之前先读注释：【五】必须在【六】之前（标记会把断点
 * 那一层验没了），【十一】必须在所有 DOM 断言之后（记事本抢焦点）。
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
 *
 * **【十一】会真弹一个记事本出来**，脚本在同一节里立刻杀掉它，不留到最后：记事本
 * 抢走前台会把 Electron 窗口的 rAF 掐掉，之后的页面查询看起来像是卡死（v0.6 记过
 * 这个坑）。它后面还有一节要跳页读 innerText（【十二】），靠的就是那次杀干净。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SEED_EXPECT, SEED_HENTAI, SEED_VIDEOS } from './lib/video-seed-data.ts'

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

/** 记事本的 pid 集合。【八】要真开一个出来，开完得收拾干净 */
function notepadPids(): Set<string> {
  try {
    const out = execSync('tasklist /fi "imagename eq notepad.exe" /nh /fo csv', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // 大小写不敏感：Win11 的记事本是商店应用，tasklist 报的是 `Notepad.exe`
    // 大写 N。过滤器本身不区分大小写，栽在这个正则上过一次了
    return new Set([...out.matchAll(/^"notepad\.exe","(\d+)"/gim)].map((m) => m[1]))
  } catch {
    return new Set()
  }
}

/**
 * 只杀这个脚本自己开出来的那些记事本。
 *
 * 不用 `Stop-Process -Name notepad`：用户自己开着的记事本里可能有没存的东西，
 * 验证脚本把它连带关掉是真丢数据。所以开之前记一遍 pid，开之后只杀新出现的。
 *
 * Win11 的记事本是多标签的，已经开着的话新文件会变成一个标签、不产生新进程 ——
 * 那种情况下这里一个都杀不掉，是对的：那个进程不是我们开的。真机上看到「杀掉 0 个」
 * 而屏幕上确实弹了一个，先想这条，再想是不是又栽在进程名上。
 *
 * 商店版记事本一次会起两个进程（一个开窗口、一个后台），所以正常一趟报 2。
 */
function killNotepads(before: Set<string>): number {
  const fresh = [...notepadPids()].filter((p) => !before.has(p))
  for (const pid of fresh) {
    try {
      execSync(`taskkill /pid ${pid} /f`, { stdio: 'ignore' })
    } catch {
      /* 自己已经退了就算了 */
    }
  }
  return fresh.length
}

async function main(): Promise<void> {
  const ws = await connect()
  await send(ws, 'Page.enable')
  await send(ws, 'Runtime.enable')

  await evalJs(ws, `await window.baoyi.settings.patch({ onboarded: true }); return true`)

  console.log('\n【一】IPC 那 19 个 channel 真的都注册了')
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
     // 这两条只验「handler 在」，不验能不能打开：vid-0003 的路径是假的，
     // 走到 existsSync 那一步就返回了，不会真弹播放器出来。
     // 真调起播放器那一条排在最后一节，理由见文件头
     await probe('play', () => window.baoyi.video.play('vid-0003'))
     await probe('reveal-subtitle', () => window.baoyi.video.revealSubtitle('vid-0003', 'D:\\\\不存在.srt'))
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

  // 期望值从 seed 的**声明**算（见 lib/video-seed-data.ts 顶部注释），不写死数字：
  // 铺的数据一改，写死的那些会集体过期，而过期的表现是验证脚本自己红一片
  assert(
    `墙上是 ${SEED_EXPECT.live} 张卡（归档的不在默认视图里）`,
    wall.cards === SEED_EXPECT.live,
    `拿到 ${wall.cards}`
  )
  assert(
    `有 ${SEED_EXPECT.realPosters} 张卡带真图`,
    wall.imgs === SEED_EXPECT.realPosters,
    `拿到 ${wall.imgs}`
  )
  assert(
    `那 ${SEED_EXPECT.realPosters} 张图真的解出来了 —— 这一条是 baoyi://poster 协议的唯一硬证据`,
    wall.decoded === SEED_EXPECT.realPosters,
    `解出来 ${wall.decoded} 张，src=${JSON.stringify(wall.srcs)}`
  )
  assert(
    '海报地址走 baoyi://poster/ 且带版本号',
    wall.srcs.every((s: string) => /^baoyi:\/\/poster\/vid-\d+\.png\?v=\d+$/.test(s)),
    JSON.stringify(wall.srcs)
  )
  assert(
    `剩下 ${SEED_EXPECT.initials} 张退回首字占位`,
    wall.initials === SEED_EXPECT.initials,
    `拿到 ${wall.initials}`
  )
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
  assert(
    `counts.all 是 ${SEED_EXPECT.live}（不含归档）`,
    side.counts.all === SEED_EXPECT.live,
    `拿到 ${side.counts.all}`
  )
  assert(
    `counts.archived 是 ${SEED_EXPECT.archived}`,
    side.counts.archived === SEED_EXPECT.archived,
    `拿到 ${side.counts.archived}`
  )
  assert(
    `counts 里电影 ${SEED_EXPECT.movies} / 剧集 ${SEED_EXPECT.series}（归档那部电影不计）`,
    side.counts.type.movie === SEED_EXPECT.movies &&
      side.counts.type.series === SEED_EXPECT.series,
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
  // v0.8 补的一条。v0.7 的 seed 把 tags 铺成了逗号分隔的字符串，而那一列存的是
  // JSON 数组 —— 于是 counts.tags 一直是空的，侧栏那段 v-if 从来没渲染过，
  // 而当时没有任何一条断言看过标签，所以一路绿着。补上这条，塌了会立刻现形
  assert(
    `侧栏标签区拿到 ${SEED_EXPECT.tagNames.length} 个标签（seed 的 tags 真被解出来了）`,
    Array.isArray(side.counts.tags) && side.counts.tags.length === SEED_EXPECT.tagNames.length,
    `拿到 ${JSON.stringify((side.counts.tags ?? []).map((t: any) => t.name))}`
  )
  // detail 那一栏在通过时也会打出来（assert 的既有行为），所以写成实测值而不是
  // 「没渲染」这类结论 —— 否则绿灯旁边跟着一句像是失败的话
  assert('标签区出现在页面上', side.text.includes('标签'), `页面含「标签」=${side.text.includes('标签')}`)

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

  console.log('\n【五】播放键指着哪一集（Step 7）')
  // **必须排在【六】标记之前。** 【六】会把有文件的 11 集全标成看完，之后
  // `resumeEpisode` 三层规则里的前两层都空了，答案落到「第一集」——「断点优先」
  // 这条规则就再也验不出来了。这一节还在 vid-0004 的详情页上，不用重新跳
  const play = await evalJs(
    ws,
    `const btn = document.querySelector('.detail__play')
     return {
       label: btn?.textContent?.trim() ?? null,
       disabled: btn ? btn.disabled : null,
       // 每行那个悬停才亮的三角，DOM 里应该一直在（只是 opacity: 0）
       rowPlays: document.querySelectorAll('.ep__play').length,
       rows: document.querySelectorAll('.ep').length
     }`
  )
  console.log('  播放键:', JSON.stringify(play))
  assert('详情页有播放键', play.label !== null, '找不到 .detail__play')
  assert('播放键没被禁用（这部剧有文件）', play.disabled === false, `disabled=${play.disabled}`)
  // 断点在 S02E02（seed 给了 position_sec: 812）。要是标签写的是 S01E06，
  // 说明界面走的是「第一集没看完的」那条，把断点这一层漏了。
  // 这个标签是 Detail.vue 自己算的第二份实现，selfcheck 验的是 db.ts 那份 ——
  // 两边算出不同答案的时候，用户看到的是标签，点开的是另一集
  assert(
    '播放键指着断点那一集 S02E02，而不是 S01E06',
    typeof play.label === 'string' && play.label.includes('S02E02'),
    `标签是「${play.label}」`
  )
  // 缺文件的 5 集也该有自己的三角（点了会提示文件不在），所以是 16 不是 11
  assert('每一集都有自己的播放键', play.rowPlays === 16, `拿到 ${play.rowPlays} 个 / ${play.rows} 行`)

  console.log('\n【六】标记观看状态：剧一级跟着集走')
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

  console.log('\n【七】换海报 / 撤海报走的是真文件')
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

  console.log('\n【八】改过的字段：面板渲染 + 取消保留')
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

  console.log('\n【九】字幕面板 + 播放打不开时的样子')
  await goto(ws, '#/video/vid-0001')
  const subs = await evalJs(
    ws,
    `const t = document.body.innerText
     return {
       ext: document.querySelectorAll('.sub').length,
       hasExtPanel: t.includes('外挂字幕'),
       hasEmbedded: t.includes('内嵌字幕'),
       labels: [...document.querySelectorAll('.sub__label')].map((e) => e.textContent.trim())
     }`
  )
  console.log('  字幕:', JSON.stringify(subs))
  // seed 给 vid-0001 铺了 1 条内嵌 + 2 条外挂。两块面板分开渲染，是因为这两种
  // 东西用户能做的事不一样：外挂的能在文件夹里翻出来，内嵌的只能看着
  assert('有「内嵌字幕」这一行', subs.hasEmbedded === true)
  assert('有「外挂字幕」那块面板', subs.hasExtPanel === true)
  assert('外挂字幕列了 2 条', subs.ext === 2, `拿到 ${subs.ext}`)
  assert(
    '外挂那两条没把内嵌的混进来',
    !subs.labels.some((l: string) => l.includes('国语')),
    JSON.stringify(subs.labels)
  )

  // 文件不在了的那条路。播放失败最容易退化成「点了没反应」—— 这里验的是
  // 主进程确实回了一句能显示的话，而不是静默返回
  const miss = await evalJs(ws, `return await window.baoyi.video.play('vid-0003')`)
  console.log('  打不开的:', JSON.stringify(miss))
  assert('假路径播放返回 ok: false', miss.ok === false, JSON.stringify(miss))
  assert(
    '失败时 message 有内容（否则界面上就是「点了没反应」）',
    typeof miss.message === 'string' && miss.message.length > 0,
    `message=${JSON.stringify(miss.message)}`
  )

  // 越界的字幕路径。这一条不点界面按钮，直接打通道：`showItemInFolder` 能打开
  // 任何位置，而这个通道从渲染进程过来。真放行了会弹出资源管理器，那本身就是
  // 失败的样子 —— 所以断言的是「没弹」
  const foreign = await evalJs(
    ws,
    `return await window.baoyi.video.revealSubtitle('vid-0001', 'C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts')`
  )
  assert('不认这条资源的字幕路径被挡掉了', foreign === false, `返回 ${JSON.stringify(foreign)}`)

  console.log(`\n【十】里番这一格 + hanime 按钮 + 点标签筛选（v0.8）`)
  // 排在【十一】记事本之前：那一节抢焦点，之后的 DOM 查询不可靠
  await goto(ws, '#/video')
  const hentaiSide = await evalJs(
    ws,
    `for (let i = 0; i < 40; i++) {
       if (document.querySelectorAll('.row').length > 0) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const rows = [...document.querySelectorAll('.row')]
     const row = rows.find((r) => r.querySelector('.row__label')?.textContent?.trim() === '${SEED_HENTAI}')
     const counts = await window.baoyi.video.counts()
     return {
       present: !!row,
       count: row?.querySelector('.row__count')?.textContent?.trim() ?? '',
       inCounts: (counts.categories ?? []).find((c) => c.name === '${SEED_HENTAI}')?.count ?? -1,
       cats: (counts.categories ?? []).map((c) => c.name)
     }`
  )
  console.log('  里番格:', JSON.stringify(hentaiSide))
  // 这一条是第三节那个「界面免费」说法的**唯一**真机证据：Sidebar 那段 v-for
  // 是通用的，所以只要分类行进了库、有条目挂着，这一格就该自己长出来
  assert(`侧栏长出了「${SEED_HENTAI}」这一格（没写界面代码）`, hentaiSide.present === true, JSON.stringify(hentaiSide.cats))
  assert(
    `那一格的计数是 ${SEED_EXPECT.hentai}`,
    hentaiSide.count === String(SEED_EXPECT.hentai),
    `显示 ${JSON.stringify(hentaiSide.count)}`
  )
  assert(
    `counts.categories 里也是 ${SEED_EXPECT.hentai}`,
    hentaiSide.inCounts === SEED_EXPECT.hentai,
    `拿到 ${hentaiSide.inCounts}`
  )

  const hentaiWall = await evalJs(
    ws,
    `const rows = [...document.querySelectorAll('.row')]
     const row = rows.find((r) => r.querySelector('.row__label')?.textContent?.trim() === '${SEED_HENTAI}')
     row.click()
     for (let i = 0; i < 40; i++) {
       await new Promise((r) => setTimeout(r, 200))
       const n = document.querySelectorAll('.card').length
       if (n > 0 && n <= ${SEED_EXPECT.hentai}) break
     }
     return {
       cards: document.querySelectorAll('.card').length,
       names: [...document.querySelectorAll('.card__name')].map((e) => e.textContent.trim()),
       heading: document.querySelector('h1')?.textContent?.trim() ?? ''
     }`
  )
  console.log('  筛后的墙:', JSON.stringify(hentaiWall))
  // 点侧栏那一格是**同页**筛选（store.select 改 query 再 load），不走路由，
  // 所以不受「窗口被遮住时路由过渡冻住」那条限制
  assert(
    `点里番只剩 ${SEED_EXPECT.hentai} 张卡`,
    hentaiWall.cards === SEED_EXPECT.hentai,
    `拿到 ${hentaiWall.cards}：${JSON.stringify(hentaiWall.names)}`
  )
  const hentaiNames = SEED_VIDEOS.filter((v) => v.category === SEED_HENTAI && !v.archived).map((v) => v.name)
  assert(
    '筛出来的正是那两条，没混进别的分类',
    hentaiNames.every((n) => hentaiWall.names.includes(n)) &&
      hentaiWall.names.length === hentaiNames.length,
    `期望 ${JSON.stringify(hentaiNames)}，拿到 ${JSON.stringify(hentaiWall.names)}`
  )

  // 详情页：刮到条目号的那条
  await goto(ws, '#/video/vid-0009')
  const withId = await evalJs(
    ws,
    `// 等的是 .tag 而不是 .btn：按钮在页头，标签面板在下面，先到的是按钮，
     // 拿它当就绪信号会在标签还没挂上的时候就去查
     for (let i = 0; i < 40; i++) {
       if (document.querySelectorAll('.tag').length > 0) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const btns = [...document.querySelectorAll('.btn')]
     const find = (label) => btns.find((b) => b.textContent.trim() === label)
     const h = find('hanime')
     const tags = [...document.querySelectorAll('.tag')]
     return {
       hanime: !!h,
       hanimeTitle: h?.getAttribute('title') ?? '',
       tmdbDisabled: find('TMDB')?.disabled ?? null,
       doubanDisabled: find('豆瓣')?.disabled ?? null,
       tagLabels: tags.map((t) => t.textContent.trim()),
       clickableTags: tags.filter((t) => t.classList.contains('tag--clickable')).length,
       tagIsButton: tags.filter((t) => t.tagName === 'BUTTON').length
     }`
  )
  console.log('  有 id 的:', JSON.stringify(withId))
  assert('刮到条目号时 hanime 按钮在', withId.hanime === true)
  assert(
    'hanime 按钮指向 watch?v=86994',
    withId.hanimeTitle.includes('watch?v=86994'),
    `title=${JSON.stringify(withId.hanimeTitle)}`
  )
  // 里番在 TMDB / 豆瓣上没有条目，那两个按钮该是常驻置灰。三个按钮并排时行为
  // 各不相同（两个置灰 + 一个隐藏），这一条钉住的就是「不一致是故意的」
  assert('TMDB 按钮置灰（里番没有 TMDB 条目）', withId.tmdbDisabled === true, `disabled=${withId.tmdbDisabled}`)
  assert('豆瓣按钮置灰', withId.doubanDisabled === true, `disabled=${withId.doubanDisabled}`)
  assert('标签渲染出来了', withId.tagLabels.includes('巨乳'), JSON.stringify(withId.tagLabels))
  assert(
    '标签是可点的 button，不是 span —— 不然点了没反应',
    withId.tagIsButton > 0 && withId.clickableTags === withId.tagIsButton,
    `button=${withId.tagIsButton} clickable=${withId.clickableTags}`
  )

  // 点标签这一步**拆成两半验**，因为它走 router.push，而窗口被遮住时应用内
  // 路由过渡会被冻住（见文件头）——那是驱动环境的限制，不是功能的缺陷。
  // 于是：点击这一半只验「跳了，且跳对了地方」（读 hash），筛选那一半直接问
  // 数据源要结果。两半合起来是完整的链路，且都不依赖那个会被冻住的过渡
  const tagClick = await evalJs(
    ws,
    `const tag = [...document.querySelectorAll('.tag')].find((t) => t.textContent.trim() === '巨乳')
     tag.click()
     await new Promise((r) => setTimeout(r, 600))
     const byTag = await window.baoyi.video.list({ tag: '巨乳' })
     return {
       hash: location.hash,
       byTag: byTag.map((v) => v.name_zh),
       hanimeIds: byTag.map((v) => v.hanime_id)
     }`
  )
  console.log('  点标签:', JSON.stringify(tagClick))
  assert(
    '点标签跳回了海报墙',
    /#\/video\/?(\?|$)/.test(tagClick.hash),
    `hash=${JSON.stringify(tagClick.hash)}`
  )
  assert(
    '「巨乳」筛出 2 条 —— 筛的是标签，不是碰巧只有它自己',
    tagClick.byTag.length === 2,
    JSON.stringify(tagClick.byTag)
  )
  // hanime_id 一路穿过视图、IPC、序列化到了渲染进程。少了 COALESCE 或
  // rowToVideo 漏一列，这里会是 undefined 而不是空串
  assert(
    'hanime_id 穿过 IPC 到了界面（一条有值一条空串，都不是 undefined）',
    tagClick.hanimeIds.includes('86994') && tagClick.hanimeIds.includes(''),
    JSON.stringify(tagClick.hanimeIds)
  )

  // 详情页：没刮到条目号的那条 —— v-if 的另一半
  await goto(ws, '#/video/vid-0010')
  const noId = await evalJs(
    ws,
    `for (let i = 0; i < 40; i++) {
       if (document.querySelectorAll('.btn').length > 0) break
       await new Promise((r) => setTimeout(r, 200))
     }
     const btns = [...document.querySelectorAll('.btn')]
     return {
       hanime: btns.some((b) => b.textContent.trim() === 'hanime'),
       hasPlay: btns.some((b) => b.textContent.includes('播放') || b.textContent.includes('打开')),
       text: document.body.innerText.includes('hanime')
     }`
  )
  console.log('  没 id 的:', JSON.stringify(noId))
  assert('没刮到条目号时 hanime 按钮不出现', noId.hanime === false)
  assert('页面上也没有 hanime 字样残留', noId.text === false)
  // 别的按钮还在 —— 证明上一条不是因为整页没渲染出来
  assert('同一页别的按钮照常渲染（排除「整页空」这种假绿）', noId.hasPlay === true)

  console.log('\n【十一】真调起播放器（会弹记事本，随后杀掉）')
  // 这一节必须排在所有 DOM 断言之后，理由见文件头。
  // vid-0008 的路径指着 profile 里一个真的 .txt：验的是 shell.openPath 这一步
  // 真的走通了，而那取决于系统有没有关联程序 —— 假 mkv 验不了这个
  const before = await evalJs(ws, `return (await window.baoyi.video.get('vid-0008'))?.watch_status`)
  assert('开之前 vid-0008 是 unwatched', before === 'unwatched', `拿到 ${before}`)

  const padsBefore = notepadPids()
  const launched = await evalJs(ws, `return await window.baoyi.video.play('vid-0008')`)
  console.log('  播放结果:', JSON.stringify(launched))
  assert('真文件播放返回 ok: true', launched.ok === true, JSON.stringify(launched))

  // 立刻收拾，别等到最后：记事本占着前台，后面【十一】的页面查询会看起来卡死
  await new Promise((r) => setTimeout(r, 1200))
  console.log(`  杀掉 ${killNotepads(padsBefore)} 个记事本`)

  const after = await evalJs(ws, `return (await window.baoyi.video.get('vid-0008'))?.watch_status`)
  assert('开过之后落到 watching（未看 → 在看）', after === 'watching', `拿到 ${after}`)
  // 回包里就该带着新状态，界面不用再查一趟
  assert(
    '返回的 item 上直接带着新状态',
    launched.item?.watch_status === 'watching',
    `item.watch_status=${launched.item?.watch_status}`
  )

  console.log('\n【十二】统计面板认得影视')
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
  assert(
    `stats.videos 是 ${SEED_EXPECT.total}（含归档）`,
    stats.stats.videos === SEED_EXPECT.total,
    `拿到 ${stats.stats.videos}`
  )
  assert('stats.episodes 是 16', stats.stats.episodes === 16, `拿到 ${stats.stats.episodes}`)

  console.log('\n【十三】库里的实况 —— 不信应用自己的汇报')
  const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n

  // 上面那些期望值是从 seed 的**声明**算出来的，所以还差一环：万一 seed 自己
  // 少插了一条，声明和渲染会一起少而彼此吻合，断言就变成空转。这三条直接数表，
  // 把「声明」和「库里真有什么」对上，那一环就补齐了
  assert(
    `resource 表里 ${SEED_EXPECT.total} 条影视 —— seed 声明的都真插进去了`,
    n(`SELECT COUNT(*) AS n FROM resource WHERE kind = 'video'`) === SEED_EXPECT.total,
    `拿到 ${n(`SELECT COUNT(*) AS n FROM resource WHERE kind = 'video'`)}`
  )
  assert(
    `库里 ${SEED_EXPECT.hentai} 条里番`,
    n(`SELECT COUNT(*) AS n FROM resource WHERE category = '${SEED_HENTAI}'`) === SEED_EXPECT.hentai,
    `拿到 ${n(`SELECT COUNT(*) AS n FROM resource WHERE category = '${SEED_HENTAI}'`)}`
  )
  assert(
    `hanime_id 有值的是 ${SEED_EXPECT.withHanimeId} 条`,
    n(`SELECT COUNT(*) AS n FROM video_meta WHERE hanime_id != ''`) === SEED_EXPECT.withHanimeId,
    `拿到 ${n(`SELECT COUNT(*) AS n FROM video_meta WHERE hanime_id != ''`)}`
  )
  // 分类行本身在不在（迁移那一步的产物）。侧栏那一格是 GROUP BY 数出来的，
  // 所以就算这一行缺了、只要有条目挂着，界面上也看得见 —— 两件事得分开验
  assert(
    'categories 表里有 video-hentai 这一行（迁移插进去的）',
    n(`SELECT COUNT(*) AS n FROM categories WHERE id = 'video-hentai' AND kind = 'video'`) === 1
  )
  assert(
    '「其他」被挪到了 sort_order 8，兜底那格还在最后',
    n(`SELECT COUNT(*) AS n FROM categories WHERE id = 'video-other' AND sort_order = 8`) === 1
  )

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
  // 【八】那一下真落到盘上了。IPC 回包说 watching 不算数 —— 那可能只是内存里的
  // 一个对象，重启就没了
  const played = db
    .prepare(`SELECT watch_status, last_watched_at FROM video_meta WHERE resource_id = 'vid-0008'`)
    .get() as any
  assert(
    '播放过的 vid-0008 在库里也是 watching',
    played?.watch_status === 'watching',
    `库里是 ${played?.watch_status}`
  )
  assert(
    'last_watched_at 记上了时间',
    Number(played?.last_watched_at) > 0,
    `拿到 ${played?.last_watched_at}`
  )
  // 断点那一集没被动过：只是渲染了个标签，不是打开了它
  const resume = db
    .prepare(`SELECT position_sec FROM episode WHERE resource_id = 'vid-0004' AND season = 2 AND episode = 2`)
    .get() as any
  assert('S02E02 的断点还在（只看了标签，没真开）', Number(resume?.position_sec) === 812, `拿到 ${resume?.position_sec}`)
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
