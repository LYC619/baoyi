import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

test('真实便签组件异步载入后启用编辑；自动保存状态对 Vue 可观察',async()=>{
  let resolve!:(value:unknown)=>void,updated=0
  const promise=new Promise(r=>resolve=r)
  const api={context:()=>promise,updateContext:async(_id:string,input:any)=>{updated++;return {...input,revision:input.revision+1}},onChanged:()=>()=>{}}
  const load=createRendererLoader({vue:{...Vue,onBeforeUnmount:()=>{}},'vue-router':{onBeforeRouteLeave:()=>{},onBeforeRouteUpdate:()=>{},useRoute:()=>({query:{}}),useRouter:()=>({replace:async()=>{}})},'lucide-vue-next':{}},{window:{baoyi:{workspace:{timeline:api,onChanged:()=>()=>{}},project:{rules:async()=>[]}},addEventListener:()=>{},removeEventListener:()=>{}},setTimeout,clearTimeout})
  const component=load('src/components/project/ProjectNotes.vue').default
  const scope=Vue.effectScope(),setup=scope.run(()=>component.setup({item:{id:'p',entries:[]}},{expose:()=>{}}))
  const states:boolean[]=[];const stop=Vue.watchEffect(()=>states.push(setup.state.value.loaded))
  resolve({current:'旧便签',next:'',prompt:'',rules:[],version:1,revision:0,updatedAt:0})
  await new Promise(setImmediate);await Vue.nextTick()
  assert.equal(states.at(-1),true,'载入完成后模板必须获知 loaded 变化')
  assert.equal(setup.state.value.value.current,'旧便签')
  setup.state.value.edit({next:'下一步'});await setup.state.value.flush();await Vue.nextTick()
  assert.equal(updated,1);assert.equal(setup.status.value,'已保存到本机')
  setup.state.value.dispose();stop();scope.stop()
})
