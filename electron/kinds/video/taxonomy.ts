/**
 * 视频的分类体系与内置标签池。
 *
 * 和软件（services/taxonomy.ts）、游戏（kinds/game/taxonomy.ts）三套分开。
 * 理由在 0.6 已经付过学费：categories 和 tags 在 0.5 之前是全局单表，
 * 「开发工具」和「RPG」混在一个池子里，识别 prompt 会把一个调试器归进「RPG」。
 * 现在再加一套「剧情」「悬疑」，不隔开的话软件的识别 prompt 里会出现「悬疑」。
 *
 * ## 为什么按地区/形态分，不按题材分
 *
 * 题材（科幻、悬疑、爱情）是**标签**该干的事：一部片可以同时是科幻和爱情，
 * 而分类是单选的（resource.category 是一列，不是数组）。按题材做分类，
 * 用户第一次看到《她》就得决定它到底算科幻还是爱情 —— 而这个决定没有正确答案。
 *
 * 地区和形态是互斥的：一部片不会同时是华语和日韩，不会同时是电影和纪录片。
 * 效果图里侧栏那四个格子（华语/欧美/日韩/纪录片）也是这个思路。
 *
 * 粒度沿用前两个品类的经验：格子少而满，比多而空好。
 */

import type { Category } from '../../../src/types'

/** 归不进任何分类时的落脚点。它也是分类表里真实存在的一条，不是特殊值 */
export const VIDEO_FALLBACK_CATEGORY = '其他'

/**
 * 里番那一格。0.8 加的，是视频的第八个分类，不是第四种资源类型。
 *
 * 单独导出成常量而不是就地写字符串：这四个字后面还要出现在文件名解析器和
 * hanime 通道的判据里（「这条该不该走那条刮削通道」看的就是它），
 * 三处各写一遍字面量，改一次名字就漏一处。
 */
export const HENTAI_CATEGORY_ID = 'video-hentai'
export const HENTAI_CATEGORY = '里番'

export const VIDEO_CATEGORIES: Category[] = [
  {
    id: 'video-cn',
    name: '华语',
    description: '内地、港台、新马华语的电影与剧集',
    icon: 'clapperboard',
    sort_order: 1
  },
  {
    id: 'video-west',
    name: '欧美',
    description: '北美、欧洲、澳洲的电影与剧集',
    icon: 'film',
    sort_order: 2
  },
  {
    id: 'video-jpkr',
    name: '日韩',
    description: '日本、韩国的真人电影与剧集（动画归「动画」）',
    icon: 'tv',
    sort_order: 3
  },
  {
    id: 'video-anime',
    name: '动画',
    description: '日本番剧、剧场版动画、以及各国动画电影',
    icon: 'sparkles',
    sort_order: 4
  },
  {
    id: 'video-doc',
    name: '纪录片',
    description: '纪录片、纪实影像、科普专题',
    icon: 'camera',
    sort_order: 5
  },
  {
    id: 'video-show',
    name: '综艺',
    description: '综艺、脱口秀、真人秀、晚会',
    icon: 'mic',
    sort_order: 6
  },
  {
    id: HENTAI_CATEGORY_ID,
    name: HENTAI_CATEGORY,
    description: '成人动画作品',
    icon: 'flame',
    sort_order: 7
  },
  {
    id: 'video-other',
    name: VIDEO_FALLBACK_CATEGORY,
    description: '录屏、下载的短视频、个人影像，以及暂未归类的视频',
    icon: 'inbox',
    // 兜底那格一直排在最后。0.8 插进「里番」时它从 7 挪到 8 ——
    // 老库里这一挪要靠 migrateVideo 单独走一次，见那边的注释
    sort_order: 8
  }
]

/**
 * 内置标签池。以 source='user' 落库，直接进池注入 prompt。
 *
 * 标签池空着的时候 agent 只能凭空造词，造出来的又不进池（source='ai'），
 * 于是每一轮都在造新词。给它一批通用的起点，收敛才有着力处。
 *
 * ## 这里刻意不放的东西
 *
 * **分辨率和编码不进标签池**（4K、HDR、HEVC）。它们是本地事实，从文件名和
 * 容器元数据里确定性地读得出来 —— v0.7 计划里那条最贵的教训：能在本地读到的
 * 事实，不该让模型去猜。它们作为 video_meta 的真列存在，界面上单独显示。
 * 放进标签池等于邀请 agent 去猜一个我们已经知道的答案。
 *
 * **导演和演员名不进标签池**。它们来自 TMDB，是刮削结果而不是分类词；
 * 池子里塞几百个人名会把 prompt 撑爆，而这些名字本来就不需要模型收敛。
 * 它们照样会作为标签挂在条目上（规格里要求可点击筛选），只是不进内置池。
 *
 * 剩下的才是模型真该判断的：题材、气质、系列归属。
 */
export const VIDEO_TAGS = [
  '剧情',
  '喜剧',
  '动作',
  '科幻',
  '悬疑',
  '恐怖',
  '爱情',
  '战争',
  '武侠',
  '犯罪',
  '传记',
  '合家欢'
]
