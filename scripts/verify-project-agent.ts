import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { inspectProject } from '../electron/kinds/project/scanner.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/library-backup.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'

test('默认导入状态只作用于新项目，重复导入保留人工状态',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-default-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try{
    const library=new ProjectLibrary(db),scan=await inspectProject(root)
    const item=library.register(scan,'paused')
    assert.equal(item.state,'paused')
    library.update(item.id,{state:'maintaining'})
    assert.equal(library.register(scan,'archived').state,'maintaining')
  }finally{db.close();await fs.rm(root,{recursive:true,force:true})}
})

test('项目工具读取真实文件，拒绝越界与凭据',async()=>{
  const workspace=await import('../electron/kinds/project/workspace.ts').catch(()=>({readProjectText:undefined,listProjectFiles:undefined,projectOverview:undefined}))
  assert.equal(typeof workspace.readProjectText,'function')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-tools-'))
  try {
    await fs.writeFile(path.join(root,'README.md'),'# Demo\n说明内容')
    await fs.writeFile(path.join(root,'.env'),'SECRET=not-for-agent')
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{dev:'vite',test:'node --test'}}))
    assert.match(await workspace.readProjectText!(root,'README.md'),/说明内容/)
    await assert.rejects(()=>workspace.readProjectText!(root,'../outside.txt'),/项目|范围/)
    await assert.rejects(()=>workspace.readProjectText!(root,'.env'),/凭据|敏感/)
    assert.ok(!(await workspace.listProjectFiles!(root,'')).some(f=>f.path==='.env'))
    assert.equal((await workspace.projectOverview!(root)).scripts[0].name,'dev')
  }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('项目对话持久化历史和工具提案，确认才写资料，修改过的项目拒绝旧提案',async()=>{
  const agent=await import('../electron/kinds/project/agent.ts').catch(()=>({createProjectAgent:undefined}))
  assert.equal(typeof agent.createProjectAgent,'function')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-chat-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  db.exec(VIDEO_JOBS_SQL)
  try {
    await fs.writeFile(path.join(root,'README.md'),'# 演示\n项目说明')
    const library=new ProjectLibrary(db),item=library.register(await inspectProject(root))
    let histories:number[]=[]
    const manager=agent.createProjectAgent!({db,config:()=>({enabled:true,api_key:'test',api_url:'http://localhost',model:'test'}),run:async options=>{
      histories.push(options.history?.length||0)
      const tool=options.tools.find(t=>t.name==='propose_project_update')!
      await tool.execute({summary:'有依据的项目简介',tags:['文稿']})
      return {stopReason:'done',text:'已提出资料建议，请核对。',turns:1,tokens:10,error:''}
    }})
    const session=manager.create(item.id)
    const result=await manager.send(session.id,'帮我完善资料')
    assert.equal(result.messages.length,2);assert.equal(library.get(item.id)?.summary,item.summary)
    assert.equal(result.status,'idle');assert.equal(result.messages[1].proposal?.patch.summary,'有依据的项目简介')
    manager.apply(session.id,result.messages[1].id)
    assert.equal(library.get(item.id)?.summary,'有依据的项目简介')
    const second=await manager.send(session.id,'再看看')
    assert.deepEqual(histories,[0,2]);assert.equal(manager.get(session.id)?.messages.length,4)
    library.update(item.id,{notes:'人工修改'})
    assert.throws(()=>manager.apply(session.id,second.messages[3].id),/变化|过期/)
    const reopened=agent.createProjectAgent!({db,config:()=>({enabled:false} as any)})
    assert.equal(reopened.list(item.id).length,1);assert.equal(reopened.get(session.id)?.messages.length,4)
    const backup=buildLibraryBackup(db),target=new DatabaseSync(':memory:');initSchema(target,KINDS);target.exec(VIDEO_JOBS_SQL)
    try{
      restoreLibraryBackup(target,backup)
      assert.equal(JSON.parse(String(target.prepare('SELECT payload FROM project_sessions').get()?.payload)).messages.length,4)
      const corrupt=structuredClone(backup);corrupt.tables.project_sessions[0].resource_id='other'
      assert.throws(()=>restoreLibraryBackup(target,corrupt),/session disagree/)
      const legacy=structuredClone(backup) as any;legacy.schema_version=14;delete legacy.tables.project_sessions
      for(const row of legacy.tables.video_meta)delete row.media_kind
      restoreLibraryBackup(target,legacy);assert.equal(target.prepare('SELECT count(*) n FROM project_sessions').get()?.n,0)
    }finally{target.close()}
  }finally{db.close();await fs.rm(root,{recursive:true,force:true})}
})

test('停止项目对话保留记录，应用重启恢复未完成状态',async()=>{
  const {createProjectAgent}=await import('../electron/kinds/project/agent.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-cancel-'))
  try {
    const item=new ProjectLibrary(db).register(await inspectProject(root))
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve})
    const manager=createProjectAgent({db,config:()=>({enabled:true,api_key:'test',api_url:'http://localhost',model:'test'}),run:async options=>{
      started();await new Promise<void>(resolve=>options.signal!.addEventListener('abort',()=>resolve(),{once:true}))
      return {stopReason:'aborted',turns:1,tokens:0,text:'',error:''}
    }})
    const session=manager.create(item.id),pending=manager.send(session.id,'停止测试');await ready
    assert.equal(manager.get(session.id)?.status,'running');manager.cancel(session.id)
    assert.equal((await pending).status,'interrupted');assert.equal(manager.busy(),false)
    const interrupted=manager.get(session.id)!;interrupted.status='running'
    db.prepare('UPDATE project_sessions SET payload=? WHERE id=?').run(JSON.stringify(interrupted),session.id)
    assert.equal(createProjectAgent({db,config:()=>({} as any)}).get(session.id)?.status,'interrupted')
  }finally{db.close();await fs.rm(root,{recursive:true,force:true})}
})

test('模型故障保留失败记录并释放会话，可继续发送',async()=>{
  const {createProjectAgent}=await import('../electron/kinds/project/agent.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-error-'))
  try{
    const item=new ProjectLibrary(db).register(await inspectProject(root));let fail=true
    const manager=createProjectAgent({db,config:()=>({enabled:true,api_key:'test',api_url:'http://localhost',model:'test'}),run:async()=>{
      if(fail)throw new Error('model connection failed')
      return {stopReason:'done',turns:1,tokens:0,text:'已恢复',error:''}
    }})
    const session=manager.create(item.id)
    assert.equal((await manager.send(session.id,'故障测试')).status,'failed');assert.equal(manager.busy(),false)
    assert.match(manager.get(session.id)!.error,/connection/)
    fail=false
    assert.equal((await manager.send(session.id,'继续')).status,'idle');assert.equal(manager.get(session.id)!.messages.length,4)
  }finally{db.close();await fs.rm(root,{recursive:true,force:true})}
})


test('本地登记不调用已配置且永不返回的模型，登记会话幂等且保护人工资料', async () => {
  const { createProjectAgent } = await import('../electron/kinds/project/agent.ts')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-project-local-'))
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  try {
    await fs.writeFile(path.join(root, 'README.md'), '# Local import')
    const library = new ProjectLibrary(db), scan = await inspectProject(root), item = library.register(scan)
    library.update(item.id, { name: '人工名称', category: '其他', source: 'self', state: 'maintaining' })
    for (const enabled of [true, false]) {
      let calls = 0
      const manager = createProjectAgent({ db, config: () => ({ enabled, api_key: 'test', api_url: 'http://127.0.0.1', model: 'test' }), run: () => { calls++; return new Promise(() => {}) } })
      assert.equal(typeof manager.recordImport, 'function', 'registration must have a synchronous local-only entry')
      const session = manager.recordImport(item.id)
      assert.equal(session.title, '导入登记'); assert.equal(session.status, 'idle'); assert.equal(calls, 0)
      assert.match(session.messages[0].text, /本地|登记/)
      assert.equal(manager.recordImport(library.register(scan).id).id, session.id)
      assert.equal(manager.list(item.id).length, 1)
      assert.equal(manager.get(session.id)?.messages.length, 1)
      assert.equal(library.get(item.id)?.name, '人工名称'); assert.equal(library.get(item.id)?.state, 'maintaining')
    }
  } finally {
    db.close()
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  }
})
