import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

test('annotation project picker handles search, archived projects and failed writes without navigating',async()=>{
  const writes:any[]=[],changes:any[]=[],pushes:any[]=[],unmount:Function[]=[],scope=Vue.effectScope()
  let fail=true
  const api={list:async()=>[{id:'p',name:'当前研究',state:'active'},{id:'q',name:'旧项目',state:'archived'}]}
  const load=createRendererLoader({vue:{...Vue,onBeforeUnmount:(f:Function)=>unmount.push(f)},'vue-router':{useRoute:()=>({fullPath:'/document/d'}),useRouter:()=>({push:(p:any)=>pushes.push(p)})}},
    {window:{baoyi:{project:api,workspace:{links:{add:async(...args:any[])=>{writes.push(args);if(fail)throw Error('项目已删除')}}}}}})
  const state=scope.run(()=>load('src/components/workspace/AnnotationProjectLinks.vue').default.setup({documentId:'d',annotationId:'a',references:[]},{expose(){},emit:(...args:any[])=>changes.push(args)}))
  try {
    await state.open();assert.deepEqual(state.filtered.value.map((p:any)=>p.id),['p'])
    state.archived.value=true;state.search.value='旧';assert.deepEqual(state.filtered.value.map((p:any)=>p.id),['q'])
    await state.add({id:'p'});assert.match(state.error.value,/项目已删除/);assert.deepEqual(changes,[])
    assert.deepEqual(pushes,[]);assert.equal(state.opened.value,true)
    fail=false;await state.add({id:'p'});assert.equal(state.opened.value,false);assert.deepEqual(changes,[['changed']])
    assert.deepEqual(writes,[['project','p','d','a'],['project','p','d','a']])
  }finally{unmount.forEach(f=>f());scope.stop()}
})

test('ResourceLinks discards stale empty annotations when switching candidates or closing dialog',async()=>{
  const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>{resolve=r});return {promise,resolve}}
  const notesA=deferred(),notesB=deferred(),linksAdded:any[]=[],unmount:Function[]=[],scope=Vue.effectScope()
  const docA={id:'doc-a',name:'文档 A',kind:'document',path:'a.md'}
  const docB={id:'doc-b',name:'文档 B',kind:'document',path:'b.md'}
  const annB={id:'ann-b',documentId:'doc-b',kind:'excerpt',quote:'摘录 B',note:'',location:{page:1,offset:0},createdAt:1,updatedAt:1}
  const api={
    workspace:{
      links:{
        list:async()=>[],
        resources:async()=>[docA,docB],
        add:async(...args:any[])=>{linksAdded.push(args)}
      },
      documents:{
        annotations:(id:string)=>id==='doc-a'?notesA.promise:notesB.promise
      },
      onChanged:()=>()=>{}
    }
  }
  const load=createRendererLoader({
    vue:{...Vue,onBeforeUnmount:(f:Function)=>unmount.push(f)},
    'vue-router':{useRoute:()=>({path:'/project/p',query:{}}),useRouter:()=>({resolve:()=>({fullPath:'/project/p'}),push:async()=>{}})},
    'lucide-vue-next':{},
    '@/components/project/ProjectDialog.vue':{},
    './ProjectFiles.vue':{}
  },{window:{baoyi:api}})
  const state=scope.run(()=>load('src/components/workspace/ResourceLinks.vue').default.setup({owner:'project',id:'p'},{expose(){},emit(){}}))
  try{
    const { locale } = load('src/i18n/index.ts')
    assert.equal(state.displayTitle.value, '相关实践与资源')
    locale.value = 'en'
    assert.equal(state.displayTitle.value, 'Related practice and resources')
    locale.value = 'zh-CN'
    await state.start()
    const clickA=state.clickCandidate(docA)
    const clickB=state.clickCandidate(docB)
    notesB.resolve([annB])
    await clickB
    assert.equal(state.selected.value,'doc-b')
    assert.equal(state.annotations.value.length,1)
    assert.equal(state.show.value,true)
    notesA.resolve([])
    await clickA
    assert.equal(state.selected.value,'doc-b')
    assert.equal(state.annotations.value.length,1)
    assert.equal(state.show.value,true)
    assert.deepEqual(linksAdded,[])

    // Closing dialog before an annotation fetch resolves must also block auto-link
    const notesLate=deferred()
    api.workspace.documents.annotations=()=>notesLate.promise
    const clickLate=state.clickCandidate(docA)
    state.closeDialog()
    notesLate.resolve([])
    await clickLate
    assert.equal(state.show.value,false)
    assert.deepEqual(linksAdded,[])
  }finally{unmount.forEach(f=>f());scope.stop()}
})
