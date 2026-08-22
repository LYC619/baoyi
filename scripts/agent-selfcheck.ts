/**
 * agent 自检 —— 不需要 API Key，不需要 Electron，不引入测试框架。
 *
 *   npm run selfcheck
 *
 * 覆盖三件出错代价最高的事：
 *   1. tool-calling 回路本身（工具真的被执行了？结果真的回灌了？护栏真的拦得住？）
 *   2. 路径沙箱（模型让它读 C:\Windows 时，它到底拦不拦）
 *   3. 识别日志（agent 的事件流能不能原样还原成一轮一轮的过程）
 * 其余逻辑靠 vue-tsc 和实跑覆盖，这里只守住这三条。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgent, type AgentEvent, type AgentTool } from '../electron/services/agent/loop.ts'
import { isInside, resolveInside } from '../electron/services/agent/paths.ts'
import {
  decodeText,
  isReadableName,
  looksBinary,
  readTextFile
} from '../electron/services/agent/files.ts'
import { readExternalActiveAt } from '../electron/services/activity.ts'
import { fillIdentifySystem, limitTags } from '../electron/services/agent/prompts.ts'
import { activityOf, displayName, groupRounds, subtitleName } from '../src/utils/index.ts'

const CONFIG = { api_url: 'http://localhost/v1', api_key: 'test', model: 'fake', enabled: true }

let passed = 0
let failed = 0

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
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

type Scripted = { tool?: { name: string; args: unknown }; text?: string }

/**
 * 把 fetch 换成一个照剧本出牌的假模型。
 * 返回 sent 数组，方便断言「工具结果确实被回灌进了下一轮请求」。
 */
function mockModel(script: Scripted[]): { sent: any[]; restore: () => void } {
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

function echoTool(calls: Array<{ name: string; args: any }>): AgentTool {
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

/* ------------------------------ 用例 ------------------------------ */

async function main(): Promise<void> {
  console.log('\nagent loop')

  await check('执行工具、回灌结果、模型不再调用时收工', async () => {
    const calls: Array<{ name: string; args: any }> = []
    const mock = mockModel([
      { tool: { name: 'probe', args: { v: 'a' } } },
      { text: '处理完了' }
    ])
    try {
      const result = await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [echoTool(calls)]
      })
      assert.equal(result.stopReason, 'done')
      assert.equal(result.text, '处理完了')
      assert.equal(result.turns, 2)
      assert.equal(result.tokens, 20, 'token 应该逐轮累加')
      assert.deepEqual(calls, [{ name: 'probe', args: { v: 'a' } }])

      // 第二轮请求里必须带着上一轮的工具结果，否则模型看不到自己干了什么
      const second = mock.sent[1].messages
      const toolMsg = second.find((m: any) => m.role === 'tool')
      assert.ok(toolMsg, '第二轮请求缺少 role=tool 的消息')
      assert.equal(toolMsg.tool_call_id, 'call_1')
      assert.match(toolMsg.content, /probe 收到/)
    } finally {
      mock.restore()
    }
  })

  await check('参数不是合法 JSON 时把错误回灌，而不是中断整轮', async () => {
    const calls: Array<{ name: string; args: any }> = []
    const mock = mockModel([
      { tool: { name: 'probe', args: '{"v": ' } },
      { text: '收到，重来' }
    ])
    try {
      const result = await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [echoTool(calls)]
      })
      assert.equal(result.stopReason, 'done')
      assert.equal(calls.length, 0, '参数坏掉时不该真的执行工具')
      const toolMsg = mock.sent[1].messages.find((m: any) => m.role === 'tool')
      assert.match(toolMsg.content, /不是合法的 JSON/)
    } finally {
      mock.restore()
    }
  })

  await check('模型点名不存在的工具时给出可用列表', async () => {
    const mock = mockModel([{ tool: { name: '不存在', args: {} } }, { text: 'ok' }])
    try {
      await runAgent({ config: CONFIG, system: 's', user: 'u', tools: [echoTool([])] })
      const toolMsg = mock.sent[1].messages.find((m: any) => m.role === 'tool')
      assert.match(toolMsg.content, /不存在名为/)
      assert.match(toolMsg.content, /probe/)
    } finally {
      mock.restore()
    }
  })

  await check('同参数反复调用会被拦下，不会烧光额度', async () => {
    const calls: Array<{ name: string; args: any }> = []
    // 剧本只有一条，假模型会一直重复它
    const mock = mockModel([{ tool: { name: 'probe', args: { v: 'same' } } }])
    try {
      const result = await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [echoTool(calls)],
        maxTurns: 8
      })
      assert.equal(result.stopReason, 'max_turns')
      assert.equal(calls.length, 3, `重复调用应在第 3 次后被拦下，实际执行了 ${calls.length} 次`)
      const last = mock.sent[mock.sent.length - 1].messages.filter((m: any) => m.role === 'tool')
      assert.match(last[last.length - 1].content, /完全相同的参数/)
    } finally {
      mock.restore()
    }
  })

  await check('工具抛异常时转成错误消息继续，不炸掉整次运行', async () => {
    const boom: AgentTool = {
      name: 'probe',
      description: '总是失败',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('磁盘不见了')
      }
    }
    const mock = mockModel([{ tool: { name: 'probe', args: {} } }, { text: '知道了' }])
    try {
      const result = await runAgent({ config: CONFIG, system: 's', user: 'u', tools: [boom] })
      assert.equal(result.stopReason, 'done')
      const toolMsg = mock.sent[1].messages.find((m: any) => m.role === 'tool')
      assert.match(toolMsg.content, /磁盘不见了/)
    } finally {
      mock.restore()
    }
  })

  await check('HTTP 报错时返回 error 而不是抛出', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"tools not supported"}'
    })) as unknown as typeof fetch
    try {
      const result = await runAgent({ config: CONFIG, system: 's', user: 'u', tools: [], maxTurns: 1 })
      assert.equal(result.stopReason, 'error')
      assert.match(result.error, /tools not supported/)
    } finally {
      globalThis.fetch = original
    }
  })

  await check('已取消的信号进来就立刻停手', async () => {
    const mock = mockModel([{ tool: { name: 'probe', args: {} } }])
    try {
      const result = await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [echoTool([])],
        signal: AbortSignal.abort()
      })
      assert.equal(result.stopReason, 'aborted')
      assert.equal(mock.sent.length, 0, '取消后不该再发出请求')
    } finally {
      mock.restore()
    }
  })

  /* --------------------------- 路径沙箱 --------------------------- */

  console.log('\n路径沙箱')

  const root = path.join(os.tmpdir(), 'baoyi-selfcheck-root')

  await check('允许根目录自身和它下面的路径', () => {
    assert.equal(resolveInside([root], root), path.resolve(root))
    assert.equal(
      resolveInside([root], path.join(root, 'app', 'a.exe')),
      path.join(root, 'app', 'a.exe')
    )
  })

  await check('拒绝根目录之外的路径', () => {
    assert.throws(() => resolveInside([root], 'C:\\Windows\\System32\\cmd.exe'), /路径越界/)
    assert.throws(() => resolveInside([root], '/etc/passwd'), /路径越界/)
  })

  await check('拒绝 .. 回溯出根目录', () => {
    assert.throws(() => resolveInside([root], path.join(root, '..', '别处', 'x.exe')), /路径越界/)
  })

  await check('同前缀的兄弟目录不算在内（Tools 不该放行 Tools2）', () => {
    assert.equal(isInside('C:\\Tools', 'C:\\Tools\\a.exe'), true)
    assert.equal(isInside('C:\\Tools', 'C:\\Tools2\\a.exe'), false)
    assert.equal(isInside('C:\\Tools', 'C:\\ToolsBackup'), false)
  })

  await check('大小写和结尾分隔符不影响判断', () => {
    assert.equal(isInside('C:\\Tools\\', 'c:\\TOOLS\\sub\\a.exe'), true)
  })

  await check('空路径和非字符串一律拒绝', () => {
    assert.throws(() => resolveInside([root], ''), /不能为空/)
    assert.throws(() => resolveInside([root], null), /不能为空/)
    assert.throws(() => resolveInside([root], 42), /不能为空/)
  })

  /* --------------------------- 读说明文档 --------------------------- */

  console.log('\n读说明文档')

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-doc-'))

  await check('认得出说明文档，认得出不该读的东西', () => {
    for (const name of ['README.md', '使用说明.txt', 'changelog', 'LICENSE', 'config.ini', 'Read Me.txt']) {
      assert.equal(isReadableName(name), true, `${name} 应该可读`)
    }
    for (const name of ['x64dbg.exe', 'zlib.dll', 'icon.png', 'data.bin', 'font.ttf']) {
      assert.equal(isReadableName(name), false, `${name} 不该可读`)
    }
  })

  await check('UTF-8 中文正常读出', async () => {
    const f = path.join(tmp, 'README.md')
    await fsp.writeFile(f, '# Everything\n\n本地文件秒搜工具，按文件名瞬间定位。\n')
    const out = await readTextFile(f)
    assert.match(out, /UTF-8/)
    assert.match(out, /本地文件秒搜工具/)
  })

  await check('GBK 中文不会读成乱码', async () => {
    // 「文件秒搜」的 GBK 字节，模拟国产绿色软件常见的说明文件
    const gbk = Buffer.from([0xce, 0xc4, 0xbc, 0xfe, 0xc3, 0xeb, 0xcb, 0xd1, 0x0d, 0x0a])
    const f = path.join(tmp, '使用说明.txt')
    await fsp.writeFile(f, gbk)
    const out = await readTextFile(f)
    assert.match(out, /GBK/, '应当判定为 GBK')
    assert.match(out, /文件秒搜/, `解出来的不是原文，实际内容：${JSON.stringify(out.slice(-30))}`)
    assert.ok(!out.includes('�'), '不该出现替换字符（乱码）')
  })

  await check('带 BOM 的 UTF-8 不把 BOM 当正文', async () => {
    const f = path.join(tmp, 'notice.txt')
    await fsp.writeFile(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('测试内容')]))
    const out = await readTextFile(f)
    assert.match(out, /UTF-8 \(BOM\)/)
    assert.ok(!out.includes('﻿'), 'BOM 不该留在正文里')
  })

  await check('末尾截断的 UTF-8 不会被误判成 GBK', () => {
    // 「中文」的 UTF-8 是 6 字节，砍掉最后一个字节模拟读取上限处截断
    const full = Buffer.from('中文', 'utf8')
    const cut = full.subarray(0, full.length - 1)
    const { text, encoding } = decodeText(cut)
    assert.equal(encoding, 'UTF-8', '退字节重试应当让它仍被认作 UTF-8')
    assert.equal(text, '中')
  })

  await check('二进制文件被挡下，不喂给模型', async () => {
    const f = path.join(tmp, 'data.txt')
    await fsp.writeFile(f, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x61, 0x62]))
    assert.equal(looksBinary(Buffer.from([0x61, 0x00, 0x62])), true)
    assert.equal(looksBinary(Buffer.from('plain text')), false)
    await assert.rejects(() => readTextFile(f), /二进制/)
  })

  await check('exe 走不通这个工具', async () => {
    const f = path.join(tmp, 'app.exe')
    await fsp.writeFile(f, 'MZ')
    await assert.rejects(() => readTextFile(f), /不是可读的文本文件/)
  })

  await check('空文件给出明确说明而不是空串', async () => {
    const f = path.join(tmp, 'empty.txt')
    await fsp.writeFile(f, '')
    assert.match(await readTextFile(f), /空文件/)
  })

  fs.rmSync(tmp, { recursive: true, force: true })

  /* --------------------------- 识别日志 --------------------------- */

  console.log('\n识别日志')

  await check('真实事件流能还原成一轮一轮的过程', async () => {
    const trail: AgentEvent[] = []
    const mock = mockModel([
      { tool: { name: 'probe', args: { v: 'a' } } },
      { tool: { name: 'probe', args: { v: 'b' } } },
      { text: '看明白了' }
    ])
    try {
      await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [echoTool([])],
        onEvent: (e) => trail.push(e)
      })
    } finally {
      mock.restore()
    }

    const rounds = groupRounds(trail)
    assert.equal(rounds.length, 3, `应当分出 3 轮，实际 ${rounds.length} 轮`)
    assert.deepEqual(
      rounds.map((r) => r.index),
      [1, 2, 3],
      '轮次编号要跟着 loop 的 turn 事件走'
    )

    // 每一轮的调用和它的返回必须落在同一轮里，否则日志页会把因果拆开显示
    const first = rounds[0].events.map((x) => x.event.type)
    assert.deepEqual(first, ['tool_call', 'tool_result'])

    // 下标是渲染 key，必须唯一且能索引回原数组
    const indexes = rounds.flatMap((r) => r.events.map((x) => x.i))
    assert.equal(new Set(indexes).size, indexes.length, '事件下标重复了，渲染 key 会撞车')
    for (const i of indexes) assert.ok(trail[i], `下标 ${i} 索引不回原事件`)

    // 一个事件都不能漏 —— 漏掉的那条恰恰可能是解释「为什么判断错了」的关键
    assert.equal(indexes.length, trail.filter((e) => e.type !== 'turn').length)
  })

  await check('日志被截断时，落在第一个 turn 前的事件也不丢', () => {
    const rounds = groupRounds([
      { type: 'tool_result', name: 'probe', text: '半截', isError: false },
      { type: 'turn', index: 9 },
      { type: 'tool_call', name: 'probe', args: {} }
    ])
    assert.deepEqual(
      rounds.map((r) => r.index),
      [0, 9]
    )
  })

  await check('建表和日志淘汰的 SQL 能真的跑起来', async () => {
    // database.ts 依赖 electron 和 better-sqlite3（按 Electron ABI 编译），纯 node 载不进来。
    // 所以从构建产物里把 SQL 原文抠出来，喂给 node 自带的 sqlite 跑一遍 ——
    // 验的是真正会发出去的那几条语句，不是照抄一份。建表语句写错的代价是整个应用打不开。
    const bundle = path.join(import.meta.dirname, '..', 'dist-electron', 'main.js')
    if (!fs.existsSync(bundle)) {
      console.log('       （跳过：先 npm run build 才有 dist-electron/main.js）')
      return
    }
    const source = await fsp.readFile(bundle, 'utf8')

    /** 取出 anchor 所在的那段模板字符串原文 */
    const sqlAround = (anchor: string): string => {
      const at = source.indexOf(anchor)
      assert.ok(at > 0, `构建产物里找不到 ${anchor}`)
      const open = source.lastIndexOf('`', at)
      const close = source.indexOf('`', at)
      assert.ok(open > 0 && close > at, `${anchor} 不在模板字符串里`)
      return source.slice(open + 1, close)
    }

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS software'))

    const cols = db.prepare('PRAGMA table_info(identify_logs)').all() as Array<{ name: string }>
    assert.ok(cols.length > 0, 'identify_logs 表没建出来')
    for (const need of ['id', 'dir', 'status', 'events', 'created_at']) {
      assert.ok(cols.some((c) => c.name === need), `identify_logs 缺列 ${need}`)
    }

    const insert = db.prepare(sqlAround('INSERT INTO identify_logs'))
    for (let i = 0; i < 320; i++) {
      insert.run({
        id: `log-${i}`,
        dir: 'D:\\Tools\\x',
        label: 'x',
        kind: 'unit',
        status: 'success',
        summary: '注册 1 项',
        registered: 1,
        rounds: 3,
        duration_ms: 100,
        tokens: 500,
        stop_reason: 'done',
        events: '[]',
        created_at: 1_000 + i
      })
    }

    db.prepare(sqlAround('DELETE FROM identify_logs WHERE id NOT IN')).run(300)
    const left = db.prepare('SELECT COUNT(*) AS n FROM identify_logs').get() as { n: number }
    assert.equal(left.n, 300, `淘汰后应剩 300 条，实际 ${left.n}`)

    // 淘汰要留下最新的那批，留错方向等于每次都在删刚写进去的日志
    const oldest = db.prepare('SELECT MIN(created_at) AS t FROM identify_logs').get() as { t: number }
    assert.equal(oldest.t, 1_020, '被删掉的应该是最旧的 20 条')

    db.close()
  })

  await check('暂存 / 确认 / 忽略那几条 SQL 和表结构对得上', async () => {
    // 列名写错、命名参数漏一个，这类错误 vue-tsc 一个都看不见 —— 它们只会在
    // 用户点下「确认」的那一刻抛出来。prepare 一遍就能全部逼出来：
    // SQLite 在 prepare 阶段就会校验表名、列名和参数。
    const bundle = path.join(import.meta.dirname, '..', 'dist-electron', 'main.js')
    if (!fs.existsSync(bundle)) {
      console.log('       （跳过：先 npm run build 才有 dist-electron/main.js）')
      return
    }
    const source = await fsp.readFile(bundle, 'utf8')
    const sqlAround = (anchor: string): string => {
      const at = source.indexOf(anchor)
      assert.ok(at > 0, `构建产物里找不到 ${anchor}`)
      const open = source.lastIndexOf('`', at)
      const close = source.indexOf('`', at)
      return source.slice(open + 1, close)
    }

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS software'))

    for (const anchor of [
      'INSERT INTO pending_software',
      'UPDATE pending_software SET',
      'INSERT INTO skip_list',
      'INSERT INTO tags',
      'INSERT INTO categories'
    ]) {
      assert.doesNotThrow(() => db.prepare(sqlAround(anchor)), `${anchor} 这条语句和表结构对不上`)
    }

    // 「长期未用」的判据换成了两个时间取晚的那个，写错这里等于整个分组失效
    db.prepare(
      `INSERT INTO software (id, created_at, updated_at, exe_path, file_name, last_used_at, external_active_at)
       VALUES ('a', 0, 0, 'C:\\a.exe', 'a.exe', 0, 9000),
              ('b', 0, 0, 'C:\\b.exe', 'b.exe', 9000, 0),
              ('c', 0, 0, 'C:\\c.exe', 'c.exe', 0, 0)`
    ).run()
    const stale = db
      .prepare('SELECT id FROM software WHERE MAX(last_used_at, external_active_at) < 5000')
      .all() as Array<{ id: string }>
    assert.deepEqual(
      stale.map((r) => r.id),
      ['c'],
      '只有两个时间都读不到的才算长期未用'
    )

    db.close()
  })

  /* --------------------------- 外部活跃时间 --------------------------- */

  console.log('\n外部活跃时间')

  const act = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-act-'))
  const exe = path.join(act, 'Tool.exe')
  const long = Date.now() - 400 * 86_400_000
  const recent = Date.now() - 3 * 86_400_000

  await check('配置文件被改过时，取配置的时间而不是 exe 的', async () => {
    await fsp.writeFile(exe, 'MZ')
    await fsp.utimes(exe, new Date(long), new Date(long))
    const cfg = path.join(act, 'Tool.ini')
    await fsp.writeFile(cfg, '[main]')
    await fsp.utimes(cfg, new Date(recent), new Date(recent))

    const at = readExternalActiveAt(exe)
    assert.ok(
      Math.abs(at - recent) < 2000,
      `应当取 Tool.ini 的 mtime，实际 ${new Date(at).toISOString()}`
    )
  })

  await check('没有配置文件时退回 exe 自己的 mtime', async () => {
    const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-act-bare-'))
    const only = path.join(bare, 'Solo.exe')
    await fsp.writeFile(only, 'MZ')
    await fsp.utimes(only, new Date(long), new Date(long))
    assert.ok(Math.abs(readExternalActiveAt(only) - long) < 2000)
    fs.rmSync(bare, { recursive: true, force: true })
  })

  await check('落在未来的 mtime 不采信 —— 否则「长期未用」永远筛不到它', async () => {
    const weird = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-act-future-'))
    const f = path.join(weird, 'Future.exe')
    const ahead = Date.now() + 365 * 86_400_000
    await fsp.writeFile(f, 'MZ')
    await fsp.utimes(f, new Date(ahead), new Date(ahead))
    assert.equal(readExternalActiveAt(f), 0)
    fs.rmSync(weird, { recursive: true, force: true })
  })

  await check('读不到的路径返回 0，而不是抛出来打断注册', () => {
    assert.equal(readExternalActiveAt(path.join(act, '并不存在', 'x.exe')), 0)
  })

  fs.rmSync(act, { recursive: true, force: true })

  await check('上次活跃优先信抱一自己的记录，其次才是磁盘推算', () => {
    const base = { last_used_at: 0, external_active_at: 0 } as any

    const launched = activityOf({ ...base, last_used_at: recent, external_active_at: long })
    assert.equal(launched.source, 'baoyi')
    assert.equal(launched.at, recent, '抱一记到过启动就不该再看磁盘')

    const external = activityOf({ ...base, external_active_at: recent })
    assert.equal(external.source, 'external')
    assert.equal(external.at, recent)
    assert.notEqual(external.label, '从未使用', '有活跃痕迹就不该再说「从未使用」')

    const never = activityOf(base)
    assert.equal(never.source, 'none')
    assert.equal(never.label, '从未使用')
  })

  /* --------------------------- 分类与标签 --------------------------- */

  console.log('\n分类与标签')

  const CATS = [
    { id: 'find', name: '文件搜索', description: '查找、定位、磁盘分析', icon: 'search', sort_order: 1 },
    { id: 'other', name: '其他', description: '无法归入以上分类', icon: 'box', sort_order: 2 }
  ]

  await check('插槽真的被填上了 —— 漏填等于把 {{tags}} 原样发给模型', () => {
    const filled = fillIdentifySystem(CATS, ['便携', '开源'])
    assert.ok(!filled.includes('{{'), `提示词里还留着没替换的插槽：${filled.match(/\{\{\w+\}\}/)?.[0]}`)
    assert.match(filled, /文件搜索 —— 查找、定位、磁盘分析/, '分类描述要一起注入，AI 才有判据')
    assert.match(filled, /便携、开源/)
  })

  await check('分类表或标签池为空时也给得出一句能用的话', () => {
    const filled = fillIdentifySystem([], [])
    assert.ok(!filled.includes('{{'))
    assert.match(filled, /标签池还是空的/)
  })

  await check('模型一口气造五个新词时，只放行一个', () => {
    const pool = new Set(['便携', '开源', 'CLI'])
    const out = limitTags(['便携', '开源', '反汇编', '脱壳', '调试器'], pool)
    assert.deepEqual(out, ['便携', '开源', '反汇编'], `实际拿到 ${JSON.stringify(out)}`)
  })

  await check('总数封顶 3 个，池内的也不例外', () => {
    const pool = new Set(['便携', '开源', 'CLI', 'GUI', '单文件'])
    assert.equal(limitTags(['便携', '开源', 'CLI', 'GUI', '单文件'], pool).length, 3)
  })

  await check('空数组、空串、重复项都不该混进去', () => {
    const pool = new Set(['便携'])
    assert.deepEqual(limitTags([], pool), [])
    assert.deepEqual(limitTags(['便携', '便携', '  ', ''], pool), ['便携'])
  })

  /* --------------------------- 卡片标题 --------------------------- */
  console.log('\n卡片标题')

  const procmon = {
    name_zh: '进程监视器',
    name_en: 'Process Monitor',
    file_description: 'Process Monitor',
    file_name: 'Procmon.exe'
  } as any

  await check('中英文两种模式各自打头，另一个降为副标题', () => {
    assert.equal(displayName(procmon, 'zh'), '进程监视器')
    assert.equal(subtitleName(procmon, 'zh'), 'Process Monitor')
    assert.equal(displayName(procmon, 'en'), 'Process Monitor')
    assert.equal(subtitleName(procmon, 'en'), '进程监视器')
  })

  await check('选中的那一侧没有值时落到另一侧，不会显示空标题', () => {
    const onlyEn = { name_zh: '', name_en: 'PowerRun', file_description: '', file_name: 'PowerRun.exe' } as any
    assert.equal(displayName(onlyEn, 'zh'), 'PowerRun')
    assert.equal(subtitleName(onlyEn, 'zh'), '', '标题和副标题不该是同一个名字')

    const nothing = { name_zh: '', name_en: '', file_description: '', file_name: 'AmazTool.exe' } as any
    assert.equal(displayName(nothing, 'zh'), 'AmazTool')
    assert.equal(displayName(nothing, 'en'), 'AmazTool')
  })

  console.log(`\n${passed} 通过，${failed} 失败\n`)
  if (failed > 0) process.exit(1)
}

void main()
