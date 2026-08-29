/**
 * 把 ludusavi-manifest 的 YAML 编译成一份紧凑的 JSON 索引。
 *
 *   npm run build-save-manifest
 *
 * 输入是 `参考/ludusavi-manifest-master/data/manifest.yaml`（16.7 MB，53000 条记录，
 * 数据源是 PCGamingWiki）。**输入本身不在仓库里** —— `参考/` 是 gitignore 的，
 * 要重新编译得先去 https://github.com/mtkennerly/ludusavi-manifest 抓一份放到那个位置。
 * 编译产物 `resources/save-manifest.json` 才是提交进仓库、随应用分发的那一份，
 * 所以平常没人需要跑这个脚本 —— 只有想跟上上游更新时才跑。
 *
 * 为什么在构建期编译，而不是运行时读 YAML：
 *   · 运行时不需要 YAML 解析器。js-yaml 只是 devDependency，不进打包产物。
 *   · 16.7 MB 的 YAML 解析一次要几百毫秒并吃掉上百 MB 内存。而我们只需要其中
 *     一小部分字段（存档路径模板），编译完不到十分之一。
 *   · 编译期能把「展不开的占位符」这类问题一次性筛掉，运行时那一层因此可以
 *     假定索引里的每条模板都是能展开的，不必在热路径上重复判断。
 *
 * 只保留 Windows 上用得上、且**能展开**的模板。ludusavi 支持的占位符比我们多
 * （`<root>` 是它自己配置的库目录，`<storeUserId>` 是 Steam 用户数字 ID），
 * 那些我们无从得知，留在索引里只会让「已知存档位置」这句话变成谎话。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { normalizeGameName, truncateTemplate } from '../electron/kinds/game/savedb.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SOURCE = path.join(ROOT, '参考', 'ludusavi-manifest-master', 'data', 'manifest.yaml')
const OUT = path.join(ROOT, 'resources', 'save-manifest.json')

/** ludusavi 的条目形状，只声明我们真正读的那几个字段 */
interface LudusaviGame {
  files?: Record<string, { tags?: string[]; when?: Array<{ os?: string; store?: string }> }>
}

/**
 * 一条 `files` 记录要不要收。
 *
 * tags 里有 `save` 就收；**完全没有 tags 也收** —— ludusavi 自己对无标签条目
 * 的处理就是照备，那多半是没人来得及分类的存档路径。只标了 `config` 的不收：
 * 配置文件丢了重设一遍就行，那不是这个功能要保护的东西。
 */
function wantedTags(tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true
  return tags.includes('save')
}

/**
 * `when` 说明这条路径在哪些平台/商店下成立。没有 when = 到处都成立。
 * 有 when 时，只要有**任意一条**没写 os 或写的是 windows，这条路径在 Windows 上就成立。
 */
function onWindows(when?: Array<{ os?: string }>): boolean {
  if (!when || when.length === 0) return true
  return when.some((w) => !w.os || w.os === 'windows')
}

/* 截断规则和运行时共用同一份实现（savedb.ts 的 truncateTemplate），
   两边必须一致 —— 否则索引里会留下运行时展不开的模板。 */

/* ============================== 编译 ============================== */

if (!fs.existsSync(SOURCE)) {
  console.error(`找不到源文件：${SOURCE}`)
  console.error('参考/ 是 gitignore 的。从 https://github.com/mtkennerly/ludusavi-manifest')
  console.error('下载 manifest.yaml 放到那个位置，或直接用仓库里已编译好的 resources/save-manifest.json。')
  process.exit(1)
}

console.log(`读取 ${path.relative(ROOT, SOURCE)}（${(fs.statSync(SOURCE).size / 1024 / 1024).toFixed(1)} MB）…`)
const raw = yaml.load(fs.readFileSync(SOURCE, 'utf-8')) as Record<string, LudusaviGame>
const total = Object.keys(raw).length
console.log(`解析出 ${total} 个游戏条目，开始筛选…`)

/** 归一化名 → { name: 原名, paths: 模板数组 } */
const index: Record<string, { name: string; paths: string[] }> = {}
const stats = {
  withFiles: 0,
  kept: 0,
  truncated: 0,
  dropUnexpandable: 0,
  dropTags: 0,
  dropOs: 0,
  collisions: 0
}

for (const [name, game] of Object.entries(raw)) {
  if (!game?.files) continue
  stats.withFiles++

  const paths: string[] = []
  for (const [template, rule] of Object.entries(game.files)) {
    if (!wantedTags(rule?.tags)) {
      stats.dropTags++
      continue
    }
    if (!onWindows(rule?.when)) {
      stats.dropOs++
      continue
    }
    const cut = truncateTemplate(template)
    if (!cut) {
      stats.dropUnexpandable++
      continue
    }
    if (cut !== template) stats.truncated++
    // 截断会让同一个游戏的 *.dat 和 *.bak 收敛成同一个父目录，去重
    if (!paths.includes(cut)) paths.push(cut)
  }
  if (paths.length === 0) continue

  const key = normalizeGameName(name)
  if (!key) continue

  // 归一化会让「Game: Remastered」和「Game Remastered」撞成同一个键。
  // 合并而不是后者覆盖前者：两条都是同一个游戏的真实存档位置，验证那一步
  // 会把不存在的筛掉，多给几条候选比丢掉一条正确的划算。
  if (index[key]) {
    stats.collisions++
    for (const p of paths) if (!index[key].paths.includes(p)) index[key].paths.push(p)
  } else {
    index[key] = { name, paths }
    stats.kept++
  }
}

const payload = {
  /** 索引自己的格式版本，和 SCHEMA_VERSION 无关。运行时读到不认识的版本就整个不用 */
  format: 1,
  source: 'ludusavi-manifest (PCGamingWiki)',
  built_at: new Date().toISOString(),
  games: index
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload), 'utf-8')

const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2)
console.log('')
console.log(`总条目          ${total}`)
console.log(`带 files 的      ${stats.withFiles}`)
console.log(`收进索引        ${stats.kept}（归一化撞键合并 ${stats.collisions} 次）`)
console.log(`截断到父目录     ${stats.truncated}（通配符 / 认不得的末段）`)
console.log(`丢弃 · 非存档    ${stats.dropTags}`)
console.log(`丢弃 · 非 Win    ${stats.dropOs}`)
console.log(`丢弃 · 截不出结果 ${stats.dropUnexpandable}`)
console.log('')
console.log(`已写出 ${path.relative(ROOT, OUT)}（${mb} MB）`)
