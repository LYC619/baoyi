
import { tr } from '../i18n/index.ts'
import type {GameItem,LinkedFile} from '../types/index.ts'
export const projectOf=(game:Pick<GameItem,'linked_files'>)=>game.linked_files.find(link=>link.role==='report'&&link.project)?.project
export const TOOL_PURPOSE:Record<NonNullable<LinkedFile['purpose']>,string>={get modifier() { return tr("数值修改") },get backup() { return tr("备份与恢复") },get inspection() { return tr("只读检查") },get patch() { return tr("修复与补丁") },get mixed() { return tr("综合辅助") }}
export const PROJECT_FILTERS={get all() { return tr("全部档案") },get issues() { return tr("有待处理问题") },get deferred() { return tr("游玩时验证") },get static() { return tr("静态检查") },get updated() { return tr("资料有更新") }} as const

export function gameDocumentGroup(file:LinkedFile,guidePath=''):'start'|'guide'|'record'{
  if(file.path===guidePath||/使用与攻略导航|当前用法/.test(file.label))return 'start'
  if(file.role==='report'||file.project||/精修记录|验收记录|核查报告/.test(file.label))return 'record'
  return 'guide'
}
