/**
 * 资源品类模块的契约。
 *
 * 抱一要装的不只是软件，还有游戏、图片、视频。这个文件规定「一个品类模块
 * 必须给公共层什么」—— 给全了才编译得过，漏一样 TypeScript 当场报错。
 *
 * 显式注册而不是按目录自动发现：自动发现看着优雅，漏一个只会在运行时静默，
 * 而显式列表能让类型检查替你把关。抱一的品类数量也不会多到需要自动发现。
 *
 * 界线在哪：公共层（electron/services/）管 resource 总表、agent 回路、路径沙箱、
 * 联网搜索、暂存确认这套流程；它不知道「软件有分类」「软件能搬目录」这些概念。
 * 品类模块（electron/kinds/<kind>/）管自己的私有表、提示词、工具、扫描方式。
 */

import type { SqlDb } from '../services/schema.ts'
import type { Category } from '../../src/types'

export interface KindSchema {
  /** 这个品类私有的表。建在 resource 之后，可以引用 resource(id) */
  tables: string
  /** 可选：把 resource 和私有表拼回一张宽表的视图，方便这个品类自己的读路径 */
  view?: string
  /** 可选：私有表上的索引。建在 migrate 之后，理由见 services/schema.ts */
  indexes?: string
  /**
   * 可选：从旧版本库升上来时，这个品类自己要做的事。
   * from 是升级前的版本号；公共层保证它在 resource 表已经就绪之后调用。
   */
  migrate?: (d: SqlDb, from: number) => void
}

export interface ResourceKindModule {
  /** 库里 resource.kind 那一列的值，也是这个模块的唯一 id */
  kind: string
  /** 界面上显示的名字 */
  label: string
  /**
   * 这个品类默认的分类体系。
   * 分类「这件事」是公共的（resource.category 那一列），但「开发工具 / 系统管理」
   * 这些具体的名字是软件才有的 —— 视频库的分类不该长这样。所以由模块自己提供。
   */
  defaultCategories: Category[]
  /**
   * 这个品类的内置标签池。同样是模块自己的事 —— 「魂系」「开放世界」
   * 不该出现在软件的识别 prompt 里，「便携」「单文件」也不该出现在游戏的。
   */
  defaultTags: string[]
  schema: KindSchema
}
