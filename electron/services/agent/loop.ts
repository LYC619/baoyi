/**
 * 一个最小的 tool-calling agent 循环，走 OpenAI 兼容的 /chat/completions。
 *
 * 结构参考 pi 的 agent-loop（参考/pi-main/packages/agent/src/agent-loop.ts）：
 * 「请求 → 拿到 tool_calls → 本地执行 → 结果回灌 → 再请求」，直到模型不再要求调用工具。
 * pi 里的流式、压缩、steering、会话持久化在这里都不需要，所以只保留循环本体
 * 以及三条护栏：最大轮数、重复调用检测、可中断。
 */

import type { AgentEvent, AgentStopReason, AIConfig } from '../../../src/types'

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
  signal?: AbortSignal
  onEvent?: (e: AgentEvent) => void
}

const REQUEST_TIMEOUT = 120_000
const MAX_RETRY = 2
/** 单个工具结果回灌给模型的长度上限，防止一次目录列表把上下文撑爆 */
const MAX_TOOL_OUTPUT = 6000
/** 同一个工具 + 同一组参数连续命中这个次数就判定模型在原地打转 */
const MAX_REPEAT = 3

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

function endpoint(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '')
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
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
  signal: AbortSignal | undefined
): Promise<ChatTurn> {
  const body = JSON.stringify({
    model: config.model,
    messages,
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    })),
    tool_choice: 'auto',
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
  let tokens = 0
  let text = ''
  let turns = 0

  while (turns < maxTurns) {
    if (signal?.aborted) return { stopReason: 'aborted', error: '', turns, tokens, text }
    turns++
    onEvent?.({ type: 'turn', index: turns })

    let turn: ChatTurn
    try {
      turn = await requestTurn(config, messages, tools, signal)
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

      const tool = byName.get(name)
      if (!tool) {
        const msg = `错误：不存在名为 ${name} 的工具。可用工具：${[...byName.keys()].join('、')}`
        onEvent?.({ type: 'tool_result', name, text: msg, isError: true })
        push(msg)
        continue
      }

      let args: Record<string, unknown>
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {}
      } catch {
        // 参数不是合法 JSON，把错误还给模型让它重发，而不是中断整轮
        const msg = `错误：参数不是合法的 JSON，请重新调用 ${name}。收到的是：${rawArgs.slice(0, 200)}`
        onEvent?.({ type: 'tool_result', name, text: msg, isError: true })
        push(msg)
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
      try {
        const result = await tool.execute(args, signal)
        onEvent?.({ type: 'tool_result', name, text: result, isError: false })
        push(result)
      } catch (err) {
        if (signal?.aborted) return { stopReason: 'aborted', error: '', turns, tokens, text }
        const msg = `错误：${err instanceof Error ? err.message : String(err)}`
        onEvent?.({ type: 'tool_result', name, text: msg, isError: true })
        push(msg)
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
