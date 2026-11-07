import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSchema, TABLES_SQL } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'

async function fixture(t:test.TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-doc-category-')), db=new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  t.after(async()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
  await fs.writeFile(path.join(root,'credential.pdf'),'pdf fixture');await fs.writeFile(path.join(root,'notes.md'),'# 内容')
  return {root,db,docs:new DocumentLibrary(db)}
}
test('证书导入显式分类受到保护，未指定分类进入其他；自定义编号重命名不影响成员',async t=>{
  const {root,db,docs}=await fixture(t)
  const certificate=await docs.register(path.join(root,'credential.pdf'),'certificate')
  assert.equal(certificate.type,'certificate','导入必须继承用户分类');assert.equal(certificate.typeLocked,true)
  assert.equal((await docs.register(path.join(root,'notes.md'))).submodule,'reading')
  const category=docs.saveCategory({name:'研究资料',description:'科研项目相关资料',behavior:'reading',order:2})
  docs.update(certificate.id,{type:category.id});docs.saveCategory({...category,name:'研究档案'})
  assert.equal(docs.require(certificate.id).type,category.id);assert.equal(docs.require(certificate.id).typeName,'研究档案');assert.equal(docs.require(certificate.id).readable,true)
  assert.throws(()=>docs.removeCategory(category.id),/转移/)
  docs.removeCategory(category.id,'book');assert.equal(docs.require(certificate.id).type,'book')
  initSchema(db,KINDS);assert.ok(!docs.categories().some(c=>c.id===category.id))
  assert.ok(docs.categories().some(c=>c.id==='novel'))
})
test('分类、说明、顺序和保护标记随备份恢复；旧备份补齐分类',async t=>{
  const {root,db,docs}=await fixture(t)
  assert.equal(typeof docs.saveCategory,'function','分类需要可维护')
  const category=docs.saveCategory({name:'技术手册',description:'安装维护操作',behavior:'reading',order:0})
  const item=await docs.register(path.join(root,'notes.md'),category.id)
  const backup=buildLibraryBackup(db), target=new DatabaseSync(':memory:');t.after(()=>target.close());initSchema(target,KINDS);target.exec(VIDEO_JOBS_SQL)
  restoreLibraryBackup(target,backup)
  assert.equal(new DocumentLibrary(target).require(item.id).typeName,'技术手册')
  assert.equal(new DocumentLibrary(target).require(item.id).typeLocked,true)
  const legacy=structuredClone(backup) as any;legacy.schema_version=18;delete legacy.tables.document_categories
  for(const row of legacy.tables.document_meta){delete row.category_id;delete row.type_locked}
  restoreLibraryBackup(target,legacy)
  assert.ok(new DocumentLibrary(target).categories().some(c=>c.id==='archive_other'))
})
test('0.17/0.18 旧 document_meta 原位迁移保留旧类型、阅读位置和资料编号',()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(TABLES_SQL)
  db.exec(`CREATE TABLE document_meta(resource_id TEXT PRIMARY KEY REFERENCES resource(id),document_type TEXT NOT NULL DEFAULT 'other',format TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',counterpart TEXT NOT NULL DEFAULT '',issued_on TEXT NOT NULL DEFAULT '',expires_on TEXT NOT NULL DEFAULT '',read_state TEXT NOT NULL DEFAULT 'unread',page INTEGER NOT NULL DEFAULT 1,page_count INTEGER NOT NULL DEFAULT 0,scroll_offset REAL NOT NULL DEFAULT 0);
    INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) VALUES('legacy','document','D:/fixture/old.pdf','old.pdf',1,1);
    INSERT INTO document_meta(resource_id,document_type,format,page) VALUES('legacy','contract','pdf',7);
    INSERT INTO settings(key,value) VALUES('_schema','18');`)
  try {initSchema(db,KINDS);const item=new DocumentLibrary(db).require('legacy');assert.equal(item.type,'archive_other');assert.equal(item.submodule,'archive');assert.equal(item.position.page,7);assert.equal(item.typeLocked,true)} finally {db.close()}
})
