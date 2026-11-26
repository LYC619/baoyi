export interface AIProgress {
  phase: 'running' | 'done'
  /** 当前正在识别的目录 */
  current: string
  processed: number
  total: number
  failed: number
  /** 已注册的软件数 */
  registered: number
  /** agent 最近一次动作的可读描述，用于让用户看到它在干什么 */
  log: string
}

export interface AIResult {
  /** 处理过的目录数 + 补全过的遗留条目数 */
  processed: number
  /** 新注册的软件条目数。走确认流程时这里是「暂存待确认」的条数 */
  registered: number
  skipped: number
  failed: number
  /** 本次消耗的 token 总数，便于用户判断成本 */
  tokens: number
  /** 本轮汇总报告的 id。空串表示这轮没跑任何任务，没有报告可看 */
  report_id: string
}

/* ------------------------------ 识别日志 ------------------------------ */

/**
 * agent 循环里发生的一件事。日志页直接按这个序列回放识别过程，
 * 所以它同时是主进程的事件类型和落库的记录格式。
 */
export type AgentEvent =
  | { type: 'turn'; index: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | {
      type: 'tool_result'
      name: string
      text: string
      isError: boolean
      /** 这次工具执行花了多久。0.4 之前的日志没有这个字段，读出来是 undefined */
      ms?: number
    }

export type AgentStopReason = 'done' | 'max_turns' | 'aborted' | 'error'

/** 日志状态。success 表示至少注册了一个条目 */
export type IdentifyLogStatus = 'success' | 'skipped' | 'failed'

export interface IdentifyLog {
  id: string
  /** 被识别的目录（单条补全时是 exe 所在目录） */
  dir: string
  /** 列表上展示的标题：目录名或文件名 */
  label: string
  /** unit = 整个目录，item = 单条补全 */
  kind: 'unit' | 'item'
  /** 资源类型：software / game / video。0.9 加入，区分各模块的识别日志 */
  resource_kind: 'software' | 'game' | 'video'
  status: IdentifyLogStatus
  /** 一行结论，例如「注册 2 项」或跳过原因 */
  summary: string
  registered: number
  rounds: number
  duration_ms: number
  tokens: number
  stop_reason: AgentStopReason | ''
  /** 完整过程。按 turn 事件分组即可还原每一轮 */
  events: AgentEvent[]
  created_at: number
}

export interface IdentifyLogQuery {
  status?: IdentifyLogStatus
  keyword?: string
  /** 按资源类型过滤：software / game / video */
  resource_kind?: string
  limit?: number
}

/* ------------------------------ 汇总报告 ------------------------------ */

/** 汇总报告里的一行：一个目录的结果摘要 */
export interface IdentifyReportEntry {
  dir: string
  label: string
  status: IdentifyLogStatus
  rounds: number
  tokens: number
  /** 这一条识别过程中调用了几次 web_search */
  searches: number
  /** 结论或失败 / 跳过原因 */
  note: string
}

/**
 * 一轮批量识别的汇总。
 *
 * 逐条日志回答「这个目录为什么这样判断」，这份回答「这一轮整体怎么样」——
 * 哪些没成、共花了多少、搜索额度用掉多少。它是对已有数据的汇总，不额外消耗任何 token。
 */
export interface IdentifyReport {
  id: string
  created_at: number
  resource_kind: 'software' | 'game' | 'video'
  processed: number
  registered: number
  skipped: number
  failed: number
  duration_ms: number
  tokens: number
  searches: number
  entries: IdentifyReportEntry[]
}

/**
 * 搜索服务的一次调用记录。
 *
 * 不新建表 —— 从 identify_logs 的 web_search 事件里现取。代价是时间只精确到
 * 「所属那次识别」这一级（日志本身只有一个时间戳），够用来回答「今天搜了几次、通不通」。
 */
export interface SearchCallRecord {
  /** 所属识别日志的时间。同一次识别里的多次搜索共用它 */
  at: number
  query: string
  status: 'ok' | 'empty' | 'timeout' | 'failed'
  /** 耗时毫秒。0 表示这条日志是 0.4 之前记的，当时没有计时 */
  ms: number
  /** 哪个目录触发的 */
  label: string
}
