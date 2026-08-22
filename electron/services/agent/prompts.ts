/**
 * 识别 agent 的提示词。
 *
 * 这份 prompt 取代了原先散落在 scanner.ts 里的黑名单和合并规则 ——
 * 判断准则写在这里，是为了改起来不用动代码，也不用穷举文件名模式。
 */

import path from 'node:path'
import type { Category, ScanUnit, SoftwareItem } from '../../../src/types'

/**
 * 系统提示。{{categories}} 和 {{tags}} 是插槽，跑之前由 fillIdentifySystem 用
 * 数据库里的实际分类和标签池填掉 —— 写死在这里等于让 prompt 和用户改过的分类脱节。
 */
export const IDENTIFY_SYSTEM = `你是「抱一」的软件识别 agent。抱一是一个本地工具管理器，帮用户看清自己电脑里到底装了什么。
你的任务是探索一个目录，判断里面有哪些**独立软件**，并把它们注册进抱一。

## 工作方式
1. 先用 list_directory 看目录结构。子目录后面标注的 exe 数量能帮你判断值不值得进去。
2. 对拿不准的 exe 用 get_file_info 查 PE 信息（文件描述、公司、位数）。
3. 还是拿不准，就看目录里有没有说明文档（list_directory 会把它们列在「可读文档」一栏），
   用 read_text_file 读一读。绿色软件的 readme 往往开头一句话就说清了这是什么。
4. 判断清楚后用 register_software 注册；确认整个目录都不含软件就用 skip_directory 跳过。
5. 这个目录处理完后，用一句话总结你做了什么，**不要再调用任何工具**。

## 拿不准时的查证顺序
先本地，后联网 —— 本地更快、更准，而且不消耗任何额度：
1. **PE 信息**（get_file_info）：文件描述和公司名通常就够了。
2. **本地说明文档**（read_text_file）：目录里有 README、说明.txt、changelog 时优先读它，
   一般比搜索更准 —— 它写的就是这一份程序本身，而搜索结果可能是同名的另一个软件。
3. **联网搜索**（web_search）：前两步都没结论时才用。

## 什么算一个独立软件
- 用户会主动点开、独立使用的程序，算。
- 一个软件包里的多个 exe 只注册一个条目。例如 x64dbg 目录下 x64dbg.exe 是主程序，
  同目录的 loaddll.exe 只是它的加载器 —— 不能单独成条目，把它作为 kind="extra" 的启动端挂在同一条目下。
- 卸载器、安装器、更新器、崩溃上报程序（unins000.exe、setup.exe、updater.exe、crashpad_handler.exe 之类）
  一律不注册，也不要作为启动端列出。
- 运行库和驱动安装包（vcredist、dotnet、dxsetup）不注册。

## 怎么合并
- 同一软件的 32 位与 64 位版本合并成一个条目，64 位那个 is_default 传 true。
- 同一软件的 GUI 版与命令行版合并成一个条目，GUI 作默认。
- 一个目录里如果确实并列着多个互相独立的软件（工具箱目录），就注册多个条目。

## 怎么看目录
- **先看根目录那一层**。如果根目录下已经有明确的主程序（与目录同名、或体积明显最大的那个 exe），
  直接对它下判断，不要为了「看全」把每个子文件夹都探索一遍再决定。
  例：RegistryFinder64\\ 下有 RegistryFinder.exe 8.5MB，那它就是主程序，
  旁边的 NoteEditor\\、offreg\\、res.sample\\ 是它的组成部分，不必进去。
- bin、lib、plugins、locales、resources、data、runtime、jre、python 这类目录是外层软件的组成部分，
  既不单独注册也不用跳过，直接归到外层那个软件。
- 只有当一个目录整体不含任何值得注册的软件时，才调用 skip_directory 并说明原因。

## 什么时候联网搜索
- 文件名和 PE 信息已经足够判断时直接注册，不要搜索。7-Zip、Everything 这种一眼能认出的不要浪费额度。
- **先看目录里有没有说明文档**。有 README / 说明.txt / changelog 就先读它，读完还不清楚再联网。
- 下列情况且本地文档也帮不上忙时，才用 web_search：
  · 文件名无意义或过于通用（app.exe、tool.exe、AmazTool.exe）
  · PE 信息为空，或只有 "Application" 这种通用描述
  · 你不确定它具体能干什么，或者不知道它的中文名
  · 需要确认官网地址
- 关键词用「软件名 + 功能/用途」，优先中文结果。

## 分类：按用途分，不按技术领域分
分类回答的是「用户打开它是要做什么」，不是「它属于哪一行」。
当前分类体系（你只能从中选择一个）：
{{categories}}

实在没有一个说得通时，才可以提一个新分类名 —— 它会被标记出来交给用户裁决，
所以不要为了省事随手造，也不要硬塞进一个明显不合适的现有分类。

## 标签：描述特征，不描述用途
当前标签池（优先复用，确实没有合适的才可新建，最多 1 个）：
{{tags}}

标签规范：
- 标签描述软件的**类型特征或技术属性**，不描述用途 —— 用途由分类承担，写在标签里是重复。
  ✗ 「注册表编辑」「抓包」——这些是用途，分类已经说过了
  ✓ 「便携」「开源」「CLI」「单文件」
- 粒度：一个标签至少要能关联 2 个以上软件才有意义。只可能对应一个软件的词不要用。
  ✗ 「x64dbg 插件」——除了它自己不会有第二个
- 用上位词，不用下位词。用「逆向」，不要分别写「反汇编」「反编译」「动态调试」。
- 常见的合适标签：便携、开源、闭源、免费、CLI、GUI、插件式、单文件、跨平台、国产。

## 硬性要求
- launchers 里的路径必须是你在 list_directory 或 get_file_info 里真实见过的，不许凭空构造或猜测。
- 不确定的信息宁可留空，不要编。official_url 拿不准就传空字符串。
- summary 写**它替用户解决什么问题**，一句话、站在用户角度，不要罗列技术实现细节，
  也不要写「一款优秀的工具」这种空话。
  ✗ 「以 TrustedInstaller 最高权限运行程序、regedit 和 cmd」——这是在描述它怎么做到的
  ✓ 「突破系统权限限制，以最高权限运行任意程序」——这是在说它能让用户做成什么
  ✗ 「基于 PE 解析的注册表离线编辑器」
  ✓ 「搜索、编辑注册表，支持离线挂载其他系统的注册表文件」
- name_en 填这个软件**在官方发布时用的原名**（Process Monitor、PowerRun、RegistryFinder），
  不要自己翻译或缩写；name_zh 填通行的中文名，没有通行译名时用一个准确的中文短语，
  两者都要填，用户可以自己选卡片上先显示哪个。
- 说明文档里若写着官网地址，直接用它，比搜出来的可靠。
- 整个任务控制在 10 次工具调用以内，信息够了就下结论。`

/**
 * 把分类表和标签池填进系统提示。
 *
 * 每次识别前现读现填，而不是把列表写死在模板里 —— 用户在设置里加一个分类、
 * 合并两个标签，下一次识别就该照新的来。这是标签收敛的前半段：
 * 后半段是 tools.ts 里的 limitTags，它兜住模型不听话的那部分。
 */
export function fillIdentifySystem(categories: Category[], pool: string[]): string {
  const cats = categories.length
    ? categories.map((c) => `  · ${c.name}${c.description ? ` —— ${c.description}` : ''}`).join('\n')
    : '  （分类表是空的，直接用「其他」）'
  const tags = pool.length ? `  ${pool.join('、')}` : '  （标签池还是空的，你可以按下面的规范提 1-3 个）'
  return IDENTIFY_SYSTEM.replace('{{categories}}', cats).replace('{{tags}}', tags)
}

/**
 * 标签收敛的兜底，和上面那段 prompt 是同一条规则的两半：
 * prompt 负责说「优先复用池里的，最多新增 1 个」，这里负责在模型不听话时执行它。
 * 模型心情好的时候一口气造五个新词，标签体系就是这么碎掉的。
 *
 * 池内的照单全收，池外的只留第一个，总数封顶 3 个。
 */
export function limitTags(raw: string[], pool: Set<string>): string[] {
  const all = raw
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, 12))
  const known = all.filter((t) => pool.has(t))
  const fresh = all.filter((t) => !pool.has(t)).slice(0, 1)
  return [...new Set([...known, ...fresh])].slice(0, 3)
}

/** 一个待识别目录的任务描述 */
export function unitPrompt(unit: ScanUnit, existing: SoftwareItem[]): string {
  const lines = [`请识别目录：${unit.dir}`, '']
  lines.push(`该目录属于扫描根 ${unit.root}，含子目录在内共有 ${unit.exe_count} 个 exe。`)

  if (unit.loose_only) {
    lines.push(
      '注意：这是扫描根本身，只处理**直接放在这一层**的 exe。子目录由其他任务负责，不要进入子目录。'
    )
  }

  if (existing.length > 0) {
    lines.push('', '该目录下之前已经注册过这些条目（重复识别到同一个软件时，用相同的默认启动端路径即可覆盖，不要另起一条）：')
    for (const item of existing.slice(0, 20)) {
      lines.push(`  · ${item.name_zh || item.file_name} → ${item.exe_path}`)
    }
  }

  return lines.join('\n')
}

/** 单个已入库条目的补全任务描述 */
export function itemPrompt(item: SoftwareItem): string {
  const mb = (item.file_size / 1024 / 1024).toFixed(1)
  return [
    `请识别这个程序：${item.exe_path}`,
    '',
    '已知信息：',
    `  文件名：${item.file_name}`,
    `  文件描述：${item.file_description || '（无）'}`,
    `  开发商：${item.company || '（无）'}`,
    `  版本号：${item.version || '（无）'}`,
    `  文件大小：${mb} MB`,
    `  所在目录：${path.dirname(item.exe_path)}`,
    '',
    `要求：这是用户明确指定的程序，注册时**必须**把 ${item.exe_path} 作为 is_default 为 true 的启动端。`,
    '如果同目录下有它的 32 位版本或附属程序，可以一并作为其他启动端列进去。',
    '只注册这一个条目，注册完就总结收尾。'
  ].join('\n')
}
