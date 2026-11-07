import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema, SCHEMA_VERSION } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

function fixture(t:test.TestContext) {
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  db.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) VALUES('p','project','D:/synthetic/project','project',1,1)").run()
  db.prepare("INSERT INTO project_meta(resource_id) VALUES('p')").run()
  t.after(()=>db.close())
  return {db,timeline:new TimelineLibrary(db)}
}
test('schema 27 真实旧表升级保留便签和 baseline，重复初始化不改变内容',t=>{
  const {db,timeline}=fixture(t)
  db.exec("DROP TABLE project_context; CREATE TABLE project_context(resource_id TEXT PRIMARY KEY REFERENCES resource(id) ON DELETE CASCADE,current_text TEXT NOT NULL DEFAULT '',next_text TEXT NOT NULL DEFAULT '',baseline TEXT NOT NULL DEFAULT ''); INSERT INTO project_context VALUES('p','旧进展','旧计划','{\"files\":[]}'); UPDATE settings SET value='27' WHERE key='_schema';")
  initSchema(db,KINDS);initSchema(db,KINDS)
  assert.ok(SCHEMA_VERSION>=28)
  assert.deepEqual(timeline.context('p'),{current:'旧进展',next:'旧计划',prompt:'',rules:[],revision:0,version:1,updatedAt:0})
  assert.equal(timeline.baseline('p'),'{"files":[]}')
})
test('同 revision 只有第一份保存成功，旧输入不得覆盖；目录 baseline 与便签互不覆盖',t=>{
  const {timeline}=fixture(t),original=timeline.context('p')
  const saved=timeline.updateContext('p',{...original,current:'  已完成\n',next:'下一阶段',prompt:'请继续',rules:[{type:'path',value:'docs/规则.md',label:'规范'}]})
  assert.equal(saved.current,'  已完成\n');assert.equal(saved.revision,1)
  timeline.baseline('p','{"head":"abc"}')
  assert.throws(()=>timeline.updateContext('p',{...original,next:'过期内容'}),/变化|更新|冲突/)
  assert.equal(timeline.context('p').next,'下一阶段')
  assert.equal(timeline.updateContext('p',{...saved,next:'继续'}).revision,2)
  assert.equal(timeline.baseline('p'),'{"head":"abc"}')
})
test('便签长度与规则相对路径约束；拒绝无 revision 和跨项目入口',t=>{
  const {timeline}=fixture(t),base=timeline.context('p')
  assert.throws(()=>timeline.updateContext('p',{current:'x',next:''} as any),/版本/)
  assert.throws(()=>timeline.updateContext('p',{...base,prompt:'x'.repeat(8001)}),/Prompt/)
  for(const value of ['../secret','C:\\secret','/secret','.env','docs/../../secret'])
    assert.throws(()=>timeline.updateContext('p',{...base,rules:[{type:'path',value,label:'规则'}]}),/规则|路径/)
  assert.throws(()=>timeline.updateContext('p',{...base,rules:[{type:'entry',value:'not-owned',label:'规则'}]}),/入口/)
  assert.equal(timeline.context('p').revision,0)
})
test('新便签 JSON 完整来回，schema 27 缺省补齐，新 schema 缺字段拒绝',t=>{
  const {db,timeline}=fixture(t)
  timeline.updateContext('p',{...timeline.context('p'),current:'保存',prompt:'我的提示词',rules:[{type:'path',value:'AGENTS.md',label:'规范'}]})
  const backup=buildLibraryBackup(db)
  timeline.updateContext('p',{...timeline.context('p'),prompt:'临时'})
  restoreLibraryBackup(db,backup)
  assert.equal(timeline.context('p').prompt,'我的提示词')
  const old=structuredClone(backup) as any;old.schema_version=27;delete old.tables.project_launch_profiles
  for(const row of old.tables.project_context)for(const key of ['prompt_text','rules','revision','version','updated_at'])delete row[key]
  restoreLibraryBackup(db,old)
  assert.equal(timeline.context('p').prompt,'');assert.equal(timeline.context('p').current,'保存')
  const bad=structuredClone(backup) as any;delete bad.tables.project_context[0].prompt_text
  assert.throws(()=>restoreLibraryBackup(db,bad))
})
