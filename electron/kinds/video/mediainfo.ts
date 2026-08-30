/**
 * 容器元数据：从视频文件本身读时长、分辨率、编码、音轨、内嵌字幕轨。
 *
 * 这是「本地事实」链条上最后也最硬的一环。文件名解析只认字面写了的
 * （见 `filename.ts` 里 `literalResolution` 的注释：宁可留空也不编一个），
 * 留下的空正是这一步来填 —— 一个没写分辨率的 `电影.mkv`，容器里有真值。
 *
 * ## 为什么是 WASM
 *
 * mediainfo.js 是 MediaInfoLib 的 Emscripten 移植，`dist/MediaInfoModule.wasm`
 * 是纯 WASM，**没有原生模块**。这是硬要求不是偏好：本机装不了 MSVC C++ 工具链，
 * 任何走 node-gyp 的方案都构建不出来（electron-libmpv 就是这么被否掉的，
 * 见 `v0.7-进度.md`）。
 *
 * ## 这个文件为什么拆成两半
 *
 * `mapMediaInfo` 是纯函数，收 mediainfo 的结果对象出本项目的形状，自检能
 * 拿固定 fixture 把每条映射规则都验一遍。`readContainerInfo` 才碰 fs 和 WASM。
 *
 * 拆开的理由和 v0.6 一样：真正容易错的是**映射规则**（多音轨怎么排、
 * 语言代码怎么归一、分辨率怎么落到和文件名解析同一套词汇上），
 * 而不是「能不能读到文件」。把规则关在纯函数里，它就永远是可测的。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MediaTrack } from '../../../src/types/index.ts'

/* ============================== 输出形状 ============================== */

export interface ContainerInfo {
  /** 时长，秒。0 = 读不出来 */
  duration_sec: number
  /** 容器格式（`Matroska` / `MPEG-4`）。空串 = 读不出来 */
  container: string

  width: number
  height: number
  /**
   * 归一到和文件名解析同一套词汇：`2160p` / `1080p` / `720p` / …
   *
   * 必须同一套，否则同一个字段在详情页上会时而 `1080p` 时而 `1920x1080`，
   * 而筛选器按字符串比对会把它们当成两种东西。
   */
  resolution: string
  /** `HEVC` / `AVC` / `AV1` … 空串 = 读不出来 */
  video_codec: string

  audio_tracks: MediaTrack[]
  /** 只有**内嵌**轨。外挂字幕是扫描器的事，它们的 index 恒为 -1 */
  subtitle_tracks: MediaTrack[]
}

/** 空值。含义统一是「读不出来」，不是「值为零」 */
export function emptyContainerInfo(): ContainerInfo {
  return {
    duration_sec: 0,
    container: '',
    width: 0,
    height: 0,
    resolution: '',
    video_codec: '',
    audio_tracks: [],
    subtitle_tracks: []
  }
}

/* ============================== 纯映射 ============================== */

/** mediainfo 的一条 track。字段全是字符串，键名大小写不稳，所以取值走 pick */
type RawTrack = Record<string, unknown>

/**
 * 取字段，**大小写不敏感**。
 *
 * mediainfo 不同版本、不同容器给出的键名大小写不一致（`Duration` / `duration`、
 * `Channels` / `Channel(s)`）。按字面取会在某个容器上突然读成空，
 * 而这种错不会报错，只会让详情页上少一行 —— 最难发现的那种。
 */
function pick(track: RawTrack, ...names: string[]): string {
  const lower = new Map<string, unknown>()
  for (const [k, v] of Object.entries(track)) lower.set(k.toLowerCase().replace(/[^a-z0-9]/g, ''), v)
  for (const n of names) {
    const v = lower.get(n.toLowerCase().replace(/[^a-z0-9]/g, ''))
    if (v === undefined || v === null) continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

function toNum(s: string): number {
  const m = /-?\d+(?:\.\d+)?/.exec(s)
  return m ? Number(m[0]) : 0
}

/**
 * 像素尺寸 -> 分辨率标签。
 *
 * **宽度优先，高度兜底。** 宽度是更稳的信号：不管画幅多宽，横向像素基本
 * 就是那几个标准值（3840 / 1920 / 1280）。高度不是 —— 2.39:1 的宽银幕
 * 1080p 常是 1920x800，按高度分档会把它判成 720p 甚至更低，
 * 而它在文件名里、在用户心里都是 1080p。
 *
 * 分档取「不低于」而不是精确匹配，因为 1912x796 这种非标准裁切真实存在。
 */
export function resolutionLabel(width: number, height: number): string {
  const w = Math.max(0, Math.round(width))
  const h = Math.max(0, Math.round(height))
  if (w <= 0 && h <= 0) return ''

  if (w > 0) {
    if (w >= 3200) return '2160p'
    if (w >= 1800) return '1080p'
    if (w >= 1200) return '720p'
    if (w >= 900) return '576p'
    if (w >= 800) return '540p'
    if (w >= 600) return '480p'
    return '360p'
  }
  if (h >= 1700) return '2160p'
  if (h >= 900) return '1080p'
  if (h >= 620) return '720p'
  if (h >= 550) return '576p'
  if (h >= 500) return '540p'
  if (h >= 400) return '480p'
  return '360p'
}

/**
 * 语言代码归一到两字母小写。
 *
 * mediainfo 给的可能是 `zh` / `zho` / `chi` / `Chinese` / `zh-CN`，
 * 归不到一起的话「中文」在筛选器里会散成四个。
 */
export function normLanguage(raw: string): string {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return ''
  const head = s.split(/[-_]/)[0]
  const MAP: Record<string, string> = {
    zho: 'zh', chi: 'zh', chinese: 'zh', mandarin: 'zh', cantonese: 'zh', yue: 'zh',
    eng: 'en', english: 'en',
    jpn: 'ja', japanese: 'ja',
    kor: 'ko', korean: 'ko',
    fra: 'fr', fre: 'fr', french: 'fr',
    deu: 'de', ger: 'de', german: 'de',
    spa: 'es', spanish: 'es',
    rus: 'ru', russian: 'ru',
    ita: 'it', italian: 'it'
  }
  if (MAP[head]) return MAP[head]
  return /^[a-z]{2}$/.test(head) ? head : ''
}

/** 声道数 -> 人话。5.1 / 7.1 这种是用户认得的写法，`6 声道` 不是 */
function channelLabel(channels: number): string {
  if (channels <= 0) return ''
  if (channels === 1) return '单声道'
  if (channels === 2) return '立体声'
  if (channels === 6) return '5.1'
  if (channels === 8) return '7.1'
  return `${channels} 声道`
}

const LANG_ZH: Record<string, string> = {
  zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语',
  de: '德语', es: '西语', ru: '俄语', it: '意语'
}

/**
 * 一条轨道显示成什么。优先用容器里写的标题 —— 压制组常常写得比我们拼的准
 * （「国语 5.1」「简体中文」），拼一个不如用现成的。
 */
function trackLabel(title: string, lang: string, extra: string): string {
  if (title) return title
  const parts = [LANG_ZH[lang] ?? lang, extra].filter(Boolean)
  return parts.join(' ')
}

/**
 * mediainfo 的结果对象 -> ContainerInfo。纯函数。
 *
 * 传进来的是 `format: 'object'` 那种结果，形状是 `{ media: { track: [...] } }`，
 * 每条 track 用 `@type` 区分 General / Video / Audio / Text。
 */
export function mapMediaInfo(result: unknown): ContainerInfo {
  const out = emptyContainerInfo()
  const media = (result as Record<string, unknown> | null)?.media as Record<string, unknown> | undefined
  const rawTracks = media?.track
  if (!Array.isArray(rawTracks)) return out

  const tracks = rawTracks as RawTrack[]
  const typeOf = (t: RawTrack): string => pick(t, '@type', 'type').toLowerCase()

  const general = tracks.find((t) => typeOf(t) === 'general')
  if (general) {
    out.duration_sec = Math.round(toNum(pick(general, 'Duration')))
    out.container = pick(general, 'Format')
  }

  const video = tracks.find((t) => typeOf(t) === 'video')
  if (video) {
    out.width = Math.round(toNum(pick(video, 'Width')))
    out.height = Math.round(toNum(pick(video, 'Height')))
    out.resolution = resolutionLabel(out.width, out.height)
    // Format_Profile 之类不取：详情页要的是「HEVC」不是「HEVC Main 10@L5@Main」
    out.video_codec = pick(video, 'Format').toUpperCase()
    // General 没有时长时退回视频轨的
    if (out.duration_sec === 0) out.duration_sec = Math.round(toNum(pick(video, 'Duration')))
  }

  let audioIndex = 0
  let textIndex = 0
  for (const t of tracks) {
    const kind = typeOf(t)
    if (kind === 'audio') {
      const lang = normLanguage(pick(t, 'Language'))
      const channels = Math.round(toNum(pick(t, 'Channels', 'Channel(s)')))
      const codec = pick(t, 'Format').toUpperCase()
      out.audio_tracks.push({
        index: audioIndex++,
        language: lang,
        label: trackLabel(pick(t, 'Title'), lang, channelLabel(channels)),
        codec,
        path: ''
      })
    } else if (kind === 'text') {
      const lang = normLanguage(pick(t, 'Language'))
      out.subtitle_tracks.push({
        index: textIndex++,
        language: lang,
        label: trackLabel(pick(t, 'Title'), lang, forcedMark(t)),
        codec: pick(t, 'Format').toUpperCase(),
        // 内嵌轨没有路径。外挂字幕由扫描器填，index 恒为 -1
        path: ''
      })
    }
  }

  return out
}

/** 强制字幕标记。用户看到「英语 强制」就知道那是外星语翻译轨而不是全片字幕 */
function forcedMark(t: RawTrack): string {
  return pick(t, 'Forced').toLowerCase() === 'yes' ? '强制' : ''
}

/* ============================== 读文件 ============================== */

/**
 * 找 `MediaInfoModule.wasm`。
 *
 * 开发时它在 `node_modules/mediainfo.js/dist/` 下；打包之后 electron-builder
 * 得把它复制进 resources。三条候选按可靠性排，都找不到就返回空串，
 * 由调用方决定是报错还是降级 —— **容器元数据读不到不该阻断入库**，
 * 文件名解析出来的那部分事实还在。
 */
function findWasm(): string {
  const fromEnv = process.env.BAOYI_MEDIAINFO_WASM
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const candidates: string[] = []
  // 开发和未打包的 Electron：从 node_modules 里解析
  if (typeof require !== 'undefined') {
    try {
      candidates.push(require.resolve('mediainfo.js/MediaInfoModule.wasm'))
    } catch {
      // 解析不到就往下试，不是错误
    }
  }
  candidates.push(path.join(process.cwd(), 'node_modules', 'mediainfo.js', 'dist', 'MediaInfoModule.wasm'))
  // 打包之后：electron-builder 的 extraResources
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (res) candidates.push(path.join(res, 'MediaInfoModule.wasm'))

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // 路径非法，continue
    }
  }
  return ''
}

/** WASM 模块只初始化一次。它有几 MB，每个文件重来一遍会把扫描拖垮 */
let cached: Promise<unknown> | null = null

async function getMediaInfo(): Promise<unknown> {
  if (cached) return cached
  cached = (async () => {
    const wasmPath = findWasm()
    const mod = (await import('mediainfo.js')) as unknown as {
      default: (opts: Record<string, unknown>) => Promise<unknown>
    }
    return mod.default({
      format: 'object',
      // 不要封面数据：base64 的图片会让结果对象大出几个数量级，
      // 而海报我们另有来源（侧车图片 + 联网）
      coverData: false,
      // 全量标签同理，详情页用不上，只会让映射函数要处理的键翻几倍
      full: false,
      locateFile: (p: string, prefix: string) => (wasmPath ? wasmPath : prefix + p)
    })
  })()
  return cached
}

/**
 * 读一个文件的容器元数据。读不出来返回 null。
 *
 * **不抛异常**是有意的：一个损坏的、正在下载的、或者权限不足的文件不该让
 * 整次扫描停下来。调用方拿到 null 就用文件名解析出来的那部分，
 * 详情页少几行，但条目还在。
 */
export async function readContainerInfo(filePath: string): Promise<ContainerInfo | null> {
  let handle: fsp.FileHandle | null = null
  try {
    const mi = (await getMediaInfo()) as {
      analyzeData: (
        size: () => Promise<number>,
        read: (chunkSize: number, offset: number) => Promise<Uint8Array>
      ) => Promise<unknown>
    }
    const stat = await fsp.stat(filePath)
    if (!stat.isFile() || stat.size === 0) return null

    handle = await fsp.open(filePath, 'r')
    const fh = handle
    const result = await mi.analyzeData(
      () => Promise.resolve(stat.size),
      async (chunkSize: number, offset: number) => {
        const buf = new Uint8Array(chunkSize)
        const { bytesRead } = await fh.read(buf, 0, chunkSize, offset)
        return buf.subarray(0, bytesRead)
      }
    )
    return mapMediaInfo(result)
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** WASM 加载不加载得起来。自检和设置页的诊断用 */
export function mediaInfoWasmPath(): string {
  return findWasm()
}
