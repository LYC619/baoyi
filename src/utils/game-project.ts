import type {GameItem,LinkedFile} from '../types/index.ts'
export const projectOf=(game:Pick<GameItem,'linked_files'>)=>game.linked_files.find(link=>link.role==='report'&&link.project)?.project
export const TOOL_PURPOSE:Record<NonNullable<LinkedFile['purpose']>,string>={modifier:'数值修改',backup:'备份与恢复',inspection:'只读检查',patch:'修复与补丁',mixed:'综合辅助'}
export const PROJECT_FILTERS={all:'全部档案',issues:'有待处理问题',deferred:'游玩时验证',static:'静态检查',updated:'资料有更新'} as const

export function gameDocumentGroup(file:LinkedFile,guidePath=''):'start'|'guide'|'record'{
  if(file.path===guidePath||/使用与攻略导航|当前用法/.test(file.label))return 'start'
  if(file.role==='report'||file.project||/精修记录|验收记录|核查报告/.test(file.label))return 'record'
  return 'guide'
}
