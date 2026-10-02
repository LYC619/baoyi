import type { ImageItem } from '../types/image.ts'
export interface ImageShelfEntry {id:string;name:string;item:ImageItem;members:ImageItem[]}
export function imageShelfEntries(items:ImageItem[]):ImageShelfEntry[]{
  const entries=new Map<string,ImageShelfEntry>()
  for(const item of items){
    const key=item.collectionId?'collection:'+item.collectionId:item.id
    const existing=entries.get(key)
    if(existing)existing.members.push(item)
    else entries.set(key,{id:key,name:item.collectionName||item.name,item,members:[item]})
  }
  for(const entry of entries.values()){entry.members.sort((a,b)=>(a.collectionOrder||0)-(b.collectionOrder||0));entry.item=entry.members[0]}
  return [...entries.values()]
}
