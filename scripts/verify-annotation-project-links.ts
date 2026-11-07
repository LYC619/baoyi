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
