/**
 * 软件品类模块。公共层通过这一个对象认识「软件」，别的什么都不知道。
 */

import { BUILTIN_TAGS, DEFAULT_CATEGORIES } from '../../services/taxonomy.ts'
import type { ResourceKindModule } from '../types.ts'
import { softwareSchema } from './schema.ts'

export const softwareKind: ResourceKindModule = {
  kind: 'software',
  label: '软件',
  // 「开发工具 / 系统管理 / 媒体娱乐 / 实用工具 / 其他」是软件的分类体系，
  // 视频库不该长这样。所以由模块自己交给公共层，而不是公共层写死。
  defaultCategories: DEFAULT_CATEGORIES,
  defaultTags: BUILTIN_TAGS,
  schema: softwareSchema
}
