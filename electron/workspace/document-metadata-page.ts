import { createHash } from 'node:crypto'
import type { DocumentItem, DocumentCategory, DocumentMetadataCursor } from '../../src/types/workspace.ts'
import { jsonTextPage } from '../services/agent/context.ts'

export const METADATA_OUTPUT = 20000
const PAGE_BUDGET = 18000
export interface MetadataRequest { id?:string;query?:string;compact?:boolean;start?:number;cursor?:DocumentMetadataCursor }

export function metadataRequest(args: MetadataRequest) {
  const cursor = args.cursor
  if (cursor && (typeof cursor !== 'object' || Array.isArray(cursor) || typeof cursor.stamp !== 'string' || !Number.isSafeInteger(cursor.index) || !Number.isSafeInteger(cursor.offset) || cursor.index < 0 || cursor.offset < 0 || typeof cursor.compact !== 'boolean')) throw new Error('资料续读位置无效')
  const id = cursor?.id ?? args.id, query = cursor?.query ?? args.query ?? '', compact = cursor?.compact ?? args.compact ?? false
  const start = cursor?.index ?? args.start ?? 0
  if (id !== undefined && (typeof id !== 'string' || id.length > 4096) || typeof query !== 'string' || query.length > 300 || typeof compact !== 'boolean' || !Number.isSafeInteger(start) || start < 0) throw new Error('资料查询参数无效')
  return {id,query,compact,start,cursor}
}

/** Return complete records that fit the encoded budget; oversized records use lossless JSON fragments. */
export function documentMetadataPage(rows: DocumentItem[], categories: DocumentCategory[], request: ReturnType<typeof metadataRequest>): string {
  const { start, compact, cursor, id, query } = request
  if (start > rows.length) throw new Error('资料分页位置无效')
  const records = compact ? rows.map(item => ({id:item.id,name:item.name,type:item.type,submodule:item.submodule,customGroupId:item.customGroupId || ''})) : rows
  const stamp = createHash('sha256').update(JSON.stringify([records,categories])).digest('hex')
  if (cursor && cursor.stamp !== stamp) throw new Error('资料或分类已变化，续读位置失效，请重新读取列表')
  const makeCursor = (index: number, offset = 0): DocumentMetadataCursor => ({index,offset,stamp,compact,...(id ? {id} : {}),...(query ? {query} : {})})
  const relevantCategories = (count: number) => {
    const types = new Set(rows.slice(start,start+count).map(item => item.type))
    return categories.filter(category => types.has(category.id)).map(category => compact ? {id:category.id,name:category.name,submodule:category.submodule} : category)
  }
  const items = records.slice(start,start+(compact ? 60 : 12))
  const pack = () => {
    const end = start+items.length, next = end < rows.length ? end : null
    return JSON.stringify({format:'records',stamp,start,total:rows.length,position:end,categories:relevantCategories(items.length),items,next,nextCursor:next === null ? null : makeCursor(next)})
  }
  while (items.length > 1 && pack().length > PAGE_BUDGET) items.pop()
  if (pack().length <= PAGE_BUDGET && !cursor?.offset) return pack()
  if (!items.length) throw new Error('资料续读位置无效')
  const raw = JSON.stringify({categories:relevantCategories(1),items:[records[start]]})
  return jsonTextPage(raw,cursor?.offset ?? 0,PAGE_BUDGET,(text,end) => {
    const more = end < raw.length, nextCursor = more ? makeCursor(start,end) : start+1 < rows.length ? makeCursor(start+1) : null
    return {format:'json-fragment',stamp,start,total:rows.length,position:more ? start : start+1,sourceId:rows[start].id,items:[],text,next:nextCursor?.index ?? null,nextCursor}
  })
}
