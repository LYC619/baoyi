import fs from 'node:fs'
import path from 'node:path'
import * as ResEdit from 'resedit'
import { timeSync } from '../../services/timing.ts'

export interface PeInfo {
  product_name: string
  file_description: string
  company: string
  version: string
}

const EMPTY: PeInfo = { product_name: '', file_description: '', company: '', version: '' }

export type PeArch = 'x64' | 'x86' | 'arm64' | ''

const MACHINE: Record<number, PeArch> = {
  0x8664: 'x64',
  0x014c: 'x86',
  0xaa64: 'arm64'
}

/**
 * 只读 PE 头里的 machine 字段判断位数，不加载整个文件。
 * 这是 agent 合并 32/64 位条目最直接的依据 —— 比猜文件名后缀可靠得多。
 */
export function readPeArch(exePath: string): PeArch {
  let fd: number | null = null
  try {
    fd = fs.openSync(exePath, 'r')
    const head = Buffer.alloc(0x40)
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length) return ''
    if (head.readUInt16LE(0) !== 0x5a4d) return '' // 不是 MZ 开头
    const peOffset = head.readUInt32LE(0x3c)
    if (peOffset <= 0 || peOffset > 0x1000_0000) return ''

    const sig = Buffer.alloc(6)
    if (fs.readSync(fd, sig, 0, sig.length, peOffset) < sig.length) return ''
    if (sig.readUInt32LE(0) !== 0x0000_4550) return '' // 不是 "PE\0\0"
    return MACHINE[sig.readUInt16LE(4)] ?? ''
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关不上就算了，不影响结果 */
      }
    }
  }
}

/**
 * resedit 需要把整个 exe 读进内存。超过这个体积就跳过资源解析，
 * 只靠文件名 + AI 识别。
 * ponytail: 上限 128MB —— 想支持更大的文件需换成按节区流式读取 PE 资源表。
 */
const MAX_PARSE_BYTES = 128 * 1024 * 1024

/** RT_VERSION */
const RT_VERSION = 16

/* --------------------- VS_VERSIONINFO 自己走一遍 --------------------- */

/**
 * **不用 resedit 的 `VersionInfo.fromEntries`：它在真实文件上会死循环。**
 *
 * resedit 2.0.3 的 `parseStringTable` 读完一条 String 之后，靠那条**自报的
 * wValueLength** 算下一条的位置：`offset = roundUp(keyEnd + wValueLength * 2, 4)`。
 * 真机上 `D:\软件\Waves-5.0.5000.msi_\Waves.exe` 的 CompanyName 自报
 * wValueLength=26，而它 wLength=88 圈出来的值区实际占 28 个 wchar。游标于是落在
 * 0xEC，比真正的下一条（0xF0）短 4 字节，读到的是值区尾部的填充：
 * childDataLen=0、wType≠1 → `offset += 0` → continue → 原地打转，永不退出。
 *
 * 那是个纯同步的死循环，三层防线全都挡不住它：不抛错，所以 catch 不到；文件只有
 * 0.59MB，所以体积上限用不上；没有 await，所以事件循环一次都轮不到。主进程就停在
 * 这一句上，窗口消息循环跟着停摆 —— 用户看到的就是「抱一 未响应」。
 * 后台结果照样进库，是因为卡住之前那些目录已经写完了。
 *
 * 改成按每个节点**自报的 wLength** 前进（wLength 才是含头、值和填充的整条长度），
 * 并且游标不严格变大就立刻收手。结构上不可能转不动，畸形数据最多少读几个字段。
 *
 * 顺带不再按 wType 筛 String 条目。那个字段本该 1 表示文本，实际不可信：
 * vc_redist.x64.exe 八条全写 0，值却都是正常文本，Windows 也照样当文本读出来。
 * StringFileInfo 底下的条目按定义就是字符串，位置对得上就读。
 */

const align4 = (n: number): number => (n + 3) & ~3

interface VerNode {
  wLength: number
  wValueLength: number
  wType: number
  key: string
  /** 值区起点（szKey 之后按 4 字节对齐） */
  valueStart: number
  /** 整条节点的结束位置 */
  end: number
}

function readNode(b: Buffer, off: number, limit: number): VerNode | null {
  if (off + 6 > limit) return null
  const wLength = b.readUInt16LE(off)
  // wLength 小于头长（含自报 0）的节点没法据它前进，整棵子树就此打住
  if (wLength < 6) return null
  const end = Math.min(off + wLength, limit)

  let keyEnd = off + 6
  while (keyEnd + 1 < end && b.readUInt16LE(keyEnd) !== 0) keyEnd += 2
  return {
    wLength,
    wValueLength: b.readUInt16LE(off + 2),
    wType: b.readUInt16LE(off + 4),
    key: b.subarray(off + 6, keyEnd).toString('utf16le'),
    valueStart: align4(keyEnd + 2),
    end
  }
}

/** 一个节点的子节点从哪开始：值区之后 */
function childrenStart(node: VerNode): number {
  return align4(node.valueStart + (node.wType === 1 ? node.wValueLength * 2 : node.wValueLength))
}

/** 走一层子节点。budget 是整份资源共用的节点预算，兜住任何形状的畸形数据。 */
function eachChild(
  b: Buffer,
  start: number,
  end: number,
  budget: { left: number },
  fn: (node: VerNode) => void
): void {
  let cursor = start
  while (cursor + 6 <= end) {
    if (budget.left-- <= 0) return
    const node = readNode(b, cursor, end)
    if (!node) return
    fn(node)
    const next = align4(cursor + node.wLength)
    if (next <= cursor) return // 游标必须严格前进，否则就是上面那个死循环
    cursor = next
  }
}

function readWideString(b: Buffer, start: number, end: number): string {
  let e = start
  while (e + 1 < end && b.readUInt16LE(e) !== 0) e += 2
  return b.subarray(start, Math.max(start, e)).toString('utf16le')
}

/**
 * 版本资源里的值经常带看不见的字符，直接进库会变成搜不着、对不上的脏数据。
 * 真机上 dpinst64.exe 的 FileDescription 前面就挂着两个 U+200E（从左至右标记），
 * 肉眼和 "Driver Package Installer" 完全一样。
 *
 * 一起清掉的还有零宽字符和 BOM；普通空白交给 trim。
 */
function cleanValue(s: string): string {
  return s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim()
}

function versionFromParts(ms: number, ls: number): string {
  const parts = [(ms >>> 16) & 0xffff, ms & 0xffff, (ls >>> 16) & 0xffff, ls & 0xffff]
  return parts.every((p) => p === 0) ? '' : parts.join('.')
}

/** 一份 VERSION 资源里最多走多少个节点。正常文件几十个，够用得很。 */
const MAX_VER_NODES = 4096

/**
 * 解析单份 VS_VERSIONINFO 二进制，拿出我们要的四个字段。
 *
 * 导出是给 selfcheck 用的：整个 readPeInfo 要有真 exe 才跑得起来，
 * 而死循环那个 bug 出在这一层，喂一段构造出来的畸形二进制就能守住。
 */
export function parseVersionResource(bin: Buffer): PeInfo {
  const budget = { left: MAX_VER_NODES }
  const root = readNode(bin, 0, bin.length)
  if (!root || root.key !== 'VS_VERSION_INFO') return EMPTY

  const strings: Record<string, string> = {}
  let fixedVersion = ''

  // 固定信息块：签名 0xFEEF04BD，紧跟在 szKey 后面
  if (root.wValueLength >= 52 && root.valueStart + 52 <= bin.length) {
    if (bin.readUInt32LE(root.valueStart) === 0xfeef04bd) {
      fixedVersion = versionFromParts(
        bin.readUInt32LE(root.valueStart + 8),
        bin.readUInt32LE(root.valueStart + 12)
      )
    }
  }

  eachChild(bin, childrenStart(root), root.end, budget, (block) => {
    if (block.key !== 'StringFileInfo') return
    // StringFileInfo → 每种语言一张 StringTable → 每张表若干 String
    eachChild(bin, childrenStart(block), block.end, budget, (table) => {
      eachChild(bin, childrenStart(table), table.end, budget, (str) => {
        if (!str.key) return
        // 值区的实长以 wLength 圈出来的范围为准，不信 wValueLength —— 正是它对不上才卡死的
        const value = cleanValue(readWideString(bin, str.valueStart, str.end))
        if (value && strings[str.key] === undefined) strings[str.key] = value
      })
    })
  })

  return {
    product_name: strings.ProductName?.trim() ?? '',
    file_description: strings.FileDescription?.trim() ?? '',
    company: strings.CompanyName?.trim() ?? '',
    version: strings.FileVersion?.trim() || strings.ProductVersion?.trim() || fixedVersion
  }
}

function hasAny(info: PeInfo): boolean {
  return Boolean(info.product_name || info.file_description || info.company || info.version)
}

/**
 * 读取 Windows PE 文件的版本资源。任何解析失败都退回空信息，
 * 不允许因为单个损坏文件中断整次扫描。
 *
 * 这里只用 resedit 定位资源（那部分没问题），版本资源自己解析 ——
 * 原因见上面 parseVersionResource 的注释。
 */
export function readPeInfo(exePath: string, fileSize: number): PeInfo {
  if (process.platform !== 'win32') return EMPTY
  if (fileSize <= 0 || fileSize > MAX_PARSE_BYTES) return EMPTY
  return timeSync(`readPeInfo ${path.basename(exePath)}`, () => readPeInfoInner(exePath))
}

function readPeInfoInner(exePath: string): PeInfo {
  try {
    const buffer = fs.readFileSync(exePath)
    const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true })
    const res = ResEdit.NtExecutableResource.from(exe)

    // 常见有多份（不同语言）。取第一份读得出东西的，空的就往下试。
    let fallback = EMPTY
    for (const entry of res.entries) {
      if (entry.type !== RT_VERSION) continue
      const info = parseVersionResource(Buffer.from(entry.bin))
      if (hasAny(info)) return info
      if (!hasAny(fallback)) fallback = info
    }
    return fallback
  } catch {
    return EMPTY
  }
}
