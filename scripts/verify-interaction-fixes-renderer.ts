import { latestOnly, STALE } from '../src/composables/latestOnly.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as Vue from 'vue'
import {createRendererLoader} from './helpers/renderer-harness.ts'

const tick=async()=>{await new Promise(setImmediate);await Vue.nextTick()}
function setup(file:string,api:any,mocks:Record<string,unknown>={},globals:Record<string,unknown>={},props:any={}){
  const mounted:Array<()=>unknown>=[],scope=Vue.effectScope()
  const load=createRendererLoader({vue:{...Vue,onMounted:(fn:()=>unknown)=>mounted.push(fn),onBeforeUnmount:()=>{},onUnmounted:()=>{}},'lucide-vue-next':{},'vue-router':{useRouter:()=>({push:()=>{}})},...mocks},{window:{baoyi:api},document:{activeElement:null,documentElement:{lang:''},title:''},...globals})
  const state=scope.run(()=>load(file).default.setup(props,{expose:()=>{},emit:()=>{}}))
  return {state,load,mount:async()=>{for(const fn of mounted)await fn()},dispose:()=>scope.stop()}
}
const comicPreview=(token='comic-1')=>({token,catalog:{workId:'123',name:'合成漫画',authors:[],chapters:[{id:'a',pageIds:['1']},{id:'b',pageIds:['2']}]},directory:'目录',existingId:'',existingChapters:[]})
function comicFixture(){
  const calls:any[]=[],starts:any[]=[],ingest={request:Vue.ref('123'),recovery:Vue.ref(null),open:Vue.ref(true),showRecords:Vue.ref(false),refresh:async()=>{}}
  const api={preview:async(input:string,proxy:any)=>{calls.push({input,proxy});return comicPreview('comic-'+calls.length)},start:async(...args:any[])=>{starts.push(args);return 'job'},cancelPreview:async()=>{}}
  const fixture=setup('src/components/image/ComicIngestDialog.vue',{comic:api,image:{downloadTarget:async()=>({root:'D:/fixture',locked:false})}},{'@/composables/useComicIngest':{useComicIngest:()=>ingest},'@/stores/image':{useImageStore:()=>({groups:[]})}})
  return {...fixture,calls,starts,api}
}
test('漫画换代理保留元数据、选章与目录；改作品输入才清空',async()=>{
  const f=comicFixture(),s=f.state
  try{await s.resolve();s.selected.value=['b'];s.directory.value='用户目录';const before=s.preview.value
    s.mode.value='custom';s.custom.value='127.0.0.1:7890';await tick()
    assert.equal(s.preview.value,before);assert.deepEqual([...s.selected.value],['b']);assert.equal(s.directory.value,'用户目录');assert.equal(f.calls.length,1)
    s.input.value='456';await tick();assert.equal(s.preview.value,null)
  }finally{f.dispose()}
})
test('漫画新代理用于下载令牌，保留选章与目录；相同代理不重复解析',async()=>{
  const f=comicFixture(),s=f.state
  try{await s.resolve();s.selected.value=['b'];s.directory.value='用户目录';s.mode.value='custom';s.custom.value='127.0.0.1:7890';await tick();await s.start()
    assert.equal(f.calls.length,2);assert.equal(f.calls[1].proxy.url,'127.0.0.1:7890');assert.deepEqual(JSON.parse(JSON.stringify(f.starts[0])),['comic-2',['b'],'用户目录',null,'D:/fixture'])
  }finally{f.dispose()}
  const same=comicFixture();try{await same.state.resolve();await same.state.start();assert.equal(same.calls.length,1);assert.equal(same.starts.length,1)}finally{same.dispose()}
})
test('漫画代理刷新失败保留输入且不创建任务，重试可成功',async()=>{
  const f=comicFixture(),s=f.state
  try{await s.resolve();s.selected.value=['b'];s.mode.value='custom';await tick();const original=f.api.preview;f.api.preview=async()=>{throw new Error('连接失败')};await s.start()
    assert.equal(f.starts.length,0);assert.ok(s.preview.value);assert.deepEqual([...s.selected.value],['b']);assert.match(s.error.value,/连接失败/);assert.equal(s.saving.value,false)
    f.api.preview=original;await s.start();assert.equal(f.starts.length,1)
  }finally{f.dispose()}
})
test('清理暂存拒绝确认不调用 clean，确认后才删除并刷新',async()=>{
  let accepted=false,cleaned=0,refreshed=0,prompt=''
  const f=setup('src/components/image/ComicTaskRow.vue',{}, {}, {window:{confirm:(text:string)=>{prompt=text;return accepted}}}, {
    row:{id:'j',title:'合成任务',provider:'jm'}, run:async()=>{cleaned++;refreshed++}, logs:async()=>[]
  })
  try{await f.state.action('clean');assert.equal(cleaned,0);assert.equal(refreshed,0);assert.match(prompt,/将删除已下载的临时图片文件.*不可撤销/)
    accepted=true;await f.state.action('clean');assert.equal(cleaned,1);assert.equal(refreshed,1)
  }finally{f.dispose()}

})
test('精读设置只保留历史维护，不再读取或保存自动生成策略',async()=>{
  let previews=0
  const f=setup('src/components/workspace/DocumentInsightSettings.vue',{archive:{insights:{cleanupPreview:async()=>{previews++;return {token:'c',generated:1,edited:2}}}}},{'@/composables/useArchiveAssistant':{useArchiveAssistant:()=>({loadMethod:async()=>{}})}})
  try{await f.mount();await f.state.maintain('preview');assert.equal(previews,1);assert.equal(f.state.cleanup.value.edited,2)}finally{f.dispose()}
})

function handoffFixture(){
  let seq=0;const tokens=new Set<string>(),generated:string[]=[],scopes:boolean[]=[],adoptions:string[]=[]
  const api={projectHandoffPreview:async(_id:string,rules=false)=>{scopes.push(rules);const token='p'+(++seq);tokens.add(token);return {token,stamp:token,includeRules:rules,remembered:false,configured:true,snapshot:{rules:[],warnings:[]}}},projectHandoffGenerate:async({token}:any)=>{assert.ok(tokens.delete(token),'服务只接受一次性令牌');generated.push(token);return {prompt:'结果'+token,contextRevision:seq}},projectHandoffAdopt:async(_id:string,_rev:number,prompt:string)=>{adoptions.push(prompt)}}
  const f=setup('src/components/project/ProjectHandoff.vue',{archive:api},{'@/composables/useArchiveAssistant':{useArchiveAssistant:()=>({privacyRevision:Vue.ref(0)})}},{},{id:'project'})
  return {...f,api,generated,scopes,adoptions}
}
test('交接结果重新生成刷新一次性令牌与采用状态；返回范围不自动调用模型',async()=>{
  const f=handoffFixture(),s=f.state
  try{await tick();await s.generate();await s.adopt();assert.equal(s.adopted.value,true)
    await s.regenerate();assert.deepEqual(f.generated,['p1','p2']);assert.equal(s.adopted.value,false);assert.equal(s.notice.value,'');await s.adopt();assert.deepEqual(f.adoptions,['结果p1','结果p2'])
    await s.adjustScope();assert.equal(s.result.value,null);assert.ok(s.preview.value);assert.equal(f.generated.length,2)
    s.includeRules.value=true;await s.load();await s.generate();assert.equal(f.scopes.at(-1),true);assert.equal(f.generated.at(-1),'p4')
  }finally{f.dispose()}
})
test('交接重新整理失败不重用旧令牌，也不保留旧结果为新结果',async()=>{
  const f=handoffFixture(),s=f.state
  try{await tick();await s.generate();f.api.projectHandoffPreview=async()=>{throw new Error('范围读取失败')};await s.regenerate()
    assert.equal(f.generated.length,1);assert.equal(s.result.value,null);assert.equal(s.preview.value,null);assert.match(s.error.value,/范围读取失败/);assert.equal(s.loading.value,false)
  }finally{f.dispose()}
})
test('视频多版本默认首个、记忆版本优先、空列表提示；离开释放会话',async()=>{
  let assets=[{key:'1080p',episodeId:'e'},{key:'4k',episodeId:'e'}],remembered='',opened:string[]=[],started:string[]=[],released:string[]=[]
  const f=setup('src/components/video/VideoCard.vue',{video:{preview:{onClosed:()=>()=>{},choices:async()=>({assets}),open:async(_id:string,key:string)=>{opened.push(key);return {token:key,asset:assets.find(a=>a.key===key)}},release:async(token:string)=>{released.push(token)}}}},
    {'@/composables/useVideoPreview':{useVideoPreview:()=>({}),recentVideoAsset:()=>remembered},'@/composables/useVideoFrames':{useVideoFrames:()=>({state:Vue.ref(null),stop:()=>{},start:async(token:string)=>{started.push(token)}}),claimVideoHover:()=>{},releaseVideoHover:()=>{}},'@/stores/video':{WATCH_STATUS_LABEL:{}}},
    {setTimeout,clearTimeout,cancelAnimationFrame:()=>{}},{item:{id:'v',name:'合成视频',media_kind:'video'},selectable:false})
  try{await f.state.startFrames();assert.deepEqual(opened,['1080p']);assert.deepEqual(started,['1080p']);f.state.stopFrames();assert.deepEqual(released,['1080p'])
    remembered='4k';await f.state.startFrames();assert.equal(opened.at(-1),'4k');f.state.stopFrames();assets=[];await f.state.startFrames();assert.match(f.state.frameMessage.value,/没有可用/);assert.equal(opened.length,2)
  }finally{f.state.stopFrames();f.dispose()}
})


test('重复读取只接受最后一次结果，旧失败作废，当前失败仍抛出',async()=>{
  const pending:Array<{resolve:(value:string)=>void;reject:(reason:Error)=>void}>=[]
  const read=latestOnly(()=>new Promise<string>((resolve,reject)=>pending.push({resolve,reject})))
  const first=read(),second=read()
  pending[1].resolve('new');assert.equal(await second,'new')
  pending[0].resolve('old');assert.equal(await first,STALE)
  const failedOld=read(),current=read()
  pending[2].reject(new Error('old failure'));assert.equal(await failedOld,STALE)
  pending[3].reject(new Error('current failure'));await assert.rejects(current,/current failure/)
})

test('公共详情复制等待原生完成，保存或打开位置失败不会假报成功', async () => {
  const messages: string[] = []
  let finish!: () => void, failCopy = false, failSave = false
  const load = createRendererLoader({ vue: Vue, '@/composables/useToast': { useToast: () => ({
    toast: (message: string) => messages.push(message), success: (message: string) => messages.push(message), error: (message: string) => messages.push(message)
  }) } }, { window: { baoyi: { app: { copyText: async () => {
    if (failCopy) throw new Error('剪贴板被占用')
    await new Promise<void>(resolve => { finish = resolve })
  } } } } })
  const item = Vue.ref({ id: 'test', tags: [] as string[], is_archived: false })
  const actions = load('src/composables/useResourceDetail.ts').useResourceDetail({
    item, reveal: async () => false,
    update: async (current: any, patch: any) => { if (failSave) throw new Error('写入失败'); return { ...current, ...patch } },
    archivedMessage: (value: boolean) => value ? '归档完成' : '取消完成'
  })
  const copying = actions.copyPath('test-path')
  assert.equal(messages.length, 0)
  finish(); await copying; assert.deepEqual(messages, ['路径已复制'])
  failCopy = true; await actions.copyPath('test-path'); assert.equal(messages.at(-1), '复制失败：剪贴板被占用')
  failSave = true; await actions.toggleArchive(); assert.equal(item.value.is_archived, false)
  assert.equal(messages.at(-1), '保存失败：写入失败'); assert.ok(!messages.includes('归档完成'))
  failSave = false; await actions.toggleArchive(); assert.equal(item.value.is_archived, true)
  assert.equal(messages.at(-1), '归档完成')
  actions.commitTags('甲，甲、乙, 丙,丁,戊,己,庚,辛,壬'); await tick()
  assert.deepEqual([...item.value.tags], ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'])
  await actions.reveal(); assert.equal(messages.at(-1), '文件位置不可用，请检查磁盘是否在线')
})

test('公共侧栏默认显示八个标签，展开后保留全部计数', async () => {
  const tags = Array.from({ length: 10 }, (_, i) => ({ name: '标签' + i, count: i + 1 }))
  const fixture = setup('src/components/library/LibrarySidebar.vue', {}, {}, {}, { tags })
  try {
    const { locale } = fixture.load('src/i18n/index.ts')
    assert.equal(fixture.state.visibleTagLabel.value, '标签')
    locale.value = 'en'
    assert.equal(fixture.state.visibleTagLabel.value, 'Tags')
    locale.value = 'zh-CN'
    assert.equal(fixture.state.visibleTagLabel.value, '标签')
    assert.equal(fixture.state.visibleTags.value.length, 8)
    fixture.state.tagsOpen.value = true
    assert.deepEqual([...fixture.state.visibleTags.value], tags)
    fixture.state.tagsOpen.value = false
    assert.equal(fixture.state.visibleTags.value.length, 8)
  } finally { fixture.dispose() }
})

test('English AI profile validation uses input and hostname, not the translated placeholder', async () => {
  const saved: any[] = [], errors: string[] = []
  const store = { settings: { ai: { api_url: '', api_key: '', model: '', enabled: false }, ai_profiles: [], ai_profile_id: '' }, patch: async (value: any) => { saved.push(value) } }
  const f = setup('src/components/settings/tabs/AiTab.vue', {}, {
    '@/stores/settings': { useSettingsStore: () => store },
    '@/composables/useToast': { useToast: () => ({ error: (message: string) => errors.push(message), success() {}, toast() {} }) }
  }, { URL })
  try {
    f.load('src/i18n/index.ts').applyLanguage('en')
    for (const url of ['', 'not a URL', 'file:///folder']) {
      f.state.apiUrl.value = url; await f.state.addProfile()
      assert.equal(saved.length, 0)
      assert.equal(errors.at(-1), f.load('src/i18n/index.ts').tr('先给这套配置起个名字'))
    }
    f.state.apiUrl.value = 'https://api.example.com/v1'; await f.state.addProfile()
    assert.equal(saved[0].ai_profiles[0].name, 'example.com')
    f.state.apiUrl.value = ''; f.state.profileName.value = '配置名'; await f.state.addProfile()
    assert.equal(saved[1].ai_profiles[0].name, '配置名', 'a user-provided name is never mistaken for a placeholder')
  } finally { f.dispose() }
})

test('English comic retry uses the raw phase and composable rows retain it', () => {
  const row = Vue.reactive({ provider: 'jm', phase: 'placed', phaseLabel: 'Saved, awaiting registration', status: 'failed' })
  const f = setup('src/components/image/ComicTaskRow.vue', {}, {}, {}, { row })
  try {
    f.load('src/i18n/index.ts').applyLanguage('en')
    for (const phase of ['placed', 'indexing']) { row.phase = phase; assert.equal(f.state.label('retry'), f.load('src/i18n/index.ts').tr('重试登记')) }
    row.phase = 'downloading'; assert.equal(f.state.label('retry'), f.load('src/i18n/index.ts').tr('重试剩余页'))
    row.status = 'paused'; assert.equal(f.state.label('retry'), f.load('src/i18n/index.ts').tr('继续下载'))
  } finally { f.dispose() }
  const load = createRendererLoader({
    './useImageDownloads': { useImageDownloads: () => ({ jobs: Vue.ref([{ id: 'p', status: 'failed', updatedAt: 1, work: { title: 'Sample' }, chapters: [], progress: { phase: 'importing' } }]) }) },
    './useComicIngest': { useComicIngest: () => ({ jobs: Vue.ref([{ id: 'j', status: 'failed', updatedAt: 2, name: 'Sample', phase: 'placed', selectedChapters: [] }]) }) }
  })
  const downloads = load('src/composables/useComicDownloads.ts').useComicDownloads()
  load('src/i18n/index.ts').applyLanguage('en')
  assert.deepEqual(Array.from(downloads.rows.value, (r: any) => [r.id, r.phase]), [['j', 'placed'], ['p', 'importing']])
  assert.doesNotMatch(downloads.rows.value[0].phaseLabel, /\p{Script=Han}/u)
})

test('motto, copy notification and new measurement name follow language changes without losing user text', async () => {
  const sidebar = setup('src/components/software/Sidebar.vue', {}, {
    '@/stores/software': { useSoftwareStore: () => ({}) }, '@/stores/categories': { useCategoriesStore: () => ({}) }
  })
  try {
    const chinese = sidebar.state.motto.value.text
    sidebar.load('src/i18n/index.ts').applyLanguage('en')
    assert.doesNotMatch(sidebar.state.motto.value.text, /\p{Script=Han}/u)
    sidebar.load('src/i18n/index.ts').applyLanguage('zh-CN')
    assert.equal(sidebar.state.motto.value.text, chinese)
  } finally { sidebar.dispose() }
  const savedRecords: any[] = []
  const editor = setup('src/components/personal/PersonalEditor.vue', {
    workspace: { preferences: { get: async () => ({ assetCategories: [], experienceCategories: [] }) }, personal: { save: async (v: any) => { savedRecords.push(v); return v } } }
  }, {}, { structuredClone }, { kind: 'measurement', metrics: [] })
  try {
    editor.load('src/i18n/index.ts').applyLanguage('en')
    assert.equal(editor.state.form.value.name, '', 'input starts empty so user can clear/type freely without fallback snapping back')
    await editor.state.save()
    assert.equal(savedRecords[0].name, editor.load('src/i18n/index.ts').tr('状态记录'))
    editor.state.form.value.name = '我的记录'
    editor.load('src/i18n/index.ts').applyLanguage('zh-CN')
    editor.load('src/i18n/index.ts').applyLanguage('en')
    await editor.state.save()
    assert.equal(savedRecords[1].name, '我的记录')
  } finally { editor.dispose() }
  const messages: string[] = []
  const load = createRendererLoader({ '@/composables/useToast': { useToast: () => ({ success: (text: string) => messages.push(text) }) } }, { window: { baoyi: { app: { copyText: async () => {} } } } })
  const i18n = load('src/i18n/index.ts')
  const paths = load('src/composables/useResourceDetail.ts').useResourcePaths({ reveal: async () => true, copied: () => i18n.tr('文件路径已复制'), copyTone: 'success' })
  i18n.applyLanguage('en'); await paths.copyPath('C:/用户/路径')
  assert.equal(messages[0], i18n.tr('文件路径已复制'))
  assert.doesNotMatch(messages[0], /\p{Script=Han}/u)
})
