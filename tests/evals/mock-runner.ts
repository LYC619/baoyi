import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../../electron/services/storage/schema.ts'
import { KINDS } from '../../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../../electron/kinds/video/download/jobs.ts'
import { DocumentLibrary } from '../../electron/workspace/documents.ts'
import { PersonalLibrary } from '../../electron/workspace/personal.ts'
import { ProjectLibrary } from '../../electron/kinds/project/library.ts'
import { ImageLibrary } from '../../electron/kinds/image/library.ts'
import { scanImageImport } from '../../electron/kinds/image/scanner.ts'
import { inspectProject } from '../../electron/kinds/project/scanner.ts'
import { updateSoftware } from '../../electron/kinds/software/db.ts'
import { updateGame } from '../../electron/kinds/game/db.ts'
import { updateVideo } from '../../electron/kinds/video/db.ts'
import { ArchiveAssistant } from '../../electron/archive/service.ts'
import { ARCHIVE_TOOLS } from '../../electron/archive/tools.ts'
import { outlinePdf } from '../../scripts/helpers/pdf-fixture.ts'
import { pngImage } from '../../scripts/helpers/test-images.ts'

export interface SchemaValidationError {
  path: string
  message: string
}

/** Lightweight JSON Schema validator covering the subset used by ARCHIVE_TOOLS. */
export function validateAgainstSchema(value: unknown, schema: Record<string, any>, location = '$'): SchemaValidationError[] {
  const errors: SchemaValidationError[] = []
  if (!schema || typeof schema !== 'object') return errors
  const expectedType = schema.type
  if (expectedType !== undefined) {
    const types = Array.isArray(expectedType) ? expectedType : [expectedType]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const matches = types.some(t => (t === 'integer' ? typeof value === 'number' && Number.isInteger(value) : t === actual))
    if (!matches) {
      errors.push({ path: location, message: `expected ${types.join('|')}, got ${actual}` })
      return errors
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path: location, message: `value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]` })
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push({ path: location, message: `${value} < minimum ${schema.minimum}` })
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push({ path: location, message: `${value} > maximum ${schema.maximum}` })
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push({ path: location, message: `length ${value.length} < minItems ${schema.minItems}` })
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push({ path: location, message: `length ${value.length} > maxItems ${schema.maxItems}` })
    if (schema.items) {
      for (let i = 0; i < value.length; i++) errors.push(...validateAgainstSchema(value[i], schema.items, `${location}[${i}]`))
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in record) || record[key] === undefined) errors.push({ path: `${location}.${key}`, message: 'missing required property' })
      }
    }
    const props = (schema.properties || {}) as Record<string, any>
    for (const [key, item] of Object.entries(record)) {
      if (item === undefined) continue
      if (key in props) errors.push(...validateAgainstSchema(item, props[key], `${location}.${key}`))
      else if (schema.additionalProperties === false) errors.push({ path: `${location}.${key}`, message: 'unexpected additional property' })
    }
  }
  return errors
}

export interface EvalFixture {
  root: string
  db: DatabaseSync
  docs: DocumentLibrary
  personal: PersonalLibrary
  assistant: ArchiveAssistant
  hideHentai: boolean
  sessionId: string
  ids: {
    pdfDoc: string
    longMdDoc: string
    protectedDoc: string
    missingDoc: string
    conflictDoc: string
    project: string
    software: string
    game: string
    video: string
    hiddenVideo: string
    image: string
    todo: string
    asset: string
    metric: string
  }
  paths: {
    pdfFile: string
    longMdFile: string
    protectedFile: string
    missingFile: string
    movedFile: string
    movedDir: string
    conflictFile: string
    organizeRoot: string
    projectDir: string
  }
  callTool: (name: string, args?: Record<string, any>, options?: { sessionId?: string; skipSchemaCheck?: boolean }) => Promise<any>
  callToolExpectError: (name: string, args?: Record<string, any>, pattern?: RegExp, options?: { sessionId?: string; skipSchemaCheck?: boolean }) => Promise<Error>
  close: () => Promise<void>
}

export const TOOL_MAP = new Map(ARCHIVE_TOOLS.map(t => [t.name, t]))

export async function createEvalFixture(options: { hideHentai?: boolean } = {}): Promise<EvalFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-eval-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  initSchema(db, KINDS)
  db.exec(VIDEO_JOBS_SQL)

  const docs = new DocumentLibrary(db)
  const personal = new PersonalLibrary(db)
  const projects = new ProjectLibrary(db)
  const images = new ImageLibrary(db)

  const docsDir = path.join(root, 'docs')
  const movedDir = path.join(root, 'relocated-store', 'nested')
  const organizeRoot = path.join(root, 'organized')
  const projectDir = path.join(root, 'workspace-proj')
  const comicDir = path.join(root, 'comics', 'StarAlbum')
  await fs.mkdir(docsDir, { recursive: true })
  await fs.mkdir(movedDir, { recursive: true })
  await fs.mkdir(organizeRoot, { recursive: true })
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true })
  await fs.mkdir(comicDir, { recursive: true })

  // 1. Multi-page PDF with distinct page markers for cursor pagination
  const pdfFile = path.join(docsDir, 'long-handbook.pdf')
  await fs.writeFile(pdfFile, outlinePdf(12, true, 'Long Technical Handbook', page => [
    `Chapter ${page} marker ALPHA-PAGE-${page}`,
    `Detailed verification content for section ${page} of the archive handbook.`,
    `Conclusion note on page ${page}: keep original evidence intact.`,
  ]))
  const pdfDoc = await docs.register(pdfFile, 'book')
  docs.update(pdfDoc.id, { name: '长篇技术手册', author: '张研', tags: ['手册', '分页'] })

  // 2. Long Markdown (> 28KB, 420 lines) to guarantee multi-cursor chunking
  const longMdFile = path.join(docsDir, 'long-design-notes.md')
  const mdLines: string[] = ['# 系统架构长文档', '']
  for (let i = 1; i <= 420; i++) {
    mdLines.push(`第 ${i} 行：关于归档架构演进与数据边界核验的详细记录 MARKER-LINE-${String(i).padStart(3, '0')}，包含索引、回滚与快照设计说明。`)
  }
  await fs.writeFile(longMdFile, mdLines.join('\n'), 'utf8')
  const longMdDoc = await docs.register(longMdFile, 'paper')
  docs.update(longMdDoc.id, { name: '长篇设计笔记', author: '李工', tags: ['架构'] })

  // 3. Protected document (user manually edited notes/author + locked type)
  const protectedFile = path.join(docsDir, 'protected-contract.txt')
  await fs.writeFile(protectedFile, '核心协议条款：保留人工审核备注。\n条款二：未经授权不得覆盖原分类。', 'utf8')
  const protectedDoc = await docs.register(protectedFile, 'certificate')
  docs.update(protectedDoc.id, { name: '核心资质证书', author: '官方机构', notes: '人工核验无误，禁止自动覆盖', type: 'certificate' }, 'user')

  // 4. Missing file + candidate located elsewhere
  const missingFile = path.join(docsDir, 'lost-report.md')
  await fs.writeFile(missingFile, '# 失联报告\n口令：北斗七星。', 'utf8')
  const missingDoc = await docs.register(missingFile, 'paper')
  const movedFile = path.join(movedDir, 'lost-report.md')
  await fs.rename(missingFile, movedFile)

  // 5. Document for organize conflict testing
  const conflictFile = path.join(docsDir, 'conflict-note.md')
  await fs.writeFile(conflictFile, '# 整理冲突样本\n原始正文内容。', 'utf8')
  const conflictDoc = await docs.register(conflictFile, 'book')

  // 6. Project fixture with README, src files, context notes
  await fs.writeFile(path.join(projectDir, 'README.md'), '# 星海工作台\n\n项目说明与规则文档。\n关键词：PROJECT-NEEDLE-01。\n', 'utf8')
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'star-workbench', scripts: { dev: 'node index.js' } }), 'utf8')
  await fs.writeFile(path.join(projectDir, 'src', 'index.ts'), Array.from({ length: 120 }, (_, i) => `export const line${i + 1} = 'TOKEN_${i + 1}' // search target`).join('\n'), 'utf8')
  const project = projects.register(await inspectProject(projectDir))
  db.prepare('INSERT OR REPLACE INTO project_context(resource_id,current_text,next_text,prompt_text,rules,updated_at) VALUES(?,?,?,?,?,?)')
    .run(project.id, '正在推进归档评测', '补齐边界测试', '先读工具再执行', JSON.stringify([{ path: 'README.md', label: '说明' }]), Date.now())

  // 7. Software / Game / Video / Hidden Video / Image records (including Traditional Chinese title)
  const softExe = path.join(root, 'tools', 'editor.exe')
  await fs.mkdir(path.dirname(softExe), { recursive: true })
  await fs.writeFile(softExe, 'synthetic-exe')
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,summary,category,tags) VALUES('soft-1','software',1,100,?,'editor.exe','繁體編輯器','輕量文字工具','其他','[\"效率\"]')").run(softExe)
  db.prepare("INSERT INTO software_meta(resource_id,category_locked) VALUES('soft-1',1)").run()

  const gameExe = path.join(root, 'games', 'rpg.exe')
  await fs.mkdir(path.dirname(gameExe), { recursive: true })
  await fs.writeFile(gameExe, 'synthetic-game')
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,summary,category,tags) VALUES('game-1','game',1,101,?,'rpg.exe','龍之傳說','經典角色扮演','其他','[\"單機\"]')").run(gameExe)
  db.prepare("INSERT INTO game_meta(resource_id) VALUES('game-1')").run()

  const vidFile = path.join(root, 'videos', 'docu.mp4')
  await fs.mkdir(path.dirname(vidFile), { recursive: true })
  await fs.writeFile(vidFile, 'synthetic-mp4')
  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,summary,category,tags) VALUES('video-1','video',1,102,?,'docu.mp4','山川紀錄片','自然地理','其他','[\"紀錄\"]')").run(vidFile)
  db.prepare("INSERT INTO video_meta(resource_id,user_edited) VALUES('video-1','[\"summary\"]')").run()

  db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,name_zh,summary,category,tags) VALUES('video-hidden','video',1,103,'C:/fixture/private.mp4','private.mp4','機密里番測試','隐私内容','里番','[]')").run()
  db.prepare("INSERT INTO video_meta(resource_id) VALUES('video-hidden')").run()

  await fs.writeFile(path.join(comicDir, '001.png'), pngImage(120, 180))
  const imageItem = images.register((await scanImageImport(comicDir, 'comic', false))[0])

  // 8. Personal records + legacy history
  const todo = personal.save({ kind: 'todo', name: '完成归档整理', body: '核对所有边界', data: { done: false, dueOn: '2026-12-01' } })
  const asset = personal.save({ kind: 'asset', name: '云盘订阅', body: '年度续费', data: { category: '服务', cost: 198, currency: 'CNY', cycle: 'yearly' } })
  const metric = personal.save({ kind: 'metric', name: '每周阅读页数', body: '统计进度', data: { unit: '页' } })

  db.prepare("INSERT INTO workspace_sessions(id,module,title,payload,created_at,updated_at) VALUES('legacy-ws-1','document','旧资料整理记录',?,10,20)")
    .run(JSON.stringify([{ role: 'user', content: '查一下旧合同' }, { role: 'assistant', content: '已找到旧合同记录' }]))
  db.prepare("INSERT INTO project_sessions(id,resource_id,title,payload,created_at,updated_at) VALUES('legacy-pj-1',?,'旧项目排查',?,11,21)")
    .run(project.id, JSON.stringify([{ role: 'user', content: '排查构建失败' }]))

  let hideHentai = options.hideHentai ?? true
  const assistant = new ArchiveAssistant({
    db,
    runtime: '',
    bridge: '',
    home: path.join(root, 'hermes-home'),
    assets: path.resolve('dist/pdfjs'),
    hideHentai: () => hideHentai,
    config: () => ({ enabled: false, api_url: '', api_key: '', model: '' } as any),
    current: () => true,
    searchConfig: () => ({ enabled: false, provider: 'tavily', api_key: '' } as any),
    event: () => {},
    changed: () => {},
    operation: async fn => fn(),
    updateResource: (kind, id, patch) => {
      if (kind === 'software') return updateSoftware(db, id, patch)
      if (kind === 'game') return updateGame(db, id, patch)
      if (kind === 'video') return updateVideo(db, id, patch)
      throw new Error('unsupported kind: ' + kind)
    },
    recoverRuns: false,
  })

  const sessionId = 'eval-session-1'
  const executeTool = (assistant as unknown as { execute: (sid: string, name: string, args: Record<string, any>) => Promise<string> }).execute.bind(assistant)

  const callTool = async (name: string, args: Record<string, any> = {}, opts: { sessionId?: string; skipSchemaCheck?: boolean } = {}) => {
    if (!opts.skipSchemaCheck) {
      const def = TOOL_MAP.get(name)
      assert.ok(def, `Tool not registered in ARCHIVE_TOOLS: ${name}`)
      const schemaErrors = validateAgainstSchema(args, def.parameters as Record<string, any>)
      assert.equal(schemaErrors.length, 0, `Schema validation failed for ${name}: ${JSON.stringify(schemaErrors)}`)
    }
    const raw = await executeTool(opts.sessionId || sessionId, name, args)
    return JSON.parse(raw)
  }

  const callToolExpectError = async (name: string, args: Record<string, any> = {}, pattern?: RegExp, opts: { sessionId?: string; skipSchemaCheck?: boolean } = {}) => {
    try {
      await callTool(name, args, { ...opts, skipSchemaCheck: opts.skipSchemaCheck ?? true })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (pattern) assert.match(error.message, pattern, `Expected error matching ${pattern}, got: ${error.message}`)
      return error
    }
    assert.fail(`Expected tool ${name} to fail, but it succeeded`)
  }

  return {
    root,
    db,
    docs,
    personal,
    assistant,
    get hideHentai() { return hideHentai },
    set hideHentai(val: boolean) { hideHentai = val },
    sessionId,
    ids: {
      pdfDoc: pdfDoc.id,
      longMdDoc: longMdDoc.id,
      protectedDoc: protectedDoc.id,
      missingDoc: missingDoc.id,
      conflictDoc: conflictDoc.id,
      project: project.id,
      software: 'soft-1',
      game: 'game-1',
      video: 'video-1',
      hiddenVideo: 'video-hidden',
      image: imageItem.id,
      todo: todo.id,
      asset: asset.id,
      metric: metric.id,
    },
    paths: {
      pdfFile,
      longMdFile,
      protectedFile,
      missingFile,
      movedFile,
      movedDir,
      conflictFile,
      organizeRoot,
      projectDir,
    },
    callTool,
    callToolExpectError,
    close: async () => {
      db.close()
      await fs.rm(root, { recursive: true, force: true }).catch(() => { /* best-effort */ })
    },
  }
}

export interface EvalCase {
  id: string
  group: string
  title: string
  tools: string[]
  run: (ctx: EvalFixture) => Promise<void> | void
}

export interface EvalSummary {
  total: number
  passed: number
  failed: number
  toolCoverage: { covered: string[]; missing: string[]; total: number }
  failures: Array<{ id: string; group: string; title: string; error: string }>
}
