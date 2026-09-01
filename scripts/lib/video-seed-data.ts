/**
 * 真机验证铺的那几条影视假数据 —— 声明放这儿，铺数据的和验数据的都从这里读。
 *
 * 为什么单独一个文件：`verify-video-seed.ts` 顶层就读 `process.argv`、开库、
 * 不给参数直接 `process.exit(1)`，所以它**不能被 import** —— 验证脚本一 import
 * 它就跑起来了。
 *
 * ## 为什么让 CDP 那一路从这里算期望值，而不是继续写死数字
 *
 * 原先 `verify-video-cdp.ts` 里写着「墙上是 7 张卡」「stats.videos 是 8」这类
 * 字面量。铺的数据一改，那些数字就集体过期，而过期的表现是**验证脚本自己红一
 * 片**，红的还都不是被验的功能。这跟 seed 里那个写死 `_schema !== '7'` 的闸门
 * 是同一类毛病：最需要验证路径的时候它先坏了。
 *
 * 有人会问：期望值从铺数据的声明里算，会不会变成「自己验自己」？不会，因为
 * 这里是**声明**（我要求库里有什么），墙上渲染出来的是**结果**（应用实际吐出
 * 什么），两边仍旧是独立的两样东西 —— 归档那条如果被错误地画到墙上，算出来的
 * 9 和渲染出的 10 照样对不上。
 *
 * 真正会被抹掉的那个缺口是「seed 自己没插进去」：那种情况下声明和渲染可能一起
 * 少一条而彼此吻合。所以 CDP 的最后一节直接读库核对行数（`SEEDED` 对表里的
 * `COUNT(*)`），把这一环补上 —— 那一节本来就在「不信应用自己的汇报」。
 */

export interface SeedVideo {
  id: string
  name: string
  type: 'movie' | 'series'
  /** '' = 没海报（验首字占位）；'local' = 真图；'tmdb' = 相对路径（验它被挡掉） */
  poster: '' | 'local' | 'tmdb'
  status: 'unwatched' | 'watching' | 'watched' | 'dropped'
  category: string
  /**
   * 标签，**数组**。
   *
   * v0.7 的 seed 这一栏写的是逗号分隔的字符串（`'科幻,史诗'`），而
   * `resource.tags` 那一列存的是 **JSON 数组字符串** —— 写入走
   * `JSON.stringify(p.tags)`（`kinds/video/db.ts:224`），读出走
   * `jsonArray<string>(row.tags)`（同文件 506 行）。`jsonArray` 解不开
   * `科幻,史诗`，于是**每一条铺进去的数据标签都是空的**。
   *
   * v0.7 的 CDP 那一路没有一条断言看过标签，所以这个洞一直没露头 ——
   * 连带着「侧栏的标签区」和「点标签筛选」在真机上其实从来没验过
   * （`counts.tags` 一直是空的，那一段 `v-if` 从来没渲染过）。
   * v0.8 加的里番标签断言是第一次去看它，才撞出来。
   */
  tags: string[]
  year: number
  rating: number
  doubanRating: number
  duration: number
  archived?: boolean
  /** path 指向 profile 里那个真文件，用来验「真的调起了播放器」。见 PLAYABLE */
  playable?: boolean
  /** v0.8：刮到的 hanime 条目号。空串 = 没刮到，详情页那个按钮就不该出现 */
  hanimeId?: string
}

/** 里番那两条的分类名。这里不 import taxonomy，免得脚本层依赖主进程模块树 */
export const SEED_HENTAI = '里番'

export const SEED_VIDEOS: SeedVideo[] = [
  // 有本地海报 + 在看 —— 墙上和侧栏都要能看见
  {
    id: 'vid-0001', name: '沙丘', type: 'movie', poster: 'local', status: 'watching',
    category: '欧美', tags: ['科幻', '史诗'], year: 2021, rating: 7.9, doubanRating: 7.7, duration: 9300
  },
  // 只有 TMDB 相对路径 —— 界面必须退回首字占位，不能是一张破图
  {
    id: 'vid-0002', name: '奥本海默', type: 'movie', poster: 'tmdb', status: 'unwatched',
    category: '欧美', tags: ['传记'], year: 2023, rating: 8.1, doubanRating: 8.9, duration: 10800
  },
  // 一张海报都没有 + 只有豆瓣分（验排序回落）
  {
    id: 'vid-0003', name: '钢的琴', type: 'movie', poster: '', status: 'watched',
    category: '华语', tags: ['文艺'], year: 2010, rating: 0, doubanRating: 8.4, duration: 6300
  },
  // 剧集，有季集表，看了一部分 —— 详情页的重心在这条上
  {
    id: 'vid-0004', name: '黑暗荣耀', type: 'series', poster: 'local', status: 'watching',
    category: '日韩', tags: ['悬疑', '复仇'], year: 2022, rating: 8.1, doubanRating: 8.9, duration: 0
  },
  // 剧集但没有季集表 —— 验那块「没刮到季集表」的解释面板
  {
    id: 'vid-0005', name: '某部没刮到的剧', type: 'series', poster: '', status: 'unwatched',
    category: '日韩', tags: [], year: 0, rating: 0, doubanRating: 0, duration: 0
  },
  // 弃 —— 侧栏那一格的空心点
  {
    id: 'vid-0006', name: '半途而废的片', type: 'movie', poster: '', status: 'dropped',
    category: '欧美', tags: [], year: 2015, rating: 5.2, doubanRating: 0, duration: 5400
  },
  // 归档 —— 侧栏的归档区只在有归档时出现
  {
    id: 'vid-0007', name: '收进箱底的片', type: 'movie', poster: '', status: 'watched',
    category: '华语', tags: [], year: 2008, rating: 7.0, doubanRating: 7.1, duration: 7200,
    archived: true
  },
  // v0.7 Step 7：唯一一条 path 指向**真实存在**的文件（见 seed 里的 PLAYABLE）。
  // 别的条目路径都是 D:\假影视\... ，点播放只能验到「文件不在了」那一支；
  // 而「真的调起了播放器 + 状态从未看抬到在看」这一段得有个真文件才验得到
  {
    id: 'vid-0008', name: '能真打开的片', type: 'movie', poster: '', status: 'unwatched',
    category: '欧美', tags: [], year: 2019, rating: 6.5, doubanRating: 0, duration: 3600,
    playable: true
  },
  // v0.8：里番两条，**必须成对**。
  //
  // 一条刮到了 hanime_id，一条没刮到。详情页那个按钮是 `v-if="hanimeUrl"`，
  // 只铺有 id 的那条只能验到「该出现时出现了」，验不到「不该出现时没出现」——
  // 而后者才是这个 v-if 存在的理由（TMDB / 豆瓣那两个按钮是常驻置灰的，
  // 三个按钮摆在一起时行为不一致，看起来很像是坏了，所以得盯着）。
  //
  // 两条共用「巨乳」这个标签：详情页点标签筛选要筛得出 2 条，才说明筛的是
  // 标签而不是「碰巧只有它自己」。
  {
    id: 'vid-0009', name: '巨乳女教師', type: 'movie', poster: 'local', status: 'watched',
    category: SEED_HENTAI, tags: ['巨乳', '女教師'], year: 2023, rating: 0, doubanRating: 0,
    duration: 1048, hanimeId: '86994'
  },
  {
    id: 'vid-0010', name: '没刮到条目号的里番', type: 'movie', poster: '', status: 'unwatched',
    category: SEED_HENTAI, tags: ['巨乳'], year: 0, rating: 0, doubanRating: 0, duration: 0
  }
]

/** 墙上和侧栏的默认视图都不含归档 */
export const SEED_LIVE = SEED_VIDEOS.filter((v) => !v.archived)

export const SEED_EXPECT = {
  total: SEED_VIDEOS.length,
  live: SEED_LIVE.length,
  archived: SEED_VIDEOS.filter((v) => v.archived).length,
  movies: SEED_LIVE.filter((v) => v.type === 'movie').length,
  series: SEED_LIVE.filter((v) => v.type === 'series').length,
  /** 只有 'local' 才是真图；'tmdb' 是相对路径，界面该把它当没有 */
  realPosters: SEED_LIVE.filter((v) => v.poster === 'local').length,
  initials: SEED_LIVE.filter((v) => v.poster !== 'local').length,
  hentai: SEED_LIVE.filter((v) => v.category === SEED_HENTAI).length,
  withHanimeId: SEED_VIDEOS.filter((v) => v.hanimeId).length,
  /** 侧栏标签区的格子数：不含归档那条，去重 */
  tagNames: [...new Set(SEED_LIVE.flatMap((v) => v.tags))].sort()
}
