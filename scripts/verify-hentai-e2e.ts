/**
 * 端到端走一遍里番那条链路：真实文件名 -> 解析 -> 通道判据 -> 工具表 -> prompt
 * -> 刮削 -> 入库 -> 界面读得到的形状。
 *
 *   node --experimental-strip-types --no-warnings scripts/verify-hentai-e2e.ts
 *
 * 不碰真库（内存库），不联网。
 *
 * ## 唯一被替掉的那一环，以及为什么
 *
 * `globalThis.fetch` 在这个脚本里被换成一个吐 fixture HTML 的假实现 ——
 * **只有这一环是假的**，别的每一步都是应用真正跑的那份代码：
 * 同一个解析器、同一份判据、同一张工具表、同一个 register_video、同一个 insertVideo。
 *
 * 为什么非替不可：本机连不上 hanime 的四个镜像（待确认 H，两个连接超时加一个
 * RST），而 `npm run selfcheck` 里那 27 条是**单元**级的 —— 它们直接调
 * `parseSearch(html)`，跳过了 `getHtml` 那一层。于是有一整段接缝没人验过：
 * UA 有没有真发出去、挑战页判断在真实响应流程里生不生效、budget 扣不扣、
 * 缓存命中时算不算一次、工具返回的文本模型看不看得懂、id 有没有真落到库里。
 * 这个脚本验的就是那一段。
 *
 * 它**不能**证明的事，说清楚免得误读：fixture 是按 doc/hanime-api-notes.md
 * 第三、四节的结构搭的，不是真页面。所以「选择器和 2026 年的 hanime1.me 一致」
 * 这件事这里照样证明不了 —— 那要等待确认 H 有答案。
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { listVideos, updateVideo, videoCounts, videoCategoryOf } from '../electron/kinds/video/db.ts'
import { emptyFacts } from '../electron/kinds/video/facts.ts'
import { parseHentaiName } from '../electron/kinds/video/hentai/filename.ts'
import { hanimeChannel } from '../electron/kinds/video/hentai/channel.ts'
import { clearHanimeCache } from '../electron/kinds/video/hentai/hanime.ts'
import { watchUrl } from '../electron/kinds/video/hentai/selectors.ts'
import { acceptExternalPosterUrl, isRemotePoster } from '../electron/kinds/video/posters.ts'
import { HENTAI_CATEGORY } from '../electron/kinds/video/taxonomy.ts'
import { buildVideoTools } from '../electron/kinds/video/tools.ts'
import { fillVideoSystem } from '../electron/kinds/video/prompts.ts'

let pass = 0
let fail = 0
function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        pass++
        console.log(`  ok   ${name}`)
      },
      (err) => {
        fail++
        console.log(`  FAIL ${name}`)
        console.log(`       ${err instanceof Error ? err.message : String(err)}`)
      }
    )
}

/* ==================== fixture：假的站方响应 ==================== */

// 搜索卡片是带标题的正式封面，详情 og:image / 播放清单是另一张视频缩略图。
// 两者文件名和签名都不同，不能靠改写 thumbnail 路径来拼出 cover。
const COVER_URL = 'https://vdownload.hembed.com/image/cover/title-art.jpg?secure=cover-token,1790822314'
const OTHER_COVER_URL = 'https://vdownload.hembed.com/image/cover/other-title-art.jpg?secure=other-token,1790822314'
const THUMBNAIL_URL = 'https://vdownload.hembed.com/image/thumbnail/scene-86994.jpg?secure=thumb-token,1790822306'

const SEARCH_HTML = `
<div class="content-padding-new">
  <div class="search-doujin-videos">
    <a class="overlay" href="/watch?v=86994"></a>
    <div class="card-mobile-panel">
      <img src="${COVER_URL}">
      <div class="card-mobile-title">巨乳女教師 ＃1</div>
      <div class="thumb-container"><div class="duration">17:28</div></div>
    </div>
  </div>
  <div class="search-doujin-videos">
    <a class="overlay" href="/watch?v=86995"></a>
    <div class="card-mobile-panel">
      <img src="${OTHER_COVER_URL}">
      <div class="card-mobile-title">巨乳女教師 ＃2</div>
      <div class="thumb-container"><div class="duration">18:02</div></div>
    </div>
  </div>
</div>`

const WATCH_HTML = `
<html><head>
  <meta property="og:image" content="${THUMBNAIL_URL}">
  <meta property="og:url" content="https://hanime1.me/watch?v=86994">
  <meta property="og:video:duration" content="1048">
</head><body>
  <div id="shareBtn-title">巨乳女教師 ＃1</div>
  <div class="video-details-wrapper">观看次数：10万次 2026-08-28</div>
  <div class="video-details-wrapper">
    <h4 class="video-details-title">巨乳女教师 第一集</h4>
    <div class="video-caption-text caption-ellipsis">新来的女教师被学生盯上了。<span>剧集列表</span></div>
  </div>
  <div class="meta-author"><a href="/search?brands[]=某工作室">某工作室</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=巨乳">#巨乳 (1234)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=女教師">#女教師 (567)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=無碼">#無碼 (89)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=中文字幕">#中文字幕 (77)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=凌辱">#凌辱 (66)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=調教">#調教 (55)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=人妻">#人妻 (44)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=NTR">#NTR (33)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=女教師">#女教師 (22)</a></div>
  <div class="single-video-tag"><a href="/search?tags[]=巨乳">#巨乳 (11)</a></div>
  <div class="video-playlist-wrapper">
    <div id="playlist-top-block"><h4><a href="/search?query=巨乳女教師">巨乳女教師 系列</a></h4></div>
    <div id="playlist-scroll">
      <div class="playlist-hover-wrap" data-href="/watch?v=86994">
        <img class="main-thumb" src="${THUMBNAIL_URL}">
        <h4 class="video-title"><a href="/watch?v=86994">＃1</a></h4>
        <div class="duration">17:28</div>
      </div>
      <div class="playlist-hover-wrap" data-href="/watch?v=86995">
        <img class="main-thumb" src="/e2.jpg">
        <h4 class="video-title"><a href="/watch?v=86995">＃2</a></h4>
        <div class="duration">18:02</div>
      </div>
    </div>
  </div>
</body></html>`

/** 记下每一次请求，用来核对 UA 和地址真的发出去了 */
const calls: Array<{ url: string; ua: string; lang: string }> = []
/** 下一次请求返回什么，测挑战页那条路时会被改掉 */
let nextBody: string | null = null
let nextStatus = 200

const realFetch = globalThis.fetch
function installFakeFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const h = new Headers(init.headers ?? {})
    calls.push({
      url,
      ua: h.get('User-Agent') ?? '',
      lang: h.get('Accept-Language') ?? ''
    })
    const body =
      nextBody ?? (url.includes('/search') ? SEARCH_HTML : url.includes('/watch') ? WATCH_HTML : '')
    return {
      ok: nextStatus >= 200 && nextStatus < 300,
      status: nextStatus,
      text: async () => body
    } as any
  }) as any
}

/* ==================== 链路 ==================== */

const FILE = 'OVAピュアピュア ぺろぺろ プリンセス ＃2 [中文字幕]_720P.mp4'
const REAL_FILE = '巨乳女教師 ＃1 [中文字幕][无修正]_1080P.mkv'

async function main(): Promise<void> {
  installFakeFetch()
  console.log('\n端到端 · 里番链路（只有网络那一环是假的）\n')

  /* ---------- 1. 解析 ---------- */
  await step('1 解析：真实文件名读出作品名、集号、站方标签', () => {
    const p = parseHentaiName(FILE)
    assert.equal(p.title_zh, 'OVAピュアピュア ぺろぺろ プリンセス')
    assert.equal(p.absolute_episode, 2)
    assert.equal(p.resolution, '720p')
    assert.deepEqual(p.site_tags, ['中文字幕', '720p'])
    assert.equal(p.is_special, false)
  })

  /* ---------- 2. 判据 ---------- */
  const d = new DatabaseSync(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  initSchema(d as any, KINDS)

  await step('2 判据：新文件靠文件名命中，库里没有它时分类是空的', () => {
    assert.equal(videoCategoryOf(d as any, 'D:\\H\\' + REAL_FILE), '', '库里本来不该有它')
    assert.equal(hanimeChannel(REAL_FILE), 'filename')
  })

  /* ---------- 3. 工具表 + prompt ---------- */
  const facts = {
    ...emptyFacts(),
    video_type: 'movie' as const,
    path: 'D:\\H\\' + REAL_FILE,
    dir: 'D:\\H',
    title_zh: '巨乳女教師',
    resolution: '1080p',
    duration_sec: 1048
  }
  const ctx: any = {
    facts,
    db: d as any,
    tagPool: ['巨乳'],
    searchConfig: { provider: 'model_builtin', api_key: '', endpoint: '', enabled: false },
    tmdbConfig: { api_key: '', api_domain: '', image_domain: '', enabled: false }
  }
  const tools = buildVideoTools(ctx, [HENTAI_CATEGORY, '动画', '其他'], false, false, true)

  await step('3 工具表和 prompt 对齐 —— prompt 说的工具都真的注册了', () => {
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('hanime_search'))
    assert.ok(names.includes('hanime_detail'))
    const sys = fillVideoSystem(
      [{ id: 'video-hentai', name: HENTAI_CATEGORY, description: '', icon: '', sort_order: 7 }] as any,
      ['巨乳'],
      false,
      false,
      'filename'
    )
    // prompt 里提到的每一个 hanime **工具**都必须在工具表里，否则模型白烧一轮。
    //
    // 排掉 hanime_id：它是 register_video 的一个参数，不是工具。
    // 判据是「这个名字在工具表的命名空间里」而不是「像不像工具名」——
    // 第一版按 /`hanime_\w+`/ 抓，把参数也抓进来了
    const mentioned = new Set(
      (sys.match(/`(hanime_\w+)`/g) ?? []).map((m) => m.replace(/`/g, ''))
    )
    mentioned.delete('hanime_id')
    for (const tool of mentioned) {
      assert.ok(names.includes(tool), `prompt 提到 ${tool}，但工具表里没有它`)
    }
    assert.ok(mentioned.size >= 2, `prompt 该提到那两个工具，实际提到 ${mentioned.size} 个`)

    // hanime_id 反过来验：prompt 提它，register_video 就必须收它
    const props = Object.keys(
      (tools.find((t) => t.name === 'register_video')!.parameters as any).properties
    )
    assert.ok(props.includes('hanime_id'), 'prompt 让模型填 hanime_id，但参数表里没有这个字段')
  })

  /* ---------- 4. 刮削（走真正的 getHtml 那一层） ---------- */
  let searchOut = ''
  await step('4 hanime_search：走完整取页流程，UA 和语言头真发出去了', async () => {
    calls.length = 0
    searchOut = String(await tools.find((t) => t.name === 'hanime_search')!.execute({ query: '巨乳女教師' }))
    assert.equal(calls.length, 1, `该发一次请求，实际 ${calls.length} 次`)
    assert.ok(calls[0].url.includes('/search'), '打的不是搜索端点')
    assert.ok(calls[0].url.includes('genre='), 'genre 没带上，结果会混进非里番')
    // Electron 默认 UA 带 Electron/，那是显眼的非浏览器标记，会被盾挡
    assert.ok(/Chrome\//.test(calls[0].ua), `UA 没换成浏览器：${calls[0].ua}`)
    assert.ok(!/Electron/i.test(calls[0].ua), 'UA 里还留着 Electron')
    assert.ok(calls[0].lang.includes('zh-TW'), '没带繁体优先的语言头')
    // 返回给模型的文本里得有 id，否则它没法接着调 detail
    assert.ok(searchOut.includes('86994'), `工具返回里没有 id：${searchOut.slice(0, 120)}`)
  })

  await step('5 hanime_detail：标签洗过、简介不含子节点文本、集表解出来', async () => {
    calls.length = 0
    const out = String(
      await tools.find((t) => t.name === 'hanime_detail')!.execute({ hanime_id: 86994 })
    )
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.includes('watch?v=86994'), `打错了地址：${calls[0].url}`)
    assert.ok(out.includes('巨乳'), '标签没出来')
    assert.ok(!out.includes('(1234)'), '标签上的计数没洗掉 —— 它每天变，会反复入池')
    assert.ok(!out.includes('#巨乳'), '标签前面的井号没洗掉')
    assert.ok(out.includes('新来的女教师被学生盯上了。'), '简介没出来')
    assert.ok(!out.includes('剧集列表'), '子节点文本漏进简介了')
    assert.ok(out.includes('同系列 2 集'), '集表没解出来')
    assert.ok(out.includes('站点发布日期：2026-08-28'))
    assert.ok(out.includes('时长：1048 秒'))
    assert.ok(out.includes('不要合并成一条'), '缺了那句提醒，模型会把 2 集并成一条')
  })

  /* ---------- 6. 入库 ---------- */
  await step('6 register_video：查过的 id 落库，译文和普通标签由 agent 提交', async () => {
    const out = String(
      await tools.find((t) => t.name === 'register_video')!.execute({
        name_zh: '巨乳女教師',
        name_en: '',
        summary: '新来的女教师',
        description: '新来的女教师被学生盯上了。',
        category: HENTAI_CATEGORY,
        tags: ['剧情'],
        hanime_id: 86994
      })
    )
    assert.ok(!/被忽略/.test(out), `查过的 id 该收下，实际：${out.slice(0, 160)}`)
    const row = d.prepare('SELECT hanime_id FROM video_meta').get() as any
    assert.equal(row.hanime_id, '86994')
    const episode = d.prepare('SELECT published_at,studio,duration_sec FROM episode').get() as any
    assert.equal(episode.published_at, Date.UTC(2026, 7, 28))
    assert.equal(episode.studio, '某工作室')
    assert.equal(episode.duration_sec, 1048)
  })

  await step('7 落库后的形状：译文、原文、全部站方标签、链接和封面', () => {
    const v = listVideos(d as any, { type: 'hentai' })[0] as any
    assert.equal(v.name_zh, '巨乳女教師')
    assert.equal(v.category, HENTAI_CATEGORY)
    assert.equal(v.hanime_id, '86994')
    assert.equal(v.description, '新来的女教师被学生盯上了。')
    assert.equal(v.original_description, '新来的女教师被学生盯上了。')
    assert.deepEqual(v.tags, ['剧情'])
    assert.deepEqual(
      v.hanime_tags,
      ['巨乳', '女教師', '無碼', '中文字幕', '凌辱', '調教', '人妻', 'NTR'],
      '站方标签必须去重但不能按普通标签上限截断'
    )
    // 豆瓣和官网都没有时退到 hanime 条目页
    assert.equal(v.official_url, watchUrl('86994'))

    /*
     * 封面这一条是补上来的。v0.8 把 coverUrl 解出来了却从来没用过 ——
     * register_video 里 poster_path 只取 TMDB 那份，于是里番条目永远是空白海报，
     * 而**这一路当时全绿**：id 落库了、标签对了、官网兜底也对了，
     * 谁都不会想到封面压根没接上。用户报的「封面获取没体现」就是这个。
     *
     * 三件事一起钉：值来自站方页面（不是模型填的）、是完整地址（不是 TMDB 那种
     * 相对路径）、且被 isRemotePoster 认成远端 —— 少最后一条的话
     * fetchVideoPoster 会把它当 TMDB 相对路径去拼，拼出一个必然 404 的地址。
     */
    assert.equal(
      v.poster_path,
      COVER_URL,
      '搜索页的正式封面不能被详情页 / 播放清单缩略图覆盖，签名参数也必须原样保留'
    )
    assert.ok(isRemotePoster(v.poster_path), '认不出是远端地址，下载那头会当成 TMDB 的相对路径')
    assert.ok(acceptExternalPosterUrl(v.poster_path), '过不了外站护栏，封面还是下不来')
  })

  /* ---------- 8. 界面读得到 ---------- */
  await step('8 侧栏那一格出现了，点它筛得出这一条', () => {
    const cats = videoCounts(d as any).categories
    assert.ok(!cats.some(c => c.name === HENTAI_CATEGORY))
    assert.equal(videoCounts(d as any).hentai, 1)
    assert.equal(listVideos(d as any, { type: 'hentai' }).length, 1)
    assert.equal(listVideos(d as any).length, 0)
  })

  await step('9 里番标签只在里番分类出现，点击后仍限定在里番分类', () => {
    const v = listVideos(d as any, { type: 'hentai' })[0] as any
    assert.ok(!videoCounts(d as any).tags.some((t) => t.name === '巨乳'))
    assert.ok(videoCounts(d as any).hanime_tags.some((t) => t.name === '巨乳'))
    assert.deepEqual(
      listVideos(d as any, { type: 'hentai', tag: v.hanime_tags[0] })
        .map((x: any) => x.name_zh),
      ['巨乳女教師']
    )
  })

  /* ---------- 10. 第二遍：判据换成分类那条 ---------- */
  await step('10 重新识别同一条时判据走「分类」，不再靠猜文件名', () => {
    // 这是那个鸡生蛋环的断点：分类受永久保护，所以第二次识别读得到它
    assert.equal(videoCategoryOf(d as any, 'D:\\H\\' + REAL_FILE), HENTAI_CATEGORY)
    assert.equal(hanimeChannel(REAL_FILE, videoCategoryOf(d as any, 'D:\\H\\' + REAL_FILE)), 'category')
    // 连文件名被改成毫无特征的名字也照样命中
    assert.equal(hanimeChannel('作品.mkv', HENTAI_CATEGORY), 'category')
  })

  await step('10b 已有缓存海报受保护；撤掉后重新刮削才能换成正式封面', async () => {
    const row = listVideos(d as any, { type: 'hentai' })[0] as any
    const oldPoster = 'D:\\posters\\cached-thumbnail.jpg'
    const registerAgain = () => tools.find((t) => t.name === 'register_video')!.execute({
      name_zh: '封面回归', summary: '缓存海报回归', category: HENTAI_CATEGORY, hanime_id: '86994'
    })
    updateVideo(d as any, row.id, { poster_path: oldPoster })
    await registerAgain()
    assert.equal(listVideos(d as any, { type: 'hentai' })[0].poster_path, oldPoster, '重新识别不能擅自覆盖已有海报')

    // clearVideoPoster 同样通过 updateVideo 清空这一列；这里只动内存库，不删真实图片。
    updateVideo(d as any, row.id, { poster_path: '' })
    await registerAgain()
    assert.equal(listVideos(d as any, { type: 'hentai' })[0].poster_path, COVER_URL, '撤掉旧海报后应采用新取得的正式封面')
  })

  /* ---------- 11. 盾 ---------- */
  await step('11 挑战页不被当成「站上没有」，而是报出来', async () => {
    clearHanimeCache()
    nextBody = '<html><head><title>Just a moment...</title></head><body></body></html>'
    const out = String(
      await tools.find((t) => t.name === 'hanime_search')!.execute({ query: '别的作品' })
    )
    nextBody = null
    // 关键：不能是「没搜到」。那两种情况用户要做的事完全不同
    assert.ok(/挑战页|Cloudflare/.test(out), `挑战页被当成别的了：${out.slice(0, 160)}`)
    assert.ok(!/没搜到/.test(out), '挑战页被报成「没搜到」—— 用户会以为站上没有这部作品')
  })

  await step('12 取页失败不拖垮识别，仍旧能注册（不填 hanime_id）', async () => {
    clearHanimeCache()
    nextStatus = 503
    const out = String(
      await tools.find((t) => t.name === 'hanime_search')!.execute({ query: '又一部' })
    )
    nextStatus = 200
    assert.ok(/503|盾|稍后/.test(out), `503 该说清楚：${out.slice(0, 160)}`)
    assert.ok(/register_video/.test(out), '要告诉模型下一步照样可以注册')
  })

  await step('13 预算用完之后不再发请求', async () => {
    clearHanimeCache()
    calls.length = 0
    // 前面几步已经用掉一些，这里连打到上限
    for (let i = 0; i < 8; i++) {
      await tools.find((t) => t.name === 'hanime_search')!.execute({ query: `压力测试 ${i}` })
    }
    assert.ok(calls.length <= 4, `预算没拦住，发了 ${calls.length} 次请求`)
  })

  d.close()

  /* ---------- 封面来源回归：真实解析、账本合并、注册入库，只替换取页 ---------- */
  const noSearchCover = SEARCH_HTML.replace('<img src="' + COVER_URL + '">', '')
  const noDetailCover = WATCH_HTML.replace('<meta property="og:image" content="' + THUMBNAIL_URL + '">', '')
  const coverCases = [
    {
      name: '14 封面：重复读取详情仍保留正式封面，不增加网络请求',
      searchHtml: SEARCH_HTML, watchHtml: WATCH_HTML, id: '86994', repeats: 2,
      expected: COVER_URL
    },
    {
      name: '15 封面：选中第二个候选时只用同一 ID 的封面',
      searchHtml: SEARCH_HTML, watchHtml: WATCH_HTML.replaceAll('86994', '86995'), id: '86995',
      expected: OTHER_COVER_URL
    },
    {
      name: '16 封面：搜索图缺失时退到详情图，不借用其他候选封面',
      searchHtml: noSearchCover, watchHtml: WATCH_HTML, id: '86994',
      expected: THUMBNAIL_URL
    },
    {
      name: '17 封面：直接取详情、没有搜索候选时仍有详情图兜底',
      searchHtml: null, watchHtml: WATCH_HTML, id: '86994',
      expected: THUMBNAIL_URL
    },
    {
      name: '18 封面：详情图缺失不能清空已取得的正式封面',
      searchHtml: SEARCH_HTML, watchHtml: noDetailCover, id: '86994',
      expected: COVER_URL
    },
    {
      name: '19 封面：双方都无图时保持空值，不拿播放清单图或其他候选凑数',
      searchHtml: noSearchCover, watchHtml: noDetailCover, id: '86994',
      expected: ''
    },
    {
      name: '20 封面：详情缺少 og:url 时按请求 ID 保留搜索封面',
      searchHtml: SEARCH_HTML,
      watchHtml: WATCH_HTML.replace('<meta property="og:url" content="https://hanime1.me/watch?v=86994">', ''),
      id: '86994', expected: COVER_URL
    }
  ]
  for (const c of coverCases) {
    await step(c.name, async () => {
      const coverDb = new DatabaseSync(':memory:')
      clearHanimeCache()
      calls.length = 0
      try {
        coverDb.exec('PRAGMA foreign_keys = ON')
        initSchema(coverDb as any, KINDS)
        const coverTools = buildVideoTools({ ...ctx, db: coverDb as any }, [HENTAI_CATEGORY], false, false, true)
        if (c.searchHtml !== null) {
          nextBody = c.searchHtml
          await coverTools.find((t) => t.name === 'hanime_search')!.execute({ query: '封面回归' })
        }
        nextBody = c.watchHtml
        for (let i = 0; i < (c.repeats ?? 1); i++) {
          await coverTools.find((t) => t.name === 'hanime_detail')!.execute({ hanime_id: c.id })
        }
        nextBody = null
        await coverTools.find((t) => t.name === 'register_video')!.execute({
          name_zh: '封面回归', summary: '封面来源测试', category: HENTAI_CATEGORY, hanime_id: c.id
        })
        const row = listVideos(coverDb as any, { type: 'hentai' })[0] as any
        assert.equal(row.hanime_id, c.id)
        assert.equal(row.poster_path, c.expected)
        assert.equal(row.original_description, '新来的女教师被学生盯上了。', '保留封面不能丢掉详情元数据')
        assert.ok(row.hanime_tags.includes('中文字幕'), '站方标签仍需从详情入库')
        assert.equal(calls.length, c.searchHtml === null ? 1 : 2, '合并封面不应增加额外请求')
      } finally {
        nextBody = null
        clearHanimeCache()
        coverDb.close()
      }
    })
  }
  globalThis.fetch = realFetch

  console.log(`\n${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
