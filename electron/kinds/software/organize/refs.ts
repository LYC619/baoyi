/**
 * 安装版软件的「硬引用」扫描。
 *
 * move_risk 是 agent 的判断，可能看漏。在真的剪切一个安装版目录之前，
 * 这里再从磁盘和注册表上找一遍证据：有没有别的东西按固定路径记着它。
 * 找到了不阻止用户，只把结论摆到预览面板上 —— 决定权在用户，
 * 但他必须**看见**这条信息才能决定。
 *
 * 只读，不写注册表。查不出来一律当作「没发现」而不是「安全」。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 单次 reg query 的超时。注册表查询偶尔会卡，不能让整个预览跟着挂住 */
const REG_TIMEOUT_MS = 4000

/** 要问的几个键。卸载信息、App Paths、服务 —— 硬引用基本都落在这几处 */
const REG_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SYSTEM\\CurrentControlSet\\Services'
]

function regQuery(key: string, needle: string): Promise<string[]> {
  return new Promise((resolve) => {
    // /s 递归、/f 按值搜索、/d 只匹配数据（不匹配键名）
    execFile(
      'reg',
      ['query', key, '/s', '/f', needle, '/d'],
      { timeout: REG_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        // reg 找不到匹配时退出码非 0，这不是错误。真错了也只是「没发现」
        if (!stdout) return resolve([])
        const hits = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.toLowerCase().includes(needle.toLowerCase()))
          .slice(0, 5)
        resolve(hits)
      }
    )
  })
}

/** AppData 下有没有以这个软件目录名命名的配置目录 */
function appDataHits(dirName: string): string[] {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.PROGRAMDATA]
  const out: string[] = []
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, dirName)
    try {
      if (fs.statSync(candidate).isDirectory()) out.push(candidate)
    } catch {
      /* 不存在就是没有 */
    }
  }
  return out
}

export interface RefScan {
  /** 注册表里按这个路径记着它的项 */
  registry: string[]
  /** AppData / ProgramData 下的配置目录 */
  appData: string[]
}

export function hasRefs(scan: RefScan): boolean {
  return scan.registry.length > 0 || scan.appData.length > 0
}

/** 把扫描结果写成一句用户看得懂的警告。没发现任何引用时返回空串 */
export function describeRefs(scan: RefScan): string {
  const parts: string[] = []
  if (scan.registry.length > 0) {
    parts.push(`注册表里有 ${scan.registry.length} 处按当前路径记着它（${scan.registry[0]}）`)
  }
  if (scan.appData.length > 0) {
    parts.push(`配置目录：${scan.appData.join('、')}`)
  }
  if (parts.length === 0) return ''
  return `${parts.join('；')}。移动后这些引用会失效，可能导致卸载条目失灵或软件读不到配置。`
}

/**
 * 扫一个安装目录有没有被硬引用。
 *
 * ponytail: 只查四个注册表键 + 三个 AppData 根，按目录路径做子串匹配。
 * 漏报是可能的（引用写成 8.3 短路径、或存在别的键下就查不到），
 * 但这一步的定位是「把常见证据摆到用户眼前」，不是形式化证明安全。
 * 要更严谨得整树遍历 HKLM/HKCU，那要几十秒，预览面板等不了。
 */
export async function scanRefs(dir: string): Promise<RefScan> {
  const normalized = dir.replace(/[\\/]+$/, '')
  const registry: string[] = []

  const results = await Promise.all(REG_KEYS.map((k) => regQuery(k, normalized)))
  for (const hits of results) registry.push(...hits)

  return {
    registry: [...new Set(registry)].slice(0, 5),
    appData: appDataHits(path.basename(normalized))
  }
}
