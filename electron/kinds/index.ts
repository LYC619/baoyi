/**
 * 品类注册表。加一个新品类就在这里加一行 —— 就一行。
 *
 * 显式列出而不是扫目录：TypeScript 会检查每个模块是不是把 ResourceKindModule
 * 要的都给全了，漏一样编译就过不去。自动发现漏了只会在运行时静默 ——
 * 表现成「游戏库建好了但一条数据都存不进去」，而那时候没人知道是没注册。
 */

import { softwareKind } from './software/index.ts'
import { gameKind } from './game/index.ts'
import { videoKind } from './video/index.ts'
import { imageKind } from './image/index.ts'
import { projectKind } from './project/index.ts'
import type { ResourceKindModule } from './types.ts'

export const KINDS: ResourceKindModule[] = [softwareKind, gameKind, videoKind, imageKind, projectKind]

export function kindByName(kind: string): ResourceKindModule | undefined {
  return KINDS.find((k) => k.kind === kind)
}

export type { ResourceKindModule, KindSchema } from './types.ts'
