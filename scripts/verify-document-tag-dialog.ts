import assert from 'node:assert/strict'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'
const events: string[] = [], writes: Array<{id:string;tags:string[]}> = []
let release!: () => void
const pending = new Promise<void>(resolve => { release = resolve })
const load = createRendererLoader({vue:Vue,'@/utils/workspace-api':{workspace:{documents:{update:async(id:string,patch:{tags:string[]})=>{writes.push({id,tags:patch.tags});if(id==='a')await pending;else throw new Error('fixture failure')}}}}})
const props=Vue.reactive({items:[{id:'a',name:'甲',tags:['旧']},{id:'b',name:'乙',tags:['旧']}],availableTags:[],categoryName:'小说',categoryId:'novel',embedded:true})
const state=load('src/components/workspace/DocumentTagDialog.vue').default.setup(props,{expose:()=>{},emit:(event:string)=>events.push(event)})
state.selectedTags.value=['新']
const task=state.applyBatch()
state.mode.value='replace';state.selectedTags.value.push('操作中新增')
release();await task
assert.deepEqual(JSON.parse(JSON.stringify(writes)),[{id:'a',tags:['旧','新']},{id:'b',tags:['旧','新']}], 'batch must use the original action snapshot')
assert.ok(events.includes('updated'),'partial success must refresh the list')
assert.ok(!events.includes('close'),'failed items stay visible')
assert.match(state.message.value,/1/)
console.log('PASS batch action snapshot, partial-success refresh and visible failures')
