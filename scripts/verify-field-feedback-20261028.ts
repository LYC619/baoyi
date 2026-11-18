import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { createProjectAgent } from '../electron/kinds/project/agent.ts'
import { projectAgentTools } from '../electron/workspace/project-agent-tools.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import * as Vue from 'vue'
import { createServer } from 'node:http'

const config = { enabled: true, api_key: 'fixture', api_url: 'http://fixture.invalid', model: 'fixture' }
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-field-fix-'))
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  t.after(async () => {
    db.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('baoyi-field-fix-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const project = (directory = root) => new ProjectLibrary(db).register({ path: directory, name: '隔离回归', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  return { root, db, project }
}
function initGit(root: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', '初始提交')
  return git('rev-parse', 'HEAD')
}

test('R1：默认根仓库及嵌套仓库的提交详情读取，并从持久工具记录恢复根路径', async t => {
  const { root, db, project } = await fixture(t)
  const repo = path.join(root, 'repo'); await fs.mkdir(repo); initGit(repo)
  for (const item of [project(repo), project(root)]) {
    const manager = createProjectAgent({ db, config: () => config }), session = manager.create(item.id)
    const tools = projectAgentTools(db, item, session, () => {})
    const history = JSON.parse(await tools.find(tool => tool.name === 'read_project_history')!.execute({}))
    const sha = history.commits[0].sha
    assert.match(JSON.parse(await tools.find(tool => tool.name === 'read_project_commit')!.execute({ sha })).text, /初始提交/)
    session.messages.push({ id: 'source', role: 'assistant', text: '', createdAt: Date.now(), events: [{ label: 'read_project_history 结果', detail: JSON.stringify(history) }] })
    const restored = projectAgentTools(db, item, session, () => {})
    assert.match(JSON.parse(await restored.find(tool => tool.name === 'read_project_commit')!.execute({ sha })).text, /初始提交/)
    await assert.rejects(restored.find(tool => tool.name === 'read_project_history')!.execute({ repoPath: '../outside' }), /相对路径|范围/)
    manager.dispose()
  }
})

test('R2：无仓库只运行一次，保存明确阻塞状态，手动继续仍只重查一次', async t => {
  const { db, project } = await fixture(t), item = project()
  let calls = 0, finished!: () => void
  let completion = new Promise<void>(resolve => { finished = resolve })
  const manager = createProjectAgent({ db, config: () => config, run: async options => {
    calls++
    await options.tools.find(tool => tool.name === 'read_project_history')!.execute({})
    return { stopReason: 'done', turns: 1, tokens: 0, error: '', text: '没有仓库。' }
  }, paused: () => finished() })
  t.after(() => manager.dispose())
  const session = manager.organize(item.id); await completion
  assert.equal(calls, 1)
  assert.equal(manager.get(session.id)!.workflow!.state, 'paused')
  assert.match(manager.get(session.id)!.error, /仓库/)
  assert.equal(manager.get(session.id)!.messages.length, 2)
  completion = new Promise<void>(resolve => { finished = resolve })
  manager.resumeOrganize(session.id); await completion
  assert.equal(calls, 2)
})

test('R4：800 个待记录提交不会展开为超长内部消息，待记录工具可分页完整查询', async t => {
  const { db, project } = await fixture(t), item = project()
  let calls = 0, finished!: () => void
  const complete = new Promise<void>(resolve => { finished = resolve })
  const manager = createProjectAgent({ db, config: () => config, run: async options => {
    calls++
    if (calls === 1) {
      for (let page = 0; page < 8; page++) {
        const commits = Array.from({ length: 100 }, (_, index) => ({ sha: (page * 100 + index + 1).toString(16).padStart(40, '0'), at: '2026-10-28T00:00:00Z', subject: '提交依据' }))
        options.onEvent?.({ type: 'tool_result', name: 'read_project_history', text: JSON.stringify({ commits, repoPath: '', next: { head: commits[0].sha, offset: (page + 1) * 100 } }), isError: false })
      }
    } else {
      assert.ok(options.user.length < 2000)
      const pending = options.tools.find(tool => tool.name === 'read_pending_project_commits')!
      assert.ok(pending)
      const shas: string[] = []; let start = 0
      do {
        const raw = await pending.execute({ start }); assert.ok(raw.length <= pending.maxOutput!)
        const page = JSON.parse(raw); shas.push(...page.items.map((item: any) => item.sha)); start = page.next
      } while (start !== null)
      assert.equal(new Set(shas).size, 800)
      return { stopReason: 'aborted', turns: 1, tokens: 0, error: '', text: '' }
    }
    return { stopReason: 'done', turns: 8, tokens: 0, error: '', text: '已读取。' }
  }, paused: () => finished() })
  t.after(() => manager.dispose())
  const session = manager.organize(item.id); await complete
  assert.equal(calls, 2)
  assert.equal(manager.get(session.id)!.status, 'interrupted', manager.get(session.id)!.error)
  assert.doesNotMatch(manager.get(session.id)!.error, /30000/)
})

function virtualRepositoryTools(root: string, state: any = { messages: [] }, readError = false, onRead?:()=>void) {
  const dummy = class {}, reads: string[] = []
  const fakeFs = {
    lstat: async (file: string) => {
      if (path.basename(file) === '.git') {
        if (['d0001', 'd1050'].includes(path.basename(path.dirname(file)))) return { isDirectory: () => true, isFile: () => false }
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, isSymbolicLink: () => false }
    },
    readdir: async (directory: string) => {
      onRead?.()
      if (readError) throw new Error('access denied')
      return directory === root ? Array.from({ length: 1100 }, (_, index) => ({ name: `d${String(index).padStart(4, '0')}`, isDirectory: () => true, isSymbolicLink: () => false })) : []
    }
  }
  const load = createRendererLoader({
    'node:path': { default: path }, 'node:fs/promises': { default: fakeFs },
    './project-history.ts': { projectHistory: async (directory: string) => {
      reads.push(directory)
      if (directory === root) throw new Error('not a git repository')
      return { head: 'a'.repeat(40), next: null, commits: [{ sha: 'a'.repeat(40), at: new Date().toISOString(), subject: 'fixture' }] }
    } },
    './agent-journal.ts': { AgentJournal: dummy }, './timeline.ts': { TimelineLibrary: dummy }, './project-summaries.ts': { ProjectSummaries: dummy },
    '../services/agent/context.ts': { createConversationHistoryTool: () => ({ name: 'unused' }) }
  }, { AbortController, DOMException })
  return { tools: load('electron/workspace/project-agent-tools.ts').projectAgentTools({}, { path: root }, state, () => {}), reads }
}

test('R5：扫描达到上限不能把部分候选当成唯一仓库，读取失败同样标记不完整', async () => {
  for (const readError of [false, true]) {
    const root = path.resolve('virtual-review-root'), { tools, reads } = virtualRepositoryTools(root, undefined, readError)
    const page = JSON.parse(await tools.find((tool: any) => tool.name === 'read_project_history').execute({}))
    assert.equal(page.available, false)
    assert.equal(page.scan.complete, false)
    assert.equal(reads.length, 1)
    if (!readError) assert.ok(page.candidates.includes('d0001'))
  }
})

test('R5：停止信号在扫描前生效，不执行 Git 或目录扫描', async () => {
  const { tools, reads } = virtualRepositoryTools(path.resolve('virtual-review-root'))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(tools.find((tool: any) => tool.name === 'read_project_history').execute({}, controller.signal), /取消|停止|abort/i)
  assert.equal(reads.length, 0)
})

test('R6：标准网页请求区分验证页、拒绝、限流和服务器错误，不用 Range 代表网页可用', async () => {
  let code = 200, html = '<title>Just a moment</title>', init: RequestInit | undefined
  const load = createRendererLoader({ electron: { session: { fromPartition: () => ({
    setUserAgent: () => {}, setProxy: async () => {}, resolveProxy: async () => 'PROXY fixture:1234',
    fetch: async (_url: string, options: RequestInit) => { init = options; return new Response(html, { status: code, headers: { 'content-type': 'text/html' } }) }
  }) } }, './database.ts': { getDb: () => ({}) },
    './settings-store.ts': { getSettings: () => ({ video_online_proxy: 'system://' }) } }, { URL, Response, AbortSignal, TextDecoder, Uint8Array })
  const network = load('electron/services/online-network.ts')
  for (const [status, body, outcome] of [[200, html, 'verification_required'], [403, 'Forbidden', 'restricted'], [429, 'Rate limited', 'rate_limited'], [500, 'Error', 'server_error'], [200, '<title>正常页面</title>', 'response_received']] as const) {
    code = status; html = body
    const result = await network.probeOnlineNetwork('https://fixture.invalid/')
    assert.equal(result.outcome, outcome)
    assert.equal((init!.headers as any).Range, undefined)
  }
})

test('R2：多仓库暂停后可显式选择，重建管理器仍使用同一仓库和会话；空仓库正常完成', async t => {
  const {root,db,project}=await fixture(t),item=project()
  for(const name of ['first','second']){const directory=path.join(root,name);await fs.mkdir(directory);initGit(directory)}
  let finish!:()=>void
  let completed=new Promise<void>(resolve=>{finish=resolve})
  let manager=createProjectAgent({db,config:()=>config,run:async options=>{
    await options.tools.find(tool=>tool.name==='read_project_history')!.execute({})
    return {stopReason:'done',turns:1,tokens:0,error:'',text:'选择仓库'}
  },paused:()=>finish()})
  const session=manager.organize(item.id);await completed
  assert.equal(manager.get(session.id)!.repository!.status,'needs_selection')
  assert.equal(manager.get(session.id)!.repository!.candidates.length,2)
  await manager.selectRepository(session.id,'second');manager.dispose()
  manager=createProjectAgent({db,config:()=>config,run:async options=>{
    const page=JSON.parse(await options.tools.find(tool=>tool.name==='read_project_history')!.execute({}))
    assert.equal(page.repoPath,'second')
    await options.tools.find(tool=>tool.name==='record_project_event')!.execute({title:'选择后续接',body:'只记录所选仓库',commits:page.commits.map((c:any)=>c.sha)})
    return {stopReason:'done',turns:1,tokens:0,error:'',text:'已完成'}
  },paused:()=>finish(),completed:()=>finish()})
  t.after(()=>manager.dispose())
  completed=new Promise<void>(resolve=>{finish=resolve});manager.resumeOrganize(session.id);await completed
  assert.equal(manager.get(session.id)!.workflow!.state,'complete',manager.get(session.id)!.error)
  const tools=projectAgentTools(db,item,manager.get(session.id)!,()=>{})
  await assert.rejects(tools.find(tool=>tool.name==='read_project_history')!.execute({repoPath:'first'}),/另一个仓库/)
  await assert.rejects(manager.selectRepository(session.id,'first'),/另一个仓库/)
  const empty=path.join(root,'empty');await fs.mkdir(empty);execFileSync('git',['-C',empty,'init','-q'])
  const emptyItem=project(empty),emptyTools=projectAgentTools(db,emptyItem,manager.create(emptyItem.id),()=>{})
  const page=JSON.parse(await emptyTools.find(tool=>tool.name==='read_project_history')!.execute({}))
  assert.equal(page.available,true);assert.deepEqual(page.commits,[]);assert.equal(page.next,null)
})

test('R2 界面：选择后沿用同一会话继续，失败保留输入并解除忙碌',async()=>{
  const scope=Vue.effectScope(),calls:any[]=[],props=Vue.reactive({session:{id:'paused',workflow:{state:'paused'},repository:{status:'needs_selection',candidates:['app/backend'],message:'待选择',scan:{complete:false,visited:1000,reasons:['directory_limit']}}},busy:false})
  let fail=false
  const load=createRendererLoader({vue:Vue},{window:{baoyi:{project:{selectRepository:async(id:string,path:string)=>{calls.push(['select',id,path]);if(fail)throw new Error('目录不可读');return {...props.session,repository:{status:'ready'}}},resumeOrganize:async(id:string)=>{calls.push(['resume',id]);return {...props.session,status:'running'}}}}}})
  const events:any[]=[]
  try{const state=scope.run(()=>load('src/components/project/ProjectRepositoryPanel.vue').default.setup(props,{expose(){},emit:(...args:any[])=>events.push(args)}))
    assert.equal(state.choice.value,'app/backend');assert.match(state.reasons.value,/上限/)
    await state.continueReview(true);assert.deepEqual(calls,[['select','paused','app/backend'],['resume','paused']])
    assert.deepEqual(events.filter(event=>event[0]==='working').map(event=>event[1]),[true,false])
    fail=true;state.choice.value='manual/path';await state.continueReview(true)
    assert.match(state.error.value,/不可读/);assert.equal(state.choice.value,'manual/path');assert.equal(state.working.value,false)
  }finally{scope.stop()}
})

test('R6 界面：未保存配置禁止诊断，检查期间展示状态，HTTP 拒绝不显示成功',async()=>{
  const scope=Vue.effectScope(),settings=Vue.reactive({settings:{video_online_proxy:'system://'},patch:async(value:any)=>{Object.assign(settings.settings,value)}})
  let release!:(value:any)=>void,calls=0
  const load=createRendererLoader({vue:{...Vue,onMounted:()=>{}},'@/styles/workspace.css':{},'@/stores/settings':{useSettingsStore:()=>settings}},{window:{baoyi:{video:{discovery:{online:{probe:async()=>{calls++;return new Promise(resolve=>{release=resolve})}}}}}}})
  try{const state=scope.run(()=>load('src/components/settings/OnlineSourceSettings.vue').default.setup({}, {expose(){}}))
    state.rule.value='';assert.equal(state.unsaved.value,true);await state.probe();assert.equal(calls,0)
    await state.save();assert.equal(state.unsaved.value,false)
    const pending=state.probe();assert.equal(state.busy.value,true);assert.match(state.activity.value,/检查网页/)
    release({status:403,resolved:'DIRECT',outcome:'restricted'});await pending
    assert.equal(state.busy.value,false);assert.equal(state.probeProblem.value,true);assert.match(state.status.value,/403/);assert.doesNotMatch(state.status.value,/连接成功/)
  }finally{scope.stop()}
})

test('R5：扫描过程中停止，立即退出且不自动选部分候选',async()=>{
  const controller=new AbortController(),state:any={messages:[]}
  const {tools,reads}=virtualRepositoryTools(path.resolve('stop-during-scan'),state,false,()=>controller.abort())
  await assert.rejects(tools.find((tool:any)=>tool.name==='read_project_history').execute({},controller.signal),/停止/)
  assert.equal(reads.length,1);assert.equal(state.repository,undefined)
})

test('R2：真实本机 HTTP 循环无仓库即暂停，不再发起第二个模型请求',async t=>{
  const {db,project}=await fixture(t),item=project();let calls=0,finish!:()=>void
  const completed=new Promise<void>(resolve=>{finish=resolve})
  const server=createServer(async(req,res)=>{for await(const _chunk of req){}calls++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'read-'+calls,type:'function',function:{name:'read_project_history',arguments:'{}'}}]}}]}))})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}))
  const manager=createProjectAgent({db,config:()=>({...config,api_url:`http://127.0.0.1:${(server.address() as any).port}`}),paused:()=>finish()});t.after(()=>manager.dispose())
  const session=manager.organize(item.id);await completed
  const result=manager.get(session.id)!;assert.equal(calls,1);assert.equal(result.workflow!.state,'paused');assert.match(result.error,/未找到.*仓库/)
  const event=result.messages.at(-1)!.events.find(event=>event.label==='read_project_history 结果')!;assert.equal(JSON.parse(event.detail).available,false)
})
