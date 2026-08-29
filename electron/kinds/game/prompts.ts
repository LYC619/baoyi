/**
 * 游戏识别 agent 的提示词。
 *
 * 和软件那份分开，不共用一个模板 —— 两边要判断的东西几乎没有重叠：
 * 软件关心「是不是绿色版、能不能搬目录、几个 exe 要不要合并」，游戏关心
 * 「哪个 exe 是本体、中文名是什么、存档在哪」。硬凑一份共用 prompt 的结果
 * 是两边都写着一半跟自己无关的规则，模型每次都要先读一遍再忽略掉。
 */

import type { Category } from '../../../src/types'
import type { GameCandidate } from './scanner.ts'
import { formatSize } from '../../services/agent/files.ts'

/**
 * 引擎决定存档位置 —— 查表查不到时的回退规则。
 *
 * 这一张表是 Step 7 补的，补的是三层策略里**第一层**（agent 自己推理）最薄的那一块。
 * 在它之前，prompt 里只有五条按「常见位置」排的启发式，模型得先猜厂商名再猜目录名，
 * 一条不中就再猜一条。而 scanner 早就把引擎认出来了（evidence 里那几行），
 * 引擎和存档位置的对应关系是**引擎强制的、不是习惯**：Unity 的 Application.persistentDataPath
 * 在 Windows 上就是 `%LOCALAPPDATA%Low\<公司名>\<产品名>`，虚幻的 FPaths::ProjectSavedDir()
 * 就是 `Saved\SaveGames`。这些是规则，不是经验，写进 prompt 之后模型第一发就该命中。
 *
 * 每条 `where` 都必须落在 scanner.saveRoots() 的白名单之内（`in_game_dir` 的那几条
 * 例外，它们走 ctx.roots）—— 否则 detect_save_path 会当场拒掉，白烧一次探测额度。
 * 自检里有一条守这个，也有一条守「scanner 认得的引擎在这儿都有规则」。
 *
 * 变量写法和 scanner.expandSavePath 认得的那套保持一致：`%LOCALAPPDATA%Low` 不是
 * 笔误，那是 LocalLow 的真实拼法（Low 是紧跟在 Local 后面的，不是一个子目录）。
 */
export interface EngineSaveRule {
  /** 引擎名，必须和 scanner 的 evidence 里那个词对得上，模型才连得起来 */
  engine: string
  /**
   * 游戏目录**之外**的候选，按命中率从高到低。`<>` 里的东西要模型自己替换。
   * 每一条都必须落在 scanner.saveRoots() 之内。
   */
  where?: string[]
  /**
   * 游戏目录**之内**的候选，写成相对路径。
   *
   * 和 where 分成两个字段而不是给整条规则挂一个开关：Ren'Py 和 KiriKiri
   * 两处都写（主位置在 AppData，另一份在游戏目录里），一个规则级的开关表达不了
   * 这件事 —— 自检当场把这个建模错误抓出来了。
   */
  in_game?: string[]
  /** 一句话说清「为什么是这儿」或者「上哪儿找那个占位符的值」 */
  note?: string
}

export const ENGINE_SAVE_RULES: EngineSaveRule[] = [
  {
    engine: 'Unity',
    where: ['%LOCALAPPDATA%Low\\<公司名>\\<产品名>'],
    note:
      '这是 Unity 的 Application.persistentDataPath 在 Windows 上的固定去处，几乎没有例外。' +
      '公司名和产品名不用猜 —— 目录线索里已经从 <X>_Data\\app.info 读出来了；' +
      '线索里没有的话，读 <X>_Data\\app.info 那个文件，两行，第一行公司第二行产品。'
  },
  {
    engine: 'Unreal',
    where: [
      '%LOCALAPPDATA%\\<游戏名>\\Saved\\SaveGames',
      '%USERPROFILE%\\Documents\\My Games\\<游戏名>\\Saved\\SaveGames'
    ],
    note:
      '虚幻的存档目录结构是引擎定的：<项目名>\\Saved\\SaveGames。' +
      '<游戏名> 用项目名而不是商店上的显示名 —— 就是 Binaries\\Win64 上面那一级目录的名字。'
  },
  {
    engine: 'RPG Maker',
    in_game: ['save\\', 'www\\save\\'],
    note:
      'RPG Maker（XP/VX/MV/MZ）默认就地存档，存档在游戏目录自己底下，不在 AppData。' +
      'MV/MZ 是 www\\save\\，XP/VX 是 save\\。汉化版和绿色版尤其如此。'
  },
  {
    engine: 'GameMaker',
    where: ['%LOCALAPPDATA%\\<游戏名>'],
    note: 'GameMaker 的 working_directory 就是 %LOCALAPPDATA% 下以游戏名命名的那个目录。'
  },
  {
    engine: "Ren'Py",
    where: ['%APPDATA%\\RenPy\\<游戏名>'],
    in_game: ['game\\saves\\'],
    note:
      "Ren'Py 两处都写：%APPDATA%\\RenPy\\<游戏名> 是主位置，游戏目录下的 game\\saves\\ " +
      '是随身模式留下的那一份。两个都值得验，哪个有文件用哪个。'
  },
  {
    engine: 'Godot',
    where: ['%APPDATA%\\Godot\\app_userdata\\<游戏名>'],
    note: 'Godot 的 user:// 在 Windows 上就落在这里，<游戏名> 是项目名。'
  },
  {
    engine: 'KiriKiri',
    where: ['%APPDATA%\\<游戏名>'],
    in_game: ['savedata\\'],
    note: 'KiriKiri（日系视觉小说）多数就地存 savedata\\，少数走 %APPDATA%\\<游戏名>。'
  },
  {
    engine: 'NW.js',
    where: ['%APPDATA%\\<游戏名>', '%LOCALAPPDATA%\\<游戏名>'],
    note: 'NW.js 打包的程序按 Chromium 的规矩走，用户数据在 %APPDATA%\\<应用名>。'
  },
  {
    engine: 'QSP',
    in_game: ['save\\', 'saves\\'],
    note: 'QSP 这类文字冒险引擎一律就地存档。'
  }
]

/** 把规则表渲染成 prompt 里的那一节 */
function renderEngineRules(): string {
  const code = (list: string[]): string => list.map((w) => `\`${w}\``).join('　或　')
  return ENGINE_SAVE_RULES.map((r) => {
    const parts: string[] = []
    if (r.where?.length) parts.push(code(r.where))
    // 「游戏目录下」这句必须显式写出来：相对路径单看是认不出该拼在哪儿的
    if (r.in_game?.length) parts.push(`**游戏目录下**的 ${code(r.in_game)}`)
    return `- **${r.engine}** → ${parts.join('；也可能是 ')}${r.note ? `\n  ${r.note}` : ''}`
  }).join('\n')
}

export const IDENTIFY_GAME_SYSTEM = `你是「抱一」的游戏识别 agent。抱一是一个本地资源管理器，帮用户看清自己电脑里到底存了什么。
你的任务是探索一个目录，判断它是不是一个游戏，是的话把它注册进抱一，并尽量找到它的存档位置。

## 工作方式
1. 系统已经先替你看过一眼，任务描述里的「目录线索」写着命中的引擎特征和目录里的 exe 列表。
   **先读它**，很多时候它已经够你下判断了，不必再 list_directory 一遍。
2. 线索不够时再用 list_directory 看结构、用 read_text_file 读说明文档。
3. 找存档：先按下面「怎么找存档」那一节想出候选路径，再用 detect_save_path 逐个验证。
   **只有 detect_save_path 说存在的路径才能填进 save_paths**。
4. 用 register_game 注册；确认这个目录不是游戏就用 skip_directory 跳过。
5. 处理完用一句话总结，**不要再调用任何工具**。

## 哪个 exe 是本体
这是最容易搞错的一步，而且错了用户点开的就是个错东西。
- 线索里给了「疑似主程序」时，直接用它 —— 那是按引擎的命名规则推出来的，不是猜的。
- **Unity 游戏**：主程序是与 \`X_Data\\\` 目录同名的 \`X.exe\`。
  \`UnityCrashHandler64.exe\` / \`UnityCrashHandler32.exe\` 是崩溃上报程序，**绝对不是本体**，
  而且它常常比本体还大 —— 不要按体积挑。
- **Unreal 游戏**：根目录那个短小的 \`X.exe\` 是启动壳，它才是用户该点的那个；
  \`Binaries\\Win64\\X-Win64-Shipping.exe\` 是真正的可执行体，但不要拿它当主程序。
- **RPG Maker MV/MZ**：\`Game.exe\` 或与目录同名的 exe。
- 下面这些一律不是本体，也不要注册成条目：
  unins*.exe、setup.exe、*Setup*.exe、vcredist*、dxsetup、DXSETUP.exe、oalinst.exe、
  crashpad_handler.exe、UnityCrashHandler*.exe、*Launcher.exe 中的第三方启动器
  （游戏自带的中文启动器可以留意，但优先选真正的游戏本体）。
- 汉化整合包里常有「一键汉化.exe」「启动游戏.bat」之类，它们不是本体。

## 一个目录里有多个游戏
少见但存在（合集、老游戏打包）。真遇上就对每个游戏各调一次 register_game，
每次填各自的主程序路径。拿不准是不是两个游戏时，按一个处理。

## 怎么找存档
存档几乎总在游戏目录**之外**。

**认出游戏名之后第一件事是 lookup_save_paths**，它查的是 PCGamingWiki 社区维护的
已知存档位置库（19000+ 游戏）。查到了就直接拿那些路径去 detect_save_path 验，
省下好几轮猜。用英文原名查 —— 那个库的键是英文名。

查不到（或者数据库不可用）时**先看引擎**，再退回按位置猜。

### 回退第一步：按引擎的规则推
目录线索里报了哪个引擎，就直接用那一条 —— 这些不是经验总结，是引擎写死的行为，
命中率远高于按「常见位置」逐个试：

{{engine_rules}}

替换 \`<>\` 里的东西时：\`<公司名>\` / \`<产品名>\` 优先用线索里从 app.info 读出来的那两个；
\`<游戏名>\` 试英文原名、去掉空格的写法、以及主程序 exe 去掉扩展名的名字（**这个常常最准**，
它就是项目名）。

### 回退第二步：按位置猜
引擎认不出来（老游戏、汉化整合包），或者按引擎那条没验到，再按这个顺序试：
1. \`%APPDATA%\\<游戏名或厂商名>\`、\`%LOCALAPPDATA%\\<同上>\`。
2. \`%USERPROFILE%\\Documents\\My Games\\<游戏名>\` —— Unreal 和大量欧美游戏用这里。
3. \`%USERPROFILE%\\Saved Games\\<游戏名>\`。
4. \`%USERPROFILE%\\Documents\\<游戏名>\` —— 国产游戏和独立游戏常用。
5. **游戏目录自己底下的 save\\ / saves\\ / savedata\\ / 存档\\** —— 绿色版、汉化版
   大多就地存档。线索里报了「目录内自带存档目录」就先验这个。

规则：
- **不管从哪一步来的路径，都必须过 detect_save_path。** 引擎规则给的是「该在哪」，
  detect_save_path 回答的是「这台机器上在不在」—— 前者推得再对，用户没玩过、
  装在别的账户下、或者用的是绿色版，路径照样是空的。**没验过就填等于编。**
- 游戏名要试几种写法：中文名、英文原名、去掉空格的英文名、去掉冒号和副标题的写法。
- lookup_save_paths 查到的路径**也要验**。那是社区记录，游戏换过存档位置、或者这台
  机器上装的是别的版本，都会让记录对不上。查表和你自己的猜测在这里是平级的证据。
- 一次 detect_save_path 只验一个路径，最多验 6 次。全都不存在就把 save_paths 留空 ——
  **留空是可以接受的答案，编一个不存在的路径不是**。用户之后可以自己指定，
  而一个错的路径会让「备份存档」备份一个空文件夹，他还以为自己有备份。
- 验证结果里「最后修改时间」很久以前或文件数为 0 的，多半不是这个游戏的存档，别填。

## 分类：按玩法类型分
当前分类体系（只能从中选一个）：
{{categories}}

分类回答的是「这是个什么类型的游戏」。分类只有几个，所以每一格都很宽 ——
战棋、卡牌构筑都可以归「策略」，不要因为不完全贴合就另起一个新分类。
实在没有一个说得通时才可以提新分类名，它会被标记出来交给用户裁决。

## 标签：描述特征，不重复分类
当前标签池（优先复用，确实没有合适的才可新建，最多 1 个）：
{{tags}}

- 标签描述玩法特征、题材或来源，不描述已经由分类表达过的类型。
  ✗ 「角色扮演」——分类已经是 RPG 了
  ✓ 「魂系」「开放世界」「像素」「汉化」「独立游戏」
- 标签要对用户有意义 —— 他是靠标签在封面墙上筛游戏的，看不懂的词等于永不会被点的筛选项。
- 粒度：一个标签至少要能关联 2 个以上游戏。只可能对应一个游戏的词不要用。
- 1-3 个。

## 命名规范
- **name_en 填官方英文名**，保持官方的大小写和空格：Elden Ring、Hollow Knight、Stardew Valley。
  不要自己缩写，不要把中文缀在后面。
- **name_zh 填通行中文译名**：《艾尔登法环》写「艾尔登法环」，不带书名号。
  没有通行译名时用英文原名，**不要自己现造一个译名**。
- 目录名常常带着版本号、汉化组、平台标记（「艾尔登法环 v1.10 豪华版 3DM汉化」），
  名字里**不要**保留这些，它们属于 description。
- **description 用中文写它是个什么游戏**，50-100 字，说玩法和特色，不要写成宣传语。
- summary 一句话，15-20 字，让用户一眼想起这是哪个游戏。

## 不是游戏怎么办
这个目录是模拟器本体、MOD 工具、攻略文档、或者压根是个普通软件 —— 用 skip_directory
说明原因。识别错一个「游戏」比漏掉一个更麻烦：它会占着封面墙的一格，
而用户得手工去删。

## 硬性要求
- exe_path 必须是你在「目录线索」或 list_directory 里真实见过的路径，不许拼、不许猜。
- save_paths 里的每一条都必须是 detect_save_path 验证存在的，一条都不许编。
- 不确定的信息宁可留空。official_url 拿不准就传空字符串。
- {{search_note}}
- 单个游戏控制在 12 次工具调用以内，信息够了就下结论。`

const SEARCH_NOTE_ON =
  '认不出这是什么游戏时可以用 web_search，关键词用「游戏名 + 游戏」，优先中文结果。' +
  '目录名一眼能认出来的（原神、饥荒、空洞骑士）不要浪费额度。'
const SEARCH_NOTE_OFF =
  '本次运行**没有开启联网搜索**，没有 web_search 工具，不要尝试调用它。' +
  '认不出来的不要编：name_zh 用目录名顶上，description 只写你能确定的部分。'

/**
 * 把分类表、标签池和搜索开关填进系统提示。
 *
 * 现读现填而不是写死：用户在设置里加一个游戏分类、合并两个标签，下一次识别
 * 就该按新的来。withSearch 必须和传给 buildGameTools 的是同一个值，否则
 * 提示词会让模型去调一个没注册的工具，白烧一轮 —— 软件那边踩过这个坑。
 */
export function fillGameSystem(
  categories: Category[],
  pool: string[],
  withSearch = true
): string {
  const cats = categories.length
    ? categories.map((c) => `  · ${c.name}${c.description ? ` —— ${c.description}` : ''}`).join('\n')
    : '  （分类表是空的，直接用「其他」）'
  const tags = pool.length ? `  ${pool.join('、')}` : '  （标签池还是空的，你可以按上面的规范提 1-3 个）'
  return IDENTIFY_GAME_SYSTEM.replace('{{categories}}', cats)
    .replace('{{tags}}', tags)
    // 引擎规则表现渲染而不是写死在模板里：改一条规则只该改 ENGINE_SAVE_RULES，
    // 自检也是照那份数据验的 —— 两处各写一遍迟早漂
    .replace('{{engine_rules}}', renderEngineRules())
    .replace('{{search_note}}', withSearch ? SEARCH_NOTE_ON : SEARCH_NOTE_OFF)
}

/** 列表太长会把后面的规则挤出模型的注意力，exe 只报前这么多个 */
const PROMPT_EXE_LIMIT = 12

/**
 * 一个候选目录的任务描述。
 *
 * 把 scanner 已经看到的东西原样交上去，是这份 prompt 最省钱的一段：
 * 引擎判出来了，「主程序是哪个」就变成一条规则而不是一轮 get_file_info。
 */
export function candidatePrompt(
  c: GameCandidate,
  registered: Array<{ name: string; path: string }> = []
): string {
  const lines = [`请识别这个目录是不是一个游戏：${c.dir}`, '']

  lines.push('## 目录线索')
  lines.push(
    c.evidence.length
      ? c.evidence.map((e) => `  · ${e}`).join('\n')
      : '  · 没有命中任何引擎特征。它可能是老游戏、汉化整合包，也可能根本不是游戏 —— 需要你自己看。'
  )

  lines.push('', `## 目录里的 exe（共 ${c.exes.length} 个，按体积排序）`)
  for (const e of c.exes.slice(0, PROMPT_EXE_LIMIT)) {
    lines.push(`  ${e.path}  ${formatSize(e.size)}`)
  }
  if (c.exes.length > PROMPT_EXE_LIMIT) {
    lines.push(`  （还有 ${c.exes.length - PROMPT_EXE_LIMIT} 个没列出，需要时用 list_directory 看）`)
  }

  if (c.likely_main) {
    lines.push(
      '',
      `## 疑似主程序：${c.likely_main}`,
      '这是按引擎的命名规则推出来的，可信度高。除非你有明确相反的证据，直接用它。'
    )
  }

  if (registered.length > 0) {
    lines.push('', '## 这个目录下之前已经注册过', '（识别到同一个游戏时用相同的 exe_path 即可覆盖，不要另起一条）')
    for (const r of registered.slice(0, 10)) lines.push(`  · ${r.name} → ${r.path}`)
  }

  return lines.join('\n')
}
