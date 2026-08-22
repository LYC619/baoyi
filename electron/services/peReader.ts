import fs from 'node:fs'
import * as ResEdit from 'resedit'

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

function versionFromFixedInfo(fixed: any): string {
  if (!fixed) return ''
  const { fileVersionMS, fileVersionLS } = fixed
  if (typeof fileVersionMS !== 'number' || typeof fileVersionLS !== 'number') return ''
  const parts = [
    (fileVersionMS >>> 16) & 0xffff,
    fileVersionMS & 0xffff,
    (fileVersionLS >>> 16) & 0xffff,
    fileVersionLS & 0xffff
  ]
  return parts.every((p) => p === 0) ? '' : parts.join('.')
}

/**
 * 读取 Windows PE 文件的版本资源。任何解析失败都退回空信息，
 * 不允许因为单个损坏文件中断整次扫描。
 */
export function readPeInfo(exePath: string, fileSize: number): PeInfo {
  if (process.platform !== 'win32') return EMPTY
  if (fileSize <= 0 || fileSize > MAX_PARSE_BYTES) return EMPTY

  try {
    const buffer = fs.readFileSync(exePath)
    const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true })
    const res = ResEdit.NtExecutableResource.from(exe)
    const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
    if (!versions.length) return EMPTY

    const vi: any = versions[0]
    const langs = typeof vi.getAllLanguagesForStringValues === 'function'
      ? vi.getAllLanguagesForStringValues()
      : []
    const strings: Record<string, string> = langs?.[0]?.values ?? {}

    return {
      product_name: strings.ProductName?.trim() ?? '',
      file_description: strings.FileDescription?.trim() ?? '',
      company: strings.CompanyName?.trim() ?? '',
      version:
        strings.FileVersion?.trim() ||
        strings.ProductVersion?.trim() ||
        versionFromFixedInfo(vi.fixedInfo)
    }
  } catch {
    return EMPTY
  }
}
