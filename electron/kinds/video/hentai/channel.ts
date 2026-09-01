/**
 * 这一条该不该走 hanime 通道。纯逻辑，不碰库也不发请求。
 *
 * ## 两条判据，命中任一就走
 *
 * 1. **分类已经是里番** —— 重新识别一条已有条目时读得到。
 * 2. **文件名形状像** —— 专用解析器认出了 `＃N` / `ROUND N` 这类集号，
 *    或者从尾巴上剥下了站方特征标记（`[中文字幕]` `[无修正]` `_720P`）。
 *
 * ## 为什么第一条判据管用（原本担心的鸡生蛋）
 *
 * 顾虑是：通道选择依赖分类 → 分类依赖识别 → 识别又要靠刮削拿数据。
 *
 * 这个环在**用户手改分类会被永久保护**这一点上断开：`category` 在
 * `db.ts` 的 `PROTECTED_RESOURCE_FIELDS` 里。用户把一条手动改成「里番」，
 * 重扫不会覆盖它，下次识别时第一条判据就命中了 —— 他只需要纠正一次。
 *
 * ## 为什么不能只靠第二条
 *
 * 文件名形状是启发式的。一部里番被用户重命名成 `作品名.mkv` 之后
 * 两条特征都没有，只有第一条判据认得它。反过来，新入库、用户还没碰过的
 * 条目只有第二条判据认得。两条各覆盖一半，缺一条都会漏。
 *
 * ## 判据宁松勿紧
 *
 * 挂上工具的代价是 prompt 长一点、模型多几个可选动作；不挂的代价是
 * 这条片子**永远刮不到**（TMDB 上没有里番）。所以第二条判据收得比较宽：
 * 单独一个 `[中文字幕]` 也算命中。误挂在普通动画上时，模型手里多两个
 * 搜不到东西的工具，它会退回 TMDB —— 那是可恢复的；漏挂不可恢复。
 */

import { parseHentaiName } from './filename.ts'
import { HENTAI_CATEGORY } from '../taxonomy.ts'

/** 判据命中的原因，用来写进日志和 prompt。空串 = 没命中 */
export type HanimeReason = '' | 'category' | 'filename'

/**
 * 站方特征标记。剥下来之后归一过的形态（见 filename.ts 的别名表）。
 *
 * `1080p` 这类清晰度**不在**这张表里：普通片库的文件名上到处都是 `_1080P`，
 * 拿它当判据等于给整个库都挂上 hanime 工具。清晰度只有和别的标记一起
 * 出现时才有意义，而那时候别的标记自己就命中了。
 */
const SITE_MARKERS = new Set(['無碼', 'AI解碼', '中文字幕', '中文配音', '同人作品', '斷面圖', 'ASMR'])

/**
 * 判一个文件名的形状像不像里番。
 *
 * 两类特征：里番专用的集号写法（`＃N` / `ROUND N`），或站方标记。
 * `第N話` / `EPN` **不算** —— 普通番剧也这么写，拿它当判据会把整个动画库
 * 都挂上这两个工具。
 */
export function looksLikeHentaiName(name: string): boolean {
  const raw = String(name ?? '')
  // 里番专用的两种集号写法。全角井号在这里就地认，不劳解析器
  if (/[#＃]\s*[\d０-９]/.test(raw)) return true
  if (/\bROUND\s*\d/i.test(raw)) return true

  const parsed = parseHentaiName(raw)
  return parsed.site_tags.some((t) => SITE_MARKERS.has(t))
}

/**
 * 这一条走不走 hanime 通道，以及为什么。
 *
 * `category` 传库里已有条目的分类（没有就空串）。返回原因而不是布尔，
 * 是因为 prompt 里要区分两种说法：分类已定的直接说「这是里番」，
 * 靠文件名猜的要留一句「如果搜不到就说明猜错了，退回 TMDB」。
 */
export function hanimeChannel(fileName: string, category = ''): HanimeReason {
  if (String(category ?? '').trim() === HENTAI_CATEGORY) return 'category'
  return looksLikeHentaiName(fileName) ? 'filename' : ''
}
