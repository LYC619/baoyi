import { computed,ref } from 'vue'
import { defineStore } from 'pinia'
import { PROJECT_CATEGORIES, type ProjectItem } from '@/types/project'
export const useProjectStore=defineStore('project',()=>{
  const items=ref<ProjectItem[]>([]),loading=ref(false),error=ref(''),search=ref(''),category=ref(''),group=ref(''),source=ref(''),state=ref(''),pinned=ref(false),sort=ref('recent')
  const savedCategories=ref<string[]>([])
  const categories=computed(()=>[...new Set([...savedCategories.value,...PROJECT_CATEGORIES,...items.value.map(i=>i.category)])].filter(Boolean))
  let subscribed=false,revision=0
  async function refresh(){
    if(!window.baoyi?.project)return
    if(!subscribed){subscribed=true;window.baoyi.project.onChanged(()=>void refresh())}
    const token=++revision;loading.value=true
    try{const rows=await window.baoyi.project.list();const taxonomy=await window.baoyi.categories.list('project');if(token===revision){items.value=rows;savedCategories.value=taxonomy.map(c=>c.name);error.value=''}}catch(e){if(token===revision)error.value=(e as Error).message}finally{if(token===revision)loading.value=false}
  }
  const shown=computed(()=>{
    const q=search.value.trim().toLocaleLowerCase()
    return items.value.filter(i=>(!q||`${i.name} ${i.summary} ${i.tags.join(' ')} ${i.path}`.toLocaleLowerCase().includes(q))&&(!category.value||i.category===category.value)&&(!group.value||i.group===group.value)&&(!source.value||i.source===source.value)&&(!state.value||i.state===state.value)&&(!pinned.value||i.pinned))
      .sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(sort.value==='name'?a.name.localeCompare(b.name,'zh-CN'):sort.value==='updated'?b.updatedAt-a.updatedAt:b.lastOpenedAt-a.lastOpenedAt||b.updatedAt-a.updatedAt))
  })
  const groups=computed(()=>[...new Set(items.value.map(i=>i.group).filter(Boolean))].sort())
  return {items,categories,loading,error,search,category,group,source,state,pinned,sort,shown,groups,refresh}
})
