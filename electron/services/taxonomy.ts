/**
 * 分类体系与内置标签池。
 *
 * 单独一个文件，是为了让它能被自检脚本直接 import —— database.ts 依赖 electron 和
 * better-sqlite3（按 Electron ABI 编译），纯 node 载不进来。而这里的迁移映射表是
 * 0.4 最危险的一处：它会改写库里**每一条**软件的 category，映射目标一个字写错，
 * 那一批条目就落进一个分类表里不存在的格子。这类错误必须能在自检里逼出来。
 */

import type { Category } from '../../src/types'

/** 归不进任何分类时的落脚点。它也是分类表里真实存在的一条，不是特殊值 */
export const FALLBACK_CATEGORY = '其他'

/**
 * 按**用途**分，不按技术领域分。
 *
 * 0.2 那套（逆向分析 / AI 编程 / 文件搜索…）粒度太细：11 个格子里有 6 个长期只装
 * 一两个软件，而 agent 每次都要在这 11 个里挑，挑错的机会也就多了 6 倍。
 * 0.4 收成 5 个 —— 每个格子都装得下十几个软件，分类才有归纳的意义。
 */
export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'system',
    name: '系统管理',
    description: '进程监控、注册表编辑、权限管理、磁盘分析、右键菜单、启动项',
    icon: 'sliders-horizontal',
    sort_order: 1
  },
  {
    id: 'dev',
    name: '开发工具',
    description: '编程、逆向、调试、十六进制编辑、代码编辑器、AI 编程辅助',
    icon: 'code-2',
    sort_order: 2
  },
  {
    id: 'utility',
    name: '实用工具',
    description: '归不进以上类别的日常效率工具：截图、OCR、PDF、笔记、搜索、下载',
    icon: 'wrench',
    sort_order: 3
  },
  {
    id: 'media',
    name: '媒体娱乐',
    description: '图片处理、音视频播放转码、游戏相关',
    icon: 'clapperboard',
    sort_order: 4
  },
  {
    id: 'other',
    name: FALLBACK_CATEGORY,
    description: '还没归类，或自建分类之前的临时存放',
    icon: 'inbox',
    sort_order: 5
  }
]

/**
 * 0.2 的分类 → 0.4 的分类。
 *
 * 不在这张表里、又不是新分类之一的（含用户自建的），一律退回「其他」——
 * 猜错的成本比让用户重归一次高：一个被塞进「媒体娱乐」的调试器不会有人回头去改。
 */
const CATEGORY_MOVES: Record<string, string> = {
  逆向分析: '开发工具',
  'AI 编程': '开发工具',
  编辑查看: '开发工具',
  系统调控: '系统管理',
  文件搜索: '实用工具',
  网络调试: '开发工具',
  图像处理: '媒体娱乐',
  媒体影音: '媒体娱乐',
  安全隐私: '实用工具',
  办公效率: '实用工具'
}

/** 一个旧分类名该迁到哪。已经是新分类之一的原样不动 */
export function mapCategory(from: string): string {
  if (DEFAULT_CATEGORIES.some((c) => c.name === from)) return from
  return CATEGORY_MOVES[from] ?? FALLBACK_CATEGORY
}

/**
 * 内置标签池。以 source='user' 落库，和用户手建的等价 —— 直接进池注入 prompt。
 *
 * 标签池空着的时候 agent 只能凭空造词，造出来的又不进池（source='ai'），
 * 于是每一轮都在造新词。给它十个通用的起点，收敛就有了着力处。
 */
export const BUILTIN_TAGS = [
  '便携',
  '开源',
  'AI 相关',
  '图片相关',
  '影音相关',
  '效率',
  '安全',
  '国产',
  '单文件',
  '跨平台'
]
