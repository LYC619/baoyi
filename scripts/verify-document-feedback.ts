import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema, setSchemaVersion } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { identifyDocumentImport } from '../electron/workspace/document-import-agent.ts'

async function fixture(t: test.TestContext, legacy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-feedback-'))
  const db = new DatabaseSync(':memory:')
  initSchema(db, KINDS)
  if (legacy) {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='document_meta'").get() as {sql:string}).sql
    db.exec('PRAGMA foreign_keys=OFF; DROP TABLE document_meta;')
    db.exec(sql.replace("document_type TEXT NOT NULL DEFAULT 'other'", "document_type TEXT NOT NULL DEFAULT 'other' CHECK(document_type IN ('book','paper','reference','contract','certificate','other'))"))
    db.exec('PRAGMA foreign_keys=ON')
  }
  t.after(async () => { db.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, {recursive:true,force:true}) })
  const file = path.join(root, '读物.txt')
  await fs.writeFile(file, '第一章\n正文')
  return {root, file, db, docs:new DocumentLibrary(db)}
}

test('upgraded six-value CHECK supports new categories and cross-module moves', async t => {
  const {file, db, docs} = await fixture(t, true)
  const item = await docs.register(file, 'novel')
  assert.equal(item.type, 'novel')
  assert.equal(docs.moveToSubmodule(item.id, 'archive').type, 'archive_other')
  assert.equal(docs.update(item.id, {type:'id_resume'}).submodule, 'archive')
  assert.equal(docs.update(item.id, {type:'reading_other'}).submodule, 'reading')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('v24 constrained database migrates old contract category without losing position',async t=>{
  const {file,db,docs}=await fixture(t,true)
  docs.saveCategory({submodule:'archive',name:'合同',description:'合同、协议与相关方凭据',behavior:'contract',order:5})
  db.prepare("UPDATE document_categories SET id='contract' WHERE name='合同'").run()
  const item=await docs.register(file,'contract')
  db.prepare('UPDATE document_meta SET page=7,submodule=NULL WHERE resource_id=?').run(item.id)
  setSchemaVersion(db,24);initSchema(db,KINDS)
  assert.equal(docs.require(item.id).type,'archive_other')
  assert.equal(docs.require(item.id).submodule,'archive')
  assert.equal(docs.require(item.id).position.page,7)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
})

test('unspecified imports and former pending records always have a submodule', async t => {
  const {file, db, docs} = await fixture(t)
  const item = await docs.register(file)
  assert.equal(item.submodule, 'reading')
  db.prepare('UPDATE document_meta SET submodule=NULL WHERE resource_id=?').run(item.id)
  initSchema(db, KINDS)
  assert.equal(docs.require(item.id).submodule, 'reading')
  docs.update(item.id,{submodule:null})
  assert.equal(docs.list({submodule:'reading'}).length,1)
})

test('reading status tags follow reading progress and respect manual tag edits', async t => {
  const {file, docs} = await fixture(t)
  const item = await docs.register(file, 'novel')
  assert.ok(item.tags.includes('未读'))
  docs.savePosition(item.id, {page:2,offset:0.3}, 10)
  assert.ok(docs.require(item.id).tags.includes('在读'))
  docs.savePosition(item.id, {page:10,offset:0.99}, 10)
  assert.ok(docs.require(item.id).tags.includes('已读'))
  docs.update(item.id, {tags:['研究','在读']})
  docs.savePosition(item.id, {page:10,offset:1}, 10)
  assert.deepEqual(docs.require(item.id).tags, ['研究','在读'])
  docs.update(item.id, {tags:['研究']})
  docs.savePosition(item.id, {page:5,offset:0}, 10)
  assert.deepEqual(docs.require(item.id).tags, ['研究'])
})

test('novel search locates text in a later chapter and wraps to the first match', async t => {
  const {file,docs}=await fixture(t)
  await fs.writeFile(file,'第一章 起点\n普通正文\n第二章 相遇\n目标词在这里。目标词第二次。\n第三章 结尾\n完成。')
  const item=await docs.register(file,'novel')
  const first=await docs.searchText(item.id,'目标词',1,0)
  assert.equal(first?.page,2)
  const next=await docs.searchText(item.id,'目标词',first!.page,first!.start+3)
  assert.equal(next?.page,2);assert.ok(next!.start>first!.start)
  const wrap=await docs.searchText(item.id,'目标词',next!.page,next!.start+3)
  assert.equal(wrap?.start,first?.start)
  assert.equal(await docs.searchText(item.id,'不存在词',1,0),null)
})

test('import agent returns validated editable suggestions without registering the source',async t=>{
  const {file,docs}=await fixture(t)
  const candidate=(await docs.scan([file])).items[0]
  const config={enabled:true,api_url:'http://localhost',api_key:'fixture-only',model:'fixture'}
  const run=async(options:any)=>{
    assert.ok(options.user.includes('第一章'))
    await options.tools[0].execute({categoryId:'novel',name:'识别书名',author:'测试作者',tags:['文学'],reason:'根据第一章标题和文件内容'})
    return {stopReason:'done',error:'',turns:1,tokens:1,text:''} as any
  }
  const result=await identifyDocumentImport(candidate,docs.categories(),config,{run})
  assert.equal(result.categoryId,'novel');assert.equal(result.author,'测试作者');assert.equal(docs.list().length,0)
  await assert.rejects(identifyDocumentImport(candidate,docs.categories(),{...config,enabled:false},{run}),/未配置/)
  await assert.rejects(identifyDocumentImport(candidate,docs.categories(),config,{run:async(options:any)=>{
    await options.tools[0].execute({categoryId:'nonexistent',name:'无效',author:'',tags:[],reason:''})
    return {} as any
  }}),/分类不存在/)
})
