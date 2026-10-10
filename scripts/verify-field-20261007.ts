import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { registerVideoContent } from '../electron/kinds/video/registration.ts'
import { listVideos, updateVideo } from '../electron/kinds/video/db.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { createProjectAgent } from '../electron/kinds/project/agent.ts'
import { inspectProject } from '../electron/kinds/project/scanner.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'

test('照片不允许写入漫画分类，历史错分照片不会随漫画隐藏',()=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const library=new ImageLibrary(db),group=library.saveGroup({name:'漫画独有'})
    db.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) VALUES('photo','image','D:/photos','photos',1,1)").run()
    db.prepare("INSERT INTO image_meta(resource_id,item_type) VALUES('photo','photo')").run()
    assert.throws(()=>library.update('photo',{groupId:group.id}),/相册|照片/)
    db.prepare('UPDATE image_meta SET group_id=?').run(group.id)
    library.saveGroup({...group,hidden:true})
    initSchema(db,KINDS)
    assert.equal(library.get('photo')?.groupId,null)
  }finally{db.close()}
})

test('hanime 来源不能因传入普通分类而出现在普通列表',()=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    registerVideoContent(db,{title:'来源隔离',directory:'D:/fixture/hanime',category:'其他',sources:[{provider:'hanime',externalId:'123456',scope:'episode',pageUrl:'https://hanime1.me/watch?v=123456',evidence:'playlist'}],items:[{title:'第一集',order:1,files:[]}]})
    assert.equal(listVideos(db).length,0)
    assert.equal(listVideos(db,{type:'hentai'}).length,1)
    const hentai=listVideos(db,{type:'hentai'})[0]
    updateVideo(db,hentai.id,{category:'动画'})
    assert.equal(listVideos(db).length,0)
    db.prepare("UPDATE resource SET category='动画' WHERE kind='video'").run()
    initSchema(db,KINDS)
    assert.equal(listVideos(db,{type:'hentai'}).length,1)
    assert.equal(listVideos(db,{type:'movie'}).length,0)
  } finally {db.close()}
})

test('项目导入初始化离线资料记录，重复调用不重复创建',async()=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const item=new ProjectLibrary(db).register(await inspectProject(process.cwd()))
    const agent=createProjectAgent({db,config:()=>({enabled:false} as any)})
    assert.equal(typeof agent.recordImport,'function')
    const session=await agent.recordImport(item.id)
    assert.match(session.messages[0].text,/本地|登记/)
    assert.match(session.messages[0].text,/README|项目配置/)
    await agent.recordImport(item.id)
    assert.equal(agent.list(item.id).length,1)
  } finally {db.close()}
})

test('本地登记后主动分析并应用建议，重复导入保留人工修改',async()=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const library=new ProjectLibrary(db),item=library.register(await inspectProject(process.cwd()))
    let calls=0
    const agent=createProjectAgent({db,config:()=>({enabled:true,api_key:'test',api_url:'http://localhost',model:'test'}),run:async options=>{
      calls++;await options.tools.find(t=>t.name==='propose_project_update')!.execute({summary:'经过文件核对的用途',tags:['软件']})
      return {stopReason:'done',text:'资料已核对',turns:1,tokens:1,error:''}
    }})
    assert.equal(typeof agent.recordImport,'function')
    const local=agent.recordImport(item.id)
    assert.equal(calls,0)
    const session=await agent.send(local.id,'完善资料')
    const proposal=session.messages.find(m=>m.proposal)!
    agent.apply(session.id,proposal.id)
    assert.equal(library.get(item.id)?.summary,'经过文件核对的用途')
    assert.ok(agent.get(session.id)?.messages.some(m=>m.proposal?.applied))
    library.update(item.id,{summary:'人工资料'})
    await agent.recordImport(item.id)
    assert.equal(library.get(item.id)?.summary,'人工资料');assert.equal(calls,1)
  } finally {db.close()}
})
