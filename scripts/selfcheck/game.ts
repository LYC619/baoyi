import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { coverUrl as coverUrlOf, LINK_TYPE_LABEL } from '../../src/utils/index.ts'
import type { LinkedFile } from '../../src/types/index.ts'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../../electron/services/storage/schema.ts'
import { KINDS } from '../../electron/kinds/index.ts'
import { gameKind } from '../../electron/kinds/game/index.ts'
import { expandSavePath, inspectDir, probeSave, saveRootOf, saveRoots, scanGameRoot } from '../../electron/kinds/game/scanner.ts'
import { deleteGame, gameCounts, gamesUnder, getGame, insertGame, listGames, updateGame, type GamePayload } from '../../electron/kinds/game/db.ts'
import { acceptSavePaths, limitGameTags } from '../../electron/kinds/game/tools.ts'
import { candidatePrompt, ENGINE_SAVE_RULES, fillGameSystem } from '../../electron/kinds/game/prompts.ts'
import { addLinks, COVER_EXTS, coverFileName, coverSiblings, guessLinkType, hasLink, isCoverExt, LINK_TYPES, MAX_LABEL, MAX_LINKS, relabelLink, removeLink } from '../../electron/kinds/game/links.ts'
import { acceptImageUrl, candidatesFromSearch, cleanQuery, coverQueries, extFromContentType, finalizeCandidates, MAX_CANDIDATES, MAX_COVER_BYTES, pickSteamApps, steamCoverCandidates } from '../../electron/kinds/game/covers.ts'
import { imageSearchAvailable, imageSearchWhyNot } from '../../electron/services/network/searchService.ts'
import { backupFolder, createBackup, deleteBackup, gameFolder, listBackups, MANIFEST, overRetention, PAYLOAD, restoreBackup, restoreBlocked, stamp, type GameLike } from '../../electron/kinds/game/backup.ts'
import { expandTemplate, lookupSavePaths, normalizeGameName, truncateTemplate, type SaveDbHandle } from '../../electron/kinds/game/savedb.ts'
import { elapsedSeconds, endSession, MIN_SESSION_SEC } from '../../electron/kinds/game/session.ts'
import { isDriveRoot, nestedInside as nestedInsideShared } from '../../electron/services/system/fstree.ts'
import { check } from './shared.ts'


/* ==================== 游戏识别 · Step 3 ==================== */

/**
 * 造一棵真实的临时目录树来跑 scanner —— 这一段全是「读磁盘之后怎么判断」，
 * 用假的 fs mock 验它等于在验 mock 自己。
 */
export async function gameIdentifySection(): Promise<void> {
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
export async function saveBackupSection(): Promise<void> {
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

export async function saveDbSection(): Promise<void> {
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
export async function engineRulesSection(): Promise<void> {
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

export async function linksAndCoverSection(): Promise<void> {
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

  await check('没有英文名时使用中文名；收纳目录不能充当游戏身份', () => {
    assert.deepEqual(coverQueries({ name_zh: '中华三国志' }), ['中华三国志'])
    const only = coverQueries({ source_dir: 'E:\\游戏\\洛克王国：世界(2002304)' })
    assert.deepEqual(only, [], '没有游戏身份时应先确认名称，不能拿目录兜底搜索')
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

  await check('Steam 只选择规范化名称相等的本体，保留续作编号差异', () => {
    // 模糊匹配会把 Portal 匹到 Portal 2 上，而封面错了比没封面更糟
    const items = [
      { id: 620, name: 'Portal 2' },
      { id: 400, name: 'Portal' },
      { id: 1, name: '完全不相关的游戏' }
    ]
    const picked = pickSteamApps(items, 'Portal')
    assert.equal(picked[0].id, 400, '完全相等的必须排第一')
    assert.deepEqual(picked.map(p => p.id), [400], 'Portal 2 不能当作 Portal 的封面来源')
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

  await check('候选定型：过白名单、精确 URL 去重、保留路径大小写、竖版优先', () => {
    const dup = 'https://cdn.cloudflare.steamstatic.com/steam/apps/400/a.jpg'
    const out = finalizeCandidates([
      { url: 'https://cdn.cloudflare.steamstatic.com/b.jpg', label: '横', source: 'steam', portrait: false, rank: 0 },
      { url: dup, label: '竖', source: 'steam', portrait: true, rank: 1 },
      { url: dup, label: '同一 URL', source: 'steam', portrait: true, rank: 2 },
      { url: dup.toUpperCase().replace('HTTPS', 'https').replace('CDN.CLOUDFLARE.STEAMSTATIC.COM', 'cdn.cloudflare.steamstatic.com'), label: '重复', source: 'steam', portrait: true, rank: 2 },
      { url: 'https://evil.example.com/x.jpg', label: '越界', source: 'search', portrait: true, rank: 0 }
    ])
    assert.ok(out[0].portrait, '竖版必须排前面')
    assert.ok(!out.some((c) => c.url.includes('evil')), '白名单外的必须被过掉')
    assert.equal(new Set(out.map((c) => c.url)).size, out.length, '不该有重复 URL')
    assert.equal(out.length, 3, 'HTTP 路径大小写可以对应不同图片，不能合并')
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

export async function playSessionSection(): Promise<void> {
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
