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
 *
 * ## 豆瓣那一段刻意写成「补充」
 *
 * `douban_search` 不是第四件事。提示词里它出现在「认定了是哪一部之后」，
 * 而且反复说查不到没关系 —— 因为它一旦被当成识别手段，模型就会在认不出片名时
 * 拿文件名去查豆瓣，那是在**用一个中文站的模糊搜索代替判断**，
 * 而错的豆瓣链接比没有链接更糟：用户点进去看到的是另一部片。
 */

import type { Category } from '../../../src/types'
import type { VideoFacts } from './facts.ts'

export const IDENTIFY_VIDEO_SYSTEM = `你是「抱一」的影视识别 agent。抱一是一个本地资源管理器，帮用户看清自己电脑里到底存了什么。
你的任务是把一个已经扫描好的影视条目补全信息并注册进抱一。

## 先读这一句
任务描述里的「已知事实」是**系统从文件名、nfo 侧车文件、视频容器里确定性读出来的**，
技术参数来自实际文件，无需重复验证。标题和年份是识别线索，应结合原始文件名、nfo 和数据库检索结果判断作品；目录名只提供上下文。

你的任务是认出作品、核对数据库条目、归类打标签。收藏分组只能由用户修改；来源系列关系由程序另存。

## 工作方式
1. 已知事实里**带了 TMDB id 或 IMDB id** 时：直接用 \`tmdb_detail\`（或 \`tmdb_find\`）取详情，
   **不要再搜索**。那个 id 是别的媒体中心刮削好写进 nfo 的，比你搜出来的准。
2. 没有 id 时用 \`tmdb_search\` 搜。搜出来的候选带了分数和年份，挑一个。
3. 挑不出来（候选都不像、或者一条都没搜到）时，{{search_hint}}
4. {{douban_step}}用 \`register_video\` 注册。录屏、短视频和个人影像也属于要收录的内容，归「其他」。仅明显的样片、预告等附属文件使用 \`skip_entry\`。
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

## 录屏、短视频和个人影像
教学录屏、会议录像、家庭视频、游戏实况、直播录像及下载的短视频归「其他」，照常注册。
用文件名概括内容；没有影视数据库条目时留空 id，简介只写文件名或元数据能支持的内容。
只有明确属于其他作品的预告片、样片等附属文件才跳过，不因为“不是电影或剧集”跳过视频。

## 目录和命名分组
原始视频文件名是识别作品的首要线索，目录可包含多部独立作品，不能把它们当成一部剧。
收藏分组只能由用户管理，禁止新增或调整分组。来源系列关系由站点目录另行保存。
结合文件标题、同目录作品和库中已有条目决定是否分组。有关联时优先复用已有分组名；
只有“下载”“视频”等存放位置线索时留空，不因为文件放在一起就断言属于同一作品。

## 硬性要求
- **不要编 TMDB id。** 只填 tmdb_search / tmdb_detail / tmdb_find 真实返回过的 id。
  编一个 id 会让下次刷新刮到另一部片。
- 不确定的信息宁可留空。official_url 拿不准就传空字符串。
- 已知事实里给了的技术字段（分辨率、编码、时长、音轨）**不要填进 register_video** ——
  它们不在参数表里，系统直接用读到的值。
- 单个条目控制在 8 次工具调用以内。事实已经很全了，够了就下结论。`

const SEARCH_HINT_ON =
  '可以用 `web_search` 查一下（关键词用「片名 + 电影」或「片名 + 电视剧」，优先中文结果），' +
  '查完再回来搜 TMDB。**联网搜索按次计费，同一个条目最多 3 次** —— ' +
  '认不出来就承认认不出来，反复换词搜是在花用户的钱买同一批结果。'
const SEARCH_HINT_OFF =
  '就**不填 tmdb_id 直接注册**，name_zh 用已知事实里的标题顶上，description 只写你确定的部分。' +
  '本次运行没有开启联网搜索，没有 `web_search` 和 `douban_search` 工具，不要尝试调用它们。'

/**
 * 第 4 步的前缀。豆瓣走的是**同一个搜索服务商**，所以它和 `web_search`
 * 共用一个开关 —— 关了搜索这两个工具一起消失，这里也就不能提它。
 *
 * 措辞上「已经认定是哪一部了的话」在前，是要把顺序钉死：先判断，再查豆瓣。
 * 反过来的话模型会拿文件名去查豆瓣当识别手段用，见文件头的注释。
 */
const DOUBAN_STEP_ON =
  '已经认定是哪一部了的话，用 `douban_search` 按**中文名**补一个豆瓣评分和条目链接' +
  '（可选，查不到就跳过，不影响注册）。然后'
const DOUBAN_STEP_OFF = ''

/**
 * 豆瓣的规则单独一节，只在有搜索时出现。
 *
 * 三件事必须说：它是补充不是识别手段、id 不能编、评分不用它填。
 * 最后一条尤其要写明 —— 参数表里没有评分字段，但模型看不到参数表的「没有」，
 * 它只会觉得「我知道这部片豆瓣 8.9」然后想办法把这个数塞进某个字段。
 */
const DOUBAN_NOTE = `
## 关于豆瓣
- \`douban_search\` 是**补充，不是识别手段**。先用已知事实和 TMDB 认出这是哪一部，
  再拿确定的中文名去查它。认不出片名时**不要**拿文件名去查豆瓣蒙 ——
  错的豆瓣链接比没有链接更糟，用户点进去看到的是另一部片。
- 用**中文译名**查。豆瓣是中文站，拿英文原名查往往找不到条目页。
- 剧集可以按「剧名 第二季」查：豆瓣的分季是独立条目，各有各的评分，匹配到分季更准。
  （这和搜 TMDB 的规则**相反** —— TMDB 上一部剧是一个条目，不要带季号。）
- **豆瓣评分不用你填**，参数表里也没有这个字段。你只要把 \`douban_id\` 填对，
  系统自己按 id 从查询结果里取那个分。你自己记得的分数一律不要写进任何字段。
- **不要编 douban_id。** 只填 \`douban_search\` 真实返回过的 id，编的会被丢弃。
- 已知事实里有 TMDB / IMDB id 时那句「不要再搜索」说的是 TMDB，
  豆瓣该不该查是独立的判断。
- 查一次不行最多再查一次（去掉年份、换个译名），**第三次不要查了**。
  同一个服务商同一批索引，换词序不会变出一个新条目页，而每次都在花用户的钱。`

/**
 * 里番通道那一段。只在判据命中时拼进去。
 *
 * 分两种说法，因为两条判据的确定性不一样：分类已经是「里番」是用户手改过的
 * 事实（分类受永久保护），而文件名形状只是启发式。后者要留一句「搜不到就是猜错了」，
 * 否则模型会硬把一部普通动画塞进这条通道，然后因为搜不到而反复重搜。
 */
const HANIME_NOTE_CATEGORY = `
## 这一条是里番，走 hanime 通道
这条目的分类已经是「里番」（用户定过或之前识别过），所以：
- **不要用 TMDB 或豆瓣**。那两个站上没有这类作品，搜了只会浪费轮次，
  或者更糟 —— 匹配到一部同名的普通动画，把整条刮成另一部片。
- 用 \`hanime_search\` 按**作品名**搜。作品名是去掉集号（＃2 / ROUND1 / 第3話）
  和方括号标记（[中文字幕] / [无修正]）之后剩下的那部分。已知事实里的标题
  已经是解析过的，直接用它。
- 找到之后用 \`hanime_detail\` 取站方标签和简介，把 id 填进 \`register_video\`
  的 \`hanime_id\`。
- **分类保持「里番」**，不要改成「动画」。`

const HANIME_NOTE_FILENAME = `
## 这个文件名看起来像里番
文件名上有里番的特征（＃N / ROUND N 这类集号，或 [中文字幕] [无修正] 这类标记），
所以给了你 \`hanime_search\` / \`hanime_detail\` 两个工具。
- **先判断，再搜**。看已知事实里的标题：像日本成人动画就走 hanime 通道，
  分类填「里番」。
- 如果 \`hanime_search\` 搜不到，**那说明这个判断错了** —— 不要反复重搜，
  回到 TMDB 那条正常路径，分类按它真实的样子填。
- 走 hanime 通道时不要同时查 TMDB 和豆瓣：那两个站上没有这类作品。`

const HANIME_NOTE_COMMON = `
## 关于 hanime
- **站方标签直接可用**。它们是这个站自己的分类词（巨乳、女教師、無碼、中文字幕…），
  比你造的词准。但仍旧受标签规则约束：优先用标签池里已有的，新增最多 2 个。
- **不要编 hanime_id。** 只填 \`hanime_search\` / \`hanime_detail\` 真实返回过的，
  编的会被丢弃。
- 站上一部作品的多集是**各自独立的条目**，每集有自己的 id。你只负责手上这一个
  文件对应的那一集，**不要把同系列的集合并成一条** —— 别的集是别的文件，
  它们会各自走一次识别。
- 取页次数有限（比 TMDB 更紧）。搜一次不行就换一次写法，**不要第三次** ——
  这个站有防护，请求太密会连不上，而代价落在用户的网络上。
- 搜不到、解析不出来、或者取页失败，都**不是错误** —— 不填 \`hanime_id\`
  直接 \`register_video\`，条目照样完整。`

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
 *
 * `withSearch` 管**两个**工具：`web_search` 和 `douban_search`。豆瓣走的是同一个
 * 搜索服务商，所以没有第三个开关 —— 给它单独一个只会让用户在设置里多面对一个
 * 不知道该不该开的东西，而它的答案永远和联网搜索那个一样。
 */
export function fillVideoSystem(
  categories: Category[],
  pool: string[],
  withSearch = true,
  withTmdb = true,
  /** '' = 不挂里番通道；'category' / 'filename' = 判据命中的原因，见 hentai/channel.ts */
  hanimeReason: '' | 'category' | 'filename' = ''
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
    .replace('{{douban_step}}', withSearch ? DOUBAN_STEP_ON : DOUBAN_STEP_OFF)

  if (withSearch) out += DOUBAN_NOTE
  if (!withTmdb) out += NO_TMDB_NOTE
  // 里番那两段排在最后：判据命中时它说的话要压过上面 TMDB / 豆瓣那些通用规则
  if (hanimeReason === 'category') out += HANIME_NOTE_CATEGORY + HANIME_NOTE_COMMON
  else if (hanimeReason === 'filename') out += HANIME_NOTE_FILENAME + HANIME_NOTE_COMMON
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
  registered: Array<{ name: string; path: string; collection_name?: string }> = []
): string {
  const lines = [
    `请识别并注册这个影视条目：${f.path}`,
    '',
    `## 已知事实（系统从文件名 / nfo / 容器元数据里确定性读出来的，不用再验证）`,
    `  形态：${f.video_type === 'series' ? '剧集' : '电影'}`
  ]

  const title = [f.title_zh, f.title_en].filter(Boolean).join(' / ') || '（文件名里切不出标题）'
  lines.push(`  标题：${title}`)
  lines.push(`  内容目录：${f.dir}${f.shared_directory ? '（多部作品共享）' : ''}`)
  if (f.files?.length) {
    lines.push('', '## 原始视频文件名与解析结果')
    for (const file of f.files.slice(0, 12)) lines.push(`  · ${file.name} → ${file.title || '未解析出标题'}${file.year ? `（${file.year}）` : ''}`)
    if (f.files.length > 12) lines.push(`  另有 ${f.files.length - 12} 个文件。`)
  }
  if (f.sibling_titles?.length > 1) {
    lines.push('', '## 同目录作品（用于判断是否分组，分别注册）', `  ${f.sibling_titles.slice(0, 20).join('、')}`)
  }
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
      '（核对文件和作品身份，确有关联时复用已有命名分组；不同作品分别保留）'
    )
    for (const r of registered.slice(0, 10)) lines.push(`  · ${r.name} → ${r.path}${r.collection_name ? `；分组：${r.collection_name}` : ''}`)
  }

  return lines.join('\n')
}
