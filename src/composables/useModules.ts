/**
 * 模块切换的记忆层。
 *
 * 顶栏那两个 Tab 不只是两个链接 —— 从软件库切到游戏库再切回来，用户期待
 * 回到刚才那一页、那一屏，而不是被弹回首页重新找。所以这里记三样东西：
 * 当前停在哪个模块、每个模块最后待过的完整路径、列表页的滚动位置。
 *
 * 状态放模块作用域（和 useToast 一样）而不是 pinia：它跟着窗口活，
 * 不需要序列化、不需要跨窗口，一个单例就够。
 */

import { ref } from 'vue'

export type ModuleKey = 'software' | 'game' | 'video' | 'image' | 'project'

export interface ModuleTab {
  key: ModuleKey
  label: string
  /** 没有记忆位置时的落地路由名 */
  home: string
}

export const MODULE_TABS: ModuleTab[] = [
  { key: 'software', label: '软件', home: 'home' },
  { key: 'game', label: '游戏', home: 'game-home' },
  { key: 'video', label: '影视', home: 'video-home' },
  { key: 'image', label: '图片', home: 'image-home' },
  { key: 'project', label: '项目', home: 'project-home' }
]

/**
 * 当前亮着的 Tab。
 *
 * 设置页、引导页不属于任何模块，停在那里时这个值保持不动 ——
 * 从软件库进设置，顶栏还应该是「软件」亮着，而不是两个都灭掉。
 */
export const activeModule = ref<ModuleKey>('software')

const lastPath: Record<ModuleKey, string> = { software: '', game: '', video: '', image: '', project: '' }
const scrollTop: Record<ModuleKey, number> = { software: 0, game: 0, video: 0, image: 0, project: 0 }

/**
 * 路由上挂的模块标记。没标记的（设置 / 引导）返回 null。
 *
 * 拿 MODULE_TABS 当名单而不是写一串 `m === 'x' ||`：加模块时那串条件是最容易
 * 漏的一处，而漏了的表现是「顶栏 Tab 不亮、切回来回不到刚才那页」——
 * 两个都不报错，只是安静地不对。名单只有一份，就漏不掉。
 */
export function moduleOf(meta: { module?: unknown }): ModuleKey | null {
  const m = meta.module
  if (typeof m !== 'string') return null
  return MODULE_TABS.some((t) => t.key === m) ? (m as ModuleKey) : null
}

/** 由路由 afterEach 调用：记住「刚才在哪个模块的哪一页」 */
export function trackRoute(to: { fullPath: string; meta: { module?: unknown } }): void {
  const key = moduleOf(to.meta)
  if (!key) return
  activeModule.value = key
  lastPath[key] = to.fullPath
}

/**
 * 点某个 Tab 该去哪。有记忆走记忆，没有就去该模块首页。
 * 返回 router.push 能直接吃的值。
 */
export function moduleTarget(key: ModuleKey): string | { name: string } {
  const back = lastPath[key]
  if (back) return back
  const tab = MODULE_TABS.find((t) => t.key === key)
  // 注册表里没有这个 key 属于编码错误，早点炸掉好过静默跳首页
  if (!tab) throw new Error(`未知模块：${key}`)
  return { name: tab.home }
}

export function rememberScroll(key: ModuleKey, top: number): void {
  scrollTop[key] = top
}

export function recallScroll(key: ModuleKey): number {
  return scrollTop[key]
}
