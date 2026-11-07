import type { SqlDb } from '../services/schema.ts'
import type { ReadingLocation,TextAnchor } from '../../src/types/workspace.ts'
export function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(label + '无效')
  return value.trim()
}
export function name(value: unknown): string { const result = text(value, '名称', 300); if (!result) throw new Error('名称不能为空'); return result }
export function number(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(label + '无效')
  return value
}
export function date(value: unknown): string {
  const result = text(value, '日期', 10)
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) throw new Error('日期无效')
  return result
}
export function location(value: ReadingLocation): ReadingLocation {
  const page = number(value?.page, '页码', 1, 1000000)
  if (!Number.isInteger(page)) throw new Error('页码无效')
  const parsed=value.anchor?anchor(value.anchor):undefined
  if(parsed?.pages?.some(p=>p.page<=page))throw new Error('跨页锚点页码顺序无效')
  return { page, offset: number(value?.offset, '阅读位置', 0, 1),...(parsed?{anchor:parsed}:{}) }
}
export function anchor(value:TextAnchor):TextAnchor {
  keys(value,['version','kind','start','end','exact','prefix','suffix','fingerprint','regions','pages'])
  if(value.version!==1||!['text','pdf'].includes(value.kind))throw new Error('锚点版本或类型无效')
  const start=number(value.start,'锚点范围'),end=number(value.end,'锚点范围')
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start>30000)throw new Error('锚点范围无效')
  for(const [key,max] of [['exact',30000],['prefix',48],['suffix',48],['fingerprint',100]] as const)text(value[key],'锚点文字',max)
  if(value.exact.length!==end-start)throw new Error('锚点文字与范围不符')
  const result:TextAnchor={version:1,kind:value.kind,start,end,exact:value.exact,prefix:value.prefix,suffix:value.suffix,fingerprint:value.fingerprint}
  if(value.regions!==undefined){
    if(value.kind!=='pdf'||!Array.isArray(value.regions)||value.regions.length>2000)throw new Error('锚点区域无效')
    result.regions=value.regions.map(r=>{keys(r,['x','y','width','height']);for(const n of Object.values(r))number(n,'锚点区域',0,1);if(r.x+r.width>1.00001||r.y+r.height>1.00001)throw new Error('锚点区域超出页面');return {x:r.x,y:r.y,width:r.width,height:r.height}})
  }
  if(value.pages!==undefined){
    if(value.kind!=='pdf'||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>100)throw new Error('跨页锚点无效')
    let previous=0,total=value.exact.length
    result.pages=value.pages.map(part=>{
      keys(part,['page','anchor']);const page=number(part.page,'跨页页码',1,1000000)
      if(!Number.isInteger(page)||page<=previous||Object.hasOwn(part.anchor,'pages')||part.anchor.kind!=='pdf')throw new Error('跨页锚点无效')
      previous=page;const parsed=anchor(part.anchor);total+=parsed.exact.length
      if(total>30000)throw new Error('跨页锚点文字过长')
      return {page,anchor:parsed}
    })
  }
  return result
}
export function strings(value: unknown, max = 50): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('列表无效')
  return [...new Set(value.map(v => text(v, '列表内容', 1000)).filter(Boolean))]
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('修改内容无效')
  return value as Record<string, unknown>
}
export function keys(value: unknown, allowed: string[]): void {
  if (Object.keys(object(value)).some(k => !allowed.includes(k))) throw new Error('包含不支持的字段')
}
export function transaction<T>(db: SqlDb, action: () => T): T {
  db.exec('SAVEPOINT workspace_change')
  try { const result = action(); db.exec('RELEASE workspace_change'); return result }
  catch (e) { db.exec('ROLLBACK TO workspace_change; RELEASE workspace_change'); throw e }
}
