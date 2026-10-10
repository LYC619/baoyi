import type { ResourceKindModule } from '../types.ts'
import { projectSchema } from './schema.ts'
import { PROJECT_CATEGORIES } from '../../../src/types/project.ts'
export const projectKind: ResourceKindModule = {
  kind:'project',label:'项目',schema:projectSchema,
  defaultCategories:PROJECT_CATEGORIES.map((name,i)=>({id:`project-category-${i}`,name,description:'',icon:'FolderKanban',sort_order:i})),defaultTags:[]
}
