import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import {createRendererLoader} from './helpers/renderer-harness.ts'
const tick=async()=>{await new Promise(setImmediate);await Vue.nextTick()}
function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(cause:Error)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}}
function audioFixture(){
  let closed=()=>{},changed=async()=>{},exists=true
  const metadata=deferred(),scope=Vue.effectScope()
  const api={preview:{onClosed:(fn:any)=>{closed=fn;return ()=>{}}},onLibraryChanged:(fn:any)=>{changed=fn;return ()=>{}},get:async()=>exists?{id:'album'}:null,library:async()=>({contents:[{id:'a'},{id:'b'}]}),audioInfo:()=>metadata.promise}
  const load=createRendererLoader({vue:Vue,pinia:{defineStore:(_id:string,setup:any)=>setup}},{window:{baoyi:{video:api}},setTimeout,clearTimeout})
  const audio=scope.run(()=>load('src/stores/audio.ts').useAudioStore())
  const track=(id:string)=>({id,episode:id,resource:{id:'album'},title:id,duration:30})
  return {audio,track,metadata,closed:()=>closed(),remove:async()=>{exists=false;await changed()},scope}
}
test('音频主进程撤销清空队列；迟到元信息与播放失败不能复活播放器',async()=>{
  const f=audioFixture(),play=deferred(),a=f.audio
  try{a.attach({paused:true,pause(){},play:()=>play.promise});const pending=a.play(f.track('a'),[f.track('a')]);const resuming=a.toggle();f.closed();play.reject(new Error('late play failure'));f.metadata.resolve({music:{artist:'旧曲目'}});await pending;await resuming
    assert.equal(a.current.value,null);assert.equal(a.music.value,null);assert.equal(a.queue.value.length,0);assert.equal(a.failure.value,'')
  }finally{f.scope.stop()}
})
test('音频库删除当前作品会撤销播放；自然结束到队尾停止播放状态',async()=>{
  const f=audioFixture(),a=f.audio;f.metadata.resolve(null)
  try{await a.play(f.track('a'),[f.track('a'),f.track('b')]);await f.remove();assert.equal(a.current.value,null)
    await a.play(f.track('b'),[f.track('a'),f.track('b')]);a.playing.value=true;a.next();assert.equal(a.playing.value,false);assert.equal(a.current.value.id,'b')
  }finally{f.scope.stop()}
})
function component(file:string,api:any,mocks:Record<string,unknown>,props:any){
  const scope=Vue.effectScope(),load=createRendererLoader({vue:{...Vue,onBeforeUnmount:()=>{},onMounted:()=>{}},'lucide-vue-next':{},...mocks},{window:{baoyi:api},IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}}})
  return {state:scope.run(()=>load(file).default.setup(props,{expose(){},emit(){}})),scope}
}
test('JM 排行榜迟到响应不进入搜索栏目；隐藏后不会恢复旧结果',async()=>{
  const request=deferred(),ingest={request:Vue.ref(''),recovery:Vue.ref(null)},props=Vue.reactive({active:true})
  const f=component('src/components/image/JmSourceBrowser.vue',{comic:{cancelBrowse:async()=>{},browse:()=>request.promise}},{'@/composables/useComicIngest':{useComicIngest:()=>ingest}},props)
  try{const pending=f.state.browse();await tick();f.state.switchMode('search');request.resolve({items:[{id:'old'}],page:1,pages:1});await pending;assert.equal(f.state.results.value.length,0);assert.equal(f.state.busy.value,false);assert.equal(f.state.mode.value,'search')}
  finally{f.scope.stop()}
})
test('哔咔旧的目录响应不能覆盖用户刚选定的新根目录',async()=>{
  const request=deferred(),api={image:{downloadTarget:()=>request.promise,chooseDownloadRoot:async()=>'/new',onJobsChanged:()=>()=>{}}}
  const f=component('src/components/image/PicaSourceBrowser.vue',api,{'@/stores/image':{useImageStore:()=>({items:[],groups:[]})}},{active:true})
  try{const pending=f.state.target();await f.state.chooseRoot();request.resolve({root:'/old',locked:false});await pending;assert.equal(f.state.root.value,'/new')}
  finally{f.scope.stop()}
})
