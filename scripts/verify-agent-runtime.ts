import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgent } from '../electron/services/agent/loop.ts'
import { readProjectText } from '../electron/kinds/project/workspace.ts'

export async function endpoint(t: test.TestContext, reply: (body: any, request: number) => { status?: number; message?: any }) {
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); requests.push(body)
    const response = reply(body, requests.length)
    res.writeHead(response.status || 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response.status ? { error: { message: 'fixture failure' } } : {
      choices: [{ message: response.message || { role: 'assistant', content: '已完成' } }], usage: { total_tokens: 2 }
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address() as { port: number }
  return { requests, config: { enabled: true, api_key: 'local-fixture', api_url: `http://127.0.0.1:${address.port}`, model: 'fixture' } }
}

test('无工具的真实请求省略 tools 和 tool_choice', async t => {
  const { config, requests } = await endpoint(t, () => ({}))
  const result = await runAgent({ config, tools: [], user: '总结', system: 'fixture' })
  assert.equal(result.stopReason, 'done')
  assert.equal('tools' in requests[0], false)
  assert.equal('tool_choice' in requests[0], false)
})

test('HTTP 400 参数错误立即结束且不重试', async t => {
  const { config, requests } = await endpoint(t, () => ({ status: 400 }))
  const result = await runAgent({ config, tools: [], user: '总结', system: 'fixture' })
  assert.equal(result.stopReason, 'error'); assert.match(result.error, /400/)
  assert.equal(requests.length, 1)
})

test('HTTP 503 临时失败重试后可继续', async t => {
  const { config, requests } = await endpoint(t, (_, n) => n === 1 ? { status: 503 } : {})
  const result = await runAgent({ config, tools: [], user: '总结', system: 'fixture' })
  assert.equal(result.stopReason, 'done'); assert.equal(requests.length, 2)
})

test('工具实际执行并将结果回传给下一轮请求', async t => {
  const { config, requests } = await endpoint(t, (_, n) => n === 1 ? { message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_fact', arguments: '{"key":"answer"}' } }]
  } } : {})
  let executed = 0
  const result = await runAgent({ config, user: '读取', system: 'fixture', tools: [{
    name: 'read_fact', description: '读取事实', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    execute: async args => { assert.equal(args.key, 'answer'); executed++; return '事实为 42' }
  }] })
  assert.equal(result.stopReason, 'done'); assert.equal(executed, 1)
  assert.equal(requests[0].tools[0].function.name, 'read_fact')
  assert.ok(requests[1].messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call-1' && m.content === '事实为 42'))
})

test('超过 512 KB 的项目文本可按行读取并给出后续范围', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-read-page-'))
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }) })
  await fs.writeFile(path.join(root, 'large.md'), Array.from({ length: 12000 }, (_, i) => `记录 ${i + 1} ${'内容'.repeat(20)}`).join('\n'))
  const text = await readProjectText(root, 'large.md', 9000)
  assert.match(text, /9000: 记录 9000/)
  assert.match(text, /下一次|next/)
  assert.ok(text.length < 20000)
})

test('不支持的文本格式使用明确格式错误', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-read-format-'))
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }) })
  await fs.writeFile(path.join(root, 'picture.png'), 'fixture')
  await assert.rejects(readProjectText(root, 'picture.png'), /格式|文本类型/)
})
