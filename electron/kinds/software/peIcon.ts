/**
 * 从 PE 的图标资源里取最佳那一帧。纯逻辑：只吃 Buffer，不碰 Electron 也不碰磁盘，
 * 于是自检能直接驱动它（`app.getFileIcon` 那条路自检碰不到）。
 *
 * ## 为什么非要自己解一遍
 *
 * `app.getFileIcon` 在**有图标资源的 exe 上也会回 Windows 的通用程序图标**。
 * 2026-09-02 在真库 46 条软件上量过：13 条拿到的是同一张 32×32 通用图
 * （那张淡色窗框加蓝块的图），而其中 12 条的 PE 里明明有 256×256 的图标帧，
 * 腾讯 ima.copilot 甚至有 12 组 61 张。
 *
 * **这个洞为什么一直没人发现**：`icon_path` 非空、图标文件真的在、`<img>` 也
 * 渲染成功 —— 三道能自动检查的地方全是绿的。只有人眼看得出来那是张空白图。
 * 用户报的「空图标」就是它，不是提取失败。
 *
 * ## 只收 PNG 帧
 *
 * Vista 之后 256×256 那一帧通常直接存 PNG 字节，取出来原样写盘就行。
 * 老式的 DIB 帧要自己拼 ICONDIR 再交给 nativeImage 转，代码量差一个数量级 ——
 * 而真库上量过：46 条里 30 条的最佳帧是 PNG，**而那 12 条出问题的全都有
 * 256×256 PNG 帧**。DIB-only 的那些 `getFileIcon` 本来就取对了（48×48 的真图标，
 * 不是通用图），退回去不损失什么。
 *
 * ponytail: 不解 DIB 帧 —— DIB-only 的 exe 仍走 `getFileIcon`，拿到 48×48。
 * 要更高清得拼一个单帧 .ico 交给 `nativeImage.createFromPath`（单帧所以没有
 * 「浏览器挑哪一层」的问题，见 icons.ts 里否掉 .ico 的那段）。
 */

import * as ResEdit from 'resedit'

const RT_ICON = 3
const RT_GROUP_ICON = 14

/** PNG 的魔数，八个字节全比 —— 只比前四个的话 DIB 头有极小概率撞上 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 一个 PNG 至少得有魔数 + IHDR + IEND。比这还短的一定是坏数据，
 * 而坏图标写进去的表现是界面上一个破图框 —— 比退回首字占位更糟。
 */
const MIN_PNG_BYTES = 64

/**
 * 比这还小就不如让 `getFileIcon` 去取（它至少回 48×48 的真图标）。
 *
 * 32 而不是 48：32×32 的真图标仍旧比通用图有用，而卡上是 48px，
 * 差这一档远不如「图对不对」要紧。
 */
const MIN_USEFUL_PX = 32

/**
 * 图标提取的体积上限，**故意比 `readPeInfo` 的 128MB 松**。
 *
 * 两处的约束不一样：`readPeInfo` 是**同步**的，而且在扫描循环里每个 exe 都要走
 * 一次 —— 它读一个 200MB 的文件就是主进程停摆几百毫秒，那正是「点开始识别
 * 界面卡死」那一章的病根。图标提取是 `async` 的（`fsp.readFile` 不堵事件循环），
 * 而且结果按 exe 路径缓存，同一个文件一辈子只读一次。
 *
 * 真库上量到的代价：9 个 exe 超过 128MB，其中 8 个有 256×256 的 PNG 帧 ——
 * 而它们恰好是最容易被 `getFileIcon` 塞一张通用图的那类（大号 Electron 应用）。
 * 卡在 128MB 上等于这个修复对最严重的那批一点用都没有。
 *
 * ponytail: 上限 512MB，仍旧是「整个文件读进内存」。真要去掉这个上限，
 * 得换成只映射 PE 的资源节区。
 */
export const MAX_ICON_BYTES = 512 * 1024 * 1024

/** GRPICONDIR 里一帧的描述 */
interface IconFrame {
  /** 目录项自报的宽。**只用来排序前的初筛，不当结果** —— 见 realSize 的注释 */
  width: number
  height: number
  bits: number
  id: number
}

/**
 * 解 GRPICONDIR，回帧表（顺序不重要，挑帧按 PNG 实际尺寸来）。
 *
 * 结构（全小端）：头 6 字节（保留 2、类型 2、张数 2），之后每帧 14 字节 ——
 * 宽 1、高 1、色数 1、保留 1、平面 2、位深 2、字节数 4、资源 id 2。
 *
 * **宽高各只占一个字节，所以 256 记成 0。**
 *
 * 张数按**缓冲区实际长度**再夹一次，不光信自报的 `idCount` —— 畸形资源里
 * 那个数可以远大于真实数据，照着它读会越界。这和 peReader 里那个死循环
 * 是同一类教训：自报的长度一律不能当界。
 */
function parseGroup(bin: ArrayBuffer | Uint8Array): IconFrame[] {
  const b = asBuffer(bin)
  if (b.length < 6) return []
  const declared = b.readUInt16LE(4)
  const fits = Math.floor((b.length - 6) / 14)
  const count = Math.min(declared, fits)

  const out: IconFrame[] = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14
    out.push({
      width: b[o] === 0 ? 256 : b[o],
      height: b[o + 1] === 0 ? 256 : b[o + 1],
      bits: b.readUInt16LE(o + 6),
      id: b.readUInt16LE(o + 12)
    })
  }
  return out
}

/**
 * 从 PNG 自己的 IHDR 里读真实宽高。认不出回 null。
 *
 * **必须读这个，不能信 GRPICONDIR 里那两个字节。** 真库上量到 X-Mouse Button
 * Control 的目录项自报 13×13，而那一帧实际是 256×256 的 PNG。按自报的宽高排序
 * 就会把这张最好的帧排到最后，于是挑出一张更小的 —— 表现是「图标是对的但很糊」，
 * 没人会往「目录项在说谎」上想。
 *
 * 和 peReader 里 `wValueLength` 短报那个 bug 是同一类：**自报的数字一律要有
 * 第二来源去核**。
 */
function realSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24) return null
  if (png.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null
  return { width, height }
}

/**
 * resedit 的 `entry.bin` 是 `ArrayBuffer`，而这里的解析全按 Buffer 走。
 * 单独一个包装是因为 `Buffer.from` 对 `ArrayBuffer | Uint8Array` 这个联合
 * 挑不出重载，而在每个调用点写一次 `as unknown as` 只是把噪声抄三遍。
 */
function asBuffer(bin: ArrayBuffer | Uint8Array): Buffer {
  return bin instanceof Uint8Array ? Buffer.from(bin) : Buffer.from(bin)
}

/** 这段字节是不是一张说得过去的 PNG */
function isPng(buf: Buffer): boolean {
  return buf.length >= MIN_PNG_BYTES && buf.subarray(0, 8).equals(PNG_SIG)
}

export interface BestIcon {
  png: Buffer
  width: number
  height: number
}

/**
 * 从一个图标组里挑最佳的 PNG 帧。**纯函数，不碰 resedit 也不碰 PE** ——
 * 自检直接构造 `groupBin` 和 `icons` 驱动它（真 exe 进不了自检，但触发问题的
 * 形状能原样搭出来）。和 `peReader` 里把 `parseVersionResource` 单独摘出来
 * 是同一个理由。
 *
 * `icons` 是 RT_ICON 按资源 id 索引的表。挑不出回 null。
 */
export function pickBestPngFrame(
  groupBin: ArrayBuffer | Uint8Array,
  icons: Map<number, Buffer>
): BestIcon | null {
  let best: BestIcon | null = null
  for (const frame of parseGroup(groupBin)) {
    const buf = icons.get(frame.id)
    if (!buf || !isPng(buf)) continue
    // 尺寸取 PNG 自己报的，不取目录项报的 —— 见 realSize 的注释
    const size = realSize(buf)
    if (!size) continue
    if (!best || size.width * size.height > best.width * best.height) {
      best = { png: buf, width: size.width, height: size.height }
    }
  }
  if (!best) return null
  // 比 getFileIcon 还小就不值得用这条路
  return best.width >= MIN_USEFUL_PX && best.height >= MIN_USEFUL_PX ? best : null
}

/**
 * 从一个 exe 的字节里取最佳的 PNG 图标帧。取不到回 null，调用方退回
 * `app.getFileIcon`。
 *
 * 任何解析失败都是 null，不抛 —— 单个畸形文件不许中断整次扫描。
 * 这一条和 `readPeInfo` 的约定一致。
 */
export function bestIconPng(buffer: Buffer): BestIcon | null {
  let entries: ReturnType<typeof ResEdit.NtExecutableResource.from>['entries']
  try {
    const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true })
    entries = ResEdit.NtExecutableResource.from(exe).entries
  } catch {
    return null
  }

  // RT_ICON 按 id 索引一次。多个图标组常常共用帧，逐组重新遍历是白扫
  const icons = new Map<number, Buffer>()
  for (const e of entries) {
    if (e.type !== RT_ICON) continue
    const id = Number(e.id)
    if (Number.isFinite(id) && !icons.has(id)) icons.set(id, asBuffer(e.bin))
  }
  if (icons.size === 0) return null

  /*
   * 图标组按 id 升序试，**取第一个有 PNG 帧的组里最大的那张**。
   *
   * 为什么不跨组挑最大：Windows 拿资源 id 最小的那一组当程序图标，别的组是
   * 文档类型图标之类的东西（腾讯 ima.copilot 有 12 组）。跨组取最大有可能
   * 挑到一张「这个软件能打开的文件」的图标，而那种错法看起来像是刮错了封面。
   */
  const groups = entries
    .filter((e) => e.type === RT_GROUP_ICON)
    .map((e) => ({ id: Number(e.id), bin: e.bin }))
    .sort((a, b) => a.id - b.id)

  for (const g of groups) {
    const best = pickBestPngFrame(g.bin, icons)
    if (best) return best
  }
  return null
}

