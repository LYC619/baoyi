import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apiBase, parseModelList } from '../../electron/services/agent/loop.ts'
import { fillIdentifySystem, limitTags } from '../../electron/kinds/software/prompts.ts'
import { BUILTIN_TAGS, DEFAULT_CATEGORIES, FALLBACK_CATEGORY, mapCategory } from '../../electron/services/taxonomy/taxonomy.ts'
import { planDroppedDir, planRoot, skippable } from '../../electron/kinds/software/scanPlan.ts'
import { countExes } from '../../electron/kinds/software/exeCount.ts'
import { parseVersionResource } from '../../electron/kinds/software/peReader.ts'
import { pickBestPngFrame } from '../../electron/kinds/software/peIcon.ts'
import { ICON_EXTS, iconFileName, iconSiblings, isIconExt, isManualIcon } from '../../electron/kinds/software/icons.ts'
import { defaultAction, defaultFolder, nestedInside, rebase, sameVolume, sanitizeFolder, targetDir } from '../../electron/kinds/software/organize/plan.ts'
import { isLink, LINK_MARK, makeJunction, moveDir, removeJunction, writeLinkMark } from '../../electron/kinds/software/organize/fsops.ts'
import { compareVersions, iconUrl as iconUrlOf, parseVersion, versionOf } from '../../src/utils/index.ts'
import { COVER_EXTS } from '../../electron/kinds/game/links.ts'
import { POSTER_EXTS } from '../../electron/kinds/video/posters.ts'
import { check } from './shared.ts'
export async function scanSection(): Promise<void> {

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

  await check('直接拖入单个便携软件目录时直接作为一个单元收录', async () => {
    const dropped = await planDroppedDir(path.join(scanRoot, 'BlueStacks X'))
    assert.equal(dropped.units.length, 1)
    assert.equal(dropped.units[0].dir, path.join(scanRoot, 'BlueStacks X'))
    assert.equal(dropped.units[0].exe_count, 2)
  })

  /* ----------------------------- 数 exe 的遍历 ----------------------------- */

  // 这一节守的是「界面别卡死」。从前 tools.ts 里有一份同步的 readdirSync 递归，
  // agent 每调一次 list_directory 就在主进程上跑最坏 36 万次目录项访问，
  // Windows 直接判「未响应」。现在只剩 exeCount.ts 这一份异步实现，两边共用。
  console.log('\n扫描 · 数 exe 的遍历')

  await check('数得对，且把子目录算进去', async () => {
    const r = await countExes(path.join(scanRoot, 'BlueStacks X'), { maxDepth: 8 })
    assert.equal(r.count, 2, 'HD-Player.exe + plugins\\helper.exe')
    assert.equal(r.truncated, false)
    assert.ok(r.visited > 0, 'visited 要如实报，调用方拿它扣预算')
  })

  await check('maxDepth 到底就不再往下', async () => {
    const deep = path.join(scanRoot, '深')
    assert.equal((await countExes(deep, { maxDepth: 8 })).count, 1, 'a/b/c/deep.exe')
    assert.equal((await countExes(deep, { maxDepth: 2 })).count, 0, '第 3 层的 exe 不该数到')
  })

  await check('skip 名单里的目录不进去', async () => {
    const bare = await countExes(scanRoot, { maxDepth: 8 })
    const skipped = await countExes(scanRoot, { maxDepth: 8, skip: skippable })
    assert.ok(bare.count > skipped.count, 'node_modules 里那个 exe 该被 skip 挡掉')
  })

  await check('撞上 maxExes：count 是下界，truncated 为真', async () => {
    const r = await countExes(scanRoot, { maxDepth: 8, maxExes: 2 })
    assert.equal(r.count, 2)
    assert.equal(r.truncated, true, '没数完必须说出来 —— agent 靠它区分「真的 0 个」和「没数完」')
  })

  await check('撞上 maxEntries：预算花光就收手', async () => {
    const r = await countExes(scanRoot, { maxDepth: 8, maxEntries: 3 })
    assert.equal(r.truncated, true)
    assert.ok(r.visited <= 3, `visited 不该超过预算，实际 ${r.visited}`)
  })

  await check('预算为 0 时一项都不访问', async () => {
    const r = await countExes(scanRoot, { maxDepth: 8, maxEntries: 0 })
    assert.equal(r.count, 0)
    assert.equal(r.visited, 0)
    assert.equal(r.truncated, true)
  })

  await check('取消信号一进来就收手', async () => {
    const r = await countExes(scanRoot, { maxDepth: 8, cancelled: () => true })
    assert.equal(r.count, 0)
    assert.equal(r.truncated, true)
  })

  await check('读不到的目录当空目录，不抛', async () => {
    const r = await countExes(path.join(scanRoot, '并不存在'), { maxDepth: 8 })
    assert.equal(r.count, 0)
    assert.equal(r.truncated, false, '目录不存在不算「没数完」，它确实没有 exe')
  })

  await fsp.rm(scanRoot, { recursive: true, force: true })

  /* --------------------------- 读 exe 的版本资源 --------------------------- */

  // 这一节和上一节守的是同一件事：界面别卡死。v0.8.0 上点「开始识别」弹「抱一 未响应」，
  // 根因是 resedit 的 VS_VERSIONINFO 解析器按 String 条目**自报的 wValueLength**
  // 算下一条的位置，真实文件里那个数对不上时游标原地打转 —— 纯同步死循环，
  // 不抛错所以 catch 不到，没有 await 所以事件循环一次都轮不到，主进程就此停摆。
  //
  // 现在自己走 VS_VERSIONINFO（peReader.ts 里 parseVersionResource），
  // 按每个节点自报的 wLength 前进，游标不严格变大就收手。下面喂的是构造出来的畸形
  // 二进制 —— 真 exe 进不了 selfcheck，但触发那个 bug 的形状能原样搭出来。
  console.log('\n软件识别 · 读 exe 的版本资源')

  const align4 = (n: number): number => (n + 3) & ~3
  const wide = (s: string): Buffer => Buffer.from(s + '\0', 'utf16le')

  /** 按 VS_VERSIONINFO 的节点格式拼一段。wLength / wValueLength 可以手写成假的，畸形用例要的就是这个 */
  function verNode(o: {
    key: string
    value?: Buffer
    wType?: number
    wValueLength?: number
    wLength?: number
    children?: Buffer[]
  }): Buffer {
    const key = wide(o.key)
    const value = o.value ?? Buffer.alloc(0)
    // 兄弟节点之间要 4 字节对齐，补在前一条后面
    const children = Buffer.concat(
      (o.children ?? []).map((c) => Buffer.concat([c, Buffer.alloc(align4(c.length) - c.length)]))
    )
    const valueStart = align4(6 + key.length)
    const childStart = align4(valueStart + value.length)
    const buf = Buffer.alloc(childStart + children.length)
    const wType = o.wType ?? 1
    buf.writeUInt16LE(o.wLength ?? buf.length, 0)
    buf.writeUInt16LE(o.wValueLength ?? (wType === 1 ? value.length / 2 : value.length), 2)
    buf.writeUInt16LE(wType, 4)
    key.copy(buf, 6)
    value.copy(buf, valueStart)
    children.copy(buf, childStart)
    return buf
  }

  /** VS_FIXEDFILEINFO：52 字节，签名 + 版本号，剩下的字段这里用不到 */
  function fixedInfo(ms: number, ls: number): Buffer {
    const b = Buffer.alloc(52)
    b.writeUInt32LE(0xfeef04bd, 0)
    b.writeUInt32LE(ms, 8)
    b.writeUInt32LE(ls, 12)
    return b
  }

  const versionRoot = (strings: Buffer[], fixed = fixedInfo(0x0005_0000, 0x1388_0000)): Buffer =>
    verNode({
      key: 'VS_VERSION_INFO',
      value: fixed,
      wType: 0,
      children: [
        verNode({
          key: 'StringFileInfo',
          children: [verNode({ key: '080404b0', children: strings })]
        })
      ]
    })

  await check('String 条目自报的 wValueLength 短了，值和后面的兄弟都不能丢', () => {
    // Waves.exe 的真实形状：CompanyName 自报 26，值区实际占 28 个 wchar。
    // 旧解析器据此算下一条的位置，落在真正的下一条之前 4 字节，从此原地打转。
    const info = parseVersionResource(
      versionRoot([
        verNode({ key: 'CompanyName', value: wide('ESS Earth Sciences Pty Ltd'), wValueLength: 26 }),
        verNode({ key: 'FileDescription', value: wide('Waves') }),
        verNode({ key: 'FileVersion', value: wide('5.0.5000') })
      ])
    )
    assert.equal(info.company, 'ESS Earth Sciences Pty Ltd', '短报的那条不能被截断')
    assert.equal(info.file_description, 'Waves', '它后面的兄弟不能被吃掉')
    assert.equal(info.version, '5.0.5000')
  })

  await check('wLength 自报 0 的畸形节点：收手，不是原地打转', () => {
    // 死循环的直接护栏。真转起来这条会挂着不返回 —— selfcheck 卡住本身就是失败信号
    const info = parseVersionResource(
      versionRoot([
        verNode({ key: 'ProductName', value: wide('никогда'), wLength: 0 }),
        verNode({ key: 'CompanyName', value: wide('Acme') })
      ])
    )
    assert.equal(info.version, '5.0.5000.0', '固定信息块照样读得到')
  })

  await check('wType 写 0 的 String 照样当文本读', () => {
    // vc_redist.x64.exe 八条全写 0，值却都是正常文本，Windows 也照样按文本读出来。
    // StringFileInfo 底下的条目按定义就是字符串，那个标志不可信
    const info = parseVersionResource(
      versionRoot([
        verNode({ key: 'ProductName', value: wide('VC++ Redistributable'), wType: 0 }),
        verNode({ key: 'CompanyName', value: wide('Microsoft Corporation'), wType: 0 })
      ])
    )
    assert.equal(info.product_name, 'VC++ Redistributable')
    assert.equal(info.company, 'Microsoft Corporation')
  })

  await check('值里看不见的方向标记和零宽字符要清掉', () => {
    // dpinst64.exe 的 FileDescription 前面挂着两个 U+200E，肉眼和正常的一模一样，
    // 直接进库就变成搜不着、对不上的脏数据
    const info = parseVersionResource(
      versionRoot([
        verNode({ key: 'FileDescription', value: wide('‎‎Driver Package Installer') }),
        verNode({ key: 'ProductName', value: wide('﻿Driver Package​') })
      ])
    )
    assert.equal(info.file_description, 'Driver Package Installer')
    assert.equal(info.product_name, 'Driver Package')
  })

  await check('没有 FileVersion 时退回固定信息块里的版本号', () => {
    const info = parseVersionResource(versionRoot([verNode({ key: 'CompanyName', value: wide('Acme') })]))
    assert.equal(info.version, '5.0.5000.0', '四段全要，末尾的 0 也是版本号的一部分')
  })

  await check('不是 VS_VERSION_INFO 就当读不到，别硬猜', () => {
    const info = parseVersionResource(verNode({ key: '不认识', value: wide('x') }))
    assert.equal(info.company, '')
    assert.equal(info.version, '')
  })

  /* --------------------------- 从 PE 里取图标帧 --------------------------- */

  // 0.8.0 上报的「空图标」的根因**不是提取失败**：`app.getFileIcon` 在有图标资源的
  // exe 上也会回一张 Windows 的通用程序图标（淡色窗框加蓝块）。2026-09-02 在真库
  // 46 条上量到 13 条拿的是同一张 32×32 通用图，而其中 12 条的 PE 里有 256×256 的
  // 真图标，腾讯 ima.copilot 甚至有 12 组 61 张。
  //
  // **这个洞躲过了所有能自动检查的地方**：icon_path 非空、图标文件真的在、
  // `<img>` 也渲染成功。只有人眼看得出那是张空白图 —— 和「Write 工具毁中文」
  // 同一类：闸门全绿，只有肉眼能发现。
  //
  // 所以现在自己解 RT_GROUP_ICON 挑最大的 PNG 帧（peIcon.ts），取不到才退回
  // getFileIcon。下面喂构造出来的畸形数据，守住真实文件上撞到的那几个形状。
  console.log('\n软件图标 · 从 PE 里取图标帧')

  /** 拼一段 GRPICONDIR。宽高和张数都可以手写成假的，畸形用例要的就是这个 */
  function iconGroup(
    frames: Array<{ w: number; h: number; bits?: number; id: number }>,
    declaredCount?: number
  ): Buffer {
    const b = Buffer.alloc(6 + frames.length * 14)
    b.writeUInt16LE(0, 0)
    b.writeUInt16LE(1, 2)
    b.writeUInt16LE(declaredCount ?? frames.length, 4)
    frames.forEach((f, i) => {
      const o = 6 + i * 14
      // 256 在这个格式里记成 0（宽高各只有一个字节）
      b[o] = f.w >= 256 ? 0 : f.w
      b[o + 1] = f.h >= 256 ? 0 : f.h
      b.writeUInt16LE(f.bits ?? 32, o + 6)
      b.writeUInt16LE(f.id, o + 12)
    })
    return b
  }

  /** 一张最小可用的假 PNG：魔数 + IHDR（宽高写在里面）+ 填充到够长 */
  function fakePng(w: number, h: number): Buffer {
    const b = Buffer.alloc(96)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(13, 8)
    b.write('IHDR', 12, 'latin1')
    b.writeUInt32BE(w, 16)
    b.writeUInt32BE(h, 20)
    return b
  }

  /** 老式 DIB 帧：BITMAPINFOHEADER 打头，不是 PNG */
  function fakeDib(w: number, h: number): Buffer {
    const b = Buffer.alloc(96)
    b.writeUInt32LE(40, 0)
    b.writeInt32LE(w, 4)
    b.writeInt32LE(h * 2, 8)
    return b
  }

  await check('挑最大的 PNG 帧，256 记成 0 也要认出来', () => {
    const icons = new Map([
      [1, fakePng(32, 32)],
      [2, fakePng(256, 256)],
      [3, fakePng(48, 48)]
    ])
    const best = pickBestPngFrame(
      iconGroup([
        { w: 32, h: 32, id: 1 },
        { w: 256, h: 256, id: 2 },
        { w: 48, h: 48, id: 3 }
      ]),
      icons
    )
    assert.equal(best?.width, 256, '256 那一帧在目录项里宽高写的是 0，不还原就会被当成最小的')
    assert.equal(best?.height, 256)
  })

  await check('目录项自报的宽高不可信，按 PNG 的 IHDR 算', () => {
    // X-Mouse Button Control 的真实形状：目录项自报 13×13，那一帧实际是 256×256。
    // 按自报的排序会把最好的帧排到最后，表现是「图标对但很糊」，
    // 没人会往「目录项在说谎」上想。和 wValueLength 短报是同一类教训
    const best = pickBestPngFrame(
      iconGroup([
        { w: 13, h: 13, id: 1 },
        { w: 48, h: 48, id: 2 }
      ]),
      new Map([
        [1, fakePng(256, 256)],
        [2, fakePng(48, 48)]
      ])
    )
    assert.equal(best?.width, 256, '自报 13×13 的那一帧实际是 256×256，它才是最佳帧')
  })

  await check('自报的张数远大于实际数据时不越界', () => {
    // 畸形资源里 idCount 可以是任意数。照着它读会读到缓冲区外面
    const best = pickBestPngFrame(iconGroup([{ w: 64, h: 64, id: 1 }], 9999), new Map([[1, fakePng(64, 64)]]))
    assert.equal(best?.width, 64, '实际只有一帧，多报的那些不该让整段解析崩掉')
  })

  await check('DIB 帧跳过去，让 getFileIcon 接手', () => {
    // DIB-only 的 exe（真库上 15 条）getFileIcon 取到的是 48×48 的**真**图标，
    // 不是通用图，所以这条退路是有用的，不是聊胜于无
    const best = pickBestPngFrame(iconGroup([{ w: 256, h: 256, id: 1 }]), new Map([[1, fakeDib(256, 256)]]))
    assert.equal(best, null, '不解 DIB，回 null 让调用方退回 getFileIcon')
  })

  await check('比 getFileIcon 还小的 PNG 帧不值得用', () => {
    // 16×16 的 PNG 放到 48px 的卡上比 getFileIcon 的 48×48 更难看
    assert.equal(pickBestPngFrame(iconGroup([{ w: 16, h: 16, id: 1 }]), new Map([[1, fakePng(16, 16)]])), null)
    assert.ok(pickBestPngFrame(iconGroup([{ w: 32, h: 32, id: 1 }]), new Map([[1, fakePng(32, 32)]])), '32 够用')
  })

  await check('帧指向的 RT_ICON 不存在时不炸，也不回半张图', () => {
    assert.equal(pickBestPngFrame(iconGroup([{ w: 256, h: 256, id: 7 }]), new Map()), null)
  })

  await check('截断的 GRPICONDIR 和空缓冲都当没有图标', () => {
    assert.equal(pickBestPngFrame(Buffer.alloc(0), new Map([[1, fakePng(64, 64)]])), null)
    assert.equal(pickBestPngFrame(Buffer.alloc(4), new Map([[1, fakePng(64, 64)]])), null)
    // 头齐了但帧数据只有一半
    assert.equal(
      pickBestPngFrame(iconGroup([{ w: 64, h: 64, id: 1 }]).subarray(0, 12), new Map([[1, fakePng(64, 64)]])),
      null
    )
  })

  await check('PNG 魔数对但短得不像图的不收', () => {
    // 坏图标写进去的表现是界面上一个破图框，比退回首字占位更糟
    const stub = fakePng(256, 256).subarray(0, 24)
    assert.equal(pickBestPngFrame(iconGroup([{ w: 256, h: 256, id: 1 }]), new Map([[1, stub]])), null)
  })

  await check('IHDR 里写了荒唐的尺寸就不认这一帧', () => {
    const bogus = fakePng(1, 1)
    bogus.writeUInt32BE(999_999, 16)
    assert.equal(pickBestPngFrame(iconGroup([{ w: 256, h: 256, id: 1 }]), new Map([[1, bogus]])), null)
  })

  /* ------------------------------ 手动换图标 ------------------------------ */

  // 自动提图标本来就会失败（getFileIcon 拿不到图时静默返回空串），所以手动指定是
  // 那部分条目唯一的出路。这一节守的是「两套命名不许撞」和「重新识别别覆盖用户的图」。
  console.log('\n软件图标 · 手动指定')

  await check('图标认的格式和封面、海报是同一份名单', () => {
    // kinds/ 之间不该互相 import，三份名单没有编译期保障，只能靠这一条盯着
    assert.deepEqual(ICON_EXTS, COVER_EXTS)
    assert.deepEqual(ICON_EXTS, POSTER_EXTS)
    assert.ok(isIconExt('a.PNG') && isIconExt('图标.webp'))
    assert.ok(!isIconExt('a.ico'), '.ico 是多尺寸容器，挑到 16×16 放大到 64px 比不换更难看')
    assert.ok(!isIconExt('icon'), '没扩展名的不收')
  })

  await check('手动图标按条目 id 命名，认不出的扩展名退回 .png', () => {
    assert.equal(iconFileName('abc', 'D:\\x\\logo.PNG'), 'abc.png')
    assert.equal(iconFileName('abc', 'D:\\x\\logo.webp'), 'abc.webp')
    assert.equal(iconFileName('abc', 'noext'), 'abc.png')
    assert.equal(iconFileName('abc', 'a.svg'), 'abc.png', '不认的格式不能原样落到文件名上')
  })

  await check('换扩展名时清孤儿的名单覆盖所有认得的格式', () => {
    const siblings = iconSiblings('abc')
    assert.equal(siblings.length, ICON_EXTS.length)
    for (const ext of ICON_EXTS) assert.ok(siblings.includes(`abc${ext}`), `${ext} 不在清理名单里`)
    // 实际会写出来的那个名字必须在名单里，否则 dropManualIcons 漏删的正是当前这张
    assert.ok(siblings.includes(iconFileName('abc', 'x.webp')))
  })

  await check('手动图标和自动提取的图标靠文件名就分得开', () => {
    // 手动的是 <uuid>.<ext>，自动的是 <exe 路径的 sha1>.png。
    // sha1 是 40 位纯十六进制，UUID 带连字符，撞不上 —— 所以不需要多一列 schema
    const id = 'b1946ac9-2492-4d3d-9b0e-000000000001'
    assert.equal(isManualIcon(id, `D:\\baoyi\\icons\\${id}.png`), true)
    assert.equal(isManualIcon(id, `D:\\baoyi\\icons\\${id}.webp`), true)
    const sha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
    assert.equal(isManualIcon(id, `D:\\baoyi\\icons\\${sha1}.png`), false, '自动提的那张不算手动')
  })

  await check('判「是不是手动」只看文件名，不看目录', () => {
    // 图标目录的绝对路径跟着用户数据目录走（临时 profile、换过数据目录、打包前后
    // 都不一样）。拿目录当判据的话，同一条记录换个 profile 就会从「手动」变「自动」
    const id = 'b1946ac9-2492-4d3d-9b0e-000000000002'
    assert.equal(isManualIcon(id, `C:\\另一个\\profile\\icons\\${id}.jpg`), true)
    assert.equal(isManualIcon(id, `/home/u/.config/baoyi/icons/${id}.jpg`), true)
  })

  await check('空值和别人的 id 都不算手动', () => {
    const id = 'b1946ac9-2492-4d3d-9b0e-000000000003'
    assert.equal(isManualIcon(id, ''), false, '没图标时不该显示「重新提取」')
    assert.equal(isManualIcon('', 'x.png'), false)
    assert.equal(isManualIcon(id, 'b1946ac9-2492-4d3d-9b0e-000000000004.png'), false)
    // 前缀相同但不是同一个 id —— 必须严格等于，不能用 startsWith
    assert.equal(isManualIcon(id, `${id}-extra.png`), false)
  })

  await check('图标地址只按 basename 找文件 —— 协议那头防的是 ../ 穿越', () => {
    // 和封面同一个约定：main.ts 的 baoyi:// 处理器拿 path.basename 兜底，
    // 渲染进程这边的 iconUrl 也只取最后一段
    assert.equal(iconUrlOf('C:\\Users\\x\\baoyi\\icons\\abc.png', 7), 'baoyi://icon/abc.png?v=7')
    assert.equal(iconUrlOf('..\\..\\Windows\\System32\\evil.png', 1), 'baoyi://icon/evil.png?v=1')
    assert.equal(iconUrlOf('', 1), '', '没图标时不该拼出一个指向 undefined 的地址')
  })

  await check('图标地址的版本号跟着 updated_at 走 —— 换图标功能上线后这一条是必需的', () => {
    // 手动图标的文件名按条目 id 定，换一张之后 URL 一个字符都不变，Chromium 会
    // 继续拿内存里那张旧图 —— 用户看到的是「点了没反应」。从前没这个问题是因为
    // 图标从来不会被替换（sha1 命名 + 内容不变），换图标一上线这个前提就没了
    const a = iconUrlOf('D:\\icons\\abc.png', 1000)
    const b = iconUrlOf('D:\\icons\\abc.png', 2000)
    assert.notEqual(a, b, '换图标之后 URL 必须变')
    // 默认值也得带上 ?v=，否则「没传版本号」那条路又退回没有缓存破除的老样子
    assert.match(iconUrlOf('D:\\icons\\abc.png'), /\?v=0$/)
  })
}
export async function taxonomySection(): Promise<void> {


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
}
export async function organizeSection(): Promise<void> {


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
}
