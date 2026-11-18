import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { reactive, ref } from 'vue'
import { runAgent, type AgentEvent, type AgentTool } from '../../electron/services/agent/loop.ts'
import { isInside, resolveInside } from '../../electron/services/agent/paths.ts'
import { decodeText, isReadableName, looksBinary, readTextFile } from '../../electron/services/agent/files.ts'
import { readExternalActiveAt } from '../../electron/services/activity.ts'
import { activityOf, createLatestGuard, displayName, groupRounds, logToText, plain, searchCalls, subtitleName } from '../../src/utils/index.ts'
import type { IdentifyLog } from '../../src/types/index.ts'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, TABLES_SQL, initSchema, objectType, schemaVersion } from '../../electron/services/schema.ts'
import { KINDS } from '../../electron/kinds/index.ts'
import { softwareKind } from '../../electron/kinds/software/index.ts'
import { gameKind } from '../../electron/kinds/game/index.ts'
import { normalizeProxyRules, parseProxyInput, serializeProxyInput, toElectronProxyConfig, usesChromiumFetch } from '../../electron/services/proxy-rules.ts'
import { decidePortable, PORTABLE_MARKERS } from '../../electron/services/portable-rules.ts'
import { HANIME_CLOUDFLARE_IPS, HANIME_HOSTS, buildHanimeHostResolverRules, getHanimeHostsStatus, isUnreachableLoadError, pickStartupIp, isConnectionFailure, isHanimeHost, orderedHanimeIps } from '../../electron/services/hanime-network-rules.ts'
import { fetchHanimeResource } from '../../electron/kinds/video/hentai/hanime.ts'
import { CONFIG, sleep, check, mockModel, echoTool } from './shared.ts'
export async function agentSection(): Promise<void> {


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

  await check('同一个错误连续 3 次就终止整次运行，不让模型换措辞接着重试', async () => {
    const calls: any[] = []
    const boom: AgentTool = {
      name: 'probe',
      description: '总是同一个错误',
      parameters: { type: 'object', properties: { v: { type: 'string' } } },
      execute: async (args) => {
        calls.push(args)
        throw new Error('table pending_software has no column named is_portable')
      }
    }
    // 参数每轮都不一样：按「同参数」去重的 MAX_REPEAT 拦不住这种打转，
    // 数据库缺列那次就是这么白烧了 8 轮
    const mock = mockModel([
      { tool: { name: 'probe', args: { v: 'a' } } },
      { tool: { name: 'probe', args: { v: 'b' } } },
      { tool: { name: 'probe', args: { v: 'c' } } }
    ])
    try {
      const result = await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [boom],
        maxTurns: 12
      })
      assert.equal(result.stopReason, 'error')
      assert.equal(calls.length, 3, `应在第 3 次同错后终止，实际执行了 ${calls.length} 次`)
      assert.match(result.error, /has no column named is_portable/, '原始错误要原样报上去')
    } finally {
      mock.restore()
    }
  })

  await check('中间成功过一次就重新计数，零散的同名错误不会误伤会话', async () => {
    let n = 0
    const flaky: AgentTool = {
      name: 'probe',
      description: '错两次、成一次、再错一次',
      parameters: { type: 'object', properties: { v: { type: 'string' } } },
      execute: async () => {
        n++
        if (n === 3) return '这次成了'
        throw new Error('同一个错误')
      }
    }
    const mock = mockModel([
      { tool: { name: 'probe', args: { v: 'a' } } },
      { tool: { name: 'probe', args: { v: 'b' } } },
      { tool: { name: 'probe', args: { v: 'c' } } },
      { tool: { name: 'probe', args: { v: 'd' } } },
      { text: '收尾' }
    ])
    try {
      const result = await runAgent({
        config: CONFIG,
        system: 's',
        user: 'u',
        tools: [flaky],
        maxTurns: 6
      })
      assert.equal(result.stopReason, 'done', '错误不连续就不该终止')
      assert.equal(n, 4)
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
    const bundle = path.join(import.meta.dirname, '..', '..', 'dist-electron', 'main.js')
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
    // 0.5 起公共表在 services/schema.ts 的 TABLES_SQL 里，锚点从 resource 起
    // （写 software 会先撞上 kinds/software 那段只含 software_meta 的模板）
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS resource ('))

    const cols = db.prepare('PRAGMA table_info(identify_logs)').all() as Array<{ name: string }>
    assert.ok(cols.length > 0, 'identify_logs 表没建出来')
    for (const need of ['id', 'dir', 'resource_kind', 'status', 'events', 'created_at']) {
      assert.ok(cols.some((c) => c.name === need), `identify_logs 缺列 ${need}`)
    }

    const insert = db.prepare(sqlAround('INSERT INTO identify_logs'))
    for (let i = 0; i < 320; i++) {
      insert.run({
        id: `log-${i}`,
        dir: 'D:\\Tools\\x',
        label: 'x',
        kind: 'unit',
        resource_kind: 'software',
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
    const bundle = path.join(import.meta.dirname, '..', '..', 'dist-electron', 'main.js')
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
    // 0.5 起表分散在公共层和品类模块两处，构建产物里是几段独立的模板，
    // 锚点要分开写。software 本身是 resource + software_meta 拼出来的视图
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS resource ('))
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS scan_units'))
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS software_meta'))
    db.exec(sqlAround('CREATE VIEW IF NOT EXISTS software'))

    for (const anchor of [
      'INSERT INTO pending_software',
      'UPDATE pending_software SET',
      'INSERT INTO skip_list',
      'INSERT INTO tags',
      'INSERT INTO categories',
      // 0.3 新增的几条。整理会改动用户磁盘上的真实路径，而这几条负责把库里的
      // 记录跟着改过去 —— 列名写错的表现是「整理完点启动就失败」，且那时候
      // 用户已经不知道是整理干的了
      'INSERT INTO organize_plans',
      'UPDATE organize_plans SET undone_at',
      // 0.5 拆表之后，同一件事要落到两张表上，所以两条都得核
      'UPDATE resource SET path = @exe_path',
      'UPDATE software_meta SET launchers = @launchers',
      // 0.7 起影视模块也有一条 INSERT INTO resource（列名是拼出来的、带 ${}，prepare 不了），锚点写到 file_name 才落在软件那条上
      'INSERT INTO resource\n         (id, kind, created_at, updated_at, path, icon_path, file_name',
      'INSERT INTO software_meta\n         (resource_id',
      'INSERT OR IGNORE INTO resource\n',
      'INSERT OR IGNORE INTO software_meta',
      // 0.4 新增的汇总报告。列名写错的表现是「识别跑完了但报告永远打不开」
      'INSERT INTO identification_reports',
      'DELETE FROM identification_reports WHERE id NOT IN'
    ]) {
      assert.doesNotThrow(() => db.prepare(sqlAround(anchor)), `${anchor} 这条语句和表结构对不上`)
    }

    /** 视图是只读的，造数据要往两张基表上写 */
    const seed = (
      id: string,
      lastUsed: number,
      externalActive: number,
      portable: number | null,
      risk: string
    ): void => {
      db.prepare(
        `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name,
           last_used_at, external_active_at)
         VALUES (?, 'software', 0, 0, ?, ?, ?, ?)`
      ).run(id, `C:\\${id}.exe`, `${id}.exe`, lastUsed, externalActive)
      db.prepare(
        `INSERT INTO software_meta (resource_id, is_portable, move_risk) VALUES (?, ?, ?)`
      ).run(id, portable, risk)
    }

    // 三态的 is_portable：NULL 必须能和 0 区分开。压成同一个值的后果是
    // 「还没判断过」的条目被当成「判断为不是绿色软件」，整理时按安装版处理。
    // 时间字段一律给足，免得这几行落进下面那个「长期未用」的判定里
    seed('p1', 9000, 9000, 1, 'safe')
    seed('p2', 9000, 9000, 0, 'risky')
    seed('p3', 9000, 9000, null, 'unknown')
    const portable = db
      .prepare('SELECT id FROM software WHERE is_portable = 1')
      .all() as Array<{ id: string }>
    assert.deepEqual(portable.map((r) => r.id), ['p1'], 'is_portable = 1 只该命中真正的绿色软件')
    const unjudged = db
      .prepare('SELECT id FROM software WHERE is_portable IS NULL')
      .all() as Array<{ id: string }>
    assert.deepEqual(unjudged.map((r) => r.id), ['p3'], 'NULL 和 0 被压成了同一个值')

    // 「长期未用」的判据换成了两个时间取晚的那个，写错这里等于整个分组失效
    seed('a', 0, 9000, null, 'unknown')
    seed('b', 9000, 0, null, 'unknown')
    seed('c', 0, 0, null, 'unknown')
    const stale = db
      .prepare(
        `SELECT id FROM software WHERE MAX(last_used_at, external_active_at) < 5000 ORDER BY id`
      )
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
}
export async function rendererUtilitiesSection(): Promise<void> {


  /* --------------------------- 日志复制成文本 --------------------------- */
  console.log('\n日志复制成文本')

  const sampleLog: IdentifyLog = {
    id: 'l1',
    dir: 'D:\\Software\\1.system\\RegistryFinder64',
    label: 'RegistryFinder64',
    kind: 'unit' as const,
    resource_kind: 'software' as const,
    status: 'success' as const,
    summary: '待确认 1 项',
    registered: 1,
    rounds: 3,
    duration_ms: 96_900,
    tokens: 85_550,
    stop_reason: 'done' as const,
    events: [
      { type: 'turn' as const, index: 1 },
      { type: 'tool_call' as const, name: 'list_directory', args: { path: 'D:\\S\\RF' } },
      { type: 'tool_result' as const, name: 'list_directory', text: '目录：D:\\S\\RF\n本级 exe（1）', isError: false, ms: 12 },
      { type: 'turn' as const, index: 2 },
      { type: 'text' as const, name: '', text: '看起来是注册表搜索工具' } as any
    ],
    created_at: 1_700_000_000_000
  }

  await check('头三行给出目录、状态和成本', () => {
    const text = logToText(sampleLog)
    const lines = text.split('\n')
    assert.match(lines[0], /^目录：D:\\Software\\1\.system\\RegistryFinder64$/)
    assert.match(lines[1], /^状态：识别完成/)
    assert.match(lines[2], /轮次：3 \| 耗时：96\.9s \| Tokens：85,550/)
  })

  await check('每一轮的调用、完整返回、模型原话都在，一个字不省', () => {
    const text = logToText(sampleLog)
    assert.match(text, /\[轮次 1\] → list_directory .*D:\\\\S\\\\RF/)
    // 页面上折叠到 6 行，复制出去必须是全文 —— 它是要贴进 issue 的
    assert.match(text, /返回：目录：D:\\S\\RF\n本级 exe（1）/)
    assert.match(text, /\[轮次 2\] 模型推理：看起来是注册表搜索工具/)
  })

  await check('撞上轮数上限时在头部就说清楚', () => {
    const text = logToText({ ...sampleLog, stop_reason: 'max_turns' })
    assert.match(text, /达到轮数上限被强制结束/)
  })

  /* --------------------------- 搜索调用记录 --------------------------- */
  console.log('\n搜索调用记录')

  const searchLog = (id: string, at: number, events: any[]): IdentifyLog => ({
    ...sampleLog,
    id,
    created_at: at,
    events
  })

  await check('从事件流里认出每一次搜索，并给出结论', () => {
    const calls = searchCalls([
      searchLog('a', 2000, [
        { type: 'turn', index: 1 },
        { type: 'tool_call', name: 'list_directory', args: { path: 'x' } },
        { type: 'tool_result', name: 'list_directory', text: '目录', isError: false, ms: 5 },
        { type: 'tool_call', name: 'web_search', args: { query: 'cc-gui 是什么' } },
        { type: 'tool_result', name: 'web_search', text: '「cc-gui」的搜索结果：\n[1] ...', isError: false, ms: 1400 }
      ]),
      searchLog('b', 1000, [
        { type: 'tool_call', name: 'web_search', args: { query: 'Kelivo' } },
        { type: 'tool_result', name: 'web_search', text: '「Kelivo」没有搜到结果。请依据本地信息判断。', isError: false, ms: 900 }
      ])
    ])
    assert.equal(calls.length, 2, `实际取到 ${calls.length} 条`)
    // 新的在前
    assert.equal(calls[0].query, 'cc-gui 是什么')
    assert.equal(calls[0].status, 'ok')
    assert.equal(calls[0].ms, 1400)
    assert.equal(calls[1].status, 'empty', '搜到 0 条和搜失败不是一回事')
    assert.ok(!calls.some((c) => c.query === ''), 'list_directory 不该被算成搜索')
  })

  await check('失败和超时分开记 —— webSearch 不抛异常，只能从文案上认', () => {
    const calls = searchCalls([
      searchLog('t', 3000, [
        { type: 'tool_call', name: 'web_search', args: { query: 'a' } },
        { type: 'tool_result', name: 'web_search', text: '搜索「a」失败：The operation was aborted due to timeout。请依据本地信息判断。', isError: false, ms: 20_000 }
      ]),
      searchLog('f', 2000, [
        { type: 'tool_call', name: 'web_search', args: { query: 'b' } },
        { type: 'tool_result', name: 'web_search', text: '搜索「b」失败：HTTP 401 Unauthorized。请依据本地信息判断。', isError: false, ms: 300 }
      ])
    ])
    assert.equal(calls[0].status, 'timeout')
    assert.equal(calls[1].status, 'failed')
  })

  await check('0.4 之前的老日志没有 ms，读出来是 0 而不是崩掉', () => {
    const calls = searchCalls([
      searchLog('old', 1000, [
        { type: 'tool_call', name: 'web_search', args: { query: 'old' } },
        { type: 'tool_result', name: 'web_search', text: '「old」的搜索结果：\n[1] x', isError: false }
      ])
    ])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].ms, 0)
  })

  await check('调用没有对应返回时算失败，不静默丢掉这一次额度', () => {
    const calls = searchCalls([
      searchLog('cut', 1000, [{ type: 'tool_call', name: 'web_search', args: { query: '被截断了' } }])
    ])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].status, 'failed')
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

  /* --------------------------- IPC 边界 --------------------------- */
  console.log('\nIPC 边界（reactive 代理拍平）')

  // structuredClone 用的是和 contextBridge 同一套结构化克隆算法，
  // 所以这里能不开 Electron 就复现「点了没反应」那个失败。
  const cloneable = (v: unknown): boolean => {
    try {
      structuredClone(v)
      return true
    } catch {
      return false
    }
  }

  await check('reactive 代理直接递过去会被结构化克隆拒收（这就是那个 bug）', () => {
    const store = ref({ software_scan_dirs: ['D:\\Software'] })
    assert.equal(cloneable(store.value.software_scan_dirs), false, '代理竟然能克隆？那这个护栏就没意义了')
    const item = reactive({ tags: ['t'] })
    assert.equal(cloneable({ tags: item.tags }), false, '嵌在对象里的代理同样过不去')
  })

  await check('plain() 拍平之后能过克隆，且值不变', () => {
    const store = ref({ software_scan_dirs: ['D:\\Software\\1.system', 'E:\\Tools'] })
    const flat = plain(store.value.software_scan_dirs)
    assert.ok(cloneable(flat), 'plain() 之后还是克隆不了，护栏失效')
    assert.deepEqual(flat, ['D:\\Software\\1.system', 'E:\\Tools'])

    const item = reactive({ tags: ['a', 'b'] })
    assert.ok(cloneable(plain({ tags: item.tags })), '嵌套代理没被拍平')
  })

  await check('plain(undefined) 保持 undefined —— ai.complete() 不传 ids 时靠这个', () => {
    assert.equal(plain(undefined), undefined)
  })
}
export async function migrationSection(): Promise<void> {


  /* ------------------------- 并发收尾：latest-wins 令牌 ------------------------- */

  console.log('\n并发收尾 · latest-wins 令牌')

  // ponytail: 这两条验的是 createLatestGuard 本身，加一段与 composable 同构的手写骨架。
  // 天花板：谁把 useAI / software store 里的 isCurrent 判断删掉，这两条照样绿 ——
  // composable 依赖 window.baoyi，在 Node 里跑不起来。要真正盯住调用点，
  // 得给 window.baoyi 做一层假实现再 import 那几个模块，代价比现在这条大得多。

  // 可取消任务的场景（useAI / useScan）：cancel 不再同步清 running，旧轮的 IPC
  // 返回晚于新轮的 begin() 才到。收尾只有 isCurrent 才许清状态 —— 这一条守的
  // 就是「cancel 之后立刻点第二轮」那个最容易踩的时刻。
  await check('过期轮次的 finally 不清掉还在跑的新一轮', async () => {
    const rounds = createLatestGuard()
    let running = false
    // complete 的骨架：begin 领号，收尾只在当值时清 running（与 composable 相同）
    const complete = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        running = true
        const round = rounds.begin()
        setTimeout(() => {
          if (rounds.isCurrent(round)) running = false
          resolve()
        }, ms)
      })

    const stale = complete(30) // 第一轮，收尾慢
    await sleep(10)
    void complete(60) // cancel 之后用户立刻点出的第二轮
    await stale // 第一轮此刻才收尾
    assert.ok(running, '第一轮已过期，不许把第二轮的 running 清掉')
    await sleep(70)
    assert.ok(!running, '第二轮自己收尾时该正常清掉 running')
  })

  // 列表查询的场景（software store 的 load）：先点一个响应快的，又点了一个慢的，
  // 旧响应先回来时新查询还在路上 —— 过期收尾必须两样都不碰。
  await check('晚到的旧响应不覆盖新结果，也不清掉新一轮的 loading', async () => {
    const rounds = createLatestGuard()
    let items: string | null = null
    let loading = false
    const load = (ms: number, group: string): Promise<void> =>
      new Promise((resolve) => {
        loading = true
        const round = rounds.begin()
        setTimeout(() => {
          // 与 store.load 相同的收尾：只在当值时写结果、清 loading
          if (rounds.isCurrent(round)) {
            items = group
            loading = false
          }
          resolve()
        }, ms)
      })

    const stale = load(30, '旧分组') // 先点了一个响应快的
    await sleep(10)
    void load(50, '新分组') // 又点了一个慢的，此刻还在路上
    await stale // 旧响应在新一轮开始之后才回来
    assert.equal(items, null, '过期响应不许覆盖状态')
    assert.ok(loading, '第二个查询还在跑，loading 必须还挂着')
    await sleep(55)
    assert.equal(items, '新分组', '当值的响应正常落地')
    assert.ok(!loading, '新轮自己的收尾清掉 loading')
  })

  /* --------------------------- 库迁移：0.4 -> 0.5 --------------------------- */

  console.log('\n库迁移 · 0.4 -> 0.5 拆总表')

  // 用 node:sqlite 驱动 electron/services/schema.ts —— 和应用跑的是同一份代码。
  // better-sqlite3 按 Electron ABI 编译，纯 node 载不进来，所以这里换个驱动。
  // 迁移是全项目唯一会改写用户几个月真实数据的一段，没有用例兜着不敢动。

  /** 造一张 0.4 形状的 software 宽表，外加分类、暂存区和版本号 */
  function makeV4Db(): InstanceType<typeof DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(`
      CREATE TABLE software (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        exe_path TEXT NOT NULL UNIQUE, icon_path TEXT, file_name TEXT NOT NULL,
        file_description TEXT DEFAULT '', company TEXT DEFAULT '', version TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0, source_dir TEXT DEFAULT '',
        name_zh TEXT DEFAULT '', name_en TEXT DEFAULT '', summary TEXT DEFAULT '',
        description TEXT DEFAULT '', category TEXT DEFAULT '其他', tags TEXT DEFAULT '[]',
        official_url TEXT DEFAULT '', ai_status TEXT DEFAULT 'pending', launchers TEXT DEFAULT '[]',
        why_choose TEXT DEFAULT '', use_cases TEXT DEFAULT '', notes TEXT DEFAULT '',
        alternatives TEXT DEFAULT '[]', mastery_level TEXT DEFAULT 'new',
        last_used_at INTEGER DEFAULT 0, use_count INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0,
        external_active_at INTEGER DEFAULT 0,
        is_portable INTEGER DEFAULT NULL, move_risk TEXT DEFAULT 'unknown', link_target TEXT DEFAULT ''
      );
      CREATE TABLE categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        icon TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const ins = d.prepare(
      `INSERT INTO software (id, created_at, updated_at, exe_path, file_name, name_zh,
         category, tags, notes, use_count, mastery_level, is_portable, move_risk, link_target,
         company, version, file_description, launchers)
       VALUES (?, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // 三态各来一条：判定为绿色 / 判定为不是 / 还没判断过
    ins.run('a', 'C:\\T\\a.exe', 'a.exe', '甲', '开发', '["x"]', '我的备注', 7, 'expert',
      1, 'safe', '', 'AcmeCo', '1.2', 'A 工具', '[{"path":"C:\\\\T\\\\a.exe","is_default":true}]')
    ins.run('b', 'C:\\T\\b.exe', 'b.exe', '乙', '我的自建分类', '[]', '', 0, 'new',
      0, 'risky', 'D:\\real\\b', '', '', '', '[]')
    ins.run('c', 'C:\\T\\c.exe', 'c.exe', '丙', '其他', '[]', '', 0, 'new',
      null, 'unknown', '', '', '', '', '[]')
    // 用户自建分类 + 内置的一条，版本号停在 4
    d.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)').run('u1', '我的自建分类', 9)
    d.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)').run('b1', '开发', 1)
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('_schema', '4')
    return d
  }

  await check('4 -> 5 迁完，用户自建的分类必须还在', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    const names = (d.prepare('SELECT name FROM categories').all() as any[]).map((r) => r.name)
    // 这一条就是 rebuildCategories 那颗雷：闸门写成「版本号小于当前」的话，
    // 4 -> 5 会再跑一次 DELETE FROM categories，自建分类当场没
    assert.ok(names.includes('我的自建分类'), `自建分类被清了，现有：${names.join(',')}`)
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    d.close()
  })

  await check('4 -> 5 迁完，条目一条不少且能从 software 视图读回来', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 3)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM software_meta').get() as any).n, 3)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM software').get() as any).n, 3)
    assert.equal(objectType(d as any, 'software'), 'view', 'software 该变成视图')
    assert.equal(objectType(d as any, 'software_legacy_v4'), 'table', '老表该改名留着')
    d.close()
  })

  await check('is_portable 的三态穿过迁移不变形', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    const rows = d.prepare('SELECT id, is_portable FROM software ORDER BY id').all() as any[]
    assert.equal(rows[0].is_portable, 1, '判定为绿色的该是 1')
    assert.equal(rows[1].is_portable, 0, '判定为不是的该是 0')
    // 这一条是整段迁移最要命的地方：null 被压成 0，整理时就会把「还没判断过」
    // 当成「判断为不可搬」，或者反过来 —— 见 schema.ts 里 software_meta 的注释
    assert.equal(rows[2].is_portable, null, '还没判断过的必须仍是 NULL')
    d.close()
  })

  await check('视图把两张表拼回原来的字段，用户数据一个不丢', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    const a = d.prepare('SELECT * FROM software WHERE id = ?').get('a') as any
    assert.equal(a.exe_path, 'C:\\T\\a.exe', 'path 要以 exe_path 的名字露出来')
    assert.equal(a.notes, '我的备注')
    assert.equal(a.use_count, 7)
    assert.equal(a.mastery_level, 'expert')
    assert.equal(a.company, 'AcmeCo')
    assert.equal(a.version, '1.2')
    assert.equal(a.file_description, 'A 工具')
    assert.equal(a.move_risk, 'safe')
    assert.equal(JSON.parse(a.tags)[0], 'x')
    const b = d.prepare('SELECT * FROM software WHERE id = ?').get('b') as any
    assert.equal(b.link_target, 'D:\\real\\b', 'junction 的指向不能丢，丢了就撤销不回去')
    d.close()
  })

  await check('迁移是幂等的：再跑一遍不出错也不重复搬', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    initSchema(d as any, KINDS)
    initSchema(d as any, KINDS)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 3)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM software_meta').get() as any).n, 3)
    d.close()
  })

  await check('0.1 的老库（缺后来那些列）能一路迁到 5', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    // 0.1 只有这些列：没有 source_dir / launchers / external_active_at / 0.3 的三列
    d.exec(`
      CREATE TABLE software (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        exe_path TEXT NOT NULL UNIQUE, icon_path TEXT, file_name TEXT NOT NULL,
        file_description TEXT DEFAULT '', company TEXT DEFAULT '', version TEXT DEFAULT '',
        file_size INTEGER DEFAULT 0, name_zh TEXT DEFAULT '', name_en TEXT DEFAULT '',
        summary TEXT DEFAULT '', description TEXT DEFAULT '', category TEXT DEFAULT '效率工具',
        tags TEXT DEFAULT '[]', official_url TEXT DEFAULT '', ai_status TEXT DEFAULT 'pending',
        why_choose TEXT DEFAULT '', use_cases TEXT DEFAULT '', notes TEXT DEFAULT '',
        alternatives TEXT DEFAULT '[]', mastery_level TEXT DEFAULT 'new',
        last_used_at INTEGER DEFAULT 0, use_count INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0
      );
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '', sort_order INTEGER DEFAULT 0);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    d.prepare(
      `INSERT INTO software (id, created_at, updated_at, exe_path, file_name, name_zh, notes)
       VALUES (?, 1, 2, ?, ?, ?, ?)`
    ).run('old', 'C:\\T\\old.exe', 'old.exe', '老条目', '五年前写的备注')
    initSchema(d as any, KINDS)
    const row = d.prepare('SELECT * FROM software WHERE id = ?').get('old') as any
    assert.equal(row.notes, '五年前写的备注', '老用户的备注一个字都不能丢')
    assert.equal(row.is_portable, null, '没判断过就该是 NULL')
    assert.equal(row.move_risk, 'unknown')
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    d.close()
  })

  await check('总表的路径全局唯一：两个 kind 抢同一个目录会被挡下', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const ins = d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name)
       VALUES (?, ?, 1, 2, ?, ?)`
    )
    ins.run('r1', 'software', 'D:\\Games\\X', 'X')
    // 磁盘只有一块：同一个目录被软件模块和游戏模块各认领一次，
    // 整理模块搬动它的时候另一边的记录会当场失效
    assert.throws(() => ins.run('r2', 'game', 'D:\\Games\\X', 'X'), /UNIQUE|constraint/i)
    d.close()
  })

  await check('删条目时 software_meta 跟着走，不留孤儿', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    d.prepare('DELETE FROM resource WHERE id = ?').run('a')
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM software_meta').get() as any).n, 2)
    d.close()
  })

  await check('全新的空库能一次建起来 —— 首次启动走的就是这条路', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    // 空库里连 settings 表都没有。initSchema 如果在建表之前去读版本号，
    // 这里会抛 no such table: settings —— 表现是新用户第一次打开就崩在建库
    initSchema(d as any, KINDS)
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    assert.equal(objectType(d as any, 'software'), 'view')
    // 分类来自品类模块交上来的那份，公共层没写死
    const n = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    assert.ok(n > 0, '内置分类该被装上')
    d.close()
  })

  await check('公共层不认识软件：TABLES_SQL 里没有任何软件私有的东西', () => {
    // 这一条守的是分层本身。软件的表和视图归 kinds/software/schema.ts，
    // 谁哪天图省事把它们挪回公共层，这里就会红 —— 那正是要拦的那一步。
    // 只看真正的 DDL，注释里提一句「那张表归软件模块管」是说明不是耦合
    const ddl = TABLES_SQL.replace(/--[^\n]*/g, '')
    for (const leak of ['software_meta', 'is_portable', 'move_risk', 'link_target']) {
      assert.ok(!ddl.includes(leak), `公共层的 TABLES_SQL 里出现了软件私有的 ${leak}`)
    }
    // 反过来，品类模块必须自己带齐
    assert.ok(softwareKind.schema.tables.includes('software_meta'))
    assert.ok(softwareKind.schema.view?.includes('is_portable'))
    assert.equal(softwareKind.kind, 'software')
    assert.ok(softwareKind.defaultCategories.length > 0, '分类要由模块自己提供')
  })

  /* --------------------------- 库迁移：0.5 -> 0.6 --------------------------- */

  console.log('\n库迁移 · 0.5 -> 0.6 分类标签按品类隔开')

  /** 造一张 0.5 形状的库：resource + software_meta + 全局单表的 categories / tags */
  function makeV5Db(): InstanceType<typeof DatabaseSync> {
    const d = makeV4Db()
    initSchema(d as any, [softwareKind])
    // 把版本号按回 5，并把 0.6 的痕迹抹掉，装成一个真正停在 0.5 的库
    d.prepare(`UPDATE settings SET value = '5' WHERE key = '_schema'`).run()
    return d
  }

  await check('5 -> 6 迁完，软件的分类和标签一条不少，且都归到 software 名下', () => {
    const d = makeV5Db()
    const before = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    initSchema(d as any, KINDS)

    const soft = d.prepare(`SELECT name FROM categories WHERE kind = 'software'`).all() as any[]
    assert.equal(soft.length, before, `软件分类条数变了：${before} -> ${soft.length}`)
    assert.ok(soft.some((c) => c.name === '我的自建分类'), '自建分类必须还在，且还归软件')

    // 名单从 KINDS 推，不写死品类名 —— 写死的话每加一个品类这条就假失败一次，
    // 而它真正要守的是「有标签落在所有已注册品类之外」
    const known = KINDS.map((k) => k.kind)
    const placeholders = known.map(() => '?').join(',')
    const orphan = (
      d
        .prepare(`SELECT COUNT(*) AS n FROM tags WHERE kind NOT IN (${placeholders})`)
        .get(...known) as any
    ).n
    assert.equal(orphan, 0, `不该有落在 ${known.join('/')} 之外的标签`)
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    d.close()
  })

  await check('游戏的分类和标签装进去了，而且不会串进软件那一侧', () => {
    const d = makeV5Db()
    initSchema(d as any, KINDS)

    const gameCats = (d.prepare(`SELECT name FROM categories WHERE kind = 'game'`).all() as any[])
      .map((c) => c.name)
    assert.ok(gameCats.includes('RPG'), `游戏分类没装上：${gameCats.join(',')}`)

    // 这一条守的就是加 kind 的理由：RPG / 魂系混进软件的池子，
    // 软件识别 prompt 的分类菜单里就会出现 RPG，agent 会拿它去归类一个调试器
    const softCats = (d.prepare(`SELECT name FROM categories WHERE kind = 'software'`).all() as any[])
      .map((c) => c.name)
    assert.ok(!softCats.includes('RPG'), 'RPG 串进软件分类了')
    const softTags = (d.prepare(`SELECT name FROM tags WHERE kind = 'software'`).all() as any[])
      .map((t) => t.name)
    assert.ok(!softTags.includes('魂系'), '魂系串进软件标签池了')
    assert.ok(softTags.includes('便携'), '软件自己的内置标签该在')
    const gameTags = (d.prepare(`SELECT name FROM tags WHERE kind = 'game'`).all() as any[])
      .map((t) => t.name)
    assert.ok(gameTags.includes('魂系'), '游戏标签没装上')
    d.close()
  })

  await check('同一个词能在两个品类下各存一份 —— 唯一键是 (kind, name)', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const ins = d.prepare(`INSERT INTO tags (kind, name, source, created_at) VALUES (?, ?, 'user', 1)`)
    ins.run('software', '横跨两界')
    ins.run('game', '横跨两界')
    assert.equal((d.prepare(`SELECT COUNT(*) AS n FROM tags WHERE name = '横跨两界'`).get() as any).n, 2)
    // 同一个品类下仍然不许重复
    assert.throws(() => ins.run('game', '横跨两界'), /UNIQUE|constraint/i)
    d.close()
  })

  await check('标签 id 穿过迁移不变 —— 设置页正开着的那些按钮不能失效', () => {
    const d = makeV5Db()
    const before = new Map(
      (d.prepare('SELECT id, name FROM tags').all() as any[]).map((t) => [t.name, t.id])
    )
    assert.ok(before.size > 0, '前置条件：0.5 的库里该有内置标签')
    initSchema(d as any, KINDS)
    for (const [name, id] of before) {
      const now = d.prepare(`SELECT id FROM tags WHERE kind = 'software' AND name = ?`).get(name) as any
      assert.equal(now?.id, id, `标签「${name}」的 id 变了：${id} -> ${now?.id}`)
    }
    d.close()
  })

  await check('5 -> 6 是幂等的：再跑两遍不重复装、不重复建表', () => {
    const d = makeV5Db()
    initSchema(d as any, KINDS)
    const cats = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    const tags = (d.prepare('SELECT COUNT(*) AS n FROM tags').get() as any).n
    initSchema(d as any, KINDS)
    initSchema(d as any, KINDS)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n, cats)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM tags').get() as any).n, tags)
    d.close()
  })

  await check('0.4 的老库能一路迁到当前版本，自建分类照样还在', () => {
    const d = makeV4Db()
    initSchema(d as any, KINDS)
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 3)
    // 0.4 -> 6 会走 rebuildCategories（from < 4 不成立，这里 from = 4，所以不走）
    const names = (d.prepare(`SELECT name FROM categories WHERE kind = 'software'`).all() as any[])
      .map((c) => c.name)
    assert.ok(names.includes('我的自建分类'), `自建分类被清了：${names.join(',')}`)
    d.close()
  })

  await check('game_meta / save_backups / game 视图都建起来了', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    assert.equal(objectType(d as any, 'game_meta'), 'table')
    assert.equal(objectType(d as any, 'save_backups'), 'table')
    assert.equal(objectType(d as any, 'game'), 'view')
    d.close()
  })

  await check('play_status 只收四个合法值，写错一个当场被挡下', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name)
       VALUES ('g1', 'game', 1, 2, 'D:\\Games\\艾尔登法环', '艾尔登法环')`
    ).run()
    const ins = d.prepare(`INSERT INTO game_meta (resource_id, play_status) VALUES (?, ?)`)
    ins.run('g1', 'playing')
    // 拼错一个状态如果被静默收下，侧边栏会多出一个谁也点不到的幽灵分组
    assert.throws(() => ins.run('g1', 'playng'), /CHECK|constraint/i)
    d.close()
  })

  await check('删游戏时 game_meta 跟着走，但备份记录留着 —— 那些文件还在磁盘上', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name)
       VALUES ('g1', 'game', 1, 2, 'D:\\Games\\X', 'X')`
    ).run()
    d.prepare(`INSERT INTO game_meta (resource_id) VALUES ('g1')`).run()
    d.prepare(
      `INSERT INTO save_backups (id, resource_id, save_path, backup_dir, created_at)
       VALUES ('b1', 'g1', 'C:\\S', 'E:\\bak\\X\\save_1', 1)`
    ).run()

    d.prepare('DELETE FROM resource WHERE id = ?').run('g1')
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM game_meta').get() as any).n, 0, 'meta 该跟着删')
    // 级联删掉记录不会删掉 E:\bak 下那份拷贝，只会让用户再也找不到它
    assert.equal(
      (d.prepare('SELECT COUNT(*) AS n FROM save_backups').get() as any).n,
      1,
      '备份记录不该被级联删掉'
    )
    d.close()
  })

  await check('game 视图把两张表拼起来，缺 meta 的游戏也要露面', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh, category)
       VALUES ('g1', 'game', 1, 2, 'D:\\G\\a', 'a.exe', '甲游戏', 'RPG')`
    ).run()
    d.prepare(
      `INSERT INTO game_meta (resource_id, play_status, total_playtime_sec, save_paths)
       VALUES ('g1', 'completed', 314159, '[{"path":"C:\\\\S","verified_at":9}]')`
    ).run()
    // 只有 resource 没有 meta 的那条：不该从库里凭空消失
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh)
       VALUES ('g2', 'game', 1, 2, 'D:\\G\\b', 'b.exe', '乙游戏')`
    ).run()

    const rows = d.prepare('SELECT * FROM game ORDER BY id').all() as any[]
    assert.equal(rows.length, 2, `LEFT JOIN 该带出两条，实际 ${rows.length}`)
    assert.equal(rows[0].play_status, 'completed')
    assert.equal(rows[0].total_playtime_sec, 314159)
    assert.equal(JSON.parse(rows[0].save_paths)[0].path, 'C:\\S')
    assert.equal(rows[1].play_status, 'unplayed', '缺 meta 时要落到默认值')
    assert.equal(rows[1].total_playtime_sec, 0)

    // 软件视图不该看见游戏，反过来也一样
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM software').get() as any).n, 0)
    d.close()
  })

  await check('公共层不认识游戏：TABLES_SQL 里没有任何游戏私有的东西', () => {
    const ddl = TABLES_SQL.replace(/--[^\n]*/g, '')
    for (const leak of ['game_meta', 'save_backups', 'play_status', 'cover_path']) {
      assert.ok(!ddl.includes(leak), `公共层的 TABLES_SQL 里出现了游戏私有的 ${leak}`)
    }
    assert.ok(gameKind.schema.tables.includes('game_meta'))
    assert.ok(gameKind.schema.tables.includes('save_backups'))
    assert.ok(gameKind.schema.view?.includes('play_status'))
    assert.equal(gameKind.kind, 'game')
    assert.ok(gameKind.defaultCategories.length > 0, '分类要由模块自己提供')
    assert.ok(gameKind.defaultTags.length > 0, '标签池也要由模块自己提供')
  })

  // 遍历 KINDS 而不是写死两个品类：0.7 加视频时这一条原本会漏掉新品类，
  // 而它守的恰恰是「加品类时词表撞车」——最容易在加第三个品类时发生的事
  await check('各品类的内置词表两两不重叠 —— 重叠就说明有一边归错了', () => {
    for (const a of KINDS) {
      for (const b of KINDS) {
        if (a.kind >= b.kind) continue
        const aCats = new Set(a.defaultCategories.map((c) => c.name))
        // 「其他」是各品类共有的兜底格子，其余不该撞
        const shared = b.defaultCategories.map((c) => c.name).filter((n) => aCats.has(n))
        assert.deepEqual(
          shared,
          a.kind === 'image' || b.kind === 'image' || !a.defaultCategories.length || !b.defaultCategories.length ? [] : ['其他'],
          `${a.kind} 和 ${b.kind} 除了「其他」不该有共有分类，实际：${shared.join(',')}`
        )
        const aTags = new Set(a.defaultTags)
        const dupTags = b.defaultTags.filter((t) => aTags.has(t))
        assert.deepEqual(dupTags, [], `${a.kind} 和 ${b.kind} 内置标签重叠：${dupTags.join(',')}`)
      }
    }
    // id 全局唯一：categories 的主键是 id，撞了会 INSERT OR REPLACE 把对方顶掉
    const ids = KINDS.flatMap((k) => k.defaultCategories.map((c) => c.id))
    assert.equal(new Set(ids).size, ids.length, `分类 id 撞了：${ids.join(',')}`)
    // 品类 id 本身也得唯一 —— 两个模块同名的话，kindByName 只找得到第一个，
    // 而另一个的私有表会建在同一个 kind 值下，两边的条目从此互相污染
    const kinds = KINDS.map((k) => k.kind)
    assert.equal(new Set(kinds).size, kinds.length, `品类 id 撞了：${kinds.join(',')}`)
  })
}


/* ==================== 出站代理 · v0.8 ==================== */

/**
 * 只验 `normalizeProxyRules` 这一个纯函数。
 *
 * 代理这条链路真正的风险**不在这儿** —— 它在「包到底从哪个网络栈出去」，
 * 而那是 `scripts/verify-proxy.cjs` 的活（要真起 Electron、真发请求、比对出口
 * IP）。这一节只保证用户填的那串被规范化成 Chromium 认得的形状，别把
 * 「配了没生效」的原因又多加一种。
 */
export async function proxySection(): Promise<void> {
  console.log('\n出站代理 · v0.8（纯函数；接线由 verify-proxy.cjs 验）')

  await check('空输入解析为 direct', () => {
    assert.deepEqual(parseProxyInput(''), { mode: 'direct' })
  })

  await check('system:// 解析为 system', () => {
    assert.deepEqual(parseProxyInput('system://'), { mode: 'system' })
  })

  await check('HTTP 地址拆出主机和端口', () => {
    assert.deepEqual(parseProxyInput('http://127.0.0.1:8080'), {
      mode: 'http', host: '127.0.0.1', port: 8080
    })
  })

  await check('SOCKS5 地址拆出主机和端口', () => {
    assert.deepEqual(parseProxyInput('socks5://127.0.0.1:10808'), {
      mode: 'socks5', host: '127.0.0.1', port: 10808
    })
  })

  await check('裸 host:port 仍按 HTTP 兼容', () => {
    assert.deepEqual(parseProxyInput(' proxy.local:3128 '), {
      mode: 'http', host: 'proxy.local', port: 3128
    })
  })

  await check('非法端口给出可读错误', () => {
    assert.throws(() => parseProxyInput('http://127.0.0.1:70000'), /端口/)
  })

  await check('Electron 配置映射正确', () => {
    assert.deepEqual(toElectronProxyConfig({ mode: 'direct' }), { mode: 'direct' })
    assert.deepEqual(toElectronProxyConfig({ mode: 'system' }), { mode: 'system' })
    assert.deepEqual(toElectronProxyConfig({ mode: 'http', host: 'h', port: 80 }), {
      proxyRules: 'http://h:80'
    })
    assert.deepEqual(toElectronProxyConfig({ mode: 'socks5', host: 'h', port: 1080 }), {
      proxyRules: 'socks5://h:1080'
    })
    assert.equal(serializeProxyInput({ mode: 'system' }), 'system://')
  })

  await check('代理模式决定 Hanime fetch 网络栈', () => {
    assert.equal(usesChromiumFetch({ mode: 'direct' }), true)
    assert.equal(usesChromiumFetch({ mode: 'system' }), true)
    assert.equal(usesChromiumFetch({ mode: 'http', host: 'h', port: 80 }), true)
    assert.equal(usesChromiumFetch({ mode: 'socks5', host: 'h', port: 1080 }), true)
  })

  await check('Hanime 内置 Hosts 覆盖四个镜像且不扩大范围', () => {
    const rules = buildHanimeHostResolverRules()
    assert.ok(rules.length > 0)
    for (const host of HANIME_HOSTS) {
      assert.match(rules, new RegExp(`MAP ${host.replaceAll('.', '\\.')} `))
      assert.equal(isHanimeHost(host), true)
    }
    assert.equal(isHanimeHost('api.themoviedb.org'), false)
    assert.equal(isHanimeHost('hanime1.me.evil.example'), false)
    assert.ok(rules.includes(HANIME_CLOUDFLARE_IPS[0]))
  })

  await check('Hanime Hosts 规则使用 Chromium 的逗号分隔 MAP 语法', () => {
    const rules = buildHanimeHostResolverRules(['hanime1.me', 'hanime1.com'], '192.0.2.1')
    assert.equal(rules, 'MAP hanime1.me 192.0.2.1, MAP hanime1.com 192.0.2.1')
    assert.equal(buildHanimeHostResolverRules([], '192.0.2.1'), '')
    assert.equal(buildHanimeHostResolverRules(['hanime1.me'], ''), '')
  })

  await check('Hanime Hosts 状态可供设置页展示', () => {
    const status = getHanimeHostsStatus()
    assert.equal(status.enabled, true)
    assert.deepEqual(status.hosts, [...HANIME_HOSTS, 'abre-videos.youjizz.com'])
    assert.deepEqual(status.ips, [...HANIME_CLOUDFLARE_IPS])
    assert.equal(status.startupIp, HANIME_CLOUDFLARE_IPS[0])
    assert.ok(status.resolverRules.includes('MAP hanime1.me'))
    const off = getHanimeHostsStatus({ enabled: false, activeIp: '1.2.3.4' })
    assert.equal(off.enabled, false)
    assert.equal(off.resolverRules, '', '关掉后设置页不该再显示一条其实没生效的规则')
    assert.equal(off.startupIp, '')
    assert.equal(off.activeIp, '')
  })

  await check('启动地址：上次通了的优先，不在池里就退回第一个', () => {
    assert.equal(pickStartupIp(), HANIME_CLOUDFLARE_IPS[0])
    assert.equal(pickStartupIp(''), HANIME_CLOUDFLARE_IPS[0])
    assert.equal(pickStartupIp(HANIME_CLOUDFLARE_IPS[2]), HANIME_CLOUDFLARE_IPS[2])
    assert.equal(pickStartupIp('192.0.2.1'), HANIME_CLOUDFLARE_IPS[0], '设置里的地址不在池里（池子改过）就忽略')
    assert.equal(pickStartupIp(undefined as unknown as string), HANIME_CLOUDFLARE_IPS[0], '老库没这个键')
    const status = getHanimeHostsStatus({ startupIp: HANIME_CLOUDFLARE_IPS[1] })
    assert.equal(status.startupIp, HANIME_CLOUDFLARE_IPS[1])
    assert.ok(status.resolverRules.includes(HANIME_CLOUDFLARE_IPS[1]), '状态页显示的规则要和真正写进 Chromium 的一致')
    assert.ok(!status.resolverRules.includes(HANIME_CLOUDFLARE_IPS[0]))
  })

  await check('验证窗口：连不上就立刻结束，被顶掉的导航和 HTTP 错误不算', () => {
    assert.equal(isUnreachableLoadError(-102, 'ERR_CONNECTION_REFUSED'), true)
    assert.equal(isUnreachableLoadError(-7, 'ERR_TIMED_OUT'), true)
    assert.equal(isUnreachableLoadError(-105, 'ERR_NAME_NOT_RESOLVED'), true)
    assert.equal(isUnreachableLoadError(-130, 'ERR_PROXY_CONNECTION_FAILED'), true)
    assert.equal(isUnreachableLoadError(-3, 'ERR_ABORTED'), false, '被新导航顶掉不是失败')
    assert.equal(isUnreachableLoadError(-324, 'ERR_EMPTY_RESPONSE'), false, '有回应就交给内容判断')
    assert.equal(isUnreachableLoadError(-501, 'ERR_INSECURE_RESPONSE'), false)
    assert.equal(isUnreachableLoadError(-102, ''), false, '没有描述就不猜')
  })

  await check('地址池按 Han1meViewer HDns 的五个 IPv4，顺序即尝试顺序', () => {
    assert.deepEqual([...HANIME_CLOUDFLARE_IPS], ['172.64.229.154', '104.25.254.167', '172.67.75.184', '104.21.7.20', '172.67.187.141'])
    assert.equal(new Set(HANIME_CLOUDFLARE_IPS).size, HANIME_CLOUDFLARE_IPS.length)
  })

  await check('运行时回退顺序：上次通的排最前，Chromium 刚失败的启动地址不再试', () => {
    const pool = ['a', 'b', 'c', 'd']
    assert.deepEqual(orderedHanimeIps('', ['a'], pool), ['b', 'c', 'd'])
    assert.deepEqual(orderedHanimeIps('c', ['a'], pool), ['c', 'b', 'd'])
    assert.deepEqual(orderedHanimeIps('a', ['a'], pool), ['b', 'c', 'd'], '被排除的地址即使是上次通的也不试')
    assert.deepEqual(orderedHanimeIps('zzz', [], pool), ['a', 'b', 'c', 'd'], '不在池里的偏好地址忽略')
    assert.deepEqual(orderedHanimeIps(), [...HANIME_CLOUDFLARE_IPS])
  })

  await check('只有线路不通才换 IP；有回应的 403 / 挑战页不算', () => {
    assert.equal(isConnectionFailure(new TypeError('fetch failed')), true)
    assert.equal(isConnectionFailure(new Error('net::ERR_CONNECTION_TIMED_OUT')), true)
    assert.equal(isConnectionFailure(new Error('net::ERR_CONNECTION_RESET')), true)
    assert.equal(isConnectionFailure(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' })), true)
    assert.equal(isConnectionFailure(Object.assign(new Error('连接 1.2.3.4 超时'), { code: 'ETIMEDOUT' })), true, '直连模块的超时错误靠 code 被认出')
    assert.equal(isConnectionFailure(Object.assign(new Error('x'), { name: 'TimeoutError' })), true)
    assert.equal(isConnectionFailure(new Error('net::ERR_ABORTED')), false, '用户取消不是线路问题')
    assert.equal(isConnectionFailure(new Error('hanime 拒绝了这次请求（HTTP 403）')), false)
    assert.equal(isConnectionFailure(null), false)
  })

  await check('代理只绑定 Hanime 专用 session', () => {
    const src = fs.readFileSync(new URL('../../electron/services/proxy.ts', import.meta.url), 'utf-8')
    assert.match(src, /fromPartition\(['"]persist:hanime-network['"]\)/)
    assert.doesNotMatch(src, /defaultSession\.setProxy/)
    assert.match(src, /looksLikeChallenge/)
  })

  await check('Hanime 远端封面复用页面的 fetch 注入', async () => {
    let called = 0
    const original = globalThis.fetch
    try {
      ;(globalThis as any).fetch = async () => {
        called += 1
        return new Response('ok')
      }
      await fetchHanimeResource('https://hanime1.me/uploads/x.jpg')
      assert.equal(called, 1)
    } finally {
      ;(globalThis as any).fetch = original
    }
  })

  await check('空串和纯空白都当直连', () => {
    assert.equal(normalizeProxyRules(''), '')
    assert.equal(normalizeProxyRules('   '), '')
    assert.equal(normalizeProxyRules('\t\n'), '')
    // undefined / null 也不能炸 —— 老库里这个键可能根本不存在
    assert.equal(normalizeProxyRules(undefined as any), '')
    assert.equal(normalizeProxyRules(null as any), '')
  })

  await check('裸 host:port 补成 http://（对齐 --proxy-server 的默认）', () => {
    assert.equal(normalizeProxyRules('127.0.0.1:10808'), 'http://127.0.0.1:10808')
    assert.equal(normalizeProxyRules('  127.0.0.1:10808  '), 'http://127.0.0.1:10808')
  })

  await check('写了协议的原样保留，不替用户改主意', () => {
    assert.equal(normalizeProxyRules('socks5://127.0.0.1:10808'), 'socks5://127.0.0.1:10808')
    assert.equal(normalizeProxyRules('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
    assert.equal(normalizeProxyRules('socks4://10.0.0.1:1080'), 'socks4://10.0.0.1:1080')
  })

  await check('Chromium 那套多规则写法不被拆坏', () => {
    // `scheme=proxy` 和分号分隔都是 Chromium proxyRules 的合法写法。
    // 含 `=` 时不补协议 —— 补了会变成 `http://https=...` 这种废话
    const multi = 'https=socks5://127.0.0.1:10808;http=http://127.0.0.1:8080'
    assert.equal(normalizeProxyRules(multi), multi)
    assert.equal(normalizeProxyRules('direct://'), 'direct://')
  })

  await check('不自己校验端口和协议名 —— 那是 Chromium 的活', () => {
    // 故意给几个不合法的：这里照样原样传下去，由 setProxy 去拒。
    // 在这儿重写一遍校验只会和 Chromium 的规则打架，且必然漏
    assert.equal(normalizeProxyRules('socks5://127.0.0.1:999999'), 'socks5://127.0.0.1:999999')
    assert.equal(normalizeProxyRules('nonsense://x'), 'nonsense://x')
  })
}


/* ==================== 绿色版判据 · v0.8 ==================== */

/**
 * `decidePortable` 这一个纯函数。真接线（`app.setPath` 到底改没改 userData）
 * 由 `verify-portable.cjs` 在真 Electron 下验。
 *
 * 这一节的重量全在**三条不该进绿色版模式的路**上：开发模式、没标记、目录不可写。
 * 三条里任何一条判错的后果都不是报错，而是**数据写到了意料之外的地方** ——
 * 开发时写进 node_modules（`npm ci` 会清掉）、装机版写到安装目录旁边
 * （卸载不带走）、只读介质上直接开不了库。
 */
export async function portableSection(): Promise<void> {
  console.log('\n绿色版判据 · v0.8（纯函数；接线由 verify-portable.cjs 验）')

  const join = (...p: string[]) => p.join('\\')
  const yes = () => true
  const no = () => false

  await check('开发模式一律不认标记 —— 否则数据会写进 node_modules', () => {
    // 开发时 process.execPath 指向 node_modules/electron/dist/electron.exe，
    // 真按它算数据就落在 node_modules 里，而 npm ci 会把那儿整个删掉
    const d = decidePortable(false, 'C:\\repo\\node_modules\\electron\\dist', yes, yes, join)
    assert.equal(d.portable, false)
    assert.ok(d.portable === false && d.reason.includes('开发模式'))
  })

  await check('打包了 + 有标记 + 可写 = 绿色版，数据落在 exe 旁边的 data', () => {
    const d = decidePortable(true, 'D:\\抱一', yes, yes, join)
    assert.equal(d.portable, true)
    assert.equal(d.portable === true && d.dataDir, 'D:\\抱一\\data')
  })

  await check('两个标记名都认（中文那个给人看，ASCII 那个防编码出岔）', () => {
    for (const marker of PORTABLE_MARKERS) {
      const exists = (p: string) => p === `D:\\抱一\\${marker}`
      const d = decidePortable(true, 'D:\\抱一', exists, yes, join)
      assert.equal(d.portable, true, `${marker} 没被认出来`)
    }
  })

  await check('没标记就是装机版 —— 数据留在 AppData', () => {
    const d = decidePortable(true, 'C:\\Program Files\\抱一', no, yes, join)
    assert.equal(d.portable, false)
    assert.ok(d.portable === false && d.reason.includes('没有标记'))
  })

  await check('有标记但目录不可写：退回默认目录，不硬来', () => {
    // 解压到 Program Files、或从只读介质跑。硬来的话开库抛 SQLITE_CANTOPEN，
    // 用户看到的是「应用打不开」，而真因是装的位置不对
    const d = decidePortable(true, 'C:\\Program Files\\抱一', yes, no, join)
    assert.equal(d.portable, false)
    assert.ok(d.portable === false && d.reason.includes('不可写'), d.portable === false ? d.reason : '')
    // 理由里要带上那个目录，否则用户没法知道该往哪儿看
    assert.ok(d.portable === false && d.reason.includes('C:\\Program Files\\抱一'))
  })

  await check('不可写的判断只在有标记时才做 —— 装机版不该被它影响', () => {
    // 没标记时 writable 返回什么都无所谓，结论都是「没有标记文件」。
    // 反过来写（先判可写）会让装机版在只读目录下报出一句和它无关的理由
    const d = decidePortable(true, 'C:\\Program Files\\抱一', no, no, join)
    assert.ok(d.portable === false && d.reason.includes('没有标记'))
  })

  /*
   * 这一条不验判据，验的是**别处有没有绕过它**。
   *
   * 绿色版能成立的全部前提是「所有数据路径都从 `app.getPath('userData')` 算」。
   * 哪天有人加第六个数据目录时直接拼了 `process.env.APPDATA`，绿色版就开始漏
   * 东西 —— 而漏法极安静：库、封面、海报跟着文件夹走了，那一样没走。表现是
   * 「整个文件夹拷到另一台机器，大部分正常，某一样是空的」，在开发机上永远
   * 看不见（两个位置都在同一台机器上，照样读得到）。
   *
   * 所以这里直接扫源文件。静态检查在这件事上比运行时断言强：运行时只能看见
   * 被调到的那几个函数，扫源文件能看见**所有**写法。
   */
  await check('没有第二处数据根 —— 所有数据目录都从 getPath(userData) 算', () => {
    const src = fs.readFileSync(
      new URL('../../electron/services/database.ts', import.meta.url),
      'utf-8'
    )
    // 硬拼环境变量是最可能的绕过方式
    for (const bad of ['process.env.APPDATA', 'process.env.LOCALAPPDATA', 'process.env.USERPROFILE']) {
      assert.ok(!src.includes(bad), `database.ts 里出现了 ${bad}，绿色版会从这儿漏数据`)
    }
    // 五个数据位置必须都在 getPath('userData') 上。数一下：少于 5 说明有人
    // 把某一处挪走了，这条断言就该重看（而不是把数字调小）
    const hits = src.match(/app\.getPath\(['"]userData['"]\)/g) ?? []
    assert.ok(
      hits.length >= 5,
      `database.ts 里只有 ${hits.length} 处 getPath('userData')，原本是 5 处（库/icons/covers/posters/save-backups）`
    )
  })

  await check('绿色版的重定向排在建锁和开库之前', () => {
    // 顺序是硬要求，且**错了不报错**：晚一步，单实例锁会先在旧 userData 里建出来、
    // createWindow 里那次 getSettings() 会顺手把库开在旧位置，结果是绿色版旁边
    // 一个空 data\、真数据还在 AppData。这种顺序约束没法用运行时断言表达，
    // 只能钉住源码里的相对位置
    const src = fs.readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf-8')
    const init = src.indexOf('initPortable()')
    const lock = src.indexOf('.requestSingleInstanceLock')
    const ready = src.indexOf('app.whenReady()')
    assert.ok(init > 0, 'main.ts 里没有 initPortable() —— 绿色版根本没接上')
    assert.ok(lock > 0 && init < lock, 'initPortable() 必须排在 requestSingleInstanceLock 之前')
    assert.ok(ready > 0 && init < ready, 'initPortable() 必须排在 whenReady 之前，不能挪进回调里')
  })

  await check('Hanime Hosts 规则排在 whenReady 之前', () => {
    const src = fs.readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf-8')
    const switchAt = src.indexOf("host-resolver-rules")
    const readyAt = src.indexOf('app.whenReady()')
    assert.ok(switchAt > 0, 'main.ts 没有 host-resolver-rules')
    assert.ok(readyAt > 0 && switchAt < readyAt, 'Hosts 规则必须在 whenReady 之前设置')
  })
}
