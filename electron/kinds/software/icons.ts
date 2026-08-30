/**
 * 手动指定的软件图标。
 *
 * 自动提图标本来就会失败：`app.getFileIcon` 拿不到图时 iconExtractor 静默返回
 * 空串，界面退回首字占位。命令行工具、老程序、被壳套过的 exe 都常见这一路。
 * 所以「换图标」不是锦上添花，它是那部分条目唯一的出路。
 *
 * 和这一层其他文件同一个约定：只做纯逻辑（名单、拼名字、认名字），
 * 不碰数据库不碰 Electron，于是自检能整个跑一遍。真拷文件、真落库在 service 那边。
 */

import path from 'node:path'

/**
 * 认的图片格式。和游戏封面（game/links.ts 的 COVER_EXTS）、影视海报
 * （video/posters.ts 的 POSTER_EXTS）刻意保持一致 —— 三处都是最终塞进渲染进程
 * `<img>` 的图，能渲染的集合是同一个。不 import 过来是因为 `kinds/` 之间
 * 不该互相依赖；三份不许走岔靠自检盯着。
 *
 * `.ico` 仍然不收，虽然图标场景下它最像是该收的那个：它是**多尺寸容器**，
 * 浏览器挑哪一层不受控，挑到 16×16 再放大到 64px 比不换更难看。
 * 用户手里真有 .ico 时，让他自己导出一张 png 是更可预期的结果。
 */
export const ICON_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp']

export function isIconExt(file: string): boolean {
  return ICON_EXTS.includes(path.extname(file).toLowerCase())
}

/**
 * 手动图标在图标目录里叫什么。
 *
 * **用条目 id，而自动提取的那份用 exe 路径的 sha1。** 两套命名共处一个目录是
 * 故意的，靠形状就分得开：id 是 UUID（带连字符、36 位），sha1 是 40 位纯十六进制，
 * 不可能撞。
 *
 * 这么分有两个好处：
 *   · `extractIcon` 只认 `<sha1>.png` 那个名字，手动图标不占它，
 *     所以重新识别时不会被自动提取覆盖，也不会挡住自动提取；
 *   · 「这个图标是不是用户亲手指的」能直接从路径看出来（见 isManualIcon），
 *     省掉一列 schema 和一次迁移。
 *
 * 扩展名跟着源文件走，不统一转 png —— 转格式要引图像库，收益只是文件名整齐。
 * 代价是换图标时可能留下一个旧扩展名的孤儿，所以落库那边要顺手清一遍同名兄弟。
 */
export function iconFileName(id: string, source: string): string {
  const ext = path.extname(source).toLowerCase()
  return `${id}${ICON_EXTS.includes(ext) ? ext : '.png'}`
}

/** 同一个条目所有可能的手动图标文件名，换扩展名时拿它清孤儿 */
export function iconSiblings(id: string): string[] {
  return ICON_EXTS.map((ext) => `${id}${ext}`)
}

/**
 * `icon_path` 里这个值是用户亲手指的，还是从 exe 里提出来的？
 *
 * 只看**文件名**，不看目录：图标目录的绝对路径跟着用户数据目录走
 * （临时 profile、换过数据目录、打包前后都不一样），拿目录当判据的话
 * 同一条记录换个 profile 就会从「手动」变成「自动」。
 *
 * 用途是重新识别时别把用户指的图标覆盖掉。判错的方向是不对称的：
 * 把手动当自动 = 用户亲手挑的图被悄悄换掉，他未必立刻发现；
 * 把自动当手动 = 一个本来能刷新的图标不刷新了，肉眼看不出区别。
 * 所以判据取严的那一侧 —— 必须严格等于 `<id>.<认识的扩展名>`。
 */
export function isManualIcon(id: string, iconPath: string): boolean {
  if (!id || !iconPath) return false
  return iconSiblings(id).includes(path.basename(iconPath).toLowerCase())
}
