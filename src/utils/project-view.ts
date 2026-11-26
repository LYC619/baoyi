import type { ProjectItem } from '../types/project.ts'

export interface ProjectFilters {search:string;category:string;group:string;source:string;state:string;pinned:boolean;availability:string;sort:string;tag?:string}
export function filterProjects(items:ProjectItem[],filters:ProjectFilters):ProjectItem[] {
  const words=filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(item=>{
    if(filters.tag&&!item.tags.includes(filters.tag))return false
    const text=[item.name,item.summary,item.path,item.category,item.group,...item.tags,...item.entries.map(e=>e.label)].join(' ').toLocaleLowerCase()
    return words.every(word=>text.includes(word))&&(!filters.category||item.category===filters.category)&&(!filters.group||item.group===filters.group)&&(!filters.source||item.source===filters.source)&&(!filters.state||item.state===filters.state)&&(!filters.pinned||item.pinned)&&(!filters.availability||(filters.availability==='available'?item.available:!item.available))
  }).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(filters.sort==='name'?a.name.localeCompare(b.name,'zh-CN',{numeric:true}):filters.sort==='updated'?b.updatedAt-a.updatedAt:b.lastOpenedAt-a.lastOpenedAt||b.updatedAt-a.updatedAt)||a.id.localeCompare(b.id))
}
