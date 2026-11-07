import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import {createRendererLoader} from './helpers/renderer-harness.ts'
test('返回摘要分组后恢复中断会话，继续入口沿用同一会话',async()=>{
  const session={id:'saved-summary',projectId:'project',title:'周摘要 · 2026-10-19',updatedAt:1,status:'interrupted',messages:[],tokens:0,error:'已达到轮数上限',summary:{kind:'week',key:'2026-10-19'}},scope=Vue.effectScope(),unmount:(()=>void)[]=[],sent:string[]=[]
  const project={summaries:async()=>[],sessions:async()=>[session],session:async()=>session,onSession:()=>()=>{},sendMessage:async(id:string)=>{sent.push(id);return {...session,status:'idle',error:''}}}
  const load=createRendererLoader({vue:{...Vue,onBeforeUnmount:(fn:()=>void)=>unmount.push(fn)},'vue-router':{useRoute:()=>({query:{}}),useRouter:()=>({})}},{window:{baoyi:{project,workspace:{onChanged:()=>()=>{}}}}})
  try {
    const state=scope.run(()=>load('src/components/workspace/ProjectSummaryPanel.vue').default.setup(Vue.reactive({projectId:'project',kind:'week',groupKey:'2026-10-19'}),{expose(){}}))
    for(let i=0;i<20;i++)await Vue.nextTick()
    assert.equal(state.session.value?.id,session.id,'不能把已有中断任务展示为从未开始')
    await state.resume();assert.deepEqual(sent,[session.id])
  }finally{unmount.forEach(fn=>fn());scope.stop()}
})
