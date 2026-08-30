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
import { reactive, ref } from 'vue'
import {
  apiBase,
  parseModelList,
  runAgent,
  type AgentEvent,
  type AgentTool
} from '../electron/services/agent/loop.ts'
import { isInside, resolveInside } from '../electron/services/agent/paths.ts'
import {
  decodeText,
  isReadableName,
  looksBinary,
  readTextFile
} from '../electron/services/agent/files.ts'
import { readExternalActiveAt } from '../electron/services/activity.ts'
import { fillIdentifySystem, limitTags } from '../electron/kinds/software/prompts.ts'
import {
  BUILTIN_TAGS,
  DEFAULT_CATEGORIES,
  FALLBACK_CATEGORY,
  mapCategory
} from '../electron/services/taxonomy.ts'
import { planRoot, skippable } from '../electron/kinds/software/scanPlan.ts'
import {
  defaultAction,
  defaultFolder,
  nestedInside,
  rebase,
  sameVolume,
  sanitizeFolder,
  targetDir
} from '../electron/kinds/software/organize/plan.ts'
import {
  isLink,
  LINK_MARK,
  makeJunction,
  moveDir,
  removeJunction,
  writeLinkMark
} from '../electron/kinds/software/organize/fsops.ts'
import {
  activityOf,
  compareVersions,
  coverUrl as coverUrlOf,
  createLatestGuard,
  displayName,
  groupRounds,
  logToText,
  LINK_TYPE_LABEL,
  parseVersion,
  plain,
  searchCalls,
  subtitleName,
  versionOf
} from '../src/utils/index.ts'
import type { LinkedFile } from '../src/types/index.ts'
import { DatabaseSync } from 'node:sqlite'
import {
  SCHEMA_VERSION,
  TABLES_SQL,
  initSchema,
  objectType,
  schemaVersion
} from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { softwareKind } from '../electron/kinds/software/index.ts'
import { gameKind } from '../electron/kinds/game/index.ts'
import {
  expandSavePath,
  inspectDir,
  probeSave,
  saveRootOf,
  saveRoots,
  scanGameRoot
} from '../electron/kinds/game/scanner.ts'
import {
  deleteGame,
  gameCounts,
  gamesUnder,
  getGame,
  insertGame,
  listGames,
  updateGame,
  type GamePayload
} from '../electron/kinds/game/db.ts'
import { acceptSavePaths, limitGameTags } from '../electron/kinds/game/tools.ts'
import {
  candidatePrompt,
  ENGINE_SAVE_RULES,
  fillGameSystem
} from '../electron/kinds/game/prompts.ts'
import {
  addLinks,
  COVER_EXTS,
  coverFileName,
  coverSiblings,
  guessLinkType,
  hasLink,
  isCoverExt,
  LINK_TYPES,
  MAX_LABEL,
  MAX_LINKS,
  relabelLink,
  removeLink
} from '../electron/kinds/game/links.ts'
import {
  acceptImageUrl,
  candidatesFromSearch,
  cleanQuery,
  coverQueries,
  extFromContentType,
  finalizeCandidates,
  MAX_CANDIDATES,
  MAX_COVER_BYTES,
  pickSteamApps,
  steamCoverCandidates
} from '../electron/kinds/game/covers.ts'
import {
  imageSearchAvailable,
  imageSearchWhyNot
} from '../electron/services/searchService.ts'
import {
  backupFolder,
  createBackup,
  deleteBackup,
  gameFolder,
  listBackups,
  MANIFEST,
  overRetention,
  PAYLOAD,
  restoreBackup,
  restoreBlocked,
  stamp,
  type GameLike
} from '../electron/kinds/game/backup.ts'
import {
  expandTemplate,
  lookupSavePaths,
  normalizeGameName,
  truncateTemplate,
  type SaveDbHandle
} from '../electron/kinds/game/savedb.ts'
import {
  elapsedSeconds,
  endSession,
  MIN_SESSION_SEC
} from '../electron/kinds/game/session.ts'
import { isDriveRoot, nestedInside as nestedInsideShared } from '../electron/services/fstree.ts'
import {
  deleteVideo,
  deriveSeriesStatus,
  getVideo,
  insertVideo,
  listEpisodes,
  listVideos,
  nextEpisode,
  syncSeriesStatus,
  updateEpisode,
  updateVideo,
  videoCounts,
  type VideoPayload
} from '../electron/kinds/video/db.ts'
import {
  cnNumber,
  detectExtra,
  parseAnimeEpisode,
  parseCnSeasonEpisode,
  parseLatinSeasonEpisode,
  parsePart,
  parseVideoName,
  parseYear,
  splitTitle,
  titleRegion
} from '../electron/kinds/video/filename.ts'
import {
  isExtraDir,
  parseSeasonFolder,
  scanVideoRoot,
  stackParts
} from '../electron/kinds/video/scanner.ts'

const CONFIG = { api_url: 'http://localhost/v1', api_key: 'test', model: 'fake', enabled: true }

let passed = 0
let failed = 0

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
  /* --------------------------- 扫描：拆识别单元 --------------------------- */

  console.log('\n扫描 · 拆识别单元')

  // 这棵树照 D:\Software 的真实形状搭的。判错「软件目录 / 收纳目录」的代价不对称：
  // 一个单元就是一次 agent 会话，沙箱只开放 unit.dir 那棵子树，所以把一个软件拆成
  // 两个单元之后，32 位和 64 位就永远合不回一条了。这一节主要守的是那一侧。
  const scanRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-scan-'))
  const rel = (p: string): string => path.relative(scanRoot, p).split(path.sep).join('/')

  const touch = async (...paths: string[]): Promise<void> => {
    for (const r of paths) {
      const full = path.join(scanRoot, ...r.split('/'))
      await fsp.mkdir(path.dirname(full), { recursive: true })
      await fsp.writeFile(full, 'x')
    }
  }

  await touch(
    // 扫描根那一层：散落的 exe 和压缩包只记不识别，别的杂文件连记都不记
    'ADU.AI-1.0.0-x64.exe',
    'NoteEditor.rar',
    'notes.txt',
    // 本层就有 exe —— 软件目录
    'BlueStacks X/HD-Player.exe',
    'BlueStacks X/plugins/helper.exe',
    // 清一色文件夹的收纳目录，要下钻
    '1.system/ProcessMonitor/Procmon.exe',
    '1.system/0.安装包/setup.zip',
    // 主程序不在本层、靠 .bat 起：整棵子树算一条，不许拆到 support\ 去
    '1.system/ghidra_12.0.4_PUBLIC_20260303/ghidra_12.0.4_PUBLIC/ghidraRun.bat',
    '1.system/ghidra_12.0.4_PUBLIC_20260303/ghidra_12.0.4_PUBLIC/support/launch.exe',
    // 收纳目录里躺着还没解压的压缩包，不该因此被当成软件目录
    '3.实用工具/PDF-XChange.rar',
    '3.实用工具/LockHunter/LockHunter.exe',
    // 32 位和 64 位分在两个子文件夹里，本层只有说明文档
    'XMouseButtonControl_2.20.5_Portable/Readme Portable.txt',
    'XMouseButtonControl_2.20.5_Portable/32bit (x86)/XMouseButtonControl.exe',
    'XMouseButtonControl_2.20.5_Portable/64bit (x64)/XMouseButtonControl.exe',
    // 真正的合集目录：下钻两层才见到 exe
    'ITEM/Win11右键菜单样式更改工具/W11ClassicMenu/ClassicMenu.exe',
    'ITEM/Win11右键菜单样式更改工具/NilesoftShell/shell.exe',
    // 第 4 层，超出下钻上限
    '深/a/b/c/deep.exe',
    // 忽略名单，任何层级都该跳过
    'node_modules/pkg/bin.exe',
    '1.system/.git/hooks/pre-commit.exe'
  )
  // 整棵子树都是空的，下钻完也该什么都不留下
  await fsp.mkdir(path.join(scanRoot, 'Adobe Illustrator 2026', 'Presets'), { recursive: true })

  const plan = await planRoot(scanRoot)
  const found = new Set(plan.units.map((u) => rel(u.dir)))
  const under = (prefix: string): string[] => [...found].filter((d) => d.startsWith(prefix))

  await check('本层有 exe 的目录直接成单元', () => {
    assert.ok(found.has('BlueStacks X'), `实际拆出：${[...found].join(' | ')}`)
    assert.ok(found.has('1.system/ProcessMonitor'), '收纳目录下钻后该找到它')
  })

  await check('清一色文件夹的收纳目录会下钻，不整个丢给 agent', () => {
    assert.ok(!found.has('1.system'), '1.system 本身不该成为单元')
    assert.ok(!found.has('ITEM'))
    assert.ok(
      found.has('ITEM/Win11右键菜单样式更改工具/W11ClassicMenu'),
      '第 3 层照样要成单元'
    )
    assert.ok(found.has('ITEM/Win11右键菜单样式更改工具/NilesoftShell'))
  })

  await check('没解压的压缩包不算「这一层有东西」', () => {
    // 3.实用工具 底下躺着 PDF-XChange.rar，它仍然是收纳目录
    assert.ok(!found.has('3.实用工具'), '压缩包让它被误判成软件目录了')
    assert.ok(found.has('3.实用工具/LockHunter'))
  })

  await check('主程序在子目录里的软件不被拆开 —— 拆了就永远合不回一条', () => {
    assert.ok(
      found.has('XMouseButtonControl_2.20.5_Portable'),
      '32bit / 64bit 必须留在同一个单元里'
    )
    assert.deepEqual(under('XMouseButtonControl_2.20.5_Portable/'), [], '被拆开了')
    // Ghidra 靠 ghidraRun.bat 启动，本层没有 exe，但它是一个软件而不是收纳目录
    const ghidra = '1.system/ghidra_12.0.4_PUBLIC_20260303/ghidra_12.0.4_PUBLIC'
    assert.ok(found.has(ghidra), 'Ghidra 整棵子树该是一条，实际没有它')
    assert.deepEqual(under(`${ghidra}/`), [], 'support\\ 不该单独成单元')
  })

  await check('下钻到第 3 层还没见到 exe 就放弃', () => {
    assert.deepEqual(under('深'), [], '第 4 层的 exe 不该被拆出单元')
  })

  await check('一个 exe 都没有的目录不惊动 agent', () => {
    assert.ok(!found.has('1.system/0.安装包'), '里面只有一个 zip')
    assert.deepEqual(under('Adobe'), [], '整棵子树是空的')
  })

  await check('忽略目录在任何层级都跳过', () => {
    assert.deepEqual(under('node_modules'), [])
    assert.equal([...found].some((d) => d.includes('.git')), false)
    assert.equal(skippable('node_modules'), true)
    assert.equal(skippable('.hidden'), true)
    assert.equal(skippable('1.system'), false, '数字开头的收纳目录不该被当成隐藏目录')
  })

  await check('exe 数量把子目录一起算进去 —— agent 靠它判断值不值得进去', () => {
    const count = (d: string): number | undefined =>
      plan.units.find((u) => rel(u.dir) === d)?.exe_count
    assert.equal(count('BlueStacks X'), 2, 'HD-Player.exe + plugins\\helper.exe')
    assert.equal(count('XMouseButtonControl_2.20.5_Portable'), 2)
    assert.equal(count('1.system/ProcessMonitor'), 1)
  })

  await check('扫描根那一层的散落 exe 和压缩包只记录，不生成单元', () => {
    assert.deepEqual(plan.loose.map(rel).sort(), ['ADU.AI-1.0.0-x64.exe', 'NoteEditor.rar'])
    assert.ok(!found.has(''), '扫描根自己不该成为一个单元')
  })

  await check('取消信号一进来就收手', async () => {
    const stopped = await planRoot(scanRoot, { cancelled: () => true })
    assert.equal(stopped.units.length, 0)
    assert.equal(stopped.loose.length, 0)
  })

  await fsp.rm(scanRoot, { recursive: true, force: true })

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
    // 0.5 起公共表在 services/schema.ts 的 TABLES_SQL 里，锚点从 resource 起
    // （写 software 会先撞上 kinds/software 那段只含 software_meta 的模板）
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS resource'))

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
    // 0.5 起表分散在公共层和品类模块两处，构建产物里是几段独立的模板，
    // 锚点要分开写。software 本身是 resource + software_meta 拼出来的视图
    db.exec(sqlAround('CREATE TABLE IF NOT EXISTS resource'))
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
      'INSERT INTO resource\n         (id, kind, created_at',
      'INSERT INTO software_meta\n         (resource_id',
      'INSERT OR IGNORE INTO resource',
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

  /* --------------------------- 分类与标签 --------------------------- */

  console.log('\n分类与标签')

  // 这一节守的是 0.4 那次迁移。rebuildCategories 会改写库里**每一条**软件的
  // category，映射目标一个字写错，那一批条目就落进一个分类表里根本不存在的格子 ——
  // 表现是「侧边栏有这个分类、点进去 0 条」，而且没有回头路。
  await check('每个映射目标都真的是一个新分类，不是打错的名字', () => {
    const names = new Set(DEFAULT_CATEGORIES.map((c) => c.name))
    for (const from of [
      '逆向分析', 'AI 编程', '编辑查看', '系统调控', '文件搜索',
      '网络调试', '图像处理', '媒体影音', '安全隐私', '办公效率'
    ]) {
      const to = mapCategory(from)
      assert.ok(names.has(to), `${from} → ${to}，而「${to}」不在新分类表里`)
      assert.notEqual(to, from, `${from} 是旧分类，不该原样留下`)
    }
  })

  await check('0.1 的分类、用户自建的分类都退回「其他」', () => {
    for (const from of ['开发工具-旧', '未分类', '我自己建的', '']) {
      assert.equal(mapCategory(from), FALLBACK_CATEGORY, `${from} 应该兜到「其他」`)
    }
    // 「开发工具」这个名字 0.1 用过、0.4 又用上了 —— 现在它是合法分类，不该被兜走
    assert.equal(mapCategory('开发工具'), '开发工具')
  })

  await check('已经是新分类的原样不动 —— 重复迁移不该把它们冲掉', () => {
    for (const c of DEFAULT_CATEGORIES) assert.equal(mapCategory(c.name), c.name)
  })

  await check('分类表本身自洽：5 条、名字不重、有兜底、排序连续', () => {
    assert.equal(DEFAULT_CATEGORIES.length, 5)
    const names = DEFAULT_CATEGORIES.map((c) => c.name)
    assert.equal(new Set(names).size, 5, '分类名重了 —— 分类是靠名字挂在条目上的')
    assert.equal(new Set(DEFAULT_CATEGORIES.map((c) => c.id)).size, 5, 'id 重了')
    assert.ok(names.includes(FALLBACK_CATEGORY), '兜底分类必须真的在表里')
    assert.deepEqual(DEFAULT_CATEGORIES.map((c) => c.sort_order), [1, 2, 3, 4, 5])
    for (const c of DEFAULT_CATEGORIES) {
      assert.ok(c.description.length > 0, `${c.name} 没有说明 —— 它会被注入 prompt 当判据`)
      assert.ok(c.icon.length > 0, `${c.name} 没有图标名`)
    }
  })

  await check('内置标签 10 个，不重复，且都在标签名长度上限内', () => {
    assert.equal(BUILTIN_TAGS.length, 10)
    assert.equal(new Set(BUILTIN_TAGS).size, 10)
    for (const t of BUILTIN_TAGS) {
      // createTag / limitTags 都按 12 字符截断，超了会导致池里的名字和条目上的对不上
      assert.ok(t.length > 0 && t.length <= 12, `「${t}」长度 ${t.length}，会被截断`)
      assert.equal(t.trim(), t, `「${t}」两头有空白`)
    }
  })

  await check('内置标签直接可用作标签池 —— 它们必须能原样通过 limitTags', () => {
    const pool = new Set(BUILTIN_TAGS)
    // 池内的照单全收（封顶 3 个）。要是有哪个被 limitTags 洗掉了，
    // 说明它进不了自己所在的池子，注入 prompt 就是骗模型
    assert.deepEqual(limitTags(['便携', '开源', 'AI 相关'], pool), ['便携', '开源', 'AI 相关'])
    assert.deepEqual(limitTags(['跨平台', '单文件'], pool), ['跨平台', '单文件'])
  })

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

  /* --------------------------- 搜索开关与提示词 --------------------------- */
  console.log('\n搜索开关与提示词')

  // 这一节守的是 0.4 修掉的那个 bug：搜索开关关着时 buildTools 不注册 web_search，
  // 可提示词还在教模型「拿不准就 web_search」—— 模型于是去调一个不存在的工具，
  // 白烧一轮。冷门软件本来就要多看几眼，轮数一浪费就直接认不出来了。
  await check('搜索关掉时，提示词不再让模型去调 web_search', () => {
    const off = fillIdentifySystem(CATS, ['便携'], false)
    assert.ok(!off.includes('{{'), `还留着没替换的插槽：${off.match(/\{\{\w+\}\}/)?.[0]}`)
    assert.ok(
      !/拿不准[^\n]*web_search|才用 web_search|就先读它，读完还不清楚再联网/.test(off),
      '关掉搜索后还在教模型调 web_search'
    )
    assert.match(off, /没有 web_search 工具/, '要明确告诉它这个工具不存在')
    assert.match(off, /仅根据本地文件信息判断/, '要给出替代做法，而不是只说「不能搜」')
  })

  await check('搜索开着时那两段照旧在', () => {
    const on = fillIdentifySystem(CATS, ['便携'], true)
    assert.ok(!on.includes('{{'))
    assert.match(on, /3\. \*\*联网搜索\*\*（web_search）/)
    assert.match(on, /关键词用「软件名 \+ 功能\/用途」/)
    assert.ok(!on.includes('没有 web_search 工具'), '开着的时候不该出现禁用说明')
  })

  await check('默认参数按「有搜索」算 —— 漏传不该让提示词变成禁用版', () => {
    assert.equal(fillIdentifySystem(CATS, ['便携']), fillIdentifySystem(CATS, ['便携'], true))
  })

  /* --------------------------- 多版本去重 --------------------------- */
  console.log('\n多版本去重')

  await check('从路径里抠版本号，取最后一个像版本号的片段', () => {
    // 1.system 里那个 1. 不是版本号，取错了就会把两个版本判成一样新
    assert.deepEqual(parseVersion('D:\\Software\\1.system\\CC Switch\\v3.16.5'), [3, 16, 5])
    assert.deepEqual(parseVersion('CC Switch v3.16.1'), [3, 16, 1])
    assert.deepEqual(parseVersion('D:\\Tools\\Everything'), [], '没有版本号就是空')
    assert.deepEqual(parseVersion('x64dbg'), [], '孤零零一个数字不算版本号')
  })

  await check('逐段比大小，段数不同时缺的按 0 算', () => {
    assert.ok(compareVersions([3, 16, 5], [3, 16, 1]) > 0)
    assert.ok(compareVersions([3, 16], [3, 16, 1]) < 0, '3.16 比 3.16.1 旧')
    assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0)
    // 逐段比而不是按字符串：字符串比较会判定 3.9 > 3.16
    assert.ok(compareVersions([3, 16], [3, 9]) > 0, '按字符串比会把 3.16 判成更旧')
    assert.ok(compareVersions([2], []) > 0, '认不出版本号的排在后面')
  })

  await check('路径里的版本号优先于 PE 版本号', () => {
    // 多版本并存时目录名就是用来区分版本的，而 PE 版本常常没跟着打包更新
    const item = {
      source_dir: 'D:\\Software\\CC Switch\\v3.16.5',
      exe_path: 'D:\\Software\\CC Switch\\v3.16.5\\cc.exe',
      version: '1.0.0.0'
    }
    assert.deepEqual(versionOf(item), [3, 16, 5])
    assert.deepEqual(
      versionOf({ source_dir: 'D:\\Tools\\LockHunter', exe_path: 'D:\\Tools\\LockHunter\\lh.exe', version: '3.4.2' }),
      [3, 4, 2],
      '路径里认不出来才退回 PE 版本'
    )
  })

  await check('同名多版本里挑得出最新那个', () => {
    const rows = [
      { source_dir: 'D:\\S\\CC Switch\\v3.16.1', exe_path: '', version: '' },
      { source_dir: 'D:\\S\\CC Switch\\v3.16.5', exe_path: '', version: '' },
      { source_dir: 'D:\\S\\CC Switch\\v3.9.0', exe_path: '', version: '' }
    ]
    const sorted = [...rows].sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
    assert.match(sorted[0].source_dir, /v3\.16\.5$/, `排序结果：${sorted.map((r) => r.source_dir).join(' | ')}`)
    assert.match(sorted[2].source_dir, /v3\.9\.0$/)
  })

  /* --------------------------- 日志复制成文本 --------------------------- */
  console.log('\n日志复制成文本')

  const sampleLog = {
    id: 'l1',
    dir: 'D:\\Software\\1.system\\RegistryFinder64',
    label: 'RegistryFinder64',
    kind: 'unit' as const,
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

  const searchLog = (id: string, at: number, events: any[]) => ({
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
    const store = ref({ scan_dirs: ['D:\\Software'] })
    assert.equal(cloneable(store.value.scan_dirs), false, '代理竟然能克隆？那这个护栏就没意义了')
    const item = reactive({ tags: ['t'] })
    assert.equal(cloneable({ tags: item.tags }), false, '嵌在对象里的代理同样过不去')
  })

  await check('plain() 拍平之后能过克隆，且值不变', () => {
    const store = ref({ scan_dirs: ['D:\\Software\\1.system', 'E:\\Tools'] })
    const flat = plain(store.value.scan_dirs)
    assert.ok(cloneable(flat), 'plain() 之后还是克隆不了，护栏失效')
    assert.deepEqual(flat, ['D:\\Software\\1.system', 'E:\\Tools'])

    const item = reactive({ tags: ['a', 'b'] })
    assert.ok(cloneable(plain({ tags: item.tags })), '嵌套代理没被拍平')
  })

  await check('plain(undefined) 保持 undefined —— ai.complete() 不传 ids 时靠这个', () => {
    assert.equal(plain(undefined), undefined)
  })

  /* --------------------------- 整理：路径计算 --------------------------- */
  console.log('\n整理 · 目标路径与文件夹名')

  await check('非法字符和结尾的点/空格都被剥掉', () => {
    assert.equal(sanitizeFolder('IDA Pro 8.3'), 'IDA Pro 8.3')
    assert.equal(sanitizeFolder('x64:dbg?'), 'x64dbg')
    assert.equal(sanitizeFolder('Tool/Kit\\v2'), 'ToolKitv2')
    // 结尾的点必须去掉：Windows 会静默把 `Foo.` 建成 `Foo`，
    // 于是「目标已存在」的判断和实际落地的路径就对不上了
    assert.equal(sanitizeFolder('Foo.'), 'Foo')
    assert.equal(sanitizeFolder('Foo   '), 'Foo')
    assert.equal(sanitizeFolder('  '), 'Unnamed', '洗成空串时要用兜底名')
  })

  await check('Windows 保留设备名被让开', () => {
    // 叫 CON 的文件夹建不出来，而错误是「参数错误」，不查表根本猜不到原因
    assert.equal(sanitizeFolder('con'), 'con_')
    assert.equal(sanitizeFolder('NUL'), 'NUL_')
    assert.equal(sanitizeFolder('COM1'), 'COM1_')
    assert.equal(sanitizeFolder('Console'), 'Console', '只有完全相同才算保留名')
  })

  await check('默认文件夹名取英文正式名，没有才退回中文名和原目录名', () => {
    assert.equal(
      defaultFolder({ name_en: 'x64dbg', name_zh: '64位调试器', exe_path: 'D:\\a\\b\\x64dbg.exe' }),
      'x64dbg'
    )
    assert.equal(
      defaultFolder({ name_en: '', name_zh: '火绒剑', exe_path: 'D:\\a\\Sysdiag\\hrsword.exe' }),
      '火绒剑'
    )
    assert.equal(
      defaultFolder({ name_en: '', name_zh: '', exe_path: 'D:\\Tools\\AmazTool\\app.exe' }),
      'AmazTool',
      '两个名字都空时用它原来的目录名，不要凭空造一个'
    )
  })

  await check('目标路径 = 根 / 分类 / 文件夹，分类名也要洗', () => {
    assert.equal(targetDir('E:\\Toolkit', '逆向分析', 'x64dbg'), 'E:\\Toolkit\\逆向分析\\x64dbg')
    // 用户可以把分类命名成「图像 / 视频」，那个斜杠会凭空多出一层目录
    assert.equal(targetDir('E:\\Toolkit', '图像/视频', 'GIMP'), 'E:\\Toolkit\\图像视频\\GIMP')
    assert.equal(targetDir('', '逆向分析', 'x64dbg'), '', '没配置整理根时不该拼出半个路径')
  })

  /* --------------------------- 整理：默认动作 --------------------------- */
  console.log('\n整理 · 默认动作')

  await check('绿色软件剪切，risky / unknown 只做链接', () => {
    assert.equal(defaultAction(true, 'safe'), 'move')
    assert.equal(defaultAction(true, 'unknown'), 'move', '绿色软件搬走没有副作用')
    assert.equal(defaultAction(false, 'safe'), 'move', '安装版判定可安全移动的也剪切')
    assert.equal(defaultAction(false, 'risky'), 'junction')
    assert.equal(defaultAction(false, 'unknown'), 'junction')
  })

  await check('is_portable 为 null 时按风险判，绝不当成绿色软件', () => {
    // null 是「还没判断过」，赌它没事的代价是把用户装好的软件搬坏
    assert.equal(defaultAction(null, 'unknown'), 'junction')
    assert.equal(defaultAction(null, 'risky'), 'junction')
    assert.equal(defaultAction(null, 'safe'), 'move', 'safe 是明确的判断，可以信')
  })

  /* --------------------------- 整理：路径重映射 --------------------------- */
  console.log('\n整理 · 路径重映射')

  await check('目录搬走后，子路径跟着换前缀', () => {
    const from = 'D:\\Software\\x64dbg_2024'
    const to = 'E:\\Toolkit\\逆向分析\\x64dbg'
    assert.equal(rebase(`${from}\\release\\x64\\x64dbg.exe`, from, to), `${to}\\release\\x64\\x64dbg.exe`)
    assert.equal(rebase(from, from, to), to, '目录自身也要映射')
  })

  await check('不在源目录下的路径原样不动', () => {
    const from = 'D:\\Software\\x64dbg'
    const to = 'E:\\Toolkit\\逆向分析\\x64dbg'
    // 一个条目的附属启动端完全可能在别的目录里，跟着改就把它指到不存在的地方了
    assert.equal(rebase('D:\\Other\\tool.exe', from, to), 'D:\\Other\\tool.exe')
    // 前缀相同但不是同一个目录：x64dbg 不该把 x64dbg_old 也算进去
    assert.equal(rebase('D:\\Software\\x64dbg_old\\a.exe', from, to), 'D:\\Software\\x64dbg_old\\a.exe')
  })

  await check('大小写不同视为同一个目录', () => {
    // 库里存的和 agent 当时看到的大小写未必一致，而 Windows 上它们是同一个目录
    assert.equal(
      rebase('d:\\software\\TOOLS\\a.exe', 'D:\\Software\\Tools', 'E:\\T\\A'),
      'E:\\T\\A\\a.exe'
    )
  })

  /* --------------------------- 整理：安全护栏 --------------------------- */
  console.log('\n整理 · 安全护栏')

  await check('同盘 / 跨盘判断', () => {
    assert.equal(sameVolume('D:\\a', 'D:\\b\\c'), true)
    assert.equal(sameVolume('D:\\a', 'E:\\a'), false)
    assert.equal(sameVolume('d:\\a', 'D:\\b'), true, '盘符大小写不该影响判断')
    // UNC 一律当跨盘，走复制校验那条更保守的路
    assert.equal(sameVolume('\\\\server\\share\\a', 'D:\\b'), false)
  })

  await check('目标落在源目录内部时能被识破', () => {
    // 整理根设成 D:\Software，而软件本来就在 D:\Software\x64dbg ——
    // 复制会一边读一边往自己里面写，走到磁盘满为止
    assert.equal(nestedInside('D:\\Software\\x64dbg', 'D:\\Software\\x64dbg\\sub'), true)
    assert.equal(nestedInside('D:\\Software\\x64dbg', 'D:\\Software\\x64dbg'), true)
    assert.equal(nestedInside('D:\\Software\\x64dbg', 'E:\\Toolkit\\x64dbg'), false)
    assert.equal(
      nestedInside('D:\\Software\\x64dbg', 'D:\\Software\\x64dbg_old'),
      false,
      '前缀相同但不是子目录'
    )
  })

  /* --------------------------- 整理：真的动文件 --------------------------- */
  console.log('\n整理 · 文件操作（真实磁盘）')

  const orgRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-org-'))

  await check('同盘移动：目录整体搬过去，内容一字不差', async () => {
    const from = path.join(orgRoot, 'src', 'MyTool')
    await fsp.mkdir(path.join(from, 'plugins'), { recursive: true })
    await fsp.writeFile(path.join(from, 'tool.exe'), 'MZ-fake-binary')
    await fsp.writeFile(path.join(from, 'plugins', 'p.dll'), 'dll-body')

    const to = path.join(orgRoot, 'dst', '逆向分析', 'MyTool')
    const outcome = await moveDir(from, to)
    assert.ok(outcome.ok, `移动失败：${outcome.note}`)
    assert.equal(fs.existsSync(from), false, '源目录该没了')
    assert.equal(await fsp.readFile(path.join(to, 'tool.exe'), 'utf-8'), 'MZ-fake-binary')
    assert.equal(await fsp.readFile(path.join(to, 'plugins', 'p.dll'), 'utf-8'), 'dll-body')
  })

  await check('目标已存在时拒绝执行，绝不覆盖', async () => {
    const from = path.join(orgRoot, 'src2', 'Dup')
    await fsp.mkdir(from, { recursive: true })
    await fsp.writeFile(path.join(from, 'new.txt'), 'new')

    const to = path.join(orgRoot, 'dst2', 'Dup')
    await fsp.mkdir(to, { recursive: true })
    await fsp.writeFile(path.join(to, 'precious.txt'), '用户已有的东西')

    const outcome = await moveDir(from, to)
    assert.equal(outcome.ok, false, '目标存在时必须失败')
    assert.match(outcome.note, /已存在/)
    // 这是最要紧的一条：原有文件必须还在，源也必须没被动过
    assert.equal(await fsp.readFile(path.join(to, 'precious.txt'), 'utf-8'), '用户已有的东西')
    assert.ok(fs.existsSync(path.join(from, 'new.txt')), '失败时源目录不该被清掉')
  })

  await check('目标嵌在源里面时被拦住', async () => {
    const from = path.join(orgRoot, 'nest', 'Self')
    await fsp.mkdir(from, { recursive: true })
    await fsp.writeFile(path.join(from, 'a.txt'), 'a')
    const outcome = await moveDir(from, path.join(from, 'inner', 'Self'))
    assert.equal(outcome.ok, false)
    assert.match(outcome.note, /内部/)
    assert.ok(fs.existsSync(path.join(from, 'a.txt')), '源必须完好')
  })

  await check('源目录不存在时给出可读的原因，而不是抛异常', async () => {
    const outcome = await moveDir(path.join(orgRoot, '并不存在'), path.join(orgRoot, 'x'))
    assert.equal(outcome.ok, false)
    assert.match(outcome.note, /不在了/)
  })

  await check('junction：建链接、能读到目标内容、能安全删掉', async () => {
    const real = path.join(orgRoot, 'real', 'Installed')
    await fsp.mkdir(real, { recursive: true })
    await fsp.writeFile(path.join(real, 'app.exe'), 'installed-body')

    const link = path.join(orgRoot, 'dst3', '系统调控', 'Installed')
    const made = await makeJunction(link, real)
    assert.ok(made.ok, `建链接失败：${made.note}`)
    assert.ok(await isLink(link), '建出来的该被认成链接')
    // junction 是透明的：从链接读到的就是真实目录的内容
    assert.equal(await fsp.readFile(path.join(link, 'app.exe'), 'utf-8'), 'installed-body')

    await writeLinkMark(real, { software: 'Installed', real_path: real, link_path: link })
    assert.ok(fs.existsSync(path.join(real, LINK_MARK)), '标记文件该落在真实目录里')

    const dropped = await removeJunction(link)
    assert.ok(dropped.ok, `删链接失败：${dropped.note}`)
    assert.equal(fs.existsSync(link), false, '链接该没了')
    // 这一条是重点：删链接绝不能碰到真实文件
    assert.equal(await fsp.readFile(path.join(real, 'app.exe'), 'utf-8'), 'installed-body')
  })

  await check('removeJunction 拒绝删实体目录', async () => {
    // 传错了参数就会把用户的软件本体删掉，所以这道判断必须在
    const solid = path.join(orgRoot, 'solid')
    await fsp.mkdir(solid, { recursive: true })
    await fsp.writeFile(path.join(solid, 'keep.txt'), 'keep')

    const outcome = await removeJunction(solid)
    assert.equal(outcome.ok, false, '实体目录必须被拒')
    assert.match(outcome.note, /不是链接/)
    assert.ok(fs.existsSync(path.join(solid, 'keep.txt')), '文件必须还在')
  })

  await fsp.rm(orgRoot, { recursive: true, force: true })

  /* ------------------------ 接口地址与模型列表 ------------------------ */

  await check('apiBase 归一用户填的接口地址', () => {
    // 拼错的代价是 404，而报错信息只会说「HTTP 404」，排查起来很贵
    assert.equal(apiBase('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
    assert.equal(apiBase('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
    assert.equal(apiBase('  https://api.deepseek.com/v1///  '), 'https://api.deepseek.com/v1')
    // 有人会把整条 chat 路径粘进来
    assert.equal(
      apiBase('https://api.deepseek.com/v1/chat/completions'),
      'https://api.deepseek.com/v1'
    )
  })

  await check('parseModelList 认得两种响应形状', () => {
    // OpenAI 标准形状
    assert.deepEqual(
      parseModelList({ object: 'list', data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }),
      ['gpt-4o', 'gpt-4o-mini']
    )
    // 少数服务商直接给数组
    assert.deepEqual(parseModelList(['qwen-plus', 'qwen-max']), ['qwen-max', 'qwen-plus'])
    // 去重
    assert.deepEqual(parseModelList({ data: [{ id: 'a' }, { id: 'a' }] }), ['a'])
    // 垃圾数据不能抛，得让上层去说「手填模型名」
    assert.deepEqual(parseModelList({ data: [{}, { id: '' }, null] }), [])
    assert.deepEqual(parseModelList(null), [])
    assert.deepEqual(parseModelList({ error: 'no such endpoint' }), [])
  })

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
          ['其他'],
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

  await gameIdentifySection()
  await saveBackupSection()
  await saveDbSection()
  await playSessionSection()
  await engineRulesSection()
  await linksAndCoverSection()
  await videoDataSection()
  await videoFilenameSection()
  await videoScanSection()

  console.log(`\n${passed} 通过，${failed} 失败\n`)
  if (failed > 0) process.exit(1)
}

/* ==================== 视频数据层 · v0.7 Step 1 ==================== */

/**
 * 迁移 6 -> 7 和视频读写层。
 *
 * 这一段的重量全在「0.6 的真实库升上来之后，原有数据一条不少」——
 * 0.7 是本项目第一次在库里已经有两个品类的情况下加第三个，而
 * initSchema 里那几道闸门（rebuildCategories、seedTags）历史上都出过
 * 「下一次提版本时误伤」的事。
 */
async function videoDataSection(): Promise<void> {
  console.log('\n视频数据层 · 迁移与读写')

  const { DatabaseSync } = await import('node:sqlite')

  /**
   * 造一张 0.6 形状的库：软件和游戏都有真实数据，版本号停在 6。
   *
   * 直接用 initSchema 建 0.6 的结构是做不到的 —— 它现在会建 7 的结构。
   * 所以这里手搭 0.6 那几张表，和 makeV4Db 一个路子。
   */
  function makeV6Db(): InstanceType<typeof DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(`
      CREATE TABLE resource (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'software',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE, icon_path TEXT, file_name TEXT NOT NULL,
        file_size INTEGER DEFAULT 0, source_dir TEXT DEFAULT '',
        name_zh TEXT DEFAULT '', name_en TEXT DEFAULT '', summary TEXT DEFAULT '',
        description TEXT DEFAULT '', category TEXT DEFAULT '其他', tags TEXT DEFAULT '[]',
        official_url TEXT DEFAULT '', ai_status TEXT DEFAULT 'pending',
        why_choose TEXT DEFAULT '', use_cases TEXT DEFAULT '', notes TEXT DEFAULT '',
        alternatives TEXT DEFAULT '[]', mastery_level TEXT DEFAULT 'new',
        last_used_at INTEGER DEFAULT 0, use_count INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0,
        external_active_at INTEGER DEFAULT 0
      );
      CREATE TABLE software_meta (
        resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
        file_description TEXT DEFAULT '', company TEXT DEFAULT '', version TEXT DEFAULT '',
        launchers TEXT DEFAULT '[]', is_portable INTEGER DEFAULT NULL,
        move_risk TEXT DEFAULT 'unknown', link_target TEXT DEFAULT ''
      );
      CREATE TABLE game_meta (
        resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,
        cover_path TEXT DEFAULT '', background_path TEXT DEFAULT '',
        play_status TEXT NOT NULL DEFAULT 'unplayed',
        total_playtime_sec INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER NOT NULL DEFAULT 0,
        save_paths TEXT NOT NULL DEFAULT '[]', linked_files TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE save_backups (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, save_path TEXT NOT NULL,
        backup_dir TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE categories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'software', name TEXT NOT NULL,
        description TEXT DEFAULT '', icon TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'software',
        name TEXT NOT NULL, source TEXT DEFAULT 'ai', created_at INTEGER NOT NULL,
        UNIQUE(kind, name)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE identify_logs (
        id TEXT PRIMARY KEY, dir TEXT NOT NULL, label TEXT DEFAULT '', kind TEXT DEFAULT 'unit',
        status TEXT NOT NULL, summary TEXT DEFAULT '', registered INTEGER DEFAULT 0,
        rounds INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0,
        stop_reason TEXT DEFAULT '', events TEXT DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE TABLE organize_plans (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, root TEXT NOT NULL,
        undone_at INTEGER DEFAULT 0, steps TEXT DEFAULT '[]'
      );
      CREATE TABLE identification_reports (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, processed INTEGER DEFAULT 0,
        registered INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0, tokens INTEGER DEFAULT 0, searches INTEGER DEFAULT 0,
        entries TEXT DEFAULT '[]'
      );
    `)

    // 一个软件、一个游戏，都带用户攒出来的东西
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh,
         category, tags, notes, use_count, mastery_level)
       VALUES ('s1', 'software', 1, 2, 'C:\\T\\a.exe', 'a.exe', '甲软件', '开发工具', '["开源"]',
         '我的软件备注', 7, 'proficient')`
    ).run()
    d.prepare('INSERT INTO software_meta (resource_id, is_portable) VALUES (?, ?)').run('s1', null)
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, name_zh,
         category, tags, notes)
       VALUES ('g1', 'game', 1, 2, 'D:\\G\\game.exe', 'game.exe', '乙游戏', 'RPG', '["魂系"]',
         '我的游戏备注')`
    ).run()
    d.prepare(
      `INSERT INTO game_meta (resource_id, play_status, total_playtime_sec, cover_path, save_paths)
       VALUES ('g1', 'playing', 7200, 'C:\\covers\\g1.jpg', '[{"path":"D:\\\\S","verified_at":9}]')`
    ).run()

    // 用户自建的分类和标签，两个品类各一
    d.prepare(
      `INSERT INTO categories (id, kind, name, sort_order) VALUES ('u1', 'software', '我的软件分类', 9)`
    ).run()
    d.prepare(
      `INSERT INTO categories (id, kind, name, sort_order) VALUES ('u2', 'game', '我的游戏分类', 9)`
    ).run()
    d.prepare(
      `INSERT INTO tags (kind, name, source, created_at) VALUES ('software', '我的标签', 'user', 1)`
    ).run()
    d.prepare(`INSERT INTO settings (key, value) VALUES ('_schema', '6')`).run()
    return d
  }

  await check('6 -> 7 迁完，软件和游戏的数据一条不少', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 2)
    const s = d.prepare('SELECT * FROM software WHERE id = ?').get('s1') as any
    assert.equal(s.notes, '我的软件备注')
    assert.equal(s.use_count, 7)
    assert.equal(s.is_portable, null, '「还没判断过」必须仍是 NULL')
    const g = d.prepare('SELECT * FROM game WHERE id = ?').get('g1') as any
    assert.equal(g.play_status, 'playing', '游玩状态不该被这次迁移碰到')
    assert.equal(g.total_playtime_sec, 7200, '游玩时长不该被清零')
    assert.equal(g.cover_path, 'C:\\covers\\g1.jpg', '封面路径不能丢')
    assert.equal(JSON.parse(g.save_paths)[0].path, 'D:\\S')
    assert.equal(schemaVersion(d as any), SCHEMA_VERSION)
    d.close()
  })

  await check('6 -> 7 迁完，用户自建的分类和标签必须还在', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    const names = (d.prepare('SELECT name FROM categories').all() as any[]).map((r) => r.name)
    // rebuildCategories 那颗雷：闸门写成「版本号小于当前」的话，6 -> 7 会再跑
    // 一次 DELETE FROM categories，两个品类的自建分类当场没
    assert.ok(names.includes('我的软件分类'), `软件自建分类被清了：${names.join(',')}`)
    assert.ok(names.includes('我的游戏分类'), `游戏自建分类被清了：${names.join(',')}`)
    const tags = (d.prepare('SELECT name FROM tags').all() as any[]).map((r) => r.name)
    assert.ok(tags.includes('我的标签'), '用户手建的标签被清了')
    d.close()
  })

  await check('6 -> 7 装上视频的分类和内置标签，且带对 kind', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    const cats = (
      d.prepare(`SELECT name FROM categories WHERE kind = 'video' ORDER BY sort_order`).all() as any[]
    ).map((r) => r.name)
    assert.deepEqual(cats, ['华语', '欧美', '日韩', '动画', '纪录片', '综艺', '其他'])
    const tags = (
      d.prepare(`SELECT name, source FROM tags WHERE kind = 'video'`).all() as any[]
    )
    assert.ok(tags.length >= 12, `视频内置标签没装进去，只有 ${tags.length} 个`)
    // 内置标签必须以 user 落库才进 prompt 的标签池，落成 ai 就等于没装
    assert.ok(tags.every((t) => t.source === 'user'), '内置标签该以 source=user 落库')
    // 关键：视频的分类不该跑到软件或游戏的侧栏去
    const soft = (
      d.prepare(`SELECT name FROM categories WHERE kind = 'software'`).all() as any[]
    ).map((r) => r.name)
    assert.ok(!soft.includes('华语'), '视频分类漏进了软件侧')
    d.close()
  })

  await check('迁移是幂等的：连跑三遍不出错，也不重复装分类', () => {
    const d = makeV6Db()
    initSchema(d as any, KINDS)
    const after1 = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    initSchema(d as any, KINDS)
    initSchema(d as any, KINDS)
    const after3 = (d.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n
    assert.equal(after3, after1, '重复跑把分类装了两遍')
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 2)
    d.close()
  })

  await check('全新安装：video 视图和 episode 表都建得出来', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    assert.equal(objectType(d as any, 'video'), 'view')
    assert.equal(objectType(d as any, 'video_meta'), 'table')
    assert.equal(objectType(d as any, 'episode'), 'table')
    assert.equal(schemaVersion(d as any), 7)
    d.close()
  })

  /* --------------------------- 读写层 --------------------------- */

  /** 一个装好 0.7 结构的空库 */
  function freshDb(): InstanceType<typeof DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    return d
  }

  const moviePayload = (over: Partial<VideoPayload> = {}): VideoPayload => ({
    path: 'D:\\Movies\\Dune.2024.mkv',
    video_type: 'movie',
    name_zh: '沙丘：第二部分',
    name_en: 'Dune: Part Two',
    summary: '厄崔迪家族的复仇之路',
    description: '',
    category: '欧美',
    tags: ['科幻', '冒险'],
    official_url: '',
    source_dir: 'D:\\Movies',
    file_size: 78_400_000_000,
    year: 2024,
    end_year: 0,
    rating: 8.7,
    duration_sec: 9960,
    resolution: '2160p',
    video_codec: 'HEVC',
    source: 'WEB-DL',
    release_group: '',
    audio_tracks: [{ index: 0, language: 'en', label: '杜比全景声', codec: 'TrueHD', path: '' }],
    subtitle_tracks: [{ index: -1, language: 'zh', label: '简中', codec: 'SRT', path: 'D:\\Movies\\Dune.srt' }],
    parts: [],
    linked_files: [],
    tmdb_id: '693134',
    imdb_id: 'tt15239678',
    episodes: [],
    ...over
  })

  const seriesPayload = (over: Partial<VideoPayload> = {}): VideoPayload => ({
    ...moviePayload(),
    path: 'E:\\TV\\The Glory',
    video_type: 'series',
    name_zh: '黑暗荣耀',
    name_en: 'The Glory',
    category: '日韩',
    tags: ['悬疑'],
    source_dir: 'E:\\TV',
    year: 2022,
    end_year: 2023,
    rating: 9.1,
    episodes: [
      { season: 1, episode: 1, title: '漆黑的开场', path: 'E:\\TV\\The Glory\\S01E01.mkv', duration_sec: 3480 },
      { season: 1, episode: 2, title: '欢迎来到我的地狱', path: 'E:\\TV\\The Glory\\S01E02.mkv', duration_sec: 3360 },
      // 第 3 集库里知道有，磁盘上没文件 —— path 空串是有意义的状态
      { season: 1, episode: 3, title: '她到底是谁', path: '' }
    ],
    ...over
  })

  await check('电影入库：一条 resource + 一行 video_meta，视图读得回来', () => {
    const d = freshDb()
    const out = insertVideo(d as any, moviePayload())
    assert.ok(out.created)
    assert.equal(out.episodesAdded, 0, '电影不该产生集')
    const v = getVideo(d as any, out.id)!
    assert.equal(v.name_zh, '沙丘：第二部分')
    assert.equal(v.video_type, 'movie')
    assert.equal(v.year, 2024)
    assert.equal(v.rating, 8.7)
    assert.equal(v.resolution, '2160p')
    assert.equal(v.audio_tracks[0].label, '杜比全景声')
    assert.equal(v.subtitle_tracks[0].path, 'D:\\Movies\\Dune.srt')
    assert.equal(v.tmdb_id, '693134')
    assert.equal(v.episode_total, 0)
    d.close()
  })

  await check('剧集入库：一条 resource + N 行 episode，缺文件的集也在', () => {
    const d = freshDb()
    const out = insertVideo(d as any, seriesPayload())
    assert.equal(out.episodesAdded, 3)
    const v = getVideo(d as any, out.id)!
    assert.equal(v.video_type, 'series')
    assert.equal(v.episode_total, 3, '缺文件的集也要计入总数')
    assert.equal(v.episode_present, 2, '磁盘上真有文件的是 2 集')
    assert.equal(v.episode_watched, 0)
    const eps = listEpisodes(d as any, out.id)
    assert.equal(eps.length, 3)
    assert.equal(eps[2].path, '', '第 3 集该是缺文件状态')
    assert.equal(eps[0].title, '漆黑的开场')
    d.close()
  })

  await check('重扫同一部片是更新而不是再开一条', () => {
    const d = freshDb()
    const a = insertVideo(d as any, moviePayload())
    const b = insertVideo(d as any, moviePayload({ name_zh: '沙丘 2', rating: 8.9 }))
    assert.equal(a.id, b.id)
    assert.equal(b.created, false)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 1)
    const v = getVideo(d as any, a.id)!
    assert.equal(v.name_zh, '沙丘 2', '识别出来的字段该被更新')
    assert.equal(v.rating, 8.9)
    d.close()
  })

  await check('重新刮削不动观看状态、播放位置和海报 —— 那是用户看出来的账', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    updateVideo(d as any, id, {
      watch_status: 'watched',
      position_sec: 5000,
      poster_path: 'C:\\covers\\v1.jpg',
      notes: '我的备注'
    })
    insertVideo(d as any, moviePayload({ name_zh: '沙丘 2' }))
    const v = getVideo(d as any, id)!
    assert.equal(v.watch_status, 'watched', '重新刮削把观看状态打回去了')
    assert.equal(v.position_sec, 5000, '播放位置被清了')
    assert.equal(v.poster_path, 'C:\\covers\\v1.jpg', '海报被清了')
    assert.equal(v.notes, '我的备注')
    d.close()
  })

  await check('补后半季：新集补进来，已看过的集进度一点不动', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    const eps = listEpisodes(d as any, id)
    updateEpisode(d as any, eps[0].id, { watch_status: 'watched', position_sec: 3480 })
    updateEpisode(d as any, eps[1].id, { watch_status: 'watching', position_sec: 900 })

    // 第 3 集下到了，另外多了两集
    const out = insertVideo(
      d as any,
      seriesPayload({
        episodes: [
          { season: 1, episode: 1, title: '漆黑的开场', path: 'E:\\TV\\The Glory\\S01E01.mkv', duration_sec: 3480 },
          { season: 1, episode: 2, title: '欢迎来到我的地狱', path: 'E:\\TV\\The Glory\\S01E02.mkv', duration_sec: 3360 },
          { season: 1, episode: 3, title: '她到底是谁', path: 'E:\\TV\\The Glory\\S01E03.mkv', duration_sec: 3480 },
          { season: 1, episode: 4, title: '慢慢渗透', path: 'E:\\TV\\The Glory\\S01E04.mkv' },
          { season: 2, episode: 1, title: '第二季开场', path: 'E:\\TV\\The Glory\\S02E01.mkv' }
        ]
      })
    )
    assert.equal(out.episodesAdded, 2, '该只新增 2 集（E04 和 S02E01）')
    const after = listEpisodes(d as any, id)
    assert.equal(after.length, 5)
    assert.equal(after[0].watch_status, 'watched', '看完的集被打回未看了')
    assert.equal(after[0].position_sec, 3480)
    assert.equal(after[1].position_sec, 900, '在看的集进度丢了')
    // 原先缺文件的第 3 集，路径该补上
    assert.equal(after[2].path, 'E:\\TV\\The Glory\\S01E03.mkv')
    d.close()
  })

  await check('季集唯一：同一季同一集反复入库不长出重复行', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    insertVideo(d as any, seriesPayload())
    insertVideo(d as any, seriesPayload())
    assert.equal(listEpisodes(d as any, id).length, 3, '集列表每扫一次长一倍')
    d.close()
  })

  await check('整部剧的状态从集列表推出来，不让用户再点一次', () => {
    // 一集都没碰 = 未看
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'unwatched', position_sec: 0 } as any,
        { path: 'b', watch_status: 'unwatched', position_sec: 0 } as any
      ]),
      'unwatched'
    )
    // 有一集播过一点 = 在看
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'unwatched', position_sec: 120 } as any,
        { path: 'b', watch_status: 'unwatched', position_sec: 0 } as any
      ]),
      'watching'
    )
    // 全看完 = 看完
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'watched', position_sec: 0 } as any,
        { path: 'b', watch_status: 'watched', position_sec: 0 } as any
      ]),
      'watched'
    )
    // 缺文件的集不参与判断：手上这两集看完了就算看完，
    // 否则一部还没播完的剧永远到不了「看完」
    assert.equal(
      deriveSeriesStatus([
        { path: 'a', watch_status: 'watched', position_sec: 0 } as any,
        { path: 'b', watch_status: 'watched', position_sec: 0 } as any,
        { path: '', watch_status: 'unwatched', position_sec: 0 } as any
      ]),
      'watched'
    )
    // 一集文件都没有：推不出状态，返回 null 而不是硬说「未看」
    assert.equal(deriveSeriesStatus([{ path: '', watch_status: 'unwatched' } as any]), null)
  })

  await check('用户标了「弃」之后，推导不许把它改回「在看」', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    const eps = listEpisodes(d as any, id)
    updateEpisode(d as any, eps[0].id, { watch_status: 'watched' })
    updateVideo(d as any, id, { watch_status: 'dropped' })
    syncSeriesStatus(d as any, id)
    // 看了 8 集不看了和「在看」在数据上分不出来，只能由用户说 ——
    // 推导覆盖掉它，用户那个决定就永远保不住
    assert.equal(getVideo(d as any, id)!.watch_status, 'dropped')
    d.close()
  })

  await check('剧一级状态跟着集变：标完最后一集自动变「看完」', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    for (const e of listEpisodes(d as any, id)) {
      if (e.path) updateEpisode(d as any, e.id, { watch_status: 'watched' })
    }
    syncSeriesStatus(d as any, id)
    assert.equal(getVideo(d as any, id)!.watch_status, 'watched')
    assert.equal(getVideo(d as any, id)!.episode_watched, 2)
    d.close()
  })

  await check('自动连播跳过缺文件的集，且能跨季', () => {
    const d = freshDb()
    const { id } = insertVideo(
      d as any,
      seriesPayload({
        episodes: [
          { season: 1, episode: 1, path: 'a.mkv' },
          // 第 2 集缺文件，连播该跳过它 —— 不跳就停在黑屏上，用户以为播放器坏了
          { season: 1, episode: 2, path: '' },
          { season: 1, episode: 3, path: 'c.mkv' },
          { season: 2, episode: 1, path: 'd.mkv' }
        ]
      })
    )
    const n1 = nextEpisode(d as any, id, 1, 1)!
    assert.equal(n1.episode, 3, '缺文件的第 2 集该被跳过')
    const n2 = nextEpisode(d as any, id, 1, 3)!
    assert.equal(n2.season, 2, '该跨季接上 S02E01')
    assert.equal(n2.episode, 1)
    // 最后一集之后没有下一集，返回 null 而不是绕回第一集
    assert.equal(nextEpisode(d as any, id, 2, 1), null)
    d.close()
  })

  await check('筛选：类型 / 观看状态 / 分类 / 标签 / 关键词各自命中', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload())
    insertVideo(d as any, seriesPayload())
    assert.equal(listVideos(d as any, { type: 'movie' }).length, 1)
    assert.equal(listVideos(d as any, { type: 'series' }).length, 1)
    assert.equal(listVideos(d as any, { category: '日韩' }).length, 1)
    assert.equal(listVideos(d as any, { tag: '科幻' }).length, 1)
    assert.equal(listVideos(d as any, { status: 'unwatched' }).length, 2)
    // 中英文标题都要搜得到 —— 规格明确要求
    assert.equal(listVideos(d as any, { keyword: '沙丘' }).length, 1)
    assert.equal(listVideos(d as any, { keyword: 'Glory' }).length, 1)
    assert.equal(listVideos(d as any, { keyword: '不存在的片' }).length, 0)
    d.close()
  })

  await check('标签筛选带引号匹配，「剧情」不该命中「剧情向」', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\a.mkv', tags: ['剧情'] }))
    insertVideo(d as any, moviePayload({ path: 'D:\\b.mkv', tags: ['剧情向'] }))
    assert.equal(listVideos(d as any, { tag: '剧情' }).length, 1)
    d.close()
  })

  await check('排序：年份和评分为 0 的沉到底，不浮在最前面', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\a.mkv', year: 2024, rating: 8.7 }))
    insertVideo(d as any, moviePayload({ path: 'D:\\b.mkv', year: 0, rating: 0 }))
    insertVideo(d as any, moviePayload({ path: 'D:\\c.mkv', year: 1994, rating: 9.7 }))
    // 「不知道年份」不是「公元 0 年」，排序时它该在最后而不是最前
    const byYear = listVideos(d as any, { sort: 'year' }).map((v) => v.year)
    assert.deepEqual(byYear, [2024, 1994, 0])
    const byRating = listVideos(d as any, { sort: 'rating' }).map((v) => v.rating)
    assert.deepEqual(byRating, [9.7, 8.7, 0])
    d.close()
  })

  await check('计数：类型和观看状态都是闭集，没有的那个是 0 不是不存在', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload())
    insertVideo(d as any, seriesPayload())
    const c = videoCounts(d as any)
    assert.equal(c.all, 2)
    assert.equal(c.type.movie, 1)
    assert.equal(c.type.series, 1)
    assert.equal(c.status.unwatched, 2)
    assert.equal(c.status.watched, 0, '一个都没有的状态该是 0 而不是缺键')
    assert.equal(c.status.dropped, 0)
    assert.ok(c.categories.some((x) => x.name === '日韩' && x.count === 1))
    assert.ok(c.tags.some((x) => x.name === '科幻'))
    d.close()
  })

  await check('删条目：集和 meta 跟着走，磁盘上的文件不碰', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, seriesPayload())
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM episode').get() as any).n, 3)
    deleteVideo(d as any, id)
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM resource').get() as any).n, 0)
    assert.equal(
      (d.prepare('SELECT COUNT(*) AS n FROM episode').get() as any).n,
      0,
      'episode 该靠 CASCADE 跟着删'
    )
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM video_meta').get() as any).n, 0)
    d.close()
  })

  await check('更新走白名单：渲染进程递来的野键进不了 SQL', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    // 这两个键一个是不存在的列、一个是主键，都不该被拼进 UPDATE
    const v = updateVideo(d as any, id, { id: 'hacked', bogus_col: 1 } as any)
    assert.equal(v!.id, id, 'id 被改掉了')
    // 视图现算的三个计数写不进去，也不该报错
    updateVideo(d as any, id, { episode_total: 99 } as any)
    assert.equal(getVideo(d as any, id)!.episode_total, 0)
    d.close()
  })

  await check('CHECK 约束拦得住闭集外的值', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    assert.throws(
      () =>
        d
          .prepare('UPDATE video_meta SET watch_status = ? WHERE resource_id = ?')
          .run('wathcing', id),
      /CHECK/i,
      '拼错的状态被静默收下了，那条记录会从界面上消失'
    )
    assert.throws(
      () => d.prepare('UPDATE video_meta SET video_type = ? WHERE resource_id = ?').run('movei', id),
      /CHECK/i
    )
    d.close()
  })

  await check('JSON 列坏掉时退回空数组，不让整个视频库打不开', () => {
    const d = freshDb()
    const { id } = insertVideo(d as any, moviePayload())
    d.prepare('UPDATE video_meta SET audio_tracks = ?, parts = ? WHERE resource_id = ?').run(
      '{坏掉的不是数组}',
      'null',
      id
    )
    const v = getVideo(d as any, id)!
    assert.deepEqual(v.audio_tracks, [])
    assert.deepEqual(v.parts, [])
    d.close()
  })

  await check('三个品类的 path 共用一个全局唯一键，同一个目录不会被认领两次', () => {
    const d = freshDb()
    insertVideo(d as any, moviePayload({ path: 'D:\\X\\same.mkv' }))
    // 磁盘只有一块。同一个路径被两个品类各自认领一次的话，整理模块搬动它时
    // 另一个模块的记录会当场失效 —— 这个约束在 resource 表上，不在品类层
    assert.throws(() => {
      d.prepare(
        `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name)
         VALUES ('dup', 'game', 1, 2, 'D:\\X\\same.mkv', 'same.mkv')`
      ).run()
    }, /UNIQUE/i)
    d.close()
  })
}

/* ==================== 游戏识别 · Step 3 ==================== */

/**
 * 造一棵真实的临时目录树来跑 scanner —— 这一段全是「读磁盘之后怎么判断」，
 * 用假的 fs mock 验它等于在验 mock 自己。
 */
async function gameIdentifySection(): Promise<void> {
  console.log('\n游戏识别 · 目录判断')

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-game-'))
  const mk = async (rel: string, bytes = 16): Promise<string> => {
    const full = path.join(base, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, Buffer.alloc(bytes))
    return full
  }
  const mkdir = (rel: string): Promise<string | undefined> =>
    fsp.mkdir(path.join(base, rel), { recursive: true })

  // Unity 游戏：主程序 600KB，崩溃上报程序 1MB —— 按体积挑正好挑错
  await mk('库/空洞骑士/hollow_knight.exe', 600_000)
  await mk('库/空洞骑士/UnityCrashHandler64.exe', 1_000_000)
  await mk('库/空洞骑士/UnityPlayer.dll', 8000)
  await mk('库/空洞骑士/hollow_knight_Data/globalgamemanagers', 400)
  await fsp.writeFile(
    path.join(base, '库/空洞骑士/hollow_knight_Data/app.info'),
    'Team Cherry\nHollow Knight\n',
    'utf8'
  )
  await mk('库/空洞骑士/readme.txt', 60)

  // RPG Maker MV + 就地存档
  await mk('库/某国产RPG/Game.exe', 200_000)
  await mk('库/某国产RPG/nw.dll', 5000)
  await mk('库/某国产RPG/www/index.html', 100)
  await mk('库/某国产RPG/save/file1.rpgsave', 900)

  // Unreal：证据藏在第二层
  await mk('库/某UE游戏/某UE游戏.exe', 150_000)
  await mkdir('库/某UE游戏/ProjectX/Binaries/Win64')
  await mkdir('库/某UE游戏/ProjectX/Content/Paks')

  // WeGame 装的游戏：一个引擎特征都不留，目录名还带着 appid 尾巴
  await mk('库/洛克王国：世界(2002304)/洛克王国：世界.exe', 300_000)
  await mk('库/洛克王国：世界(2002304)/洛克王国：世界卸载.exe', 900_000)
  await mkdir('库/洛克王国：世界(2002304)/rail_files')
  await mkdir('库/洛克王国：世界(2002304)/TCLS')

  // 有 exe 但认不出引擎
  await mk('库/老游戏/PLAY.EXE', 40_000)
  await mk('库/老游戏/data.dat', 999)

  // 没有 exe：不该成为候选
  await mk('库/攻略合集/攻略.pdf', 2000)

  await check('Unity 游戏：认出引擎，主程序挑的是本体不是崩溃上报程序', () => {
    const c = inspectDir(path.join(base, '库/空洞骑士'), base)
    assert.ok(c, '应该是一个候选')
    assert.ok(
      c!.evidence.some((e) => e.includes('Unity')),
      `没认出 Unity：${c!.evidence.join(' | ')}`
    )
    assert.equal(
      path.basename(c!.likely_main),
      'hollow_knight.exe',
      `主程序挑错了：${c!.likely_main}`
    )
    // 这一条守的就是「不要按体积挑」：崩溃上报程序排在体积第一位
    assert.equal(path.basename(c!.exes[0].path), 'UnityCrashHandler64.exe')
  })

  await check('Unity 的 app.info 被读出来，存档路径直接拼好交给 agent', () => {
    // 真机上模型把发行商猜成 2P Games（实际 DoubleCross），六次探测全打空，
    // 而答案就在 82 字节的 app.info 里。这一条守的是「能读到的别让它猜」
    const c = inspectDir(path.join(base, '库/空洞骑士'), base)!
    assert.ok(
      c.evidence.some((e) => e.includes('Team Cherry') && e.includes('Hollow Knight')),
      `app.info 没读出来：${c.evidence.join(' | ')}`
    )
    assert.ok(
      c.evidence.some((e) => e.includes('%LOCALAPPDATA%Low\\Team Cherry\\Hollow Knight')),
      `没把存档路径拼出来：${c.evidence.join(' | ')}`
    )
  })

  await check('RPG Maker MV：认出引擎，并把就地存档目录报成线索', () => {
    const c = inspectDir(path.join(base, '库/某国产RPG'), base)!
    assert.ok(c.evidence.some((e) => e.includes('RPG Maker')), c.evidence.join(' | '))
    assert.ok(c.evidence.some((e) => e.includes('save')), `没报出就地存档：${c.evidence.join(' | ')}`)
  })

  await check('Unreal：证据在第二层，也要能捞出来', () => {
    const c = inspectDir(path.join(base, '库/某UE游戏'), base)!
    assert.ok(c.evidence.some((e) => e.includes('Unreal')), c.evidence.join(' | '))
    // 与目录同名的 exe，这条判据够硬
    assert.equal(path.basename(c.likely_main), '某UE游戏.exe')
  })

  await check('认不出引擎时，evidence 为空但仍然是候选 —— 交给 agent 看，不在这里下结论', () => {
    const c = inspectDir(path.join(base, '库/老游戏'), base)
    assert.ok(c, '有 exe 就该是候选')
    assert.deepEqual(c!.evidence, [])
    // 没有硬判据就不给猜测。给错提示比不给更糟，模型会照单全收
    assert.equal(c!.likely_main, '')
  })

  await check('没有 exe 的目录不成为候选', () => {
    assert.equal(inspectDir(path.join(base, '库/攻略合集'), base), null)
  })

  await check('收纳目录直接喂给 inspectDir 也不能被当成一个游戏', () => {
    // 真机上撞到的：E:\游戏 这一层清一色是文件夹，递归数得到 33 个 exe，
    // 不拦就会把六个游戏合并成「一个有 33 个 exe 的游戏」交给 agent
    assert.equal(inspectDir(path.join(base, '库'), base), null)
  })

  await check('WeGame 游戏：认出平台，目录名带 appid 尾巴也能对上主程序而不是卸载器', () => {
    const c = inspectDir(path.join(base, '库/洛克王国：世界(2002304)'), base)!
    assert.ok(c.evidence.some((e) => e.includes('WeGame')), c.evidence.join(' | '))
    // 卸载器体积是本体的三倍，按体积挑必错；去掉 (2002304) 之后是精确同名匹配
    assert.equal(path.basename(c.likely_main), '洛克王国：世界.exe', `挑成了 ${c.likely_main}`)
  })

  await check('收纳目录会往下钻，五个游戏目录一个不漏、攻略目录不混进来', async () => {
    const found = await scanGameRoot(base)
    const names = found.map((c) => path.basename(c.dir)).sort()
    assert.deepEqual(
      names,
      ['某UE游戏', '某国产RPG', '老游戏', '空洞骑士', '洛克王国：世界(2002304)'].sort(),
      `扫出来的候选不对：${names.join('、')}`
    )
    // 大小写必须原样保留：下钻时拿小写名拼路径，在 Windows 上照样读得到，
    // 但那个走样的路径会原样落进 resource.path 和 source_dir
    const ue = found.find((c) => path.basename(c.dir).toLowerCase() === '某ue游戏')!
    assert.equal(path.basename(ue.dir), '某UE游戏', `目录名大小写被改了：${ue.dir}`)
    assert.ok(fs.existsSync(ue.exes[0].path), 'exe 路径必须真实可读')
  })

  console.log('\n游戏识别 · 存档路径边界')

  const home = os.homedir()

  await check('%APPDATA% 之类的变量能展开，认不出的变量原样留着', () => {
    assert.equal(
      expandSavePath('%USERPROFILE%\\Saved Games\\Foo', home),
      path.resolve(path.join(home, 'Saved Games', 'Foo'))
    )
    // 认不出来的不能悄悄换成空串 —— 那会把 %NOPE%\x 变成一个 \x 的合法路径
    assert.ok(expandSavePath('%NOPE%\\x', home).includes('%NOPE%'))
  })

  await check('存档白名单只放存档可能在的地方，桌面和 System32 一律拒', () => {
    const roots = saveRoots(home)
    assert.ok(saveRootOf(path.join(home, 'Documents', 'My Games', 'X'), roots))
    assert.ok(saveRootOf(path.join(home, 'AppData', 'LocalLow', 'Team', 'X'), roots))
    assert.equal(saveRootOf('C:\\Windows\\System32', roots), null)
    assert.equal(saveRootOf(path.join(home, 'Desktop', '工作'), roots), null)
    // 按分隔符边界比，别让 Documents2 蹭进 Documents
    assert.equal(saveRootOf(`${path.join(home, 'Documents')}2`, roots), null)
  })

  await check('probeSave 分得清「不存在」「存在但是空的」「有存档」', () => {
    const empty = path.join(base, '空目录')
    fs.mkdirSync(empty, { recursive: true })
    assert.equal(probeSave(path.join(base, '并不存在')).exists, false)

    const e = probeSave(empty)
    assert.equal(e.exists, true)
    // 存在但一个文件都没有 —— 这个区分是「别把空文件夹当存档备份」的依据
    assert.equal(e.files, 0)

    const real = probeSave(path.join(base, '库/某国产RPG/save'))
    assert.equal(real.exists, true)
    assert.equal(real.files, 1)
    assert.ok(real.bytes > 0 && real.newest > 0)
    assert.deepEqual(real.sample, ['file1.rpgsave'])
  })

  await check('没验证过的存档路径一律丢弃 —— 编一个不存在的路径比留空更糟', () => {
    const ledger = new Map<string, number>([
      [expandSavePath('%APPDATA%\\Real', home).toLowerCase(), 1_700_000_000_000]
    ])
    const { kept, rejected } = acceptSavePaths(
      ['%APPDATA%\\Real', '%APPDATA%\\编的', 'C:\\Windows'],
      ledger
    )
    assert.equal(kept.length, 1)
    assert.equal(kept[0].verified_at, 1_700_000_000_000)
    assert.equal(rejected.length, 2, `应该丢掉两条：${rejected.join('、')}`)
  })

  await check('标签收敛：池内的全收，池外的只留一个，总数封顶 3', () => {
    const pool = new Set(['魂系', '像素', '汉化'])
    assert.deepEqual(limitGameTags(['魂系', '像素', '汉化', '新词A', '新词B'], pool), [
      '魂系',
      '像素',
      '汉化'
    ])
    assert.deepEqual(limitGameTags(['新词A', '新词B', '新词C'], pool), ['新词A'])
    assert.deepEqual(limitGameTags(['魂系', 42, '', '  '], pool), ['魂系'])
  })

  console.log('\n游戏识别 · 落库')

  const freshDb = (): InstanceType<typeof DatabaseSync> => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    return d
  }
  const payload = (over: Partial<GamePayload> = {}): GamePayload => ({
    exe_path: 'D:\\Games\\HK\\hollow_knight.exe',
    name_zh: '空洞骑士',
    name_en: 'Hollow Knight',
    summary: '手绘风格的横版探索动作游戏',
    description: '在一座地下虫国里探索、战斗、拾取能力。',
    category: '动作',
    tags: ['像素'],
    official_url: 'https://example.com',
    source_dir: 'D:\\Games\\HK',
    file_size: 600_000,
    save_paths: [{ path: 'C:\\x\\save', verified_at: 111 }],
    linked_files: [],
    ...over
  })

  await check('注册一个游戏：resource + game_meta 各一行，能从 game 视图读回来', () => {
    const d = freshDb()
    const out = insertGame(d as any, payload())
    assert.equal(out.created, true)

    const row = d.prepare('SELECT * FROM game WHERE id = ?').get(out.id) as any
    assert.equal(row.name_zh, '空洞骑士')
    assert.equal(row.category, '动作')
    assert.equal(row.ai_status, 'done')
    assert.equal(row.play_status, 'unplayed')
    assert.deepEqual(JSON.parse(row.save_paths), [{ path: 'C:\\x\\save', verified_at: 111 }])
    // file_name 由 exe_path 推出来，不该要调用方额外填一遍
    assert.equal(row.file_name, 'hollow_knight.exe')

    // 它是游戏，不该出现在软件那一侧 —— 两个视图各管各的
    assert.equal((d.prepare('SELECT COUNT(*) AS n FROM software').get() as any).n, 0)
    d.close()
  })

  await check('重复识别同一个路径是更新，不是再开一条', () => {
    const d = freshDb()
    const first = insertGame(d as any, payload())
    const again = insertGame(d as any, payload({ name_zh: '空洞骑士（重识别）' }))
    assert.equal(again.created, false)
    assert.equal(again.id, first.id)
    assert.equal((d.prepare(`SELECT COUNT(*) AS n FROM resource`).get() as any).n, 1)
    d.close()
  })

  await check('重新识别不会清掉用户玩出来的账：时长、状态、封面、已有存档路径都留着', () => {
    const d = freshDb()
    const { id } = insertGame(d as any, payload())
    d.prepare(
      `UPDATE game_meta SET total_playtime_sec = 7200, play_status = 'playing',
         cover_path = 'C:\\covers\\hk.png', save_paths = ?
       WHERE resource_id = ?`
    ).run(JSON.stringify([{ path: 'C:\\用户自己改的', verified_at: 999 }]), id)

    insertGame(d as any, payload({ save_paths: [{ path: 'C:\\模型这次猜的', verified_at: 222 }] }))

    const row = d.prepare('SELECT * FROM game WHERE id = ?').get(id) as any
    assert.equal(row.total_playtime_sec, 7200, '游玩时长被清了')
    assert.equal(row.play_status, 'playing', '游玩状态被重置了')
    assert.equal(row.cover_path, 'C:\\covers\\hk.png', '封面被清了')
    assert.equal(
      JSON.parse(row.save_paths)[0].path,
      'C:\\用户自己改的',
      '用户手工改过的存档路径被模型的猜测盖掉了'
    )
    d.close()
  })

  await check('gamesUnder 只报同目录下的游戏，不把软件条目也算进来', () => {
    const d = freshDb()
    insertGame(d as any, payload())
    d.prepare(
      `INSERT INTO resource (id, kind, created_at, updated_at, path, file_name, source_dir, name_zh)
       VALUES ('s1', 'software', 1, 1, 'D:\\Games\\HK\\tool.exe', 'tool.exe', 'D:\\Games\\HK', '某工具')`
    ).run()
    const list = gamesUnder(d as any, 'D:\\Games\\HK')
    assert.deepEqual(list.map((g) => g.name), ['空洞骑士'])
    d.close()
  })

  await check('游戏 prompt 用的是游戏的分类和标签，没有把软件那套灌进去', () => {    const filled = fillGameSystem(gameKind.defaultCategories, gameKind.defaultTags, true)
    assert.ok(filled.includes('RPG'), '游戏分类没填进去')
    assert.ok(filled.includes('魂系'), '游戏标签没填进去')
    assert.ok(!filled.includes('{{'), '还有插槽没填')
    for (const word of ['开发工具', '系统管理', '便携', '单文件']) {
      assert.ok(!filled.includes(word), `软件那套串进游戏 prompt 了：${word}`)
    }
    // 关掉搜索时必须明说没有这个工具，否则模型会去调一个没注册的工具，白烧一轮
    const off = fillGameSystem(gameKind.defaultCategories, gameKind.defaultTags, false)
    assert.ok(off.includes('没有 web_search 工具'))
  })

  await check('候选目录的线索原样进 prompt，没有线索时也说清楚', () => {
    const c = inspectDir(path.join(base, '库/空洞骑士'), base)!
    const text = candidatePrompt(c, [{ name: '旧条目', path: 'X.exe' }])
    assert.ok(text.includes('Unity'), '引擎线索没进 prompt')
    assert.ok(text.includes('疑似主程序'), '主程序猜测没进 prompt')
    assert.ok(text.includes('旧条目'), '已注册条目没进 prompt')

    const blind = candidatePrompt(inspectDir(path.join(base, '库/老游戏'), base)!)
    assert.ok(blind.includes('没有命中任何引擎特征'), '没线索时要明说，不能只给个空列表')
    assert.ok(!blind.includes('疑似主程序'), '没有硬判据时不该出现主程序小节')
  })

  /* ==================== 游戏库的读写（Step 4 的界面吃的就是这些） ==================== */
  console.log('\n游戏库 · 列表与统计')

  /** 铺一个小库：两个动作、一个 RPG、一个归档的，状态各不相同 */
  const stocked = (): InstanceType<typeof DatabaseSync> => {
    const d = freshDb()
    insertGame(d as any, payload())
    insertGame(
      d as any,
      payload({
        exe_path: 'D:\\Games\\Celeste\\Celeste.exe',
        name_zh: '蔚蓝',
        name_en: 'Celeste',
        category: '动作',
        tags: ['像素', '高难度'],
        source_dir: 'D:\\Games\\Celeste'
      })
    )
    const rpg = insertGame(
      d as any,
      payload({
        exe_path: 'D:\\Games\\Sultan\\Sultan.exe',
        name_zh: '苏丹的游戏',
        name_en: "Sultan's Game",
        category: 'RPG',
        tags: ['剧情向'],
        source_dir: 'D:\\Games\\Sultan',
        save_paths: []
      })
    )
    const archived = insertGame(
      d as any,
      payload({
        exe_path: 'D:\\Games\\Old\\old.exe',
        name_zh: '某老游戏',
        category: '其他',
        tags: [],
        source_dir: 'D:\\Games\\Old'
      })
    )
    updateGame(d as any, rpg.id, { play_status: 'playing', total_playtime_sec: 7200 })
    updateGame(d as any, archived.id, { is_archived: true })
    return d
  }

  await check('列表默认排在最近游玩的那个前面，归档的不混进来', () => {
    const d = stocked()
    const list = listGames(d as any)
    assert.equal(list.length, 3, '归档的那条不该出现在默认列表里')
    // 只有「苏丹的游戏」被 updateGame 动过 last_played_at 之外的字段，
    // 但它的 play_status 是 playing —— 排序看的是 last_played_at，都为 0 时按加入时间
    assert.ok(!list.some((g) => g.name_zh === '某老游戏'))

    const archived = listGames(d as any, { group: 'archived' })
    assert.deepEqual(archived.map((g) => g.name_zh), ['某老游戏'])
    d.close()
  })

  await check('按分类 / 状态 / 标签 / 关键词筛，各筛各的', () => {
    const d = stocked()
    assert.equal(listGames(d as any, { category: '动作' }).length, 2)
    assert.deepEqual(
      listGames(d as any, { status: 'playing' }).map((g) => g.name_zh),
      ['苏丹的游戏']
    )
    assert.deepEqual(
      listGames(d as any, { tag: '高难度' }).map((g) => g.name_zh),
      ['蔚蓝']
    )
    // 关键词要能命中英文名
    assert.deepEqual(
      listGames(d as any, { keyword: 'Celeste' }).map((g) => g.name_zh),
      ['蔚蓝']
    )
    d.close()
  })

  await check('标签筛选带引号匹配：「像素」不会把「像素风」也捞进来', () => {
    const d = freshDb()
    insertGame(d as any, payload({ tags: ['像素风'] }))
    assert.equal(listGames(d as any, { tag: '像素' }).length, 0)
    assert.equal(listGames(d as any, { tag: '像素风' }).length, 1)
    d.close()
  })

  await check('按时长排序把玩得最多的排在最前', () => {
    const d = stocked()
    assert.equal(listGames(d as any, { sort: 'playtime' })[0].name_zh, '苏丹的游戏')
    d.close()
  })

  await check('统计：四个状态是闭集，一个都不能缺；归档的不进分类和标签', () => {
    const d = stocked()
    const c = gameCounts(d as any)
    assert.equal(c.all, 3)
    assert.equal(c.archived, 1)
    assert.deepEqual(Object.keys(c.status).sort(), ['completed', 'playing', 'shelved', 'unplayed'])
    assert.equal(c.status.playing, 1)
    assert.equal(c.status.unplayed, 2)
    assert.equal(c.status.completed, 0, '一个都没有的状态也要报 0，不能缺这个键')

    // 归档的那条分类是「其他」，不该出现在侧边栏
    assert.ok(!c.categories.some((x) => x.name === '其他'), '归档的条目混进分类统计了')
    assert.deepEqual(
      c.categories.find((x) => x.name === '动作'),
      { name: '动作', count: 2 }
    )
    assert.equal(c.tags.find((t) => t.name === '像素')?.count, 2)
    d.close()
  })

  await check('存档状态三分：没路径 / 有路径没备份 / 备过了，互斥且穷尽', () => {
    const d = stocked()
    // stocked() 里「苏丹的游戏」的 save_paths 是空的，另外两条非归档的都有路径
    const sultan = listGames(d as any, { save: 'none' })
    assert.deepEqual(sultan.map((g) => g.name_zh), ['苏丹的游戏'])
    assert.equal(listGames(d as any, { save: 'unbacked' }).length, 2)
    assert.equal(listGames(d as any, { save: 'backed' }).length, 0)

    // 给「蔚蓝」记一份备份，它应当从 unbacked 挪到 backed
    const celeste = listGames(d as any).find((g) => g.name_zh === '蔚蓝')!
    d.prepare(
      `INSERT INTO save_backups
         (id, resource_id, save_path, backup_dir, size_bytes, file_count, created_at)
       VALUES ('b1', ?, ?, 'D:\\\\bak\\\\x', 10, 1, 1)`
    ).run(celeste.id, celeste.save_paths[0].path)

    assert.deepEqual(
      listGames(d as any, { save: 'backed' }).map((g) => g.name_zh),
      ['蔚蓝']
    )
    assert.equal(listGames(d as any, { save: 'unbacked' }).length, 1)

    // 三格加起来必须等于全部：漏一格就意味着有游戏在侧边栏里点不到
    const c = gameCounts(d as any)
    assert.deepEqual(Object.keys(c.save).sort(), ['backed', 'none', 'unbacked'])
    assert.equal(c.save.none + c.save.unbacked + c.save.backed, c.all, '三格之和不等于全部')
    assert.equal(c.save.backed, 1)
    d.close()
  })

  await check('存档状态筛选和侧边栏计数用的是同一份判断，不会一边说 3 一边列 4', () => {
    const d = stocked()
    const c = gameCounts(d as any)
    for (const s of ['none', 'unbacked', 'backed'] as const) {
      assert.equal(
        listGames(d as any, { save: s }).length,
        c.save[s],
        `${s} 的计数和列表不一致`
      )
    }
    d.close()
  })

  await check('归档的游戏不进存档统计 —— 和分类标签同一个口径', () => {
    const d = stocked()
    // 归档那条是 payload() 的默认值，带存档路径且没备份，若被算进来 unbacked 会是 3
    assert.equal(gameCounts(d as any).save.unbacked, 2)
    d.close()
  })

  await check('updateGame 分得清哪些字段落在总表、哪些落在 game_meta', () => {
    const d = freshDb()
    const { id } = insertGame(d as any, payload())
    const out = updateGame(d as any, id, {
      name_zh: '改过的名字',
      tags: ['魂系', '高难度'],
      play_status: 'completed',
      total_playtime_sec: 3600
    })!
    assert.equal(out.name_zh, '改过的名字')
    assert.deepEqual(out.tags, ['魂系', '高难度'])
    assert.equal(out.play_status, 'completed')
    assert.equal(out.total_playtime_sec, 3600)
    d.close()
  })

  await check('updateGame 只认白名单里的列，patch 里的野键不会拼进 SQL', () => {
    const d = freshDb()
    const { id } = insertGame(d as any, payload())
    // 渲染进程递过来的键名直接进 SQL 就是一条注入口子，白名单挡的就是这个
    const out = updateGame(d as any, id, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ 'name_zh = 1, path': 'X' } as any),
      summary: '改了简介'
    })!
    assert.equal(out.summary, '改了简介')
    assert.equal(out.path, 'D:\\Games\\HK\\hollow_knight.exe', '路径被野键改掉了')
    d.close()
  })

  await check('is_archived 在库里是 0/1，读出来是布尔', () => {
    const d = freshDb()
    const { id } = insertGame(d as any, payload())
    assert.equal(getGame(d as any, id)!.is_archived, false)
    assert.equal(updateGame(d as any, id, { is_archived: true })!.is_archived, true)
    assert.equal(
      (d.prepare('SELECT is_archived FROM resource WHERE id = ?').get(id) as any).is_archived,
      1,
      '布尔要落成 0/1，不能落成 "true"'
    )
    d.close()
  })

  await check('库里的 JSON 列坏掉时退回空数组，不让一行坏数据打不开整个游戏库', () => {
    const d = freshDb()
    const { id } = insertGame(d as any, payload())
    d.prepare('UPDATE resource SET tags = ? WHERE id = ?').run('{不是数组', id)
    d.prepare('UPDATE game_meta SET save_paths = ? WHERE resource_id = ?').run('null', id)
    const g = getGame(d as any, id)!
    assert.deepEqual(g.tags, [])
    assert.deepEqual(g.save_paths, [])
    d.close()
  })

  await check('移除一个游戏会带走 game_meta，但不碰存档备份记录', () => {
    const d = freshDb()
    const { id } = insertGame(d as any, payload())
    d.prepare(
      `INSERT INTO save_backups (id, resource_id, save_path, backup_dir, created_at)
       VALUES ('b1', ?, 'C:\\x\\save', 'C:\\备份\\hk-2026', 1)`
    ).run(id)

    deleteGame(d as any, id)
    assert.equal(getGame(d as any, id), null)
    assert.equal(
      (d.prepare('SELECT COUNT(*) AS n FROM game_meta').get() as any).n,
      0,
      'game_meta 没跟着删'
    )
    // 备份记录指向磁盘上真实存在的一份拷贝，删记录只会让用户再也找不到它们
    assert.equal(
      (d.prepare('SELECT COUNT(*) AS n FROM save_backups').get() as any).n,
      1,
      '把用户的存档备份记录一起删了'
    )
    d.close()
  })

  await fsp.rm(base, { recursive: true, force: true })
}

/* ==================== 存档备份 · Step 5 ==================== */

/**
 * 备份和还原是游戏模块里唯一会改写用户磁盘的一段，所以这一节全部跑**真实临时目录**。
 * 用 fs mock 验它等于在验 mock 自己 —— 而这里要防的恰恰是真实文件系统的行为：
 * 目标被占用、改名失败、复制到一半断掉。
 */
async function saveBackupSection(): Promise<void> {
  console.log('\n存档备份 · 命名与护栏')

  const HK: GameLike = {
    id: 'aabbccddeeff',
    name_zh: '空洞骑士',
    name_en: 'Hollow Knight',
    file_name: 'hollow_knight.exe'
  }

  await check('时间戳用本地时间，不是 UTC —— 用户在资源管理器里看的是这个', () => {
    // 本地时间构造，所以断言也用本地取值，不写死时区
    const at = new Date(2026, 7, 29, 14, 30, 12).getTime()
    assert.equal(stamp(at), '20260829-143012')
    // 个位数月份日期要补零，否则字典序排出来是乱的
    assert.equal(stamp(new Date(2026, 0, 5, 9, 8, 7).getTime()), '20260105-090807')
  })

  await check('游戏文件夹名带 id 尾巴 —— 改名之后旧备份不会变成孤儿目录', () => {
    assert.equal(gameFolder(HK), '空洞骑士_aabbcc')
    // 改了名，尾巴不变，所以新备份还落在同一个文件夹里
    assert.equal(gameFolder({ ...HK, name_zh: '空洞骑士（重制）' }), '空洞骑士（重制）_aabbcc')
    // 名字里的非法字符要洗掉，否则目录根本建不出来
    assert.equal(gameFolder({ ...HK, name_zh: 'A/B:C?' }), 'ABC_aabbcc')
    // 一个名字都没有时退回主程序名，再退回兜底
    assert.equal(
      gameFolder({ id: '123456', name_zh: '', name_en: '', file_name: 'game.exe' }),
      'game_123456'
    )
  })

  await check('备份目录名带存档目录名 —— 一个游戏有好几条存档路径时才分得清', () => {
    const at = new Date(2026, 7, 29, 14, 30, 12).getTime()
    assert.equal(backupFolder('C:\\Users\\x\\AppData\\LocalLow\\TC\\HK', at), '20260829-143012_HK')
    assert.equal(backupFolder('D:\\Games\\HK\\save\\', at), '20260829-143012_save')
    assert.equal(backupFolder('D:\\', at), '20260829-143012_save', '盘根没有 basename，要有兜底')
  })

  await check('还原护栏：盘根、系统目录、包着备份根的路径一律拒绝', () => {
    const root = 'D:\\备份'
    const win = process.env.SystemRoot || 'C:\\Windows'

    assert.equal(restoreBlocked('D:\\Games\\HK\\save', root), '', '正常路径不该被拦')

    assert.match(restoreBlocked('', root), /没有记下存档路径/)
    assert.match(restoreBlocked('   ', root), /没有记下存档路径/)
    assert.match(restoreBlocked('save\\HK', root), /不是绝对路径/)
    assert.match(restoreBlocked('D:\\', root), /盘根/)
    assert.match(restoreBlocked('\\\\server\\share', root), /盘根/, '整个网络共享和整个盘一样坏')
    // 裸盘符是「D 盘上的当前目录」而不是盘根 —— 含义取决于进程 cwd，
    // 所以按「不是绝对路径」拒掉才对，猜它指哪儿本身就是错的
    assert.match(restoreBlocked('D:', root), /不是绝对路径/)
    assert.match(restoreBlocked(path.join(win, 'System32'), root), /系统目录/)
    assert.match(restoreBlocked(win, root), /系统目录/)
    assert.match(
      restoreBlocked(process.env.ProgramData || 'C:\\ProgramData', root),
      /系统目录/
    )

    // 这一条是最要紧的：备份根在还原目标里面，还原第一步就会删掉备份自己
    assert.match(restoreBlocked('D:\\', 'D:\\备份'), /盘根/)
    assert.match(restoreBlocked('D:\\资料', 'D:\\资料\\备份'), /备份本身/)
    // 反过来不拦：存档在备份根里面是奇怪但不致命的，备份那一层会单独拒它
    assert.equal(restoreBlocked('D:\\备份\\某游戏存档', 'D:\\备份'), '')
  })

  await check('盘根判断：两种分隔符和 UNC 共享根都认，裸盘符刻意不认', () => {
    assert.equal(isDriveRoot('D:\\'), true)
    assert.equal(isDriveRoot('d:/'), true)
    assert.equal(isDriveRoot('\\\\server\\share'), true, 'UNC 共享根也是「一整个」')
    assert.equal(isDriveRoot('D:\\Games'), false)
    assert.equal(isDriveRoot('D:\\Games\\'), false)
    // 裸盘符是 cwd 相对的，resolve 出来是个普通目录。这里返回 false 是诚实的 ——
    // 拦它是 restoreBlocked 里「不是绝对路径」那一条的职责
    assert.equal(isDriveRoot('D:'), false)
  })

  await check('路径包含判断把正斜杠也算上 —— 库里的路径两种分隔符都有', () => {
    // 原来只比 `\`，于是 D:/备份 这种写法整个漏过去，护栏形同不存在
    assert.equal(nestedInsideShared('D:\\备份', 'D:/备份/游戏'), true)
    assert.equal(nestedInsideShared('D:/备份', 'D:\\备份\\游戏'), true)
    assert.equal(nestedInsideShared('D:\\备份', 'D:\\备份2\\游戏'), false, '同前缀的兄弟目录不算')
  })

  /* ==================== 真实磁盘 ==================== */
  console.log('\n存档备份 · 备份与还原（真实磁盘）')

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-bk-'))
  const backupRoot = path.join(base, '备份根')
  await fsp.mkdir(backupRoot, { recursive: true })

  const freshDb = (): InstanceType<typeof DatabaseSync> => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    return d
  }

  /** 铺一个存档目录：两个文件 + 一层子目录 */
  const makeSave = async (name: string, body = 'save-v1'): Promise<string> => {
    const dir = path.join(base, name)
    await fsp.mkdir(path.join(dir, 'slots'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'user1.dat'), body)
    await fsp.writeFile(path.join(dir, 'slots', 'slot1.sav'), `${body}-slot`)
    return dir
  }

  await check('备份一次：拷贝完整、说明文件在载荷之外、库里记一行', async () => {
    const d = freshDb()
    const save = await makeSave('存档A')
    const r = await createBackup(d as any, HK, save, { backupRoot })
    assert.ok(r.ok, `备份失败：${r.message}`)
    const b = r.backup!

    // 拷贝在 save/ 子目录里，一个文件不少
    assert.equal(await fsp.readFile(path.join(b.backup_dir, PAYLOAD, 'user1.dat'), 'utf-8'), 'save-v1')
    assert.equal(
      await fsp.readFile(path.join(b.backup_dir, PAYLOAD, 'slots', 'slot1.sav'), 'utf-8'),
      'save-v1-slot'
    )
    // 说明文件必须在载荷**之外** —— 在里面的话还原时会被复制进用户的存档目录
    assert.ok(fs.existsSync(path.join(b.backup_dir, MANIFEST)), '说明文件没写出来')
    assert.equal(
      fs.existsSync(path.join(b.backup_dir, PAYLOAD, MANIFEST)),
      false,
      '说明文件写进载荷了，还原时会污染用户的存档目录'
    )

    // 体量按拷贝算
    assert.equal(b.file_count, 2)
    assert.equal(b.size_bytes, 'save-v1'.length + 'save-v1-slot'.length)
    // 目录落在「游戏名_id / 时间戳_存档名」下
    assert.equal(path.basename(path.dirname(b.backup_dir)), '空洞骑士_aabbcc')

    assert.deepEqual(listBackups(d as any, HK.id).map((x) => x.id), [b.id])
    d.close()
  })

  await check('同一秒备两次不合并，第二份让位到 -2', async () => {
    const d = freshDb()
    const save = await makeSave('存档B')
    const now = Date.now()
    const first = await createBackup(d as any, HK, save, { backupRoot, now })
    const second = await createBackup(d as any, HK, save, { backupRoot, now })
    assert.ok(first.ok && second.ok, '两次都该成功')
    assert.notEqual(first.backup!.backup_dir, second.backup!.backup_dir, '第二份覆盖了第一份')
    assert.match(second.backup!.backup_dir, /-2$/)
    // 两份都是完整的，不是一份被合并进另一份
    assert.equal(listBackups(d as any, HK.id).length, 2)
    d.close()
  })

  await check('空存档目录不备份 —— 备一份空的等于让用户以为自己有备份', async () => {
    const d = freshDb()
    const empty = path.join(base, '空存档')
    await fsp.mkdir(empty, { recursive: true })
    const r = await createBackup(d as any, HK, empty, { backupRoot })
    assert.equal(r.ok, false)
    assert.match(r.message, /一个文件都没有/)
    assert.equal(listBackups(d as any, HK.id).length, 0, '失败了却记了一行')
    d.close()
  })

  await check('存档目录不存在时给出可读的原因，不抛异常也不记账', async () => {
    const d = freshDb()
    const r = await createBackup(d as any, HK, path.join(base, '并不存在'), { backupRoot })
    assert.equal(r.ok, false)
    assert.match(r.message, /不在了/)
    assert.equal(listBackups(d as any, HK.id).length, 0)
    d.close()
  })

  await check('没设备份根时明说去哪儿设，而不是往当前目录乱写', async () => {
    const d = freshDb()
    const save = await makeSave('存档C')
    const r = await createBackup(d as any, HK, save, { backupRoot: '' })
    assert.equal(r.ok, false)
    assert.match(r.message, /备份目录/)
    d.close()
  })

  await check('存档目录和备份根互相嵌套时拒绝 —— 否则一边读一边往自己里面写', async () => {
    const d = freshDb()
    // 存档在备份根里面
    const inside = path.join(backupRoot, '某游戏存档')
    await fsp.mkdir(inside, { recursive: true })
    await fsp.writeFile(path.join(inside, 'a.sav'), 'x')
    const r1 = await createBackup(d as any, HK, inside, { backupRoot })
    assert.equal(r1.ok, false)
    assert.match(r1.message, /自我嵌套/)

    // 备份根在存档里面
    const outer = await makeSave('存档D')
    const r2 = await createBackup(d as any, HK, outer, { backupRoot: path.join(outer, '备份') })
    assert.equal(r2.ok, false)
    assert.match(r2.message, /自我嵌套/)
    d.close()
  })

  await check('还原：先自动备份当前存档，再把旧内容换回来', async () => {
    const d = freshDb()
    const save = await makeSave('存档E', 'save-v1')
    const made = await createBackup(d as any, HK, save, { backupRoot })
    assert.ok(made.ok)

    // 玩了一会儿，存档变了，还多了一个文件
    await fsp.writeFile(path.join(save, 'user1.dat'), 'save-v2')
    await fsp.writeFile(path.join(save, 'user2.dat'), 'new-slot')

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.ok(r.ok, `还原失败：${r.message}`)

    // 旧内容回来了
    assert.equal(await fsp.readFile(path.join(save, 'user1.dat'), 'utf-8'), 'save-v1')
    // 还原是**替换**而不是合并：备份里没有的文件不该留下来
    assert.equal(fs.existsSync(path.join(save, 'user2.dat')), false, '还原成了合并，不是替换')
    assert.equal(
      await fsp.readFile(path.join(save, 'slots', 'slot1.sav'), 'utf-8'),
      'save-v1-slot'
    )

    // 这是还原敢做的全部理由：还原前那一刻的存档必须留了一份
    assert.ok(r.safety, '没有自动备份当前存档')
    assert.equal(
      await fsp.readFile(path.join(r.safety!.backup_dir, PAYLOAD, 'user1.dat'), 'utf-8'),
      'save-v2',
      '自动备份里不是还原前的内容'
    )
    assert.ok(
      fs.existsSync(path.join(r.safety!.backup_dir, PAYLOAD, 'user2.dat')),
      '还原前多出来的那个文件没被备份下来'
    )
    // 自动备份也进列表：用户得看得见它，才能再还原回来
    assert.equal(listBackups(d as any, HK.id).length, 2)

    // 临时目录不许留下来
    for (const suffix of ['.baoyi_restore_tmp', '.baoyi_replaced_tmp']) {
      assert.equal(fs.existsSync(`${save}${suffix}`), false, `${suffix} 没清掉`)
    }
    d.close()
  })

  await check('存档目录已被删掉时，还原直接建出来，不需要先有个空目录', async () => {
    const d = freshDb()
    const save = await makeSave('存档F')
    const made = await createBackup(d as any, HK, save, { backupRoot })
    await fsp.rm(save, { recursive: true, force: true })

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.ok(r.ok, `还原失败：${r.message}`)
    assert.equal(await fsp.readFile(path.join(save, 'user1.dat'), 'utf-8'), 'save-v1')
    // 没有当前存档可备，safety 就该是 null，而不是一份空备份
    assert.equal(r.safety, null, '给一个不存在的存档做了「还原前备份」')
    d.close()
  })

  await check('备份内容被手工删掉时，还原拒绝执行且不碰当前存档', async () => {
    const d = freshDb()
    const save = await makeSave('存档G', 'live')
    const made = await createBackup(d as any, HK, save, { backupRoot })
    await fsp.rm(made.backup!.backup_dir, { recursive: true, force: true })

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.equal(r.ok, false)
    assert.match(r.message, /已经不在磁盘上/)
    // 当前存档必须完好 —— 这一条挡的是「还原到一个空目录」
    assert.equal(await fsp.readFile(path.join(save, 'user1.dat'), 'utf-8'), 'live')
    assert.equal(r.safety, null, '备份都没了还去动当前存档')
    d.close()
  })

  await check('游戏条目已被移除，备份照样能还原 —— 用户要的是存档，不是库里那一行', async () => {
    const d = freshDb()
    const save = await makeSave('存档H', 'orphan-v1')
    const made = await createBackup(d as any, HK, save, { backupRoot })
    await fsp.writeFile(path.join(save, 'user1.dat'), 'orphan-v2')

    // game 传 null：模拟条目已从库里移除（save_backups 刻意没有外键）
    const r = await restoreBackup(d as any, made.backup!.id, null, { backupRoot })
    assert.ok(r.ok, `还原失败：${r.message}`)
    assert.equal(await fsp.readFile(path.join(save, 'user1.dat'), 'utf-8'), 'orphan-v1')
    // 自动备份也得落下来，只是名字退回存档目录名
    assert.ok(r.safety, '孤儿备份还原时没有自动备份当前存档')
    assert.match(path.dirname(r.safety!.backup_dir), /存档H_orphan$/)
    d.close()
  })

  await check('上一次还原留下的临时目录会挡住这一次，并说清该清理哪个', async () => {
    const d = freshDb()
    const save = await makeSave('存档I', 'keep')
    const made = await createBackup(d as any, HK, save, { backupRoot })

    const stale = `${save}.baoyi_restore_tmp`
    await fsp.mkdir(stale, { recursive: true })

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.equal(r.ok, false)
    assert.match(r.message, /已存在/)
    assert.match(r.message, /手工清理/)
    // 当前存档不能被动
    assert.equal(await fsp.readFile(path.join(save, 'user1.dat'), 'utf-8'), 'keep')
    await fsp.rm(stale, { recursive: true, force: true })
    d.close()
  })

  await check('删一份备份：磁盘上的拷贝和库里的记录一起走', async () => {
    const d = freshDb()
    const save = await makeSave('存档J')
    const made = await createBackup(d as any, HK, save, { backupRoot })
    const dir = made.backup!.backup_dir

    const r = await deleteBackup(d as any, made.backup!.id)
    assert.ok(r.ok, r.message)
    assert.equal(fs.existsSync(dir), false, '磁盘上的拷贝没删掉')
    assert.equal(listBackups(d as any, HK.id).length, 0, '记录没删掉')
    // 删备份不该碰源存档
    assert.ok(fs.existsSync(path.join(save, 'user1.dat')), '把用户的存档删了')
    d.close()
  })

  await check('备份目录已经不在时，删记录照样成功 —— 否则那一行永远删不掉', async () => {
    const d = freshDb()
    const save = await makeSave('存档K')
    const made = await createBackup(d as any, HK, save, { backupRoot })
    await fsp.rm(made.backup!.backup_dir, { recursive: true, force: true })

    const r = await deleteBackup(d as any, made.backup!.id)
    assert.ok(r.ok, r.message)
    assert.equal(listBackups(d as any, HK.id).length, 0)
    d.close()
  })

  /* ---------------- 单文件存档：老游戏 / RPG Maker / 模拟器 ---------------- */

  await check('单个文件的存档也备得下来 —— 老游戏常常就是一个 .sav', async () => {
    const d = freshDb()
    const file = path.join(base, '单文件', 'user1.sav')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, 'single-v1')

    const r = await createBackup(d as any, HK, file, { backupRoot })
    assert.ok(r.ok, `单文件存档没能备份：${r.message}`)
    // 载荷永远是个目录，单文件放在里面 —— 于是还原、删除、算体量只有一种形状
    assert.equal(
      await fsp.readFile(path.join(r.backup!.backup_dir, PAYLOAD, 'user1.sav'), 'utf-8'),
      'single-v1'
    )
    assert.equal(r.backup!.file_count, 1)
    assert.equal(r.backup!.size_bytes, 'single-v1'.length)
    d.close()
  })

  await check('空文件不备份，理由和空目录同一条', async () => {
    const d = freshDb()
    const file = path.join(base, '空文件', 'empty.sav')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, '')
    const r = await createBackup(d as any, HK, file, { backupRoot })
    assert.equal(r.ok, false)
    assert.match(r.message, /空的/)
    d.close()
  })

  await check('还原单文件存档：写回的是文件本身，不是一个同名目录', async () => {
    const d = freshDb()
    const file = path.join(base, '单文件还原', 'save.dat')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, 'v1')

    const made = await createBackup(d as any, HK, file, { backupRoot })
    assert.ok(made.ok, made.message)
    await fsp.writeFile(file, 'v2-played-further')

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.ok(r.ok, `还原失败：${r.message}`)
    // 最要紧的一条：它必须还是一个文件。写成目录的话游戏当场读不到存档
    assert.ok((await fsp.stat(file)).isFile(), '单文件存档被还原成了一个目录')
    assert.equal(await fsp.readFile(file, 'utf-8'), 'v1')
    d.close()
  })

  await check('单文件存档还原前也要自动备份 —— 否则覆盖了就再也回不去', async () => {
    const d = freshDb()
    const file = path.join(base, '单文件退路', 'slot.sav')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, 'old')

    const made = await createBackup(d as any, HK, file, { backupRoot })
    await fsp.writeFile(file, 'current-progress')

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.ok(r.ok, `还原失败：${r.message}`)
    // 这一条是回归测试：判断「当前存档有没有东西」原先只用 walkTree，
    // 而 walkTree 对着一个文件会抛，异常被吞掉后结论是「不用备份」——
    // 单文件存档于是被直接覆盖，还原这一步的退路整个消失
    assert.ok(r.safety, '单文件存档还原前没有自动备份，覆盖之后回不去了')
    assert.equal(
      await fsp.readFile(path.join(r.safety!.backup_dir, PAYLOAD, 'slot.sav'), 'utf-8'),
      'current-progress',
      '自动备份里不是还原前那一刻的内容'
    )
    // 还原回来的是备份里那份
    assert.equal(await fsp.readFile(file, 'utf-8'), 'old')
    d.close()
  })

  await check('说明文件被删掉时，靠载荷形状也能认出这是单文件存档', async () => {
    const d = freshDb()
    const file = path.join(base, '无说明文件', 'q.sav')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, 'q1')

    const made = await createBackup(d as any, HK, file, { backupRoot })
    // 手工删掉说明文件，模拟用户清理过备份目录
    await fsp.rm(path.join(made.backup!.backup_dir, MANIFEST), { force: true })
    await fsp.writeFile(file, 'q2')

    const r = await restoreBackup(d as any, made.backup!.id, HK, { backupRoot })
    assert.ok(r.ok, `还原失败：${r.message}`)
    assert.ok((await fsp.stat(file)).isFile(), '没有说明文件时把单文件存档还原成了目录')
    assert.equal(await fsp.readFile(file, 'utf-8'), 'q1')
    d.close()
  })

  await check('备份列表新的在前', async () => {
    const d = freshDb()
    const save = await makeSave('存档L')
    const now = Date.now()
    await createBackup(d as any, HK, save, { backupRoot, now: now - 86_400_000 })
    await createBackup(d as any, HK, save, { backupRoot, now })
    const list = listBackups(d as any, HK.id)
    assert.equal(list.length, 2)
    assert.ok(list[0].created_at > list[1].created_at, '旧的排在前面了')
    d.close()
  })

  console.log('\n存档备份 · 保留上限')

  await check('超出上限时报出最早的那几份，且一个字节都不删', async () => {
    const d = freshDb()
    const save = await makeSave('存档M')
    const now = Date.now()
    for (let i = 0; i < 4; i++) {
      await createBackup(d as any, HK, save, { backupRoot, now: now - (4 - i) * 86_400_000 })
    }
    const over = overRetention(d as any, HK.id, path.resolve(save), 2)
    assert.equal(over.length, 2, '4 份留 2 份，该报 2 份超额')
    assert.ok(over[0].created_at < over[1].created_at, '报出来的顺序该是从最早开始')
    // 关键的一条：只回答问题，不动手
    assert.equal(listBackups(d as any, HK.id).length, 4, 'overRetention 删了东西')
    for (const b of over) {
      assert.ok(fs.existsSync(b.backup_dir), '磁盘上的拷贝被 overRetention 删掉了')
    }
    d.close()
  })

  await check('刚好等于上限不算超，少于上限也不算', async () => {
    const d = freshDb()
    const save = await makeSave('存档N')
    const now = Date.now()
    await createBackup(d as any, HK, save, { backupRoot, now: now - 86_400_000 })
    await createBackup(d as any, HK, save, { backupRoot, now })
    assert.deepEqual(overRetention(d as any, HK.id, path.resolve(save), 2), [], '等于上限不该报')
    assert.deepEqual(overRetention(d as any, HK.id, path.resolve(save), 5), [], '少于上限不该报')
    d.close()
  })

  await check('上限填 0 或填了不成立的值都当不限，永不提示', async () => {
    const d = freshDb()
    const save = await makeSave('存档O')
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      await createBackup(d as any, HK, save, { backupRoot, now: now - (3 - i) * 86_400_000 })
    }
    for (const keep of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(overRetention(d as any, HK.id, path.resolve(save), keep), [], `keep=${keep}`)
    }
    d.close()
  })

  await check('上限按「每条存档路径」算，不是每个游戏 —— 两条路径各留各的', async () => {
    const d = freshDb()
    const a = await makeSave('存档P1')
    const b = await makeSave('存档P2')
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      await createBackup(d as any, HK, a, { backupRoot, now: now - (3 - i) * 86_400_000 })
    }
    await createBackup(d as any, HK, b, { backupRoot, now })

    // 同一个游戏名下一共 4 份，但按路径分开算：a 超 1 份，b 一份没超
    assert.equal(overRetention(d as any, HK.id, path.resolve(a), 2).length, 1)
    assert.deepEqual(overRetention(d as any, HK.id, path.resolve(b), 2), [])
    d.close()
  })

  await fsp.rm(base, { recursive: true, force: true })
}

/* ==================== 存档查表 · 第三层 ==================== */

async function saveDbSection(): Promise<void> {
  console.log('\n存档查表 · 模板截断')

  await check('认得的占位符整条留下', () => {
    assert.equal(
      truncateTemplate('<winAppData>/Team Cherry/Hollow Knight'),
      '<winAppData>/Team Cherry/Hollow Knight'
    )
  })

  await check('在第一个认不得的段上截断，保留祖先目录', () => {
    // 这两条就是当初被整条丢掉的艾尔登法环和空洞骑士
    assert.equal(truncateTemplate('<winAppData>/EldenRing/<storeUserId>'), '<winAppData>/EldenRing')
    assert.equal(
      truncateTemplate('<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat'),
      '<home>/AppData/LocalLow/Team Cherry/Hollow Knight'
    )
  })

  await check('截断有下限：砍完只剩占位符根的整条丢掉', () => {
    // 否则 %APPDATA% 整个 Roaming 会被当成某个游戏的存档目录备走
    assert.equal(truncateTemplate('<winAppData>/<storeUserId>'), '')
    assert.equal(truncateTemplate('<home>/*'), '')
    assert.equal(truncateTemplate('<winDocuments>'), '')
  })

  await check('第一段就认不得的整条丢掉 —— Linux / Mac 的那些根', () => {
    assert.equal(truncateTemplate('<root>/saves'), '')
    assert.equal(truncateTemplate('<xdgData>/foo/bar'), '')
    assert.equal(truncateTemplate('<xdgConfig>/x'), '')
  })

  console.log('\n存档查表 · 名字归一')

  await check('大小写、空格、标点抹平，同一个游戏的几种写法归到一个键', () => {
    const want = normalizeGameName('Elden Ring')
    for (const variant of ['ELDEN RING', 'elden ring', 'Elden Ring™', ' Elden  Ring ', 'Elden-Ring']) {
      assert.equal(normalizeGameName(variant), want, `${variant} 没归到同一个键`)
    }
  })

  await check('中日韩字符保留 —— 按 \\w 过滤会把「原神」整个抹成空串', () => {
    assert.equal(normalizeGameName('原神'), '原神')
    assert.equal(normalizeGameName('苏丹的游戏'), '苏丹的游戏')
    assert.ok(normalizeGameName('ぼくのなつやすみ').length > 0)
  })

  await check('罗马数字刻意不转 —— 这是已知取舍，不是漏洞', () => {
    assert.notEqual(normalizeGameName('Final Fantasy VII'), normalizeGameName('Final Fantasy 7'))
  })

  console.log('\n存档查表 · 展开与查表')

  /** 一份手写的小索引，形状和编译出来的那份一样 */
  const miniDb: SaveDbHandle = {
    format: 1,
    source: 'selfcheck',
    built_at: new Date(0).toISOString(),
    games: {
      eldenring: { name: 'Elden Ring', paths: ['<winAppData>/EldenRing/<storeUserId>'] },
      hollowknight: {
        name: 'Hollow Knight',
        paths: [
          '<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat',
          '<home>/AppData/LocalLow/Team Cherry/Hollow Knight'
        ]
      },
      celeste: {
        name: 'Celeste',
        paths: ['<base>/Saves', '<base>/Saves/debug.celeste']
      },
      onlybase: { name: 'Only Base', paths: ['<base>/Data'] },
      unexpandable: { name: 'Unexpandable', paths: ['<xdgData>/foo'] }
    }
  }
  const HOME = 'C:\\Users\\sc'
  const ctx = { home: HOME }

  await check('占位符展开成真实路径，分隔符归一到反斜杠', () => {
    const out = expandTemplate('<home>/AppData/LocalLow/Team Cherry/Hollow Knight', ctx)
    assert.equal(out, path.resolve(`${HOME}\\AppData\\LocalLow\\Team Cherry\\Hollow Knight`))
    assert.ok(!out.includes('/'), '正斜杠没归一，路径会和库里其他路径长得不一样')
  })

  await check('<base> 只有调用方给了安装目录才展开，没给就展不开', () => {
    assert.equal(expandTemplate('<base>/Saves', ctx), '')
    assert.equal(
      expandTemplate('<base>/Saves', { ...ctx, base: 'D:\\Games\\Celeste' }),
      path.resolve('D:\\Games\\Celeste\\Saves')
    )
  })

  await check('查表按名字命中，报出索引里的原名', () => {
    const hit = lookupSavePaths(miniDb, ['艾尔登法环', 'ELDEN RING'], ctx)
    assert.ok(hit, '没命中')
    assert.equal(hit.matched, 'Elden Ring', '该报索引里的原名，用户才知道按哪个名字查到的')
    assert.equal(hit.paths.length, 1)
    assert.ok(hit.paths[0].endsWith('EldenRing'), '该截断到父目录，把所有档位都带上')
  })

  await check('多个名字按顺序试，第一个命中的就用它', () => {
    // 第一个名字查不到，第二个能查到
    const hit = lookupSavePaths(miniDb, ['某个不存在的游戏', 'Hollow Knight'], ctx)
    assert.equal(hit?.matched, 'Hollow Knight')
  })

  await check('落在别人里面的路径被丢掉 —— 备父目录已经把子路径带上了', () => {
    const hit = lookupSavePaths(miniDb, ['Celeste'], { ...ctx, base: 'D:\\Games\\Celeste' })
    assert.equal(hit?.paths.length, 1, 'Saves 和 Saves\\debug.celeste 都留下了')
    assert.ok(hit!.paths[0].endsWith('Saves'))
  })

  await check('截断之后重复的模板只留一条', () => {
    // Hollow Knight 两条模板截断后是同一个目录
    const hit = lookupSavePaths(miniDb, ['Hollow Knight'], ctx)
    assert.equal(hit?.paths.length, 1, '两条模板截出同一个目录，该去重')
  })

  await check('命中了但一条都展不开，等于没命中', () => {
    // onlybase 全是 <base>，没给安装目录时展不开
    assert.equal(lookupSavePaths(miniDb, ['Only Base'], ctx), null)
    // unexpandable 的模板第一段就认不得
    assert.equal(lookupSavePaths(miniDb, ['Unexpandable'], ctx), null)
  })

  await check('没有索引时返回 null，不抛 —— 前两层照样得能工作', () => {
    assert.equal(lookupSavePaths(null, ['Elden Ring'], ctx), null)
    assert.equal(lookupSavePaths(miniDb, [], ctx), null)
    assert.equal(lookupSavePaths(miniDb, ['', '  '], ctx), null, '空名字不该被当成键去查')
  })

  await check('查表结果只是候选，不带「已验证」的意思 —— 这一条守的是设计边界', () => {
    // 这一条守的是设计边界：lookupSavePaths 返回的路径可能根本不存在
    // （没装过这个游戏、装在别的账户下）。它必须再过 detect_save_path 那道验证。
    const hit = lookupSavePaths(miniDb, ['Elden Ring'], { home: 'Z:\\nobody' })
    assert.ok(hit, '路径不存在也照样返回 —— 存不存在由验证那一层说')
    assert.ok(hit.paths[0].startsWith('Z:\\nobody') || hit.paths[0].includes('EldenRing'))
  })
}

/* ==================== 存档发现回退 · 引擎规则（Step 7） ==================== */

/**
 * 这一节守的是「规则表和执行它的那两道门对得上」。
 *
 * 引擎规则是 prompt 里的一段文字，不是可执行代码，所以它出错的方式很特别：
 * 模型照着做了，然后 detect_save_path 当场拒掉 —— 一次探测额度白烧，而日志上
 * 只会看到一句「路径越界」。这类错在 typecheck 和实跑里都不显形（跑起来照样有
 * 结果，只是差了几次探测），只能在这儿守。
 */
async function engineRulesSection(): Promise<void> {
  console.log('\n存档发现回退 · 引擎规则')

  const home = os.homedir()
  /** 把 `<公司名>` 这类占位符换成一个具体名字，好让路径能真的展开 */
  const fill = (where: string): string => where.replace(/<[^>]+>/g, 'X')

  await check('每条规则至少给一个候选位置 —— 一条都没有的规则等于一句空话', () => {
    for (const rule of ENGINE_SAVE_RULES) {
      assert.ok(
        (rule.where?.length ?? 0) + (rule.in_game?.length ?? 0) > 0,
        `${rule.engine} 一个候选位置都没给`
      )
    }
  })

  await check('每条规则的变量都是 expandSavePath 认得的 —— 认不得的会原样留在路径里', () => {
    for (const rule of ENGINE_SAVE_RULES) {
      for (const where of rule.where ?? []) {
        const expanded = expandSavePath(fill(where), home)
        assert.ok(
          !expanded.includes('%'),
          `${rule.engine} 的「${where}」里有 expandSavePath 认不得的变量，展开后还剩：${expanded}`
        )
      }
    }
  })

  await check('每条规则都落在 saveRoots 白名单之内 —— 越界的会被 detect_save_path 当场拒掉', () => {
    // 这一条是这一节存在的主要理由。规则表里写一个 %PROGRAMFILES%\Steam\userdata
    // 看着很有道理，但那不在白名单里，模型照着做只会白烧一次探测额度
    const roots = saveRoots(home)
    for (const rule of ENGINE_SAVE_RULES) {
      for (const where of rule.where ?? []) {
        const expanded = expandSavePath(fill(where), home)
        assert.ok(
          saveRootOf(expanded, roots),
          `${rule.engine} 的「${where}」展开成 ${expanded}，不在 saveRoots 白名单里`
        )
      }
    }
  })

  await check('游戏目录内的候选写成相对路径 —— 绝对路径会指到别人的机器上去', () => {
    for (const rule of ENGINE_SAVE_RULES) {
      for (const where of rule.in_game ?? []) {
        assert.ok(
          !path.isAbsolute(where) && !where.includes('%'),
          `${rule.engine} 的 in_game 里「${where}」不是相对游戏目录的写法`
        )
      }
    }
  })

  await check('两处都写的引擎分成两个字段 —— 一个规则级的开关表达不了这件事', () => {
    // Ren'Py 和 KiriKiri 的主位置在 AppData，游戏目录里还留一份。第一版给整条规则
    // 挂了一个 in_game_dir 开关，于是这两个引擎必须二选一，自检当场抓出来了
    for (const name of ["Ren'Py", 'KiriKiri']) {
      const rule = ENGINE_SAVE_RULES.find((r) => r.engine === name)!
      assert.ok(rule.where?.length, `${name} 少了 AppData 那一半`)
      assert.ok(rule.in_game?.length, `${name} 少了游戏目录那一半`)
    }
  })

  await check('scanner 认得的引擎在规则表里都有对应规则', () => {
    // scanner 认出 GameMaker 却没有对应规则时，evidence 里那句「GameMaker 引擎」
    // 就成了一条模型用不上的线索 —— 它得自己回去猜位置，这一层等于没做
    const engines = ENGINE_SAVE_RULES.map((r) => r.engine)
    for (const word of ['Unity', 'Unreal', 'RPG Maker', 'GameMaker', "Ren'Py", 'Godot', 'KiriKiri', 'QSP', 'NW.js', 'Adobe AIR', 'Flash']) {
      assert.ok(engines.includes(word), `scanner 认得 ${word}，但规则表里没有它的存档位置`)
    }
  })

  await check('规则表里每个引擎，scanner 都真能认出来 —— 光有规则没有指纹等于没做', async () => {
    // 上面那条只比对一份手抄的词表，抄漏了它也不会响。这一条真去建目录、
    // 真跑 inspectDir，断言 evidence 里出现了引擎名。Flash/AIR 那两条就是这么补上的：
    // 先只加了规则，指纹没加，规则永远等不到人来用它
    const fp: Record<string, (d: string) => Promise<void>> = {
      Unity: async (d) => {
        await fsp.mkdir(path.join(d, 'Game_Data'), { recursive: true })
      },
      Unreal: async (d) => {
        await fsp.mkdir(path.join(d, 'Engine'), { recursive: true })
      },
      'RPG Maker': async (d) => {
        await fsp.writeFile(path.join(d, 'RGSS301.dll'), 'x')
      },
      GameMaker: async (d) => {
        await fsp.writeFile(path.join(d, 'data.win'), 'x')
      },
      "Ren'Py": async (d) => {
        await fsp.mkdir(path.join(d, 'renpy'), { recursive: true })
      },
      Godot: async (d) => {
        await fsp.writeFile(path.join(d, 'game.pck'), 'x')
      },
      KiriKiri: async (d) => {
        await fsp.writeFile(path.join(d, 'data.xp3'), 'x')
      },
      QSP: async (d) => {
        await fsp.writeFile(path.join(d, 'game.qsp'), 'x')
      },
      'NW.js': async (d) => {
        await fsp.writeFile(path.join(d, 'nw.dll'), 'x')
      },
      'Adobe AIR': async (d) => {
        await fsp.writeFile(path.join(d, 'Adobe AIR.dll'), 'x')
      },
      Flash: async (d) => {
        await fsp.writeFile(path.join(d, 'game.swf'), 'x')
      }
    }

    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-fp-'))
    try {
      for (const rule of ENGINE_SAVE_RULES) {
        const build = fp[rule.engine]
        assert.ok(build, `规则表里有 ${rule.engine}，但这条自检没给它准备指纹样本`)
        const dir = path.join(base, rule.engine.replace(/[^\w]/g, '_'))
        await fsp.mkdir(dir, { recursive: true })
        // inspectDir 要求目录里有 exe 才当候选，主程序名不影响引擎判断
        await fsp.writeFile(path.join(dir, 'game.exe'), 'x')
        await build(dir)

        const got = inspectDir(dir, base)
        assert.ok(got, `${rule.engine} 的样本目录没被 inspectDir 当成候选`)
        assert.ok(
          got.evidence.some((e) => e.includes(rule.engine)),
          `scanner 没在 evidence 里报出 ${rule.engine}，规则表里那条永远等不到人用：${JSON.stringify(got.evidence)}`
        )
      }
    } finally {
      await fsp.rm(base, { recursive: true, force: true })
    }
  })

  await check('Unity 那条和 scanner 从 app.info 拼出来的路径是同一个写法', () => {
    // 两处写法不一致（一处 %LOCALAPPDATA%Low、一处 %LOCALAPPDATA%\Low）时，模型
    // 会以为它们是两个不同的位置，于是把同一个地方验两次
    const unity = ENGINE_SAVE_RULES.find((r) => r.engine === 'Unity')!
    assert.ok(
      unity.where![0].startsWith('%LOCALAPPDATA%Low\\'),
      `Unity 的写法和 scanner 的 unityAppInfo 不一致：${unity.where![0]}`
    )
    // LocalLow 的真实拼法就是 Local 后面紧跟 Low，不是一个子目录
    const expanded = expandSavePath(fill(unity.where![0]), home)
    assert.ok(expanded.includes('LocalLow'), `没展开成 LocalLow：${expanded}`)
  })

  await check('规则表整个渲染进了 prompt，每条引擎和位置都在里面', () => {
    const filled = fillGameSystem(gameKind.defaultCategories, gameKind.defaultTags, true)
    assert.ok(!filled.includes('{{engine_rules}}'), '插槽没填')
    for (const rule of ENGINE_SAVE_RULES) {
      assert.ok(filled.includes(rule.engine), `${rule.engine} 没进 prompt`)
      for (const where of [...(rule.where ?? []), ...(rule.in_game ?? [])]) {
        assert.ok(filled.includes(where), `${rule.engine} 的「${where}」没进 prompt`)
      }
    }
    // 相对路径单看认不出该拼在哪儿，渲染时必须把「游戏目录下」说出来
    assert.ok(filled.includes('**游戏目录下**的'), 'in_game 那些候选没标明是相对游戏目录的')
  })

  await check('prompt 里「引擎规则也必须验」这句话在 —— 规则是「该在哪」，不是「在」', () => {
    // 加了一张很有把握的规则表之后，最大的新风险是模型觉得「引擎规则这么确定，
    // 不用验了吧」，然后填一个这台机器上根本不存在的路径。那正是备份一个空目录
    // 的来源，也是这一整层存在的理由被抽掉的那一刻
    const filled = fillGameSystem(gameKind.defaultCategories, gameKind.defaultTags, true)
    assert.ok(
      filled.includes('都必须过 detect_save_path'),
      '没有那句「不管从哪一步来的路径都要验」'
    )
    assert.ok(filled.includes('没验过就填等于编'), '没把后果说清')
  })

  await check('引擎规则排在按位置猜之前 —— 顺序本身就是那条策略', () => {
    const filled = fillGameSystem(gameKind.defaultCategories, gameKind.defaultTags, true)
    const byEngine = filled.indexOf('回退第一步：按引擎的规则推')
    const byGuess = filled.indexOf('回退第二步：按位置猜')
    const byLookup = filled.indexOf('lookup_save_paths')
    assert.ok(byEngine > 0 && byGuess > 0, '两节都得在')
    assert.ok(byLookup < byEngine, '查表该排在引擎规则之前 —— 查得到就不必推')
    assert.ok(byEngine < byGuess, '引擎规则该排在按位置猜之前')
  })
}

/* ==================== 关联文件与封面 · Step 7 ==================== */

async function linksAndCoverSection(): Promise<void> {
  console.log('\n关联文件 · 增删改')

  const link = (p: string, over: Partial<LinkedFile> = {}): LinkedFile => ({
    path: p,
    label: path.basename(p),
    type: 'other',
    ...over
  })

  await check('类型猜测保守：文档猜攻略、目录猜 MOD、exe 一律 other', () => {
    assert.equal(guessLinkType('D:\\x\\图文攻略.pdf'), 'guide')
    assert.equal(guessLinkType('D:\\x\\说明.TXT'), 'guide', '扩展名要不分大小写')
    assert.equal(guessLinkType('D:\\x\\mods', true), 'mod')
    // exe 可能是修改器，也可能是配置工具、汉化补丁、另一个游戏的启动器。
    // 猜错了用户得先看懂我们猜错了才能改，而 other 显示的就是文件名本身
    assert.equal(guessLinkType('D:\\x\\Trainer.exe'), 'other')
  })

  await check('重复的路径不再加一条，大小写和尾斜杠都算同一条', () => {
    const list = [link('D:\\资料\\攻略.pdf')]
    assert.equal(addLinks(list, [link('d:\\资料\\攻略.PDF')]).length, 1)
    assert.equal(addLinks(list, [link('D:\\资料\\攻略.pdf\\')]).length, 1)
    assert.equal(addLinks(list, [link('D:\\资料\\另一份.pdf')]).length, 2)
  })

  await check('加进来时标签截断、类型兜底、空路径跳过', () => {
    const out = addLinks([], [
      link('D:\\x\\a.pdf', { label: '一'.repeat(40) }),
      link('D:\\x\\b.pdf', { type: 'nope' as any }),
      link('   ', { label: '空的' })
    ])
    assert.equal(out.length, 2, '空路径该被跳过')
    assert.equal(out[0].label.length, MAX_LABEL)
    assert.equal(out[1].type, 'other', '不认识的类型该兜成 other')
  })

  await check('封顶时保留已有的，新的填到满为止', () => {
    // 已有的那些是用户之前一条条挑出来的，比这一次框选的更该留
    const existing = Array.from({ length: MAX_LINKS - 1 }, (_, i) => link(`D:\\x\\old${i}.pdf`))
    const out = addLinks(existing, [link('D:\\x\\new1.pdf'), link('D:\\x\\new2.pdf')])
    assert.equal(out.length, MAX_LINKS)
    assert.ok(out.slice(0, MAX_LINKS - 1).every((f) => f.path.includes('old')), '已有的被挤掉了')
    assert.ok(out[MAX_LINKS - 1].path.includes('new1'))
  })

  await check('hasLink 是 service 层的越界检查，认路径不认写法', () => {
    // 这一条守的是 openGameLink 那道门：它拦的是「让渲染进程打开任意本地文件」，
    // 而路径写法不同就漏过去的话，这道门等于没有
    const list = [link('D:\\资料\\攻略.pdf')]
    assert.ok(hasLink(list, 'd:\\资料\\攻略.pdf'))
    assert.ok(hasLink(list, 'D:\\资料\\.\\攻略.pdf'), '规范化之后是同一条')
    assert.ok(!hasLink(list, 'D:\\资料\\别的.pdf'))
    assert.ok(!hasLink([], 'D:\\资料\\攻略.pdf'))
  })

  await check('删一条只删那一条，删不存在的不报错也不改动别的', () => {
    const list = [link('D:\\x\\a.pdf'), link('D:\\x\\b.pdf')]
    assert.deepEqual(removeLink(list, 'D:\\X\\A.PDF').map((f) => f.path), ['D:\\x\\b.pdf'])
    assert.equal(removeLink(list, 'D:\\x\\没有这条.pdf').length, 2)
  })

  await check('标签改空退回文件名，不留一片空白', () => {
    const list = [link('D:\\x\\图文攻略.pdf', { label: '攻略' })]
    assert.equal(relabelLink(list, 'D:\\x\\图文攻略.pdf', '   ')[0].label, '图文攻略.pdf')
    assert.equal(relabelLink(list, 'D:\\x\\图文攻略.pdf', '  新名字 ')[0].label, '新名字')
  })

  await check('类型名单是闭集，且每一格都有中文标签 —— 缺一格是界面上一个空白下拉项', () => {
    assert.deepEqual(LINK_TYPES, ['guide', 'trainer', 'mod', 'emulator', 'other'])
    for (const t of LINK_TYPES) {
      assert.ok(LINK_TYPE_LABEL[t], `${t} 没有中文标签`)
    }
    // 反向也要对：标签表里多一个不存在的类型，下拉框里会出现一个选不出结果的项
    assert.deepEqual(Object.keys(LINK_TYPE_LABEL).sort(), [...LINK_TYPES].sort())
  })

  console.log('\n封面 · 文件命名')

  await check('封面按游戏 id 命名 —— 游戏改名不该让封面变成孤儿', () => {
    // 名字在详情页上随时能改，文件名跟着改就得同步挪文件，不挪就对不上
    assert.equal(coverFileName('abc-123', 'D:\\图\\艾尔登法环.png'), 'abc-123.png')
    assert.equal(coverFileName('abc-123', 'D:\\图\\封面.JPEG'), 'abc-123.jpeg', '扩展名要归成小写')
  })

  await check('认不得的扩展名退回 .png 而不是原样带出去', () => {
    assert.equal(coverFileName('id1', 'D:\\图\\x.tga'), 'id1.png')
    assert.equal(coverFileName('id1', 'D:\\图\\没有扩展名'), 'id1.png')
  })

  await check('格式白名单只放 Chromium 一定渲染得出来的，.ico 和 .psd 不收', () => {
    assert.ok(isCoverExt('a.png') && isCoverExt('A.WEBP') && isCoverExt('a.avif'))
    // .ico 是图标，塞进 2:3 的框里必然糊；.psd / .tga 直接是破图
    assert.ok(!isCoverExt('a.ico'), '.ico 不该收')
    assert.ok(!isCoverExt('a.psd') && !isCoverExt('a.tga'))
    assert.ok(!isCoverExt('封面'), '没扩展名的不该收')
  })

  await check('换扩展名时清孤儿的名单覆盖所有认得的格式', () => {
    // png 换成 jpg 时旧文件不会被覆盖，不清就留下一个谁也不引用、
    // 却和新封面同名不同扩展名的文件 —— 看着像是没换成功
    const siblings = coverSiblings('id1')
    assert.equal(siblings.length, COVER_EXTS.length)
    for (const ext of COVER_EXTS) {
      assert.ok(siblings.includes(`id1${ext}`), `${ext} 不在清理名单里`)
    }
    assert.ok(siblings.includes(coverFileName('id1', 'x.jpg')), '实际会写出来的名字必须在清理名单里')
  })

  await check('封面路径和图标一样只按 basename 找文件 —— 协议那头防的是 ../ 穿越', () => {
    // main.ts 的 baoyi:// 处理器拿 path.basename 兜底，渲染进程这边的 coverUrl
    // 也只取最后一段。两边一致，中间那段路径怎么写都到不了别的目录
    assert.equal(coverUrlOf('C:\\Users\\x\\AppData\\Roaming\\baoyi\\covers\\id1.png', 7), 'baoyi://cover/id1.png?v=7')
    assert.equal(coverUrlOf('..\\..\\Windows\\System32\\evil.png', 1), 'baoyi://cover/evil.png?v=1')
    assert.equal(coverUrlOf('', 1), '', '没有封面时不该拼出一个指向 undefined 的地址')
  })

  await check('版本号跟着 updated_at 走 —— 文件名不变，不带它换了图也不刷新', () => {
    const a = coverUrlOf('D:\\covers\\id1.png', 1000)
    const b = coverUrlOf('D:\\covers\\id1.png', 2000)
    assert.notEqual(a, b, '换封面之后 URL 必须变，否则 Chromium 继续用缓存里那张旧图')
  })

  console.log('\n封面 · 联网搜索')

  await check('查询词英文名优先 —— 商店和图床都以英文原名建索引', () => {
    // 「艾尔登法环」在 Steam 商店搜索里查不到，Elden Ring 一发就中。
    // 这不是偏好，是命中率决定的
    const qs = coverQueries({ name_zh: '艾尔登法环', name_en: 'Elden Ring' })
    assert.equal(qs[0], 'Elden Ring')
    assert.equal(qs[1], '艾尔登法环', '中文名要留着当第二顺位，不是丢掉')
  })

  await check('没有英文名时退到中文名，两个都没有时退到目录名', () => {
    assert.deepEqual(coverQueries({ name_zh: '中华三国志' }), ['中华三国志'])
    const only = coverQueries({ source_dir: 'E:\\游戏\\洛克王国：世界(2002304)' })
    assert.equal(only.length, 1)
    assert.ok(!only[0].includes('2002304'), 'appid 尾巴该被剥掉')
    assert.ok(!only[0].includes('E:\\'), '要的是目录名，不是整条路径')
  })

  await check('查询词去重，不拿同一个名字白烧两次请求', () => {
    // 中英文名填了同一个词很常见（识别时只认出一个）。
    // 大小写不同也算同一条，留下的是英文名那个（它先入列）
    const qs = coverQueries({ name_zh: 'Hades', name_en: 'hades' })
    assert.equal(qs.length, 1)
    assert.equal(qs[0].toLowerCase(), 'hades')
  })

  await check('清词只删有把握的噪声，不动游戏名本身', () => {
    assert.equal(cleanQuery('Elden Ring v1.12 [中文汉化]'), 'Elden Ring')
    assert.equal(cleanQuery('Hades_Deluxe Edition'), 'Hades')
    assert.equal(cleanQuery('The Witcher 3 REPACK'), 'The Witcher 3')
    // 罗马数字和数字编号是名字的一部分，删过头比不删更糟
    assert.equal(cleanQuery('Final Fantasy VII'), 'Final Fantasy VII')
    assert.equal(cleanQuery('Portal 2'), 'Portal 2')
  })

  await check('Steam 候选竖版排前面 —— 封面墙的框是 2:3 的', () => {
    const list = steamCoverCandidates(367520, 'Hollow Knight')
    assert.ok(list.length >= 3)
    assert.ok(list[0].portrait, '第一个必须是竖版')
    assert.ok(list[0].url.includes('367520'), 'appid 要拼进地址')
    // 横版图塞进 2:3 会被裁掉两边，只能当兜底
    const lastPortrait = list.findLastIndex((c) => c.portrait)
    const firstLandscape = list.findIndex((c) => !c.portrait)
    assert.ok(lastPortrait < firstLandscape, '竖版和横版不该交错')
  })

  await check('appid 不是纯数字时一个候选都不给，不拼出畸形地址', () => {
    assert.equal(steamCoverCandidates('abc').length, 0)
    assert.equal(steamCoverCandidates('').length, 0)
    assert.equal(steamCoverCandidates('12; rm -rf').length, 0)
  })

  await check('Steam 选 app 只做相等和包含两级，不做模糊距离', () => {
    // 模糊匹配会把 Portal 匹到 Portal 2 上，而封面错了比没封面更糟
    const items = [
      { id: 620, name: 'Portal 2' },
      { id: 400, name: 'Portal' },
      { id: 1, name: '完全不相关的游戏' }
    ]
    const picked = pickSteamApps(items, 'Portal')
    assert.equal(picked[0].id, 400, '完全相等的必须排第一')
    assert.ok(picked.some((p) => p.id === 620), '包含关系的留作候选让用户在图上选')
  })

  await check('Steam 结果里 id 不合法的条目直接丢掉', () => {
    const picked = pickSteamApps(
      [{ id: 'x', name: 'A' }, { id: 0, name: 'B' }, { id: 400, name: 'Portal' }] as any,
      'Portal'
    )
    assert.equal(picked.length, 1)
    assert.equal(picked[0].id, 400)
  })

  await check('DLC 和原声带滤掉 —— 实测它们四种封面图全都不存在', () => {
    // 真机验过：「ELDEN RING Tarnished Pack」「Sultan's Game - Original Soundtrack」
    // 这类条目跟本体一起从商店搜索回来，但 library_600x900 / portrait / header 全 404。
    // 不滤掉就是每条白烧 4 次探测请求换回一个空
    const picked = pickSteamApps(
      [
        { id: 1245620, name: 'ELDEN RING', type: 'app' },
        { id: 3655690, name: 'ELDEN RING Tarnished Pack', type: 'dlc' },
        { id: 999, name: 'ELDEN RING Bundle', type: 'bundle' }
      ],
      'Elden Ring'
    )
    assert.deepEqual(picked.map((p) => p.id), [1245620])
  })

  await check('没有 type 字段时当本体处理，不因为接口改字段就一个都不给', () => {
    // 商店接口是外部依赖，字段随时可能变。宁可多探几次，不要整个功能静默失效
    const picked = pickSteamApps([{ id: 400, name: 'Portal' }], 'Portal')
    assert.equal(picked.length, 1)
  })

  await check('URL 白名单挡的是「远端决定我们连哪台机器」，不是防御性代码', () => {
    // 候选 URL 一半来自搜索服务商的返回，等于外部输入。不设白名单，
    // 一个被污染的搜索结果就能让抱一去访问任意地址
    assert.ok(acceptImageUrl('https://cdn.cloudflare.steamstatic.com/steam/apps/400/x.jpg'))
    assert.ok(!acceptImageUrl('https://evil.example.com/x.jpg'), '白名单外的主机必须拒')
    assert.ok(!acceptImageUrl('http://cdn.cloudflare.steamstatic.com/x.jpg'), 'http 必须拒')
    assert.ok(!acceptImageUrl('file:///C:/Windows/System32/x.png'), 'file:// 必须拒')
    assert.ok(!acceptImageUrl('not a url'))
    assert.ok(!acceptImageUrl(''))
  })

  await check('看起来不是图片的地址不进候选', () => {
    assert.ok(!acceptImageUrl('https://cdn.cloudflare.steamstatic.com/steam/apps/400/'))
    assert.ok(!acceptImageUrl('https://cdn.cloudflare.steamstatic.com/a.exe'), '.exe 不该当封面')
    assert.ok(!acceptImageUrl('https://cdn.cloudflare.steamstatic.com/a.html'))
  })

  await check('扩展名以 content-type 为准，不信 URL 上写的那个', () => {
    // 远端完全可以在 .png 地址上回一张 jpeg，而扩展名写错的文件
    // 在 <img> 里未必渲染得出来
    assert.equal(extFromContentType('image/jpeg'), '.jpg')
    assert.equal(extFromContentType('image/png; charset=binary'), '.png')
    assert.equal(extFromContentType('image/webp'), '.webp')
    assert.equal(extFromContentType('text/html'), '', '非图片必须返回空串让调用方拒掉')
    assert.equal(extFromContentType(''), '')
  })

  await check('content-type 推出来的扩展名一定在封面白名单里', () => {
    // 这两份名单分开写迟早会漂：推出一个 .svg 来，setGameCover 那头会拒，
    // 用户看到的是「下载成功但封面没变」
    for (const ct of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']) {
      const ext = extFromContentType(ct)
      assert.ok(COVER_EXTS.includes(ext), `${ct} 推出的 ${ext} 不在 COVER_EXTS 里`)
    }
  })

  await check('候选定型：过白名单、去重、竖版优先、封顶', () => {
    const dup = 'https://cdn.cloudflare.steamstatic.com/steam/apps/400/a.jpg'
    const out = finalizeCandidates([
      { url: 'https://cdn.cloudflare.steamstatic.com/b.jpg', label: '横', source: 'steam', portrait: false, rank: 0 },
      { url: dup, label: '竖', source: 'steam', portrait: true, rank: 1 },
      { url: dup.toUpperCase().replace('HTTPS', 'https').replace('CDN.CLOUDFLARE.STEAMSTATIC.COM', 'cdn.cloudflare.steamstatic.com'), label: '重复', source: 'steam', portrait: true, rank: 2 },
      { url: 'https://evil.example.com/x.jpg', label: '越界', source: 'search', portrait: true, rank: 0 }
    ])
    assert.ok(out[0].portrait, '竖版必须排前面')
    assert.ok(!out.some((c) => c.url.includes('evil')), '白名单外的必须被过掉')
    assert.equal(new Set(out.map((c) => c.url.toLowerCase())).size, out.length, '不该有重复 URL')
  })

  await check('候选数量封顶 —— 再多就不是挑一张而是翻图库', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      url: `https://cdn.cloudflare.steamstatic.com/steam/apps/400/x${i}.jpg`,
      label: `图${i}`,
      source: 'steam' as const,
      portrait: true,
      rank: i
    }))
    assert.equal(finalizeCandidates(many).length, MAX_CANDIDATES)
  })

  await check('图搜结果认不出图片地址的整条丢掉，不把网页地址塞进 img', () => {
    const out = candidatesFromSearch([
      { url: 'https://zh.wikipedia.org/wiki/某游戏', title: '维基条目' },
      { imageUrl: 'https://upload.wikimedia.org/x/cover.png', title: '封面' },
      { url: 'https://static.wikia.nocookie.net/y/box.jpg', title: '盒绘' }
    ])
    assert.equal(out.length, 2, '网页地址那条必须丢掉')
    assert.ok(out.every((c) => c.source === 'search'))
  })

  await check('体积上限是个真数字，不是 0 或 Infinity', () => {
    // 边下边数超了就断 —— content-length 可以撒谎，也可以干脆不给
    assert.ok(MAX_COVER_BYTES > 1024 * 1024, '太小会把正常封面拒掉')
    assert.ok(Number.isFinite(MAX_COVER_BYTES))
  })

  await check('图搜只有 Bing 和 SearXNG 支持，其余服务商要说清而不是静默返回空', () => {
    const base = { api_key: 'k', endpoint: '', enabled: true }
    assert.ok(imageSearchAvailable({ ...base, provider: 'bing' }))
    assert.ok(imageSearchAvailable({ ...base, provider: 'searxng', endpoint: 'https://s.example.com' }))
    // 这三家的接口只回网页，拿网页地址当封面只会得到破图
    for (const p of ['tavily', 'exa', 'firecrawl'] as const) {
      assert.ok(!imageSearchAvailable({ ...base, provider: p }), `${p} 不该被当成能搜图`)
      const why = imageSearchWhyNot({ ...base, provider: p })
      assert.ok(why.length > 0, `${p} 必须给出一句能显示给用户的原因`)
      assert.ok(why.includes('网页'), '原因要说清是「只回网页」这一类，用户才知道换哪个服务商')
    }
  })

  await check('没开联网、选了「不额外联网」时给的原因各不相同', () => {
    // 三类失败的下一步动作完全不同：开开关 / 换服务商 / 填地址
    const off = imageSearchWhyNot({ provider: 'bing', api_key: 'k', endpoint: '', enabled: false })
    const builtin = imageSearchWhyNot({ provider: 'model_builtin', api_key: '', endpoint: '', enabled: true })
    const noEndpoint = imageSearchWhyNot({ provider: 'searxng', api_key: '', endpoint: '  ', enabled: true })
    assert.ok(off.includes('没有开启'))
    assert.ok(builtin.includes('不额外联网'))
    assert.ok(noEndpoint.includes('实例地址'))
    assert.equal(new Set([off, builtin, noEndpoint]).size, 3, '三类原因不该混成同一句')
  })
}

/* ==================== 游玩时长 · Step 6 ==================== */

async function playSessionSection(): Promise<void> {
  console.log('\n游玩时长 · 记账')

  /** 铺一条刚扫进来的游戏：从没玩过，时长为 0 */
  const oneGame = (): { d: InstanceType<typeof DatabaseSync>; id: string } => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    initSchema(d as any, KINDS)
    const { id } = insertGame(d as any, {
      exe_path: 'D:\\Games\\HK\\hollow_knight.exe',
      name_zh: '空洞骑士',
      name_en: 'Hollow Knight',
      summary: '',
      description: '',
      category: '动作',
      tags: [],
      official_url: '',
      source_dir: 'D:\\Games\\HK',
      file_size: 600_000,
      save_paths: [],
      linked_files: []
    })
    return { d, id }
  }

  await check('够门槛的一段游玩累加进总时长，并把上次游玩推到现在', () => {
    const { d, id } = oneGame()
    const before = Date.now()
    const out = endSession(d as any, id, 1800)!
    assert.equal(out.counted, true)
    assert.equal(out.elapsed_sec, 1800)
    assert.equal(out.total_playtime_sec, 1800)

    const g = getGame(d as any, id)!
    assert.equal(g.total_playtime_sec, 1800)
    assert.ok(g.last_played_at >= before, 'last_played_at 没被推到这一刻')
    d.close()
  })

  await check('多段游玩是累加，不是覆盖', () => {
    const { d, id } = oneGame()
    endSession(d as any, id, 600)
    endSession(d as any, id, 900)
    const out = endSession(d as any, id, 60)!
    assert.equal(out.total_playtime_sec, 1560)
    assert.equal(getGame(d as any, id)!.total_playtime_sec, 1560)
    d.close()
  })

  await check('太短的那次不计入时长 —— 启动器一闪而过不算玩了 3 秒', () => {
    const { d, id } = oneGame()
    const out = endSession(d as any, id, 3)!
    assert.equal(out.counted, false)
    assert.equal(out.elapsed_sec, 3, '实际秒数照样报出来，不改成 0')
    assert.equal(out.total_playtime_sec, 0, '不该被累加进去')
    assert.equal(getGame(d as any, id)!.total_playtime_sec, 0)
    d.close()
  })

  await check('太短也要更新上次游玩，并照样翻状态 —— 他确实启动过', () => {
    const { d, id } = oneGame()
    const out = endSession(d as any, id, 3)!
    assert.equal(out.play_status, 'playing', '短一次也是玩过一次')
    assert.equal(out.status_changed, true)
    const g = getGame(d as any, id)!
    assert.ok(g.last_played_at > 0, '上次游玩没更新')
    assert.equal(g.play_status, 'playing')
    d.close()
  })

  await check('没计入时那句话要说清为什么，不能显示「已记录 0 分钟」', () => {
    const { d, id } = oneGame()
    const out = endSession(d as any, id, 5)!
    assert.ok(!out.message.includes('0 分钟'), '说成 0 分钟会让人以为功能坏了')
    assert.ok(out.message.includes('启动器'), '该点出最可能的原因')
    d.close()
  })

  await check('门槛是 60 秒：正好 60 计入，59 不计入', () => {
    const a = oneGame()
    assert.equal(endSession(a.d as any, a.id, MIN_SESSION_SEC)!.counted, true)
    a.d.close()
    const b = oneGame()
    assert.equal(endSession(b.d as any, b.id, MIN_SESSION_SEC - 1)!.counted, false)
    b.d.close()
  })

  await check('状态只做「想玩 → 在玩」这一个方向的翻转', () => {
    const { d, id } = oneGame()
    endSession(d as any, id, 1800)
    assert.equal(getGame(d as any, id)!.play_status, 'playing')

    // 用户自己标了通关，再玩一次不该把他改回「在玩」
    updateGame(d as any, id, { play_status: 'completed' })
    const out = endSession(d as any, id, 1800)!
    assert.equal(out.play_status, 'completed', '把用户标的通关冲掉了')
    assert.equal(out.status_changed, false)
    assert.equal(out.total_playtime_sec, 3600, '时长还是要加')

    // 搁置同理 —— 重新玩起来算不算「不搁置了」只有他自己知道
    updateGame(d as any, id, { play_status: 'shelved' })
    assert.equal(endSession(d as any, id, 1800)!.play_status, 'shelved')
    d.close()
  })

  await check('游玩过程中条目被移除时，记账不把它写回来', () => {
    const { d, id } = oneGame()
    deleteGame(d as any, id)
    assert.equal(endSession(d as any, id, 1800), null, '删掉的游戏不该因为一次结算长回来')
    assert.equal(getGame(d as any, id), null)
    d.close()
  })

  await check('时钟被往回调过时算 0 秒，不记一段负时长', () => {
    const now = Date.now()
    assert.equal(elapsedSeconds(now, now - 60_000), 0)
    assert.equal(elapsedSeconds(now, now), 0)
    assert.equal(elapsedSeconds(now - 90_000, now), 90)
    // 不足一秒向下取整，不四舍五入到 1
    assert.equal(elapsedSeconds(now - 900, now), 0)
  })

  await check('负时长喂进来也不会让总时长倒退', () => {
    const { d, id } = oneGame()
    endSession(d as any, id, 1800)
    // elapsedSeconds 已经兜过底，这一条守的是 endSession 自己也不该被穿透
    const out = endSession(d as any, id, -100)!
    assert.equal(out.counted, false, '负数不该过门槛')
    assert.equal(out.total_playtime_sec, 1800, '总时长倒退了')
    d.close()
  })
}

/* ==================== 文件名解析 · v0.7 Step 2 ==================== */

/**
 * 文件名解析器。
 *
 * 两部分：手写用例表（永远跑）+ guessit 语料（有参考副本时才跑）。
 *
 * 手写那部分是真正的回归网 —— 它进版本库，任何机器上都跑得到，
 * 每一条对应一个曾经踩过的坑。语料那部分在 `.recover/` 里，被 gitignore
 * 挡在版本库外，所以它只能是「有就多验一层」，缺了不能算失败。
 *
 * 语料用「命中数不低于某个下限」而不是「全对」来断言。guessit 认的东西
 * 比这里多（集名、语言、日期、法语西语的季集词），而这一层刻意不认
 * 一部分它认的（裸数字 scene 编号 —— 见 hasSeriesMarker 的注释）。
 * 下限卡住的是「不许退步」，不是「必须追平 guessit」。
 */
async function videoFilenameSection(): Promise<void> {
  console.log('\n文件名解析')

  await check('中文标题不被季集模式吃掉 —— 上游的 \\W 分隔符会把它切成一个字', () => {
    const r = parseVideoName('漫长的季节.S01E05.2023.2160p.WEB-DL.H265.mp4')
    assert.equal(r.title_zh, '漫长的季节')
    assert.equal(r.season, 1)
    assert.deepEqual(r.episodes, [5])
    assert.equal(r.year, 2023)
  })

  await check('带年份的电影不会被 scene 编号规则拆成剧集', () => {
    // 上游有一条 four-digit-scene-numbering 模式会把 2024 读成 S20E24，
    // 每部带年份的电影都会变成剧集
    const r = parseVideoName('Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP.mkv')
    assert.equal(r.season, null)
    assert.deepEqual(r.episodes, [])
    assert.equal(r.absolute_episode, null)
    assert.equal(r.looks_like_series, false)
    assert.equal(r.year, 2024)
    assert.equal(r.title_en, 'Dune Part Two')
  })

  await check('片名里的四位数不会被当成年份', () => {
    // 取标题区之后的最后一个年份：2049 是片名的一部分
    assert.equal(parseYear('Blade.Runner.2049.2017.2160p.mkv'), 2017)
    assert.equal(parseYear('2012.2009.1080p.BluRay.mkv'), 2009)
    // 分辨率里的四位数也不是年份，大小写的 x 都要挡
    assert.equal(parseYear('Apotheosis_1920x1080.mp4'), 0)
    assert.equal(parseYear('Pirates.2008.FRENCH.1920X1080.h264.mkv'), 2008)
    // 紧跟在字母后面的四位数不是年份（BT2020 是色域标记）
    assert.equal(parseYear('Life of Pi 2012 2160p BluRay BT2020 DTSHD.mkv'), 2012)
    // 括号里的年份最明确，优先
    assert.equal(parseYear('某片(2019).1080p.mkv'), 2019)
  })

  await check('明写的 SxxExx 压得住其他模式', () => {
    // 上游在这条上会去匹配 `Part.1` 而给出 E1
    const r = parseVideoName('Adventure.Time.S08E16.Elements.Part.1.Skyhooks.720p.WEB-DL.mkv')
    assert.equal(r.season, 8)
    assert.deepEqual(r.episodes, [16])
    // S06xE01、S013E18、S01Extras 这几种上游直接给 null
    assert.equal(parseLatinSeasonEpisode('The Office - S06xE01.avi')?.season, 6)
    assert.deepEqual(parseLatinSeasonEpisode('The Office - S06xE01.avi')?.episodes, [1])
    assert.equal(parseLatinSeasonEpisode('CSI.S013E18.Sheltered.720p.mkv')?.season, 13)
    assert.equal(parseLatinSeasonEpisode('My.Name.Is.Earl.S01Extras.avi')?.season, 1)
    // 一个文件里多集：S01E02E03
    assert.deepEqual(parseLatinSeasonEpisode('Show.S01E02E03.mkv')?.episodes, [2, 3])
  })

  await check('中文季集标记不被降级成绝对集号', () => {
    // `第01集` 是明确的第 1 集，降成绝对集号会让它排不进任何一季
    const a = parseVideoName('狂飙.第01集.1080p.mkv')
    assert.deepEqual(a.episodes, [1])
    assert.equal(a.absolute_episode, null)
    assert.equal(a.title_zh, '狂飙')

    const b = parseVideoName('权力的游戏.第二季.第05集.1080p.mkv')
    assert.equal(b.season, 2)
    assert.deepEqual(b.episodes, [5])
    assert.equal(b.absolute_episode, null)

    assert.deepEqual(parseCnSeasonEpisode('某剧.第十二季.第二十集.mkv'), { season: 12, episode: 20 })
    assert.deepEqual(parseCnSeasonEpisode('某剧.第3话.mkv'), { season: null, episode: 3 })
  })

  await check('中文数字转阿拉伯数字，1-99', () => {
    assert.equal(cnNumber('一'), 1)
    assert.equal(cnNumber('十'), 10)
    assert.equal(cnNumber('十二'), 12)
    assert.equal(cnNumber('二十'), 20)
    assert.equal(cnNumber('二十三'), 23)
    assert.equal(cnNumber('05'), 5)
    // 认不出来给 0，调用方拿 `|| null` 兜住
    assert.equal(cnNumber('甲'), 0)
    assert.equal(cnNumber(''), 0)
  })

  await check('番剧的裸集号只在有字幕组前缀时才认', () => {
    // 集号在标题后面
    assert.equal(parseAnimeEpisode('[SubsPlease] Frieren - 12 (1080p) [F1A2B3C4].mkv'), 12)
    assert.equal(parseAnimeEpisode('[Figmentos] Monster 34 - At the End of Darkness [781219F1].mkv'), 34)
    // 集号后面紧跟下划线（`\w` 含下划线，所以边界不能用 \b）
    assert.equal(parseAnimeEpisode('[Evil-Saizen]_Laughing_Salesman_14_[DVD][1C98686A].mkv'), 14)
    // 集号在标题前面
    assert.equal(parseAnimeEpisode('[DeadFish] 01 - Tari Tari [BD][720p][AAC].mp4'), 1)
    // 中间夹着规格方括号块
    assert.equal(parseAnimeEpisode('[aprm] [BD][1080p] Nagi no Asukara 08 [4D102B7C].mkv'), 8)
    // 没有字幕组前缀就不认 —— 裸数字规则会毁掉 `Se7en`、`2012` 这类片名
    assert.equal(parseAnimeEpisode('Bleach - 313.mkv'), null)
    // 方括号里的数字不是集号
    assert.equal(parseAnimeEpisode('[XCT] Persepolis [H264+Aac-128(Fr-Eng)+ST(Fr-Eng)].mkv'), null)
    // 裸数字后面直接跟技术标记的，那个数字是片名的一部分
    assert.equal(parseAnimeEpisode('[h265 - hevc] transformers 2 1080p french ac3 6ch.mkv'), null)
  })

  await check('番剧集号排在上游那张表前面', () => {
    // 合集文件 `02-03` 的首集号是 2，上游给 3
    const r = parseVideoName('[ShinBunBu-Subs] Bleach - 02-03 (CX 1280x720 x264 AAC).mkv')
    assert.equal(r.absolute_episode, 2)
    assert.equal(r.season, null, '绝对集号不带季信息，硬填 1 会和真第一季撞车')
  })

  await check('NxNN 那个形状：季集、赛季年、像素尺寸得分开', () => {
    assert.equal(parseLatinSeasonEpisode('The Sopranos - [05x07] - In Camelot.mp4')?.season, 5)
    assert.equal(parseLatinSeasonEpisode('2x05 - Pure Laine.avi')?.season, 2)
    // 体育赛事拿年份当季号
    assert.equal(parseLatinSeasonEpisode('MotoGP.2016x03.USA.Race.1080p')?.season, 2016)
    // 像素尺寸不是季集
    assert.equal(parseLatinSeasonEpisode('Apotheosis_1920x1080.mp4'), null)
    assert.equal(parseLatinSeasonEpisode('[Doremi].Precure.[1280x720].mkv'), null)
    // 长宽比也不是
    assert.equal(parseLatinSeasonEpisode('Movie.16x9.aspect.mkv'), null)
    // 四位数开头再跟 1-2 位数的是日期
    assert.equal(parseLatinSeasonEpisode('Something.2008x12.13-FlexGet'), null)
    // 但一位数季号后面跟的 `.18` 是集名，不是日期
    assert.equal(parseLatinSeasonEpisode('The.Mentalist.2x21.18-5-4.HDTV.avi')?.season, 2)
  })

  await check('「Season」是片名里的词时不算季标记', () => {
    // 后面跟着括号年份的是电影
    assert.equal(parseLatinSeasonEpisode('Open Season 2 (2008) - Bluray-1080p.mkv'), null)
    // 拼出来的 Season 后面跟四位数，那是年份 —— guessit 自己的语料也标了 -season
    assert.equal(parseLatinSeasonEpisode('Show.Name.Season.2025.1080p.WEB-DL.mkv'), null)
    // 正常的整季包照认，复数形式也认
    assert.equal(parseLatinSeasonEpisode('Show.Season.2.1080p.mkv')?.season, 2)
    assert.equal(parseLatinSeasonEpisode('Something Seasons 4 Complete')?.season, 4)
    assert.equal(parseLatinSeasonEpisode('三体.Three-Body.2023.S01.2160p.mkv')?.full_season, true)
  })

  await check('分辨率、片源、发布组只报文件名字面写了的', () => {
    // 上游会从 `.mkv` 扩展名猜出 WEBDL + 720p —— Radarr 需要一个画质做下载
    // 决策，猜一个比没有强；这里恰好相反，第 4 步能从容器里读出真值
    const a = parseVideoName('某电影.2020.花絮.mkv')
    assert.equal(a.resolution, '')
    assert.equal(a.source, '')
    // `WEB-DL` 的 DL 不是发布组
    assert.equal(parseVideoName('流浪地球2.2023.2160p.WEB-DL.mkv').release_group, '')
    // `-sample` 也不是
    assert.equal(parseVideoName('Movie.2019.1080p-sample.mkv').release_group, '')
    // 真写了的照报
    const b = parseVideoName('The.Glory.S01E03.1080p.NF.WEB-DL.x264-GRP.mkv')
    assert.equal(b.resolution, '1080p')
    assert.equal(b.source, 'WEBDL')
    assert.equal(b.release_group, 'GRP')
  })

  await check('花絮预告样片认得出来，中英文都要认', () => {
    assert.deepEqual(detectExtra('某电影.2020.花絮.mkv'), { is_extra: true, kind: 'featurette' })
    assert.deepEqual(detectExtra('Movie.2019.1080p-sample.mkv'), { is_extra: true, kind: 'sample' })
    assert.equal(detectExtra('某片.预告片.mp4').is_extra, true)
    assert.equal(detectExtra('Movie.Behind.the.Scenes.mkv').kind, 'featurette')
    assert.equal(detectExtra('Movie.Deleted.Scenes.mkv').kind, 'deleted')
    assert.equal(detectExtra('[组] 某番 NCOP1 [CRC].mkv').kind, 'opening')
    // 正片不该被误判
    assert.equal(detectExtra('The.Glory.S01E03.1080p.WEB-DL.mkv').is_extra, false)
    assert.equal(detectExtra('漫长的季节.S01E05.2023.mkv').is_extra, false)
  })

  await check('分卷只认 CD/DISC/DVD + 数字，不认 Part N', () => {
    assert.equal(parsePart('Interstellar.2014.1080p.BluRay.x264.CD1.avi'), 1)
    assert.equal(parsePart('Movie.2014.DISC2.mkv'), 2)
    // `Dune: Part Two` 的 Part 是片名的一部分，认成分卷会把两部电影合成一条
    assert.equal(parsePart('Dune.Part.Two.2024.2160p.mkv'), null)
    assert.equal(parsePart('Harry.Potter.Part.1.2010.mkv'), null)
  })

  await check('中英双名拆得开，片名里的数字跟着中文走', () => {
    assert.deepEqual(splitTitle(titleRegion('三体.Three-Body.2023.S01.2160p.mkv')), {
      zh: '三体',
      en: 'Three-Body'
    })
    assert.deepEqual(splitTitle(titleRegion('灌篮高手.THE.FIRST.SLAM.DUNK.2022.BluRay.mkv')), {
      zh: '灌篮高手',
      en: 'THE FIRST SLAM DUNK'
    })
    // 按 token 分组而不是按第一个非 CJK 字符切：`流浪地球2` 的 2 是片名的一部分
    assert.deepEqual(splitTitle(titleRegion('流浪地球2.2023.2160p.WEB-DL.mkv')), {
      zh: '流浪地球2',
      en: ''
    })
  })

  await check('标题在第一个技术标记处结束，按位置不按优先级', () => {
    // 年份在前和分辨率在前都该切出同一个标题
    assert.equal(titleRegion('沙丘.2024.2160p.mkv').trim(), '沙丘')
    assert.equal(titleRegion('沙丘.2160p.2024.mkv').trim(), '沙丘')
    // `2012` 这种纯数字片名不能被年份规则切光
    assert.equal(titleRegion('2012.2009.1080p.BluRay.mkv').trim(), '2012')
    // 字幕组前缀和结尾 CRC 都剥掉
    assert.equal(titleRegion('[SubsPlease] Frieren - 12 (1080p) [F1A2B3C4].mkv').trim(), 'Frieren')
    // 中文字幕标记也是切点（`\b` 在 CJK 两侧不成立，所以那条不能带 \b）
    assert.equal(titleRegion('某剧.中英双字.1080p.mkv').trim(), '某剧')
  })

  await check('hintSeries 只放开季集解析，不凭空造季号', () => {
    // 扫描器知道「这个文件在一个有 12 个同名文件的目录里」时传 true
    const hinted = parseVideoName('new.girl.117.hdtv-lol.mp4', true)
    assert.equal(hinted.season, 1)
    assert.deepEqual(hinted.episodes, [17])
    // 不传就不认 —— 这个形状和电影的 `Movie.2019` 分不开
    const bare = parseVideoName('new.girl.117.hdtv-lol.mp4')
    assert.equal(bare.season, null)
    // hint 为 true 但文件名里真没有季集信息时，只标记「看起来是剧集」，
    // 不编一个季号出来
    const nothing = parseVideoName('某片.2020.1080p.mkv', true)
    assert.equal(nothing.season, null)
    assert.deepEqual(nothing.episodes, [])
    assert.equal(nothing.looks_like_series, true)
  })

  await guessitCorpusChecks()
}

/**
 * guessit 的 yml 测试语料。
 *
 * 语料在 `.recover/v07-refs/` 下，被 gitignore 挡在版本库外（GPL/LGPL 的
 * 参考物只读不抄，见 electron/kinds/video/parser/ORIGIN.md）。所以这一段
 * 缺了参考副本就跳过，不能算失败 —— 别的机器上没有那个目录。
 */
async function guessitCorpusChecks(): Promise<void> {
  const dir = path.resolve('.recover/v07-refs/guessit-develop/guessit/test')
  if (!fs.existsSync(dir)) {
    console.log('  - guessit 语料不在本地（.recover/ 不进版本库），跳过')
    return
  }

  const yaml = await import('js-yaml')

  interface Corpus {
    file: string
    cases: Array<{ name: string; want: Record<string, unknown> }>
  }

  const load = (file: string): Corpus => {
    // json: true 允许重复键（语料里同一个文件名出现过两次），后者覆盖前者
    const doc = yaml.default.load(fs.readFileSync(path.join(dir, file), 'utf8'), {
      json: true
    }) as Record<string, unknown>
    const cases: Corpus['cases'] = []
    for (const [key, value] of Object.entries(doc ?? {})) {
      if (key === '__default__' || !value || typeof value !== 'object') continue
      // guessit 喂的是整条路径，这一层只收文件名 —— 目录信息由扫描器另外给
      cases.push({ name: path.basename(key.replace(/\\/g, '/')), want: value as Record<string, unknown> })
    }
    return { file, cases }
  }

  /** 语料里 season/episode 可能是单值也可能是数组，取第一个 */
  const first = (v: unknown): number | null => {
    if (typeof v === 'number') return v
    if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
    return null
  }

  const corpora = ['episodes.yml', 'movies.yml', 'various.yml'].map(load)

  /**
   * 命中数下限。这些数字是 2026-08-30 实测值，留了几条余量。
   *
   * 卡的是「不许退步」。差距那部分是刻意不认的（裸数字 scene 编号）
   * 和不打算认的（法语 Saison、西语 Temporada 之类的季集词）。
   */
  const FLOOR: Record<string, { season: number; episode: number; year: number }> = {
    'episodes.yml': { season: 305, episode: 348, year: 36 },
    'movies.yml': { season: 0, episode: 0, year: 164 },
    'various.yml': { season: 72, episode: 75, year: 51 }
  }

  for (const { file, cases } of corpora) {
    await check(`${file}：季集年份命中数不低于下限（${cases.length} 条语料）`, () => {
      let season = 0
      let episode = 0
      let year = 0
      for (const c of cases) {
        const got = parseVideoName(c.name)
        const wantSeason = first(c.want.season)
        const wantEp = first(c.want.episode)
        if (wantSeason !== null && got.season === wantSeason) season++
        if (wantEp !== null && (got.episodes[0] === wantEp || got.absolute_episode === wantEp)) episode++
        if (typeof c.want.year === 'number' && got.year === c.want.year) year++
      }
      const floor = FLOOR[file]
      assert.ok(season >= floor.season, `季号命中 ${season}，低于下限 ${floor.season}`)
      assert.ok(episode >= floor.episode, `集号命中 ${episode}，低于下限 ${floor.episode}`)
      assert.ok(year >= floor.year, `年份命中 ${year}，低于下限 ${floor.year}`)
    })
  }

  await check('一条电影语料都不许被认成剧集', () => {
    // 这是这一段里唯一的零容忍断言。漏认一部剧，用户在确认面板里改一下就好；
    // 错认一部电影，它的年份变成季号，海报墙上多出「24/0 集」，
    // 而用户完全看不出为什么
    const wrong: string[] = []
    for (const { cases } of corpora) {
      for (const c of cases) {
        if (first(c.want.season) !== null || first(c.want.episode) !== null) continue
        if (c.want.type === 'episode') continue
        // guessit 有一批只断言单个属性的用例（`options: -T "..."`、只测字幕语言），
        // 它们没有 season 键不代表「这是电影」
        if ('options' in c.want || '-season' in c.want || '-episode' in c.want) continue
        if (!('title' in c.want)) continue
        const got = parseVideoName(c.name)
        if (got.season !== null || got.episodes.length > 0 || got.absolute_episode !== null) {
          wrong.push(`${c.name} -> S${got.season} E[${got.episodes}] abs=${got.absolute_episode}`)
        }
      }
    }
    assert.deepEqual(wrong, [], `被错认成剧集：\n  ${wrong.join('\n  ')}`)
  })

  await check('hintSeries 打开后命中率明显更高 —— 扫描器靠它补目录上下文', () => {
    // 各语料里「传了 hint 比不传多认出多少条」。这条守的是 hint 这个入口
    // 真的有用：如果哪天 hint 被接反或被无视，这里会掉到 0
    let gained = 0
    for (const { cases } of corpora) {
      for (const c of cases) {
        const wantEp = first(c.want.episode)
        if (wantEp === null) continue
        const bare = parseVideoName(c.name)
        const hinted = parseVideoName(c.name, true)
        const hitBare = bare.episodes[0] === wantEp || bare.absolute_episode === wantEp
        const hitHint = hinted.episodes[0] === wantEp || hinted.absolute_episode === wantEp
        if (!hitBare && hitHint) gained++
      }
    }
    assert.ok(gained >= 40, `hint 只多认出 ${gained} 条，太少了，怀疑没接上`)
  })
}


/* ==================== 视频扫描 · v0.7 Step 3 ==================== */

/**
 * 造一棵真实的临时片库来跑 scanner。理由和游戏识别那一段一样：
 * 这一整段全是「读磁盘之后怎么归堆」，用假的 fs mock 验它等于在验 mock 自己。
 *
 * 这棵树是照着真实片库里会出现的形状搭的，每一枝对着一条规则：
 * 季目录 / 平铺季集 / 番剧字幕组 / 独占目录的电影 / CD 分卷 / 一个目录多部片 /
 * 花絮目录 / 花絮后缀 / Specials 是第 0 季而不是花絮。
 */
async function videoScanSection(): Promise<void> {
  console.log('\n视频扫描')

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baoyi-vscan-'))
  const mk = async (rel: string, bytes = 1024): Promise<string> => {
    const full = path.join(base, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, Buffer.alloc(bytes))
    return full
  }

  // 剧集：两季各两集，外加一个 Specials（第 0 季，不是花絮）
  await mk('剧集/漫长的季节/Season 1/漫长的季节.S01E01.2023.1080p.WEB-DL.mkv')
  await mk('剧集/漫长的季节/Season 1/漫长的季节.S01E02.2023.1080p.WEB-DL.mkv')
  await mk('剧集/漫长的季节/Season 2/漫长的季节.S02E01.2023.1080p.WEB-DL.mkv')
  // 故意放错位置：S02E05 待在 Season 1 目录里。真实片库里这种常有
  await mk('剧集/漫长的季节/Season 1/漫长的季节.S02E05.2023.1080p.WEB-DL.mkv')
  await mk('剧集/漫长的季节/Specials/漫长的季节.E01.mkv')
  await mk('剧集/漫长的季节/poster.jpg')
  await mk('剧集/漫长的季节/tvshow.nfo')

  // 剧集：没有季目录，季集号全写在文件名里
  await mk('剧集/The Glory/The.Glory.S01E01.1080p.NF.WEB-DL.x264-GRP.mkv')
  await mk('剧集/The Glory/The.Glory.S01E02.1080p.NF.WEB-DL.x264-GRP.mkv')

  // 番剧：字幕组前缀 + 绝对集号
  await mk('番剧/葬送的芙莉莲/[SubsPlease] Sousou no Frieren - 11 (1080p) [1A2B3C4D].mkv')
  await mk('番剧/葬送的芙莉莲/[SubsPlease] Sousou no Frieren - 12 (1080p) [5E6F7A8B].mkv')

  // 电影：独占目录，带侧车，还带两种花絮
  await mk('电影/沙丘 (2021)/沙丘.Dune.2021.2160p.BluRay.x265.mkv', 4096)
  await mk('电影/沙丘 (2021)/沙丘.Dune.2021.2160p.BluRay.x265.chs.srt')
  await mk('电影/沙丘 (2021)/poster.jpg')
  await mk('电影/沙丘 (2021)/movie.nfo')
  await mk('电影/沙丘 (2021)/沙丘-trailer.mkv')
  await mk('电影/沙丘 (2021)/Featurettes/making-of.mkv')

  // 电影：CD 分卷
  await mk('电影/无间道/无间道.CD1.avi')
  await mk('电影/无间道/无间道.CD2.avi')

  // 一个目录里并列两部电影，各带同名字幕
  await mk('散装/罗马.Roma.2018.1080p.WEB-DL.mkv')
  await mk('散装/罗马.Roma.2018.1080p.WEB-DL.chs.srt')
  await mk('散装/寄生虫.Parasite.2019.1080p.BluRay.mkv')
  await mk('散装/寄生虫.Parasite.2019.1080p.BluRay.chs.srt')

  const found = scanVideoRoot(base)
  const byPath = (rel: string): any => found.find((c) => c.path === path.join(base, rel))

  await check('季目录把两季收成一条，而不是两条剧', () => {
    const hits = found.filter((c) => c.video_type === 'series' && c.title_zh === '漫长的季节')
    assert.equal(hits.length, 1, `应该只有一条，实际 ${hits.length} 条`)
    assert.equal(hits[0].path, path.join(base, '剧集/漫长的季节'))
  })

  await check('Specials 是第 0 季，不是花絮 —— 剔掉它就是实打实的丢数据', () => {
    const s = byPath('剧集/漫长的季节')
    const seasons = s.episodes.map((e: any) => e.season)
    assert.ok(seasons.includes(0), `没收到第 0 季，实际季号 ${JSON.stringify(seasons)}`)
    assert.deepEqual(
      s.episodes.map((e: any) => `S${e.season}E${e.episode}`),
      ['S0E1', 'S1E1', 'S1E2', 'S2E1', 'S2E5']
    )
  })

  await check('文件名里的季号压过季目录 —— 放错位置的文件是真实存在的', () => {
    const s = byPath('剧集/漫长的季节')
    const misplaced = s.episodes.find((e: any) => e.episode === 5)
    // 它躺在 Season 1 目录里，但文件名写的是 S02
    assert.ok(misplaced.files[0].path.includes(`Season 1${path.sep}`))
    assert.equal(misplaced.season, 2, '目录位置压过了文件名里明写的季号')

    // 反过来那半边：Specials 里那个文件名没有季号，才用目录给的 0
    const sp = s.episodes.find((e: any) => e.season === 0)
    assert.equal(path.basename(sp.files[0].path), '漫长的季节.E01.mkv')
  })

  await check('没有季目录时，季集号从文件名来', () => {
    const s = byPath('剧集/The Glory')
    assert.equal(s.video_type, 'series')
    assert.deepEqual(s.episodes.map((e: any) => `S${e.season}E${e.episode}`), ['S1E1', 'S1E2'])
  })

  await check('番剧的绝对集号成集，标题取目录名而不是罗马音', () => {
    const s = byPath('番剧/葬送的芙莉莲')
    assert.equal(s.video_type, 'series')
    assert.equal(s.title_zh, '葬送的芙莉莲')
    assert.deepEqual(s.episodes.map((e: any) => e.episode), [11, 12])
  })

  await check('独占目录的电影：路径取目录，年份从目录名补上', () => {
    const m = byPath('电影/沙丘 (2021)')
    assert.equal(m.video_type, 'movie')
    assert.equal(m.title_zh, '沙丘')
    assert.equal(m.year, 2021)
    assert.equal(m.files.length, 1)
  })

  await check('花絮目录和花絮后缀都剔掉，但记下来不丢', () => {
    const m = byPath('电影/沙丘 (2021)')
    const names = m.extras.map((e: any) => path.basename(e.path)).sort()
    assert.deepEqual(names, ['making-of.mkv', '沙丘-trailer.mkv'])
    // 剔掉的东西不许混进正片
    assert.ok(!m.files.some((f: any) => /trailer|making/i.test(f.name)))
  })

  await check('侧车按目录收齐：nfo / 海报 / 字幕各归各的', () => {
    const m = byPath('电影/沙丘 (2021)')
    assert.equal(m.sidecars.nfo.length, 1)
    assert.equal(m.sidecars.images.length, 1)
    assert.equal(m.sidecars.subtitles.length, 1)
  })

  await check('CD1/CD2 合成一条，两个文件按卷号排好', () => {
    const m = byPath('电影/无间道')
    assert.equal(m.video_type, 'movie')
    assert.equal(m.files.length, 2)
    assert.deepEqual(m.files.map((f: any) => f.part), [1, 2])
  })

  await check('一个目录里两部电影：各自一条，路径用文件不用目录', () => {
    const loose = found.filter((c) => path.dirname(c.path) === path.join(base, '散装'))
    assert.equal(loose.length, 2, `应该 2 条，实际 ${loose.length} 条`)
    assert.ok(loose.every((c: any) => c.video_type === 'movie'))
    // 路径必须是文件本身 —— 都用目录的话两部片会抢同一个全局唯一键
    assert.ok(loose.every((c: any) => c.path.endsWith('.mkv')))
  })

  await check('目录里有多部片时，字幕只跟同名的那一部走', () => {
    const roma = found.find((c) => c.title_zh === '罗马')!
    const para = found.find((c) => c.title_zh === '寄生虫')!
    assert.equal(roma.sidecars.subtitles.length, 1)
    assert.equal(para.sidecars.subtitles.length, 1)
    assert.ok(path.basename(roma.sidecars.subtitles[0]).startsWith('罗马'))
    assert.ok(path.basename(para.sidecars.subtitles[0]).startsWith('寄生虫'))
  })

  await check('一部电影没有被认成剧 —— 这是最要命的那个错法', () => {
    const movies = ['电影/沙丘 (2021)', '电影/无间道']
    for (const rel of movies) {
      const m = byPath(rel)
      assert.equal(m.video_type, 'movie', `${rel} 被认成了 ${m.video_type}`)
      assert.equal(m.episodes.length, 0)
    }
    assert.ok(found.filter((c) => path.dirname(c.path) === path.join(base, '散装')).every((c) => c.video_type === 'movie'))
  })

  await check('季目录名：S01 / Season 2 / 第三季 / Specials 都认得出来', () => {
    assert.deepEqual(parseSeasonFolder('S01'), { season: 1, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('Season 2'), { season: 2, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('第三季'), { season: 3, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('第十二季'), { season: 12, kind: 'marked' })
    assert.deepEqual(parseSeasonFolder('Specials'), { season: 0, kind: 'marked' })
  })

  await check('四位数目录是年份不是季号，纯数字只当弱信号', () => {
    assert.equal(parseSeasonFolder('2019'), null)
    assert.deepEqual(parseSeasonFolder('3'), { season: 3, kind: 'numeric' })
    // S01E01 是单集文件名，不是季目录
    assert.equal(parseSeasonFolder('S01E01'), null)
  })

  await check('Specials 和 extras 不在花絮目录表里，trailers 在', () => {
    assert.equal(isExtraDir('Specials'), false)
    assert.equal(isExtraDir('Trailers'), true)
    assert.equal(isExtraDir('花絮'), true)
    assert.equal(isExtraDir('Season 1'), false)
  })

  await check('分卷只认 CD/DVD/DISC + 数字，Part N 不认', () => {
    assert.deepEqual(stackParts('无间道.CD1'), { stem: '无间道', part: 1 })
    assert.deepEqual(stackParts('Movie (DISC 2)'), { stem: 'Movie', part: 2 })
    assert.equal(stackParts('Dune.Part.Two'), null)
    assert.equal(stackParts('沙丘.2021.1080p'), null)
    // 整个名字就是个卷号标记时不算分卷，否则 stem 会是空串
    assert.equal(stackParts('CD1'), null)
  })

  await fsp.rm(base, { recursive: true, force: true })
}

void main()
