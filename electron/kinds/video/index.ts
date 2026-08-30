/**
 * 视频品类模块。公共层通过这一个对象认识「视频」，别的什么都不知道。
 *
 * 0.7 Step 1 只有数据层：解析器、扫描器、刮削在后面几步补上，
 * 那时候这个对象会多几个字段，但 kinds/index.ts 里注册那一行不用再动 ——
 * 0.6 的游戏模块走的就是这条路，验证过。
 */

import type { ResourceKindModule } from '../types.ts'
import { VIDEO_CATEGORIES, VIDEO_TAGS } from './taxonomy.ts'
import { videoSchema } from './schema.ts'

export const videoKind: ResourceKindModule = {
  kind: 'video',
  label: '视频',
  defaultCategories: VIDEO_CATEGORIES,
  defaultTags: VIDEO_TAGS,
  schema: videoSchema
}
