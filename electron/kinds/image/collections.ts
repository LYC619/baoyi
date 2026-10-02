import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/schema.ts'
import type { ImageCollection, ImageItem } from '../../../src/types/image.ts'
export function imageCollections(db: SqlDb): ImageCollection[] {
  return (db.prepare(`SELECT * FROM image_collections c WHERE EXISTS(SELECT 1 FROM image_collection_members m WHERE m.collection_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM image_collection_members m JOIN image_meta i ON i.resource_id=m.resource_id JOIN image_groups g ON g.id=i.group_id WHERE m.collection_id=c.id AND g.hidden=1) ORDER BY name`).all() as any[]).map(row=>({id:row.id,name:row.name,members:(db.prepare('SELECT resource_id FROM image_collection_members WHERE collection_id=? ORDER BY position,resource_id').all(row.id) as any[]).map(m=>m.resource_id)}))
}
export function withImageCollections(db: SqlDb, items: ImageItem[]): ImageItem[] {
  const visible=new Set(imageCollections(db).map(c=>c.id))
  const memberships = new Map((db.prepare('SELECT m.*,c.name FROM image_collection_members m JOIN image_collections c ON c.id=m.collection_id').all() as any[]).filter(row=>visible.has(row.collection_id)).map(row=>[row.resource_id,row]))
  return items.map(item=>{const row=memberships.get(item.id);return row?{...item,collectionId:row.collection_id,collectionName:row.name,collectionOrder:row.position}:item})
}
export function saveImageCollection(db: SqlDb, name: string, members: string[], id?: string): ImageCollection {
  if(typeof name!=='string'||!name.trim()||name.trim().length>200)throw new Error('请填写 1 到 200 字的合集名称')
  if(!Array.isArray(members)||!members.length||members.length>5000||members.some(id=>typeof id!=='string'))throw new Error('请选择合集中的漫画')
  if(id && !db.prepare('SELECT 1 FROM image_collections WHERE id=?').get(id))throw new Error('合集不存在')
  const collectionId=id||randomUUID(),unique=[...new Set(members)]
  for(const member of unique){
    if(!db.prepare("SELECT 1 FROM image_meta m WHERE resource_id=? AND item_type='comic' AND (group_id IS NULL OR NOT EXISTS(SELECT 1 FROM image_groups g WHERE g.id=m.group_id AND hidden=1))").get(member))throw new Error('所选漫画不可用或已隐藏')
    const row=db.prepare('SELECT collection_id FROM image_collection_members WHERE resource_id=?').get(member) as any
    if(row && row.collection_id!==collectionId)throw new Error('所选漫画已在其他合集中，请先移出原合集')
  }
  db.exec('SAVEPOINT image_collection')
  try{
    db.prepare('INSERT INTO image_collections(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(collectionId,name.trim(),Date.now())
    db.prepare('DELETE FROM image_collection_members WHERE collection_id=?').run(collectionId)
    for(const [position,member] of unique.entries())db.prepare('INSERT INTO image_collection_members(collection_id,resource_id,position) VALUES(?,?,?)').run(collectionId,member,position)
    db.exec('RELEASE image_collection')
  }catch(error){db.exec('ROLLBACK TO image_collection; RELEASE image_collection');throw error}
  return {id:collectionId,name:name.trim(),members:unique}
}
export function removeImageCollection(db: SqlDb,id:string):void{db.prepare('DELETE FROM image_collections WHERE id=?').run(id)}
