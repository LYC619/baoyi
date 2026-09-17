/**
 * AI 识别的编排层。
 *
 * 0.1.0 是「拼 prompt → 等一坨 JSON → 解析入库」；现在换成 agent：
 * 给它一个目录和一组工具，让它自己 ls、自己看 PE、自己决定哪些 exe 属于同一个软件，
 * 然后自己调 register_software 落库。合并规则、附属程序过滤都在 prompt 里，不在代码里。
 */

import path from 'node:path'
import type {
  AgentStopReason,
  AIConfig,
  AIProgress,
  AIResult,
  IdentifyLogStatus,
  IdentifyReportEntry,
  ScanUnit,
  SearchConfig,
  SoftwareItem
} from '../../../src/types'
import { runAgent, probeToolCalling, apiBase, parseModelList, type AgentEvent } from '../../services/agent/loop'
import { fillIdentifySystem, itemPrompt, unitPrompt } from './prompts'
import { buildTools, type ToolContext } from './tools'
import {
  getSettings,
  listBySourceDir,
  listCategories,
  listForAi,
  listUnfinishedUnits,
  markScanUnit,
  saveIdentifyLog,
  saveIdentifyReport,
  tagPool,
  updateSoftware
} from '../../services/database'
import { searchAvailable } from '../../services/searchService'

/** 同时跑几个目录。三个够把等待时间压下来，又不至于撞上模型的并发限流 */
const CONCURRENCY = 3
/**
 * 单个目录允许的最大工具调用轮数，兜住模型原地打转的成本。
 *
 * 20 而不是 14：扫描器会看错，把一个「合集目录」当成软件目录交过来，那时 agent
 * 要在同一次会话里注册出好几条（见 prompts.ts 的「目录结构判断」）。14 轮不够走完，
 * 结果是注册一半就被掐断。单个软件的目录 3-5 轮就收尾，抬高上限不会让它们更贵。
 */
const MAX_TURNS_PER_UNIT = 20

let controller: AbortController | null = null

export function cancelAi(): void {
  controller?.abort()
}

/* ------------------------------ 进度汇总 ------------------------------ */

interface Tally {
  total: number
  processed: number
  registered: number
  skipped: number
  failed: number
  tokens: number
  current: string
  log: string
  /** 本轮共调了几次 web_search。报告要靠它回答「额度花在哪了」 */
  searches: number
  /** 逐条摘要，攒完一轮汇总成一份报告 */
  entries: IdentifyReportEntry[]
}

function makeReporter(tally: Tally, onProgress: (p: AIProgress) => void) {
  let last = 0
  return (force = false) => {
    const now = Date.now()
    if (!force && now - last < 150) return
    last = now
    onProgress({
      phase: 'running',
      current: tally.current,
      processed: tally.processed,
      total: tally.total,
      failed: tally.failed,
      registered: tally.registered,
      log: tally.log
    })
  }
}

/** 把 agent 的动作翻译成用户看得懂的一行字 */
function describeEvent(e: AgentEvent): string {
  if (e.type === 'tool_call') {
    const args = e.args as Record<string, any>
    switch (e.name) {
      case 'list_directory':
        return `查看目录 ${path.basename(String(args.path ?? ''))}`
      case 'get_file_info':
        return `读取 ${path.basename(String(args.path ?? ''))} 的信息`
      case 'read_text_file':
        return `阅读 ${path.basename(String(args.path ?? ''))}`
      case 'register_software':
        return `识别出「${args.name_zh ?? '?'}」`
      case 'skip_directory':
        return `跳过 ${path.basename(String(args.path ?? ''))}`
      case 'web_search':
        return `联网搜索「${args.query ?? ''}」`
      default:
        return `调用 ${e.name}`
    }
  }
  return ''
}

/* ------------------------------ 单元识别 ------------------------------ */

interface UnitOutcome {
  registered: number
  skipped: boolean
  failed: boolean
  tokens: number
  note: string
  /** 实际跑了几轮，以及为什么停 —— 日志页靠这两个说明「是想清楚了还是撞上限了」 */
  turns: number
  stopReason: AgentStopReason
}

async function identifyUnit(
  unit: ScanUnit,
  ai: AIConfig,
  system: string,
  searchConfig: SearchConfig,
  withSearch: boolean,
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void
): Promise<UnitOutcome> {
  const hadEntries = listBySourceDir(unit.dir)

  let registered = 0
  let skipped = false
  const skipReasons: string[] = []

  const ctx: ToolContext = {
    // 只开放本单元这棵子树，agent 没有理由跑到别的目录去
    roots: [unit.dir],
    unitDir: unit.dir,
    looseOnly: unit.loose_only,
    searchConfig,
    // 整目录识别的结果先进暂存区，等用户在确认面板过目
    direct: false,
    onRegister: () => {
      registered++
    },
    onSkip: (dir, reason) => {
      skipped = true
      skipReasons.push(`${path.basename(dir) || dir}：${reason}`)
    }
  }

  const result = await runAgent({
    config: ai,
    system,
    user: unitPrompt(unit, hadEntries),
    tools: buildTools(ctx, withSearch),
    maxTurns: MAX_TURNS_PER_UNIT,
    signal,
    onEvent
  })

  const base = { turns: result.turns, stopReason: result.stopReason }

  if (result.stopReason === 'error') {
    return { ...base, registered, skipped, failed: true, tokens: result.tokens, note: result.error }
  }
  if (result.stopReason === 'aborted') {
    return { ...base, registered, skipped, failed: false, tokens: result.tokens, note: '已取消' }
  }

  // 「未注册任何条目」这句话本身不解释任何事情：模型是想清楚了才收尾，还是被轮数上限
  // 掐断的？两者要改的东西完全不同（前者调判据，后者调探索策略），所以必须分开说
  const stalled = result.stopReason === 'max_turns'
  const note =
    registered > 0
      ? stalled
        ? `待确认 ${registered} 项（达到 ${MAX_TURNS_PER_UNIT} 轮上限提前结束，可能还有遗漏）`
        : `待确认 ${registered} 项`
      : skipReasons.length > 0
        ? skipReasons.join('；')
        : stalled
          ? `达到 ${MAX_TURNS_PER_UNIT} 轮上限仍未下结论，没有识别出任何条目`
          : result.text.slice(0, 200) || '未识别出任何条目'

  return { ...base, registered, skipped: registered === 0, failed: false, tokens: result.tokens, note }
}

/* ------------------------------ 单条补全 ------------------------------ */

async function identifyItem(
  item: SoftwareItem,
  ai: AIConfig,
  system: string,
  searchConfig: SearchConfig,
  withSearch: boolean,
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void
): Promise<UnitOutcome> {
  const dir = path.dirname(item.exe_path)
  let registered = 0

  const ctx: ToolContext = {
    roots: [dir],
    unitDir: dir,
    looseOnly: true,
    searchConfig,
    // 用户点着这一条说「重新识别」，对象已经明确，再拦一道确认只是碍事
    direct: true,
    onRegister: () => {
      registered++
    }
  }

  const result = await runAgent({
    config: ai,
    system,
    user: itemPrompt(item),
    tools: buildTools(ctx, withSearch),
    maxTurns: 10,
    signal,
    onEvent
  })

  const base = { turns: result.turns, stopReason: result.stopReason }

  if (result.stopReason === 'error') {
    updateSoftware(item.id, { ai_status: 'failed' })
    return { ...base, registered: 0, skipped: false, failed: true, tokens: result.tokens, note: result.error }
  }
  if (result.stopReason === 'aborted') {
    return { ...base, registered: 0, skipped: false, failed: false, tokens: result.tokens, note: '已取消' }
  }
  if (registered === 0) {
    // agent 跑完却没注册，说明它没能下结论 —— 保持 failed 让用户能单条重试
    updateSoftware(item.id, { ai_status: 'failed' })
    return {
      ...base,
      registered: 0,
      skipped: true,
      failed: true,
      tokens: result.tokens,
      note:
        result.stopReason === 'max_turns'
          ? '达到轮数上限仍未下结论'
          : result.text.slice(0, 200) || '未能识别'
    }
  }
  return { ...base, registered, skipped: false, failed: false, tokens: result.tokens, note: '已识别' }
}

/* ------------------------------ 主入口 ------------------------------ */

type Job =
  | { kind: 'unit'; unit: ScanUnit }
  | { kind: 'item'; item: SoftwareItem }

function jobLabel(job: Job): string {
  return job.kind === 'unit' ? job.unit.dir : job.item.file_name
}

async function pool(jobs: Job[], run: (job: Job) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= jobs.length || controller?.signal.aborted) return
      await run(jobs[index])
    }
  })
  await Promise.all(workers)
}

export async function completeWithAi(
  ids: string[] | undefined,
  onProgress: (p: AIProgress) => void
): Promise<AIResult> {
  controller = new AbortController()
  const signal = controller.signal

  const settings = getSettings()
  const ai = settings.ai
  const searchConfig = settings.search
  const withSearch = searchAvailable(searchConfig)

  // 分类和标签池现读现填。用户刚在设置里合并过两个标签，这一轮就该按合并后的来。
  // withSearch 同时决定「注册哪些工具」和「提示词怎么说」—— 两边必须是同一个值，
  // 否则模型会照提示词去调一个没注册的工具，白烧一轮
  const system = fillIdentifySystem(listCategories(), tagPool(), withSearch)

  // 指定了 ids 就只补这几条；否则跑完所有待识别目录 + 遗留的待补全条目
  const jobs: Job[] = ids?.length
    ? listForAi(ids).map((item) => ({ kind: 'item', item }) as Job)
    : [
        ...listUnfinishedUnits().map((unit) => ({ kind: 'unit', unit }) as Job),
        ...listForAi().map((item) => ({ kind: 'item', item }) as Job)
      ]

  const tally: Tally = {
    total: jobs.length,
    processed: 0,
    registered: 0,
    skipped: 0,
    failed: 0,
    tokens: 0,
    current: '',
    log: '',
    searches: 0,
    entries: []
  }
  const report = makeReporter(tally, onProgress)
  const roundStartedAt = Date.now()

  const finish = (): AIResult => {
    onProgress({
      phase: 'done',
      current: '',
      processed: tally.processed,
      total: tally.total,
      failed: tally.failed,
      registered: tally.registered,
      log: ''
    })
    controller = null

    // 一条都没跑就没有报告可写 —— 一份全零的报告只会让历史列表变噪音
    let reportId = ''
    if (tally.entries.length > 0) {
      try {
        reportId = saveIdentifyReport({
          resource_kind: 'software',
          processed: tally.processed,
          registered: tally.registered,
          skipped: tally.skipped,
          failed: tally.failed,
          duration_ms: Date.now() - roundStartedAt,
          tokens: tally.tokens,
          searches: tally.searches,
          entries: tally.entries
        })
      } catch {
        /* 报告写不进去不该让识别结果跟着失败，它只是事后翻看用的 */
      }
    }

    return {
      processed: tally.processed,
      registered: tally.registered,
      skipped: tally.skipped,
      failed: tally.failed,
      tokens: tally.tokens,
      report_id: reportId
    }
  }

  if (!ai.enabled || !ai.api_key) {
    tally.total = 0
    return finish()
  }
  if (jobs.length === 0) return finish()

  report(true)

  await pool(jobs, async (job) => {
    if (signal.aborted) return
    tally.current = jobLabel(job)
    tally.log = ''
    report()

    // agent 的每一步都从这里过一遍：一份喂给进度条，一份原样攒着落进日志。
    // 有了它才能回答「这个目录为什么没识别出来」—— 结论那一行说不清全过程
    const trail: AgentEvent[] = []
    const startedAt = Date.now()
    const onEvent = (e: AgentEvent) => {
      trail.push(e)
      const line = describeEvent(e)
      if (!line) return
      tally.log = line
      report()
    }

    let outcome: UnitOutcome
    try {
      outcome =
        job.kind === 'unit'
          ? await identifyUnit(job.unit, ai, system, searchConfig, withSearch, signal, onEvent)
          : await identifyItem(job.item, ai, system, searchConfig, withSearch, signal, onEvent)
    } catch (err) {
      // runAgent 自己吞掉了工具异常，能到这里的都是编排层的意外
      outcome = {
        registered: 0,
        skipped: false,
        failed: true,
        tokens: 0,
        note: err instanceof Error ? err.message : String(err),
        turns: 0,
        stopReason: 'error'
      }
    }

    if (job.kind === 'unit' && !signal.aborted) {
      markScanUnit(
        job.unit.dir,
        outcome.failed ? 'failed' : outcome.registered > 0 ? 'done' : 'skipped',
        outcome.note,
        outcome.registered
      )
    }

    // 取消不留日志：一份被用户掐断的过程记录说明不了识别本身的好坏
    if (outcome.stopReason !== 'aborted') {
      const status: IdentifyLogStatus = outcome.failed
        ? 'failed'
        : outcome.registered > 0
          ? 'success'
          : 'skipped'
      const dir = job.kind === 'unit' ? job.unit.dir : path.dirname(job.item.exe_path)
      const label =
        job.kind === 'unit' ? path.basename(job.unit.dir) || job.unit.dir : job.item.file_name
      const searches = trail.filter((e) => e.type === 'tool_call' && e.name === 'web_search').length

      try {
        saveIdentifyLog({
          dir,
          label,
          kind: job.kind,
          resource_kind: 'software',
          status,
          summary: outcome.note,
          registered: outcome.registered,
          rounds: outcome.turns,
          duration_ms: Date.now() - startedAt,
          tokens: outcome.tokens,
          stop_reason: outcome.stopReason,
          events: trail
        })
      } catch {
        /* 日志写不进去也不该让识别结果跟着失败，它只是事后翻看用的 */
      }

      tally.searches += searches
      tally.entries.push({
        dir,
        label,
        status,
        rounds: outcome.turns,
        tokens: outcome.tokens,
        searches,
        note: outcome.note
      })
    }

    tally.tokens += outcome.tokens
    tally.registered += outcome.registered
    if (outcome.failed) tally.failed++
    else if (outcome.registered === 0) tally.skipped++
    tally.processed++
    report(true)
  })

  return finish()
}

export async function testConnection(config: AIConfig): Promise<{ ok: boolean; message: string }> {
  if (!config.api_key) return { ok: false, message: '请先填写 API Key' }
  if (!config.model) return { ok: false, message: '请先填写模型名' }
  try {
    return await probeToolCalling(config)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 拉服务商的模型列表，GET {base}/models —— OpenAI 兼容格式的既有约定。
 * 不填模型名也能调（列表本来就是拿来选模型的），所以只要 Key。
 */
export async function listModels(
  config: AIConfig
): Promise<{ ok: boolean; message: string; models: string[] }> {
  if (!config.api_key) return { ok: false, message: '请先填写 API Key', models: [] }

  try {
    const res = await fetch(`${apiBase(config.api_url)}/models`, {
      headers: { Authorization: `Bearer ${config.api_key}` },
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return {
        ok: false,
        message: `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
        models: []
      }
    }

    const models = parseModelList(await res.json())
    if (models.length === 0) {
      return { ok: false, message: '接口通了，但没返回任何模型，请手动填模型名', models: [] }
    }
    return { ok: true, message: `拉到 ${models.length} 个模型`, models }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      // 不少中转站压根没实现 /models，这时候别让用户以为是 Key 错了
      message: `拉取失败：${msg}。部分中转服务不提供模型列表，可以直接手填模型名。`,
      models: []
    }
  }
}
