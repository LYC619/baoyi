/**
 * 一个最小的 tool-calling agent 循环，走 OpenAI 兼容的 /chat/completions。
 *
 * 结构参考 pi 的 agent-loop（参考/pi-main/packages/agent/src/agent-loop.ts）：
 * 「请求 → 拿到 tool_calls → 本地执行 → 结果回灌 → 再请求」，直到模型不再要求调用工具。
 * pi 里的流式、压缩、steering、会话持久化在这里都不需要，所以只保留循环本体
 * 以及四条护栏：最大轮数、重复调用检测、同一个错误反复出现就终止、可中断。
 */

import type { AgentEvent, AgentStopReason, AIConfig } from '../../../src/types'
import { timeAsync } from '../timing.ts'

export type { AgentEvent, AgentStopReason }

export interface AgentTool {
  name: string
  description: string
  /** JSON Schema，直接透传给模型 */
  parameters: Record<string, unknown>
  execute(args: any, signal?: AbortSignal): Promise<string>
}

export interface AgentRunResult {
  stopReason: AgentStopReason
  /** stopReason === 'error' 时的可读原因 */
  error: string
  turns: number
  tokens: number
  /** 模型最后一次自然语言输出 */
  text: string
}

export interface AgentRunOptions {
  config: AIConfig
  system: string
  user: string
  tools: AgentTool[]
  /** 一次运行最多允许几轮「模型请求 + 工具执行」 */
  maxTurns?: number
  /** 需要结构化提交的调用方可以显式要求工具；其他流程仍由模型决定。 */
  toolChoice?: 'auto' | 'required'
  /** 指定提交工具成功后即可结束，无须再请求一轮自然语言总结。 */
  stopAfterToolSuccess?: string
  /** Reserve the last rounds for explicit completion, so optional exploration cannot exhaust the run. */
  finalTools?: string[]
  finalTurns?: number
  signal?: AbortSignal
  onEvent?: (e: AgentEvent) => void
}

const REQUEST_TIMEOUT = 120_000
const MAX_RETRY = 2
/** 单个工具结果回灌给模型的长度上限，防止一次目录列表把上下文撑爆 */
const MAX_TOOL_OUTPUT = 6000
/** 同一个工具 + 同一组参数连续命中这个次数就判定模型在原地打转 */
const MAX_REPEAT = 3
/**
 * 同一个工具连续返回同样的错误到这个次数就终止整次运行。
 *
 * MAX_REPEAT 按「参数完全相同」判，模型换个措辞就能绕过去 —— 数据库缺列那次就是
 * 这么白烧了 8 轮：错误从头到尾是同一句，但参数每次都差一点。错误内容不变说明
 * 这事不是靠调参数能解决的，重试没有意义，直接把原始错误报上去。
 */
const MAX_SAME_ERROR = 3

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: RawToolCall[]
  tool_call_id?: string
}

interface RawToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * 用户填的 api_url 归一成「不带尾斜杠、不带具体路径」的基地址。
 * 有人习惯连 /chat/completions 一起粘进来，把它切掉，别拼出
 * /v1/chat/completions/chat/completions。
 */
export function apiBase(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

function endpoint(apiUrl: string): string {
  return `${apiBase(apiUrl)}/chat/completions`
}

/**
 * 把 GET /models 的响应抠成一串模型名。
 *
 * OpenAI 是 {data:[{id}]}，少数服务商直接返回字符串数组，两种都收。
 * 不按名字筛「支持不支持 function calling」—— 接口不提供这个信息，
 * 靠名字猜只会把用户想用的模型藏起来。选完让「测试连接」去验。
 */
export function parseModelList(json: unknown): string[] {
  const raw: unknown[] = Array.isArray(json)
    ? json
    : Array.isArray((json as any)?.data)
      ? (json as any).data
      : []
  const names = raw
    .map((m) => (typeof m === 'string' ? m : String((m as any)?.id ?? '')))
    .filter((s) => s.length > 0)
  return [...new Set(names)].sort()
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** 把工具名 + 参数压成一个可比较的键，用于重复调用检测 */
function callKey(name: string, args: unknown): string {
  try {
    return `${name}:${JSON.stringify(args)}`
  } catch {
    return `${name}:<unserializable>`
  }
}

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（输出过长已截断，共 ${text.length} 字符）`
}

interface ChatTurn {
  message: ChatMessage
  tokens: number
}

async function requestTurn(
  config: AIConfig,
  messages: ChatMessage[],
  tools: AgentTool[],
  signal: AbortSignal | undefined,
  toolChoice: AgentRunOptions['toolChoice'] = 'auto'
): Promise<ChatTurn> {
  const body = JSON.stringify({
    model: config.model,
    messages,
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    })),
    tool_choice: toolChoice,
    temperature: 0.2,
    stream: false
  })

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')

    // 每次请求单独限时，同时保留外部取消信号
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT)
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout

    try {
      const res = await fetch(endpoint(config.api_url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`
        },
        body,
        signal: merged
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const err = new Error(
          `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`
        )
        if (isRetryable(res.status) && attempt < MAX_RETRY) {
          lastError = err
          await sleep(800 * (attempt + 1))
          continue
        }
        throw err
      }

      const json: any = await res.json()
      const message = json?.choices?.[0]?.message
      if (!message || typeof message !== 'object') {
        throw new Error('响应缺少 choices[0].message')
      }
      return {
        message: {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined
        },
        tokens: Number(json?.usage?.total_tokens) || 0
      }
    } catch (err) {
      // 用户主动取消不重试
      if (signal?.aborted) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRY) {
        await sleep(800 * (attempt + 1))
        continue
      }
      throw lastError
    }
  }
  throw lastError ?? new Error('请求失败')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { config, tools, signal, onEvent } = opts
  const maxTurns = opts.maxTurns ?? 14
  const byName = new Map(tools.map((t) => [t.name, t]))

  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user }
  ]

  const repeats = new Map<string, number>()
  // 连续同一个错误的计数。key 是「工具名 + 错误内容」，成功执行一次就清零
  let lastError = ''
  let sameError = 0
  let tokens = 0
  let text = ''
  let turns = 0

  while (turns < maxTurns) {
    if (signal?.aborted) return { stopReason: 'aborted', error: '', turns, tokens, text }
    turns++
    onEvent?.({ type: 'turn', index: turns })

    let turn: ChatTurn
    const finalizing = !!opts.finalTools?.length && turns > maxTurns - Math.max(1, opts.finalTurns ?? 2)
    const availableTools = finalizing ? tools.filter(tool => opts.finalTools!.includes(tool.name)) : tools
    if (finalizing && turns === maxTurns - Math.max(1, opts.finalTurns ?? 2) + 1) messages.push({role:'user',content:'探索阶段已结束。根据已经获得的证据立即登记结果或明确跳过。不确定的可选字段留空；不要再浏览目录或猜测路径。'})
    try {
      turn = await timeAsync(`LLM 第 ${turns} 轮`, () => requestTurn(config, messages, availableTools, signal, finalizing ? 'required' : opts.toolChoice))
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === 'AbortError') {
        return { stopReason: 'aborted', error: '', turns, tokens, text }
      }
      return {
        stopReason: 'error',
        error: err instanceof Error ? err.message : String(err),
        turns,
        tokens,
        text
      }
    }

    tokens += turn.tokens
    messages.push(turn.message)

    if (turn.message.content) {
      text = turn.message.content
      onEvent?.({ type: 'text', text })
    }

    const calls = turn.message.tool_calls ?? []
    if (calls.length === 0) {
      return { stopReason: 'done', error: '', turns, tokens, text }
    }

    for (const call of calls) {
      if (signal?.aborted) return { stopReason: 'aborted', error: '', turns, tokens, text }

      const name = call?.function?.name ?? ''
      const rawArgs = call?.function?.arguments ?? '{}'
      const push = (content: string) =>
        messages.push({
          role: 'tool',
          tool_call_id: call?.id ?? name,
          content: clip(content)
        })

      /**
       * 记一条工具错误并回灌给模型。返回非 null 表示同一个错误已经连续出现
       * MAX_SAME_ERROR 次，该就此终止 —— 调用方直接把它 return 出去。
       */
      const fail = (msg: string, ms?: number): AgentRunResult | null => {
        onEvent?.({ type: 'tool_result', name, text: msg, isError: true, ms })
        push(msg)
        const key = `${name}:${msg}`
        sameError = key === lastError ? sameError + 1 : 1
        lastError = key
        if (sameError < MAX_SAME_ERROR) return null
        return {
          stopReason: 'error',
          error: `${name} 连续 ${sameError} 次返回同一个错误，重试无意义：${msg}`,
          turns,
          tokens,
          text
        }
      }

      const tool = byName.get(name)
      if (!tool || !availableTools.includes(tool)) {
        const stop = fail(`错误：不存在名为 ${name} 的工具。可用工具：${[...byName.keys()].join('、')}`)
        if (stop) return stop
        continue
      }

      let args: Record<string, unknown>
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {}
      } catch {
        // 参数不是合法 JSON，把错误还给模型让它重发，而不是中断整轮
        const stop = fail(
          `错误：参数不是合法的 JSON，请重新调用 ${name}。收到的是：${rawArgs.slice(0, 200)}`
        )
        if (stop) return stop
        continue
      }

      const key = callKey(name, args)
      const seen = (repeats.get(key) ?? 0) + 1
      repeats.set(key, seen)
      if (seen > MAX_REPEAT) {
        const msg = `错误：${name} 已经用完全相同的参数调用过 ${MAX_REPEAT} 次，结果不会变。请根据已有信息作出判断并结束。`
        onEvent?.({ type: 'tool_result', name, text: msg, isError: true })
        push(msg)
        continue
      }

      onEvent?.({ type: 'tool_call', name, args })
      const startedAt = Date.now()
      try {
        const result = await tool.execute(args, signal)
        onEvent?.({ type: 'tool_result', name, text: result, isError: false, ms: Date.now() - startedAt })
        push(result)
        // 成功一次就把错误链断开，只有「连续」同错才算死路
        lastError = ''
        sameError = 0
        if (opts.stopAfterToolSuccess === name || (finalizing && opts.finalTools!.includes(name))) {
          return { stopReason: signal?.aborted ? 'aborted' : 'done', error: '', turns, tokens, text }
        }
      } catch (err) {
        if (signal?.aborted) return { stopReason: 'aborted', error: '', turns, tokens, text }
        const stop = fail(`错误：${err instanceof Error ? err.message : String(err)}`, Date.now() - startedAt)
        if (stop) return stop
      }
    }
  }

  return { stopReason: 'max_turns', error: '', turns, tokens, text }
}

/**
 * 探测一个接口是否真的支持 function calling。
 * 不少兼容接口只实现了纯文本补全，带上 tools 会直接 400 —— 与其等到扫描时
 * 一路失败，不如在「测试连接」里就说清楚。
 */
export async function probeToolCalling(
  config: AIConfig
): Promise<{ ok: boolean; message: string }> {
  const probe: AgentTool = {
    name: 'report_ready',
    description: '确认工具调用可用时调用它',
    parameters: {
      type: 'object',
      properties: { ok: { type: 'boolean', description: '固定传 true' } },
      required: ['ok']
    },
    execute: async () => '收到'
  }

  let called = false
  const result = await runAgent({
    config,
    system: '你正在做一次连通性自检。请立刻调用 report_ready 工具，参数 ok 传 true，不要输出别的内容。',
    user: '开始自检。',
    tools: [probe],
    maxTurns: 2,
    onEvent: (e) => {
      if (e.type === 'tool_call' && e.name === 'report_ready') called = true
    }
  })

  if (result.stopReason === 'error') {
    return { ok: false, message: result.error }
  }
  if (!called) {
    return {
      ok: false,
      message: `模型能连通，但没有发起工具调用。抱一的识别流程依赖 function calling，请换一个支持工具调用的模型（如 deepseek-chat、qwen-plus、gpt-4o-mini）。模型回复：${result.text.slice(0, 80)}`
    }
  }
  return { ok: true, message: `连接正常，工具调用可用（本次自检消耗 ${result.tokens} tokens）。` }
}
