/**
 * 视频识别 agent 的提示词。
 *
 * 和软件、游戏那两份一样各自独立，不共用模板 —— 三边要判断的东西几乎不重叠。
 * 软件关心「能不能搬目录」，游戏关心「哪个 exe 是本体、存档在哪」，
 * 视频关心的是**认名字**和**这堆文件是不是同一部剧**。
 *
 * ## 这份 prompt 的设计前提：事实已经齐了
 *
 * `facts.ts` 已经把标题、年份、季集、分辨率、编码、时长、音轨、
 * 以及 nfo 里的 TMDB / IMDB id 全部读出来了。所以这份 prompt 的第一段
 * 就是把这些当**既定事实**摆出来，而不是让模型去探。
 *
 * 相应地，工具集里**没有** list_directory 和 read_text_file ——
 * 视频目录里没有说明文档可读（游戏那边有 readme 和汉化说明），
 * 而目录结构扫描器已经完整看过一遍了。给一个用不上的工具只会
 * 引诱模型浪费一轮。
 *
 * ## 模型在这一步真正该做的三件事
 *
 * 1. **认名字**。「三体」是 2023 腾讯版还是 2024 Netflix 版；
 *    `Nan.Nan.2020` 是《南南》还是《难难》—— 这是判断力，不是查表。
 * 2. **选条目**。TMDB 搜出来 8 个候选，哪个是用户手上这部。
 * 3. **归分类打标签**。分类按地区/形态（华语/欧美/日韩/动画/纪录片/综艺），
 *    题材走标签。
 *
 * 剩下的事都不该问它。
 */

import type { Category } from '../../../src/types'
import type { VideoFacts } from './facts.ts'

export const IDENTIFY_VIDEO_SYSTEM = `你是「抱一」的影视识别 agent。抱一是一个本地资源管理器，帮用户看清自己电脑里到底存了什么。
你的任务是把一个已经扫描好的影视条目补全信息并注册进抱一。

## 先读这一句
任务描述里的「已知事实」是**系统从文件名、nfo 侧车文件、视频容器里确定性读出来的**，
不是猜的。标题、年份、季集号、分辨率、编码、时长、音轨这些**已经是答案了**，
你不需要再去验证，也不要在总结里重复罗列它们。

你要做的只有三件事：**认出这是哪一部作品**、**挑对 TMDB 条目**、**归类打标签**。

## 工作方式
1. 已知事实里**带了 TMDB id 或 IMDB id** 时：直接用 \`tmdb_detail\`（或 \`tmdb_find\`）取详情，
   **不要再搜索**。那个 id 是别的媒体中心刮削好写进 nfo 的，比你搜出来的准。
2. 没有 id 时用 \`tmdb_search\` 搜。搜出来的候选带了分数和年份，挑一个。
3. 挑不出来（候选都不像、或者一条都没搜到）时，{{search_hint}}
4. 用 \`register_video\` 注册。确认这不是影视内容就用 \`skip_entry\` 跳过。
5. 处理完用一句话总结，**不要再调用任何工具**。

## 怎么搜 TMDB
- **中文片先用中文名搜**。TMDB 有完整的中文条目数据，用中文名搜华语片和日本番剧
  比用拼音或英文猜准得多。
- 搜不到再用英文名、原名、或者去掉副标题的写法。
- **年份要带上**。同名的片子太多了（《无间道》有 2002 港片和 2006 美版重拍），
  年份是分开它们最有效的一刀。已知事实里的年份是从文件名或 nfo 读出来的，可信。
- 剧集搜索时用**剧名**，不要带季号。TMDB 上一部剧是一个条目，季是它下面的层级
  —— 拿「XX 第二季」去搜通常搜不到，或者搜到一个奇怪的衍生条目。

## 挑候选时看什么
分数只是排序参考，**不是答案**。它按标题相似度、年份差、类型是否吻合算出来的，
但一个中文片库里本地标题常常是发布组写的简称，和 TMDB 上的官方译名字都不一样
却是同一部片。所以：
- **年份吻合是最硬的信号**，比标题相似度硬。差 1 年是正常的（上映年 / 引进年 /
  跨年首播），差 3 年以上基本可以排除。
- 类型要对：已知事实说这是剧集（有季集号、有多个集文件），就不要挑一个 movie 条目。
- 简介读一下。同名不同片在简介上一眼能分开。
- **拿不准就别硬挑**。register_video 允许不填 tmdb_id —— 条目照样能注册，
  用户之后可以自己刮削。刮错一部片的代价是海报、简介、季集表全是另一部片的，
  用户得手工全删一遍。

## 分类：按地区和形态分，不按题材分
当前分类体系（只能从中选一个）：
{{categories}}

- 题材（科幻、悬疑、爱情）**是标签的事，不是分类的事**。一部片可以同时是科幻和爱情，
  而分类是单选的。
- 日本番剧和动画电影归「动画」，不归「日韩」。「日韩」是真人影视。
- 华语包括内地、港台、新马华语。
- 分不清就用「其他」，不要为了填满而硬归。

## 标签：题材、气质、系列
当前标签池（优先复用，确实没有合适的才可新建，最多 2 个）：
{{tags}}

- 标签写题材和气质：「科幻」「悬疑」「武侠」「合家欢」。
- **不要**写分辨率、编码、片源（4K、HEVC、蓝光）—— 那些是本地事实，
  系统已经作为独立字段存好了，界面上单独显示。写进标签是重复，而且会把筛选器塞满。
- **不要**写导演和演员名当标签 —— 它们由刮削结果单独承载。
- 粒度：一个标签至少要能关联 2 部以上作品。只可能对应一部片的词不要用。
- 1-3 个。

## 命名规范
- **name_zh 填通行中文译名**，不带书名号：《肖申克的救赎》写「肖申克的救赎」。
  没有通行译名时用原名，**不要自己现造一个译名**。
- **name_en 填官方原名**，保持官方的大小写和空格。日本作品用罗马字或官方英文名。
- 文件名和目录名里常带着分辨率、片源、发布组、压制信息
  （\`某片.2021.2160p.WEB-DL.H265.DDP5.1-XXX\`），名字里**一个都不要保留**。
- **description 用中文写它讲什么**，50-120 字。TMDB 的中文简介可以直接用 ——
  它就是官方简介，比你重写一遍准。太长的截到 120 字左右。
- summary 一句话，15-25 字，让用户一眼想起这是哪一部。

## 不是影视内容怎么办
用 \`skip_entry\` 跳过并说明原因。比如：
- 教学录屏、会议录像、监控录像、手机拍的家庭视频
- 已经被判成花絮却漏进来的预告片、样片
- 游戏实况、直播录像

误收一个比漏掉一个麻烦：它会占着海报墙的一格，而用户得手工去删。

## 硬性要求
- **不要编 TMDB id。** 只填 tmdb_search / tmdb_detail / tmdb_find 真实返回过的 id。
  编一个 id 会让下次刷新刮到另一部片。
- 不确定的信息宁可留空。official_url 拿不准就传空字符串。
- 已知事实里给了的技术字段（分辨率、编码、时长、音轨）**不要填进 register_video** ——
  它们不在参数表里，系统直接用读到的值。
- 单个条目控制在 8 次工具调用以内。事实已经很全了，够了就下结论。`

const SEARCH_HINT_ON =
  '可以用 `web_search` 查一下（关键词用「片名 + 电影」或「片名 + 电视剧」，优先中文结果），' +
  '查完再回来搜 TMDB。'
const SEARCH_HINT_OFF =
  '就**不填 tmdb_id 直接注册**，name_zh 用已知事实里的标题顶上，description 只写你确定的部分。' +
  '本次运行没有开启联网搜索，没有 `web_search` 工具，不要尝试调用它。'

const NO_TMDB_NOTE = `
## 本次运行没有配置 TMDB
没有 \`tmdb_search\` / \`tmdb_detail\` / \`tmdb_find\` 这三个工具，不要尝试调用。
直接依据已知事实和你自己的知识注册：name_zh 认得出来就填通行译名，认不出来就用
已知事实里的标题；tmdb_id 留空；description 只写你确定的部分，**不要编简介**。`

/**
 * 把分类表、标签池和两个开关填进系统提示。
 *
 * 现读现填而不是写死：用户在设置里加一个分类、合并两个标签，下一次识别
 * 就该按新的来。`withSearch` / `withTmdb` 必须和传给 `buildVideoTools` 的
 * 是同一对值，否则提示词会让模型去调一个没注册的工具，白烧一轮 ——
 * 软件那边踩过这个坑，游戏那边的注释里也记着。
 */
export function fillVideoSystem(
  categories: Category[],
  pool: string[],
  withSearch = true,
  withTmdb = true
): string {
  const cats = categories.length
    ? categories.map((c) => `  · ${c.name}${c.description ? ` —— ${c.description}` : ''}`).join('\n')
    : '  （分类表是空的，直接用「其他」）'
  const tags = pool.length
    ? `  ${pool.join('、')}`
    : '  （标签池还是空的，你可以按上面的规范提 1-3 个）'

  let out = IDENTIFY_VIDEO_SYSTEM.replace('{{categories}}', cats)
    .replace('{{tags}}', tags)
    .replace('{{search_hint}}', withSearch ? SEARCH_HINT_ON : SEARCH_HINT_OFF)

  if (!withTmdb) out += NO_TMDB_NOTE
  return out
}

/* ============================== 任务描述 ============================== */

/** 集列表太长会把后面的规则挤出模型的注意力，只报这么多集 */
const PROMPT_EPISODE_LIMIT = 6
/** 花絮同理 */
const PROMPT_EXTRA_LIMIT = 4

function fmtDuration(sec: number): string {
  if (sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

/**
 * 一个候选条目的任务描述。
 *
 * 这一段是整套设计里最省钱的地方：`facts.ts` 读出来的东西原样交上去，
 * 「这是第几季第几集」「分辨率多少」就从「一轮工具调用」变成「一行文本」。
 *
 * 刻意**不**把技术字段说成「供参考」—— 它们是确定值。措辞上留任何
 * 「你可以核实一下」的余地，模型就会真去核实，而它没有工具能核实，
 * 于是它会编。
 */
export function videoCandidatePrompt(
  f: VideoFacts,
  registered: Array<{ name: string; path: string }> = []
): string {
  const lines = [
    `请识别并注册这个影视条目：${f.path}`,
    '',
    `## 已知事实（系统从文件名 / nfo / 容器元数据里确定性读出来的，不用再验证）`,
    `  形态：${f.video_type === 'series' ? '剧集' : '电影'}`
  ]

  const title = [f.title_zh, f.title_en].filter(Boolean).join(' / ') || '（文件名里切不出标题）'
  lines.push(`  标题：${title}`)
  if (f.original_title) lines.push(`  原名：${f.original_title}`)
  lines.push(`  年份：${f.year > 0 ? f.year : '（文件名和 nfo 里都没有）'}`)

  /* -------- id 单独一节：它决定走搜索还是走精确查询 -------- */
  const ids = [
    f.tmdb_id ? `TMDB ${f.tmdb_id}` : '',
    f.imdb_id ? `IMDB ${f.imdb_id}` : '',
    f.tvdb_id ? `TVDB ${f.tvdb_id}` : ''
  ].filter(Boolean)
  if (ids.length > 0) {
    lines.push(
      '',
      `## 已有刮削 id：${ids.join('　')}`,
      '这是 nfo 里带的，**直接用它取详情，不要再搜索**。'
    )
  }

  /* -------- 技术事实 -------- */
  const tech: string[] = []
  if (f.resolution) tech.push(f.resolution)
  if (f.video_codec) tech.push(f.video_codec)
  if (f.source) tech.push(f.source)
  if (f.release_group) tech.push(`发布组 ${f.release_group}`)
  const dur = fmtDuration(f.duration_sec)
  if (dur) tech.push(f.video_type === 'series' ? `单集 ${dur}` : dur)
  if (tech.length > 0) {
    lines.push('', `## 技术信息（已存好，不用填进 register_video）`, `  ${tech.join('　')}`)
  }
  if (f.audio_tracks.length > 0) {
    lines.push(`  音轨 ${f.audio_tracks.length} 条：${f.audio_tracks.map((t) => t.label || t.codec).join('、')}`)
  }
  if (f.subtitle_tracks.length > 0) {
    lines.push(`  字幕 ${f.subtitle_tracks.length} 轨（含外挂）`)
  }

  /* -------- 剧集的季集情况 -------- */
  if (f.video_type === 'series') {
    lines.push('', '## 季集情况')
    lines.push(
      `  磁盘上有 ${f.episode_files} 集，跨 ${f.seasons.length} 季（第 ${f.seasons.join('、')} 季）`
    )
    for (const ep of f.episodes.slice(0, PROMPT_EPISODE_LIMIT)) {
      lines.push(`  S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}${ep.title ? ` ${ep.title}` : ''}`)
    }
    if (f.episodes.length > PROMPT_EPISODE_LIMIT) {
      lines.push(`  （还有 ${f.episodes.length - PROMPT_EPISODE_LIMIT} 集，形状一样，不再列出）`)
    }
    lines.push(
      '  注册之后系统会从 TMDB 补齐这部剧的完整季集表 —— 用户缺的那些集也会露面，',
      '  所以你不用管集列表，只要挑对剧的 TMDB 条目。'
    )
  }

  /* -------- nfo 里已有的内容 -------- */
  if (f.plot) {
    lines.push('', '## nfo 里已有的简介', `  ${f.plot.slice(0, 300)}${f.plot.length > 300 ? '…' : ''}`)
  }
  const meta: string[] = []
  if (f.genres.length) meta.push(`类型 ${f.genres.join('、')}`)
  if (f.directors.length) meta.push(`导演 ${f.directors.slice(0, 3).join('、')}`)
  if (f.actors.length) meta.push(`主演 ${f.actors.slice(0, 5).join('、')}`)
  if (f.countries.length) meta.push(`地区 ${f.countries.join('、')}`)
  if (f.nfo_rating > 0) meta.push(`nfo 评分 ${f.nfo_rating}`)
  if (meta.length > 0) lines.push('', '## nfo 里的其他信息', `  ${meta.join('　')}`)

  /* -------- 扫描判据 -------- */
  if (f.evidence.length > 0) {
    lines.push('', '## 扫描判据', ...f.evidence.map((e) => `  · ${e}`))
  }

  /* -------- 花絮 -------- */
  if (f.extras.length > 0) {
    lines.push(
      '',
      `## 已剔除的附属内容（${f.extras.length} 个，不算正片）`,
      ...f.extras.slice(0, PROMPT_EXTRA_LIMIT).map((e) => `  · ${e.path.split(/[\\/]/).pop()}（${e.kind}）`)
    )
  }

  if (registered.length > 0) {
    lines.push(
      '',
      '## 这个目录下之前已经注册过',
      '（识别到同一部作品时用相同的路径注册即可覆盖，不要另起一条）'
    )
    for (const r of registered.slice(0, 10)) lines.push(`  · ${r.name} → ${r.path}`)
  }

  return lines.join('\n')
}
