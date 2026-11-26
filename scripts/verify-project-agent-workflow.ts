import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { createProjectAgent } from '../electron/kinds/project/agent.ts'

test('真实 HTTP 工具链读取历史并自动保存可续接日志，会话原始记录不被裁掉', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-agent-workflow-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('commit', '--allow-empty', '-q', '-m', '建立基础')
  const sha = git('rev-parse', 'HEAD')
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  t.after(async () => { db.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }) })
  const item = new ProjectLibrary(db).register({ path: root, name: '流程样本', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  const requests: any[] = []
  const call = (name: string, args: object) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); requests.push(body)
    const message = requests.length === 1 ? call('read_project_history', { limit: 20 })
      : requests.length === 2 ? call('record_project_event', { title: '建立基础', body: '项目建立了初始提交。', commits: [sha] })
        : { role: 'assistant', content: '已记录项目历史。' }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 3 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const config = () => ({ enabled: true, api_key: 'fixture', api_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'fixture' })
  const agent = createProjectAgent({ db, config }), session = agent.create(item.id)
  const result = await agent.send(session.id, '回顾历史并记录')
  assert.equal(result.status, 'idle')
  const events = new TimelineLibrary(db).events(item.id)
  assert.equal(events.length, 1, '工具必须实际写入日志')
  assert.equal(events[0].status, 'published'); assert.equal(events[0].generated?.sessionId, session.id)
  assert.ok(result.messages[1].events.some(e => e.label === 'read_project_history 结果' && e.detail.includes(sha)))
  const reopened = createProjectAgent({ db, config })
  await reopened.send(session.id, '继续解释这条记录')
  assert.equal(reopened.get(session.id)?.messages.length, 4)
  assert.ok(requests.at(-1).messages.some((m: any) => m.content?.includes(sha)), '后续上下文应包含此前工具依据')
  const long = reopened.get(session.id)!
  while (long.messages.length < 104) long.messages.push({ id: 'history-' + long.messages.length, role: 'user', text: '旧消息 ' + long.messages.length, createdAt: Date.now(), events: [] })
  db.prepare('UPDATE project_sessions SET payload=? WHERE id=?').run(JSON.stringify(long), session.id)
  await reopened.send(session.id, '继续')
  assert.equal(reopened.get(session.id)?.messages.length, 106, '本地原始会话不能按上下文条数删除')
})

test('整理入口立即创建会话，停止长任务后保留可继续状态', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-organize-session-'))
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  t.after(async () => { db.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }) })
  const item = new ProjectLibrary(db).register({ path: root, name: '停止样本', summary: '', category: '软件项目', source: 'self', version: '', entries: [], evidence: '', suggested: true, warnings: [] })
  let began!: () => void, ended!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), stopped = new Promise<void>(resolve => { ended = resolve })
  const manager = createProjectAgent({ db, config: () => ({ enabled: true, api_key: 'fixture', api_url: 'http://fixture.invalid', model: 'fixture' }),
    run: async options => { began(); await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true })); return { stopReason: 'aborted', turns: 1, text: '', tokens: 0, error: '' } },
    changed: session => { if (session.workflow?.state === 'paused') ended() }
  })
  assert.equal(typeof manager.organize, 'function')
  const session = manager.organize(item.id)
  assert.equal(session.workflow?.kind, 'timeline'); assert.ok(manager.list(item.id).some(s => s.id === session.id))
  await started; manager.cancel(session.id); await stopped
  assert.equal(manager.get(session.id)?.status, 'interrupted')
  assert.equal(manager.get(session.id)?.workflow?.state, 'paused')
})

test('多个项目会话立即保存排队消息，并按序执行；排队取消不调用模型', async t => {
  const db = new DatabaseSync(':memory:'); initSchema(db,KINDS);t.after(()=>db.close())
  const item = new ProjectLibrary(db).register({ path:process.cwd(),name:'排队样本',summary:'',category:'软件项目',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[] })
  let release!:()=>void,began!:()=>void
  const ready=new Promise<void>(resolve=>{began=resolve}), gate=new Promise<void>(resolve=>{release=resolve}), calls:string[]=[]
  const manager=createProjectAgent({db,config:()=>({enabled:true,api_key:'fixture',api_url:'http://fixture.invalid',model:'fixture'}),run:async options=>{
    calls.push(options.user);if(calls.length===1){began();await gate}
    return {stopReason:'done',turns:1,text:'完成',tokens:0,error:''}
  }})
  const a=manager.create(item.id),b=manager.create(item.id),c=manager.create(item.id)
  const first=manager.send(a.id,'一');await ready
  const second=manager.send(b.id,'二'),third=manager.send(c.id,'三')
  // Attach handlers immediately, before checking the still-pending persisted session.
  const secondResult=second.catch(error=>({status:'rejected',error:error.message})),thirdResult=third.catch(error=>({status:'rejected',error:error.message}))
  assert.equal(manager.get(b.id)?.status,'running','排队中的消息必须已保存并可见')
  manager.cancel(b.id);release();await first
  assert.equal((await secondResult).status,'interrupted');assert.equal((await thirdResult).status,'idle')
  assert.deepEqual(calls,['一','三']);assert.equal(manager.get(b.id)?.messages[0].text,'二')
})
