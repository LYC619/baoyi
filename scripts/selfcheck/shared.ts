import { type AgentTool } from '../../electron/services/agent/loop.ts'


export const CONFIG = { api_url: 'http://localhost/v1', api_key: 'test', model: 'fake', enabled: true }

let passed = 0
let failed = 0

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}`)
    console.log(`       ${err instanceof Error ? err.message : String(err)}`)
  }
}

/* --------------------------- 假模型 --------------------------- */

export type Scripted = { tool?: { name: string; args: unknown }; text?: string }

/**
 * 把 fetch 换成一个照剧本出牌的假模型。
 * 返回 sent 数组，方便断言「工具结果确实被回灌进了下一轮请求」。
 */
export function mockModel(script: Scripted[]): { sent: any[]; restore: () => void } {
  const original = globalThis.fetch
  const sent: any[] = []
  let turn = 0

  globalThis.fetch = (async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body))
    const step = script[Math.min(turn, script.length - 1)]
    turn++
    const message: any = { role: 'assistant', content: step.text ?? null }
    if (step.tool) {
      message.tool_calls = [
        {
          id: `call_${turn}`,
          type: 'function',
          function: {
            name: step.tool.name,
            arguments:
              typeof step.tool.args === 'string'
                ? step.tool.args
                : JSON.stringify(step.tool.args)
          }
        }
      ]
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message }], usage: { total_tokens: 10 } })
    }
  }) as unknown as typeof fetch

  return { sent, restore: () => { globalThis.fetch = original } }
}

/**
 * 把 fetch 换成一个固定 JSON 的假服务端。给只有一个端点的路子用
 * （搜索服务商、豆瓣那条路）。返回 restore，**必须放在 finally 里调** ——
 * 漏掉的话后面所有 check 都在这个假 fetch 上跑，失败原因会指向不相干的地方。
 */
export function stubJson(body: unknown): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  })) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

/**
 * 按 URL 片段分路的假服务端。TMDB 这种一次交互要打好几个端点的场合用。
 *
 * 没配到的路径返回空对象而不是抛错：这个函数是给「验别的东西」用的脚手架，
 * 让它对没预料到的请求硬失败只会把失败原因引到脚手架自己身上。
 */
export function stubFetch(routes: Record<string, unknown>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const s = String(url)
    const key = Object.keys(routes).find((k) => s.includes(k))
    const body = key ? routes[key] : {}
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

export function echoTool(calls: Array<{ name: string; args: any }>): AgentTool {
  return {
    name: 'probe',
    description: '记录调用',
    parameters: { type: 'object', properties: { v: { type: 'string' } } },
    execute: async (args) => {
      calls.push({ name: 'probe', args })
      return `probe 收到 ${JSON.stringify(args)}`
    }
  }
}
export function report(): void {
  console.log(`\n${passed} 通过，${failed} 失败\n`)
  if (failed > 0) process.exitCode = 1
}
