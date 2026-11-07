import { computed,ref,watch } from 'vue'
import { defineStore } from 'pinia'
import { PROJECT_CATEGORIES, type ProjectItem } from '@/types/project'
import { filterProjects } from '@/utils/project-view'
export const useProjectStore=defineStore('project',()=>{
  const items=ref<ProjectItem[]>([]),loading=ref(false),error=ref(''),search=ref(''),category=ref(''),group=ref(''),source=ref(''),state=ref(''),pinned=ref(false),sort=ref('recent')
  const availability=ref(''),layout=ref('cards')
  const view={search,category,group,source,state,pinned,sort,availability,layout}
  try{const saved=JSON.parse(sessionStorage.getItem('project-catalog-view')||'{}');for(const [key,field] of Object.entries(view)){if(typeof saved[key]===typeof field.value)(field as {value:unknown}).value=saved[key]}}catch{/* Optional browsing state. */}
  if(!['recent','updated','name'].includes(sort.value))sort.value='recent'
  if(!['cards','list'].includes(layout.value))layout.value='cards'
  if(!['','available','missing'].includes(availability.value))availability.value=''
  watch(Object.values(view),()=>{try{sessionStorage.setItem('project-catalog-view',JSON.stringify(Object.fromEntries(Object.entries(view).map(([key,field])=>[key,field.value]))))}catch{/* Browsing remains usable when storage is full. */}})
  const savedCategories=ref<string[]>([])
  const categories=computed(()=>[...new Set([...savedCategories.value,...PROJECT_CATEGORIES,...items.value.map(i=>i.category)])].filter(Boolean))
  let subscribed=false,revision=0
  async function refresh(){
    if(!window.baoyi?.project)return
    if(!subscribed){subscribed=true;window.baoyi.project.onChanged(()=>void refresh())}
    const token=++revision;loading.value=true
    try{const rows=await window.baoyi.project.list();const taxonomy=await window.baoyi.categories.list('project');if(token===revision){items.value=rows;savedCategories.value=taxonomy.map(c=>c.name);error.value=''}}catch(e){if(token===revision)error.value=(e as Error).message}finally{if(token===revision)loading.value=false}
  }
  const shown=computed(()=>filterProjects(items.value,{search:search.value,category:category.value,group:group.value,source:source.value,state:state.value,pinned:pinned.value,availability:availability.value,sort:sort.value}))
  const groups=computed(()=>[...new Set(items.value.map(i=>i.group).filter(Boolean))].sort())
  return {items,categories,loading,error,search,category,group,source,state,pinned,sort,availability,layout,shown,groups,refresh}
})
