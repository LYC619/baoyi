/**
 * 游戏品类模块。公共层通过这一个对象认识「游戏」，别的什么都不知道。
 *
 * 0.6 Step 2 只有数据层：扫描器、提示词、工具在 Step 3 补上，
 * 那时候这个对象会多几个字段，但注册这一行不用再动。
 */

import type { ResourceKindModule } from '../types.ts'
import { GAME_CATEGORIES, GAME_TAGS } from './taxonomy.ts'
import { gameSchema } from './schema.ts'

export const gameKind: ResourceKindModule = {
  kind: 'game',
  label: '游戏',
  defaultCategories: GAME_CATEGORIES,
  defaultTags: GAME_TAGS,
  schema: gameSchema
}
