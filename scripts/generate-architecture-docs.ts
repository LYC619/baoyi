import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { SCHEMA_VERSION, initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { ARCHIVE_TOOLS } from '../electron/archive/tools.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = path.join(ROOT, 'docs', 'architecture-and-ipc.md')

interface RouteRow {
  path: string
  name: string
  component: string
  module: string
  remountOnId: boolean
}

interface IpcFileSummary {
  file: string
  channels: { channel: string; kind: 'handle' | 'on' }[]
}

function readUtf8(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function collectServices(): { domain: string; files: string[] }[] {
  const base = path.join(ROOT, 'electron', 'services')
  const domains = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  return domains.map(domain => ({
    domain,
    files: fs.readdirSync(path.join(base, domain), { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.ts'))
      .map(e => e.name)
      .sort()
  }))
}

function collectTables(): { name: string; columns: number }[] {
  const db = new DatabaseSync(':memory:')
  initSchema(db as any, KINDS)
  db.exec(VIDEO_JOBS_SQL)
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name)
  const rows = names.map(name => {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
    return { name, columns: cols.length }
  })
  db.close()
  return rows
}

function collectRoutes(): RouteRow[] {
  const src = readUtf8('src/router/index.ts')
  const routesMatch = src.match(/routes:\s*\[([\s\S]*?)\n\s*\]/)
  if (!routesMatch) return []
  const body = routesMatch[1]
  const rows: RouteRow[] = []
  const objRe = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
  for (const m of body.matchAll(objRe)) {
    const block = m[1]
    const p = block.match(/path:\s*['"]([^'"]+)['"]/)?.[1]
    if (!p) continue
    const name = block.match(/name:\s*['"]([^'"]+)['"]/)?.[1] || '(redirect)'
    const comp = block.match(/import\(\s*['"]([^'"]+)['"]\s*\)/)?.[1] || (block.includes('redirect') ? 'redirect -> /' : '-')
    const mod = block.match(/module:\s*['"]([^'"]+)['"]/)?.[1] || '-'
    const remountOnId = /remountOnId:\s*true/.test(block)
    rows.push({ path: p, name, component: comp, module: mod, remountOnId })
  }
  return rows
}

const PREFIX_MAP: Record<string, string> = {
  'archive.ts': 'archive:',
  'comic-ingest.ts': 'comic:',
  'image-source.ts': 'image:',
  'image.ts': 'image:',
  'music.ts': 'music:',
  'project.ts': 'project:',
  'video-preview.ts': 'video-preview:',
  'workspace.ts': 'workspace:'
}

function collectIpcHandlers(): IpcFileSummary[] {
  const dir = path.join(ROOT, 'electron', 'ipc')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).sort()
  const out: IpcFileSummary[] = []
  for (const file of files) {
    const txt = fs.readFileSync(path.join(dir, file), 'utf8')
    const prefix = PREFIX_MAP[file] || ''
    const seen = new Set<string>()
    const channels: { channel: string; kind: 'handle' | 'on' }[] = []

    const directRe = /\b(?:ipcMain|ipc)\.(handle|on)\(\s*['"]([^'"]+)['"]/g
    for (const m of txt.matchAll(directRe)) {
      const kind = m[1] as 'handle' | 'on'
      const channel = m[2]
      if (channel.endsWith(':')) continue
      const key = `${kind}:${channel}`
      if (!seen.has(key)) { seen.add(key); channels.push({ channel, kind }) }
    }

    if (prefix) {
      const wrappedRe = /\b(?:handle|write)\(\s*['"]([^'"]+)['"]/g
      for (const m of txt.matchAll(wrappedRe)) {
        if (m[1].endsWith(':')) continue
        const channel = prefix + m[1]
        const key = `handle:${channel}`
        if (!seen.has(key)) { seen.add(key); channels.push({ channel, kind: 'handle' }) }
      }
    }

    if (channels.length) {
      channels.sort((a, b) => a.channel.localeCompare(b.channel))
      out.push({ file, channels })
    }
  }
  return out
}

function collectPreload(): { namespaces: string[]; invokeChannels: string[]; sendChannels: string[]; eventChannels: string[] } {
  const src = readUtf8('electron/preload.ts')
  const namespaces: string[] = []
  const apiStart = src.indexOf('const api: BaoyiApi = {')
  if (apiStart >= 0) {
    const snippet = src.slice(apiStart)
    for (const m of snippet.matchAll(/^  ([a-zA-Z0-9_]+):\s*\{/gm)) {
      namespaces.push(m[1])
    }
  }
  const uniq = (re: RegExp) => [...new Set([...src.matchAll(re)].map(m => m[1]))].sort()
  return {
    namespaces,
    invokeChannels: uniq(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g),
    sendChannels: uniq(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g),
    eventChannels: uniq(/subscribe(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g)
  }
}

export function generateArchitectureDoc(): string {
  const pkg = JSON.parse(readUtf8('package.json'))
  const services = collectServices()
  const tables = collectTables()
  const routes = collectRoutes()
  const ipcFiles = collectIpcHandlers()
  const preload = collectPreload()

  const registeredHandle = new Set(ipcFiles.flatMap(f => f.channels.filter(c => c.kind === 'handle').map(c => c.channel)))
  const registeredOn = new Set(ipcFiles.flatMap(f => f.channels.filter(c => c.kind === 'on').map(c => c.channel)))
  const missingHandles = preload.invokeChannels.filter(ch => !registeredHandle.has(ch))
  const missingOns = preload.sendChannels.filter(ch => !registeredOn.has(ch))

  const totalIpc = ipcFiles.reduce((n, f) => n + f.channels.length, 0)
  const totalServices = services.reduce((n, d) => n + d.files.length, 0)

  const lines: string[] = [
    '# 抱一架构与 IPC 索引',
    '',
    '> 本文件由 `scripts/generate-architecture-docs.ts` 根据 `electron/ipc/*`、`electron/preload.ts`、`electron/services/storage/schema.ts`、`electron/archive/tools.ts` 与 `src/router/index.ts` 自动生成。请运行 `npm run docs:generate` 更新，勿手工编辑。',
    '',
    '## 概览',
    '',
    '| 维度 | 当前值 |',
    '|---|---|',
    `| 应用版本 | \`${pkg.version}\` |`,
    `| SQLite Schema 版本 | \`v${SCHEMA_VERSION}\`（共 ${tables.length} 张数据表） |`,
    `| 主进程服务域 | ${services.length} 个子目录 / ${totalServices} 个模块文件 |`,
    `| IPC 通道 | ${totalIpc} 条主进程通道（${ipcFiles.length} 个模块）；Preload 暴露 ${preload.namespaces.length} 个命名空间（${preload.invokeChannels.length} invoke / ${preload.sendChannels.length} send / ${preload.eventChannels.length} event） |`,
    `| 前端路由 | ${routes.length} 条（Hash 路由；详情页按 \`meta.remountOnId\` 防迟到响应） |`,
    `| 归档助理工具 | ${ARCHIVE_TOOLS.length} 项（均含 JSON Schema 与离线 Eval 覆盖） |`,
    `| Preload ↔ Main 一致性 | 缺失 handle: ${missingHandles.length}，缺失 on: ${missingOns.length} |`,
    '',
    '## 1. 主进程服务分层 (`electron/services/`)',
    '',
    '| 业务域 | 模块数 | 文件清单 |',
    '|---|---:|---|'
  ]

  for (const s of services) {
    lines.push(`| \`${s.domain}/\` | ${s.files.length} | ${s.files.map(f => `\`${f}\``).join('、')} |`)
  }

  lines.push(
    '',
    '## 2. 数据表结构 (`SCHEMA_VERSION = ' + SCHEMA_VERSION + '`)',
    '',
    '| 表名 | 列数 |',
    '|---|---:|'
  )
  for (const t of tables) {
    lines.push(`| \`${t.name}\` | ${t.columns} |`)
  }

  lines.push(
    '',
    '## 3. 前端路由 (`src/router/index.ts`)',
    '',
    '| 路径 | 路由名 | 所属模块 | `remountOnId` | 页面组件 |',
    '|---|---|---|---|---|'
  )
  for (const r of routes) {
    lines.push(`| \`${r.path}\` | \`${r.name}\` | \`${r.module}\` | ${r.remountOnId ? '是' : '否'} | \`${r.component}\` |`)
  }

  lines.push(
    '',
    '## 4. Preload API 边界 (`window.baoyi.*`)',
    '',
    `- **暴露命名空间（${preload.namespaces.length}）**：${preload.namespaces.map(n => `\`${n}\``).join('、')}`,
    `- **主进程推送事件（${preload.eventChannels.length}）**：${preload.eventChannels.map(e => `\`${e}\``).join('、')}`,
    '- **边界安全约定**：所有渲染进程调用经过 `electron/ipc/main-window.ts`（主窗口主 frame 鉴权、停机/重置门控与原型污染/空字节/深度守卫）及 `electron/ipc/validate.ts` 运行时参数校验，失败时抛出带错误码的结构化 `IpcError`。',
    '',
    '## 5. IPC 通道清单 (`electron/ipc/*.ts`)',
    '',
    '| 模块文件 | 通道数 | 注册通道 |',
    '|---|---:|---|'
  )
  for (const f of ipcFiles) {
    const chList = f.channels.map(c => c.kind === 'on' ? `\`${c.channel}\` *(on)*` : `\`${c.channel}\``).join('、')
    lines.push(`| \`electron/ipc/${f.file}\` | ${f.channels.length} | ${chList} |`)
  }

  lines.push(
    '',
    `## 6. 归档助理工具集 (\`electron/archive/tools.ts\`，共 ${ARCHIVE_TOOLS.length} 项)`,
    '',
    '| # | 工具名 | 必填参数 | 说明 |',
    '|---:|---|---|---|'
  )
  ARCHIVE_TOOLS.forEach((tool, idx) => {
    const req = (tool.parameters?.required as string[] | undefined)?.length
      ? (tool.parameters.required as string[]).map(r => `\`${r}\``).join(', ')
      : '无'
    const desc = tool.description.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim()
    lines.push(`| ${idx + 1} | \`${tool.name}\` | ${req} | ${desc} |`)
  })

  if (missingHandles.length || missingOns.length) {
    lines.push(
      '',
      '## 校验告警',
      '',
      ...(missingHandles.length ? [`- 未匹配主进程 handle：${missingHandles.join(', ')}`] : []),
      ...(missingOns.length ? [`- 未匹配主进程 on：${missingOns.join(', ')}`] : [])
    )
  }

  return lines.join('\n') + '\n'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const generated = generateArchitectureDoc()
  if (check) {
    if (!fs.existsSync(OUT_FILE)) {
      console.error('FAIL docs/architecture-and-ipc.md 不存在，请运行 npm run docs:generate')
      process.exit(1)
    }
    const existing = fs.readFileSync(OUT_FILE, 'utf8').replace(/\r\n/g, '\n')
    if (existing !== generated) {
      console.error('FAIL docs/architecture-and-ipc.md 已过期，请运行 npm run docs:generate 同步')
      process.exit(1)
    }
    console.log('PASS docs/architecture-and-ipc.md is up to date')
  } else {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
    fs.writeFileSync(OUT_FILE, generated, 'utf8')
    console.log('GENERATED', path.relative(ROOT, OUT_FILE))
  }
}
