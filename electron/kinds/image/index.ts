import type { ResourceKindModule } from '../types.ts'
import { imageSchema } from './schema.ts'
export const imageKind: ResourceKindModule = {
  kind: 'image', label: '图片', schema: imageSchema,
  defaultCategories: ['照片', '漫画'].map((name, i) => ({ id: `image-category-${i}`, name, description: '', icon: i ? 'BookOpen' : 'Images', sort_order: i })),
  defaultTags: []
}
