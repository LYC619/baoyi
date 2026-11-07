import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {WorkspaceLinks} from '../electron/workspace/links.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/library-backup.ts'

async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-recycle-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
 t.after(async()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
 const source=path.join(root,'source.txt'),data=path.join(root,'data');await fs.mkdir(data);await fs.writeFile(source,'留住证据')
 const docs=new DocumentLibrary(db),doc=await docs.register(source),note=docs.annotate(doc.id,{kind:'excerpt',quote:'证据',note:'我的想法',location:{page:1,offset:0}})
 const project=new ProjectLibrary(db).register({path:root,name:'回收样本',summary:'',category:'其他',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]}),links=new WorkspaceLinks(db);links.add('project',project.id,doc.id,note.id)
 assert.ok(existsSync('electron/workspace/document-recycle.ts'),'需要可恢复的回收站服务')
 const {DocumentRecycle,addCalendarMonth}=await import('../electron/workspace/document-recycle.ts')
 let now=new Date(2028,0,31,12,30).getTime();const recycle=new DocumentRecycle(db,()=>data,()=>now)
 return {root,db,source,data,docs,doc,note,project,links,recycle,addCalendarMonth,setNow:(v:number)=>now=v}
}
test('手动删除回收文件后到期清理能完成，保留可恢复的元数据',async t=>{
 const f=await fixture(t),plan=await f.recycle.plan(f.doc.id,[f.source]);await f.recycle.remove(plan)
 await fs.unlink(plan.files[0].stored);f.setNow(plan.expiresAt+1)
 await f.recycle.cleanup();assert.equal(f.recycle.get(plan.id).state,'purged')
 await f.recycle.restore(plan.id);assert.equal(f.docs.require(f.doc.id).available,false)
})
test('仅移除索引可恢复同一资料、标注和关联，备份往返保留回收记录',async t=>{
 const f=await fixture(t),plan=await f.recycle.plan(f.doc.id,[]),record=await f.recycle.remove(plan)
 assert.ok(existsSync(f.source));assert.equal(f.docs.list().length,0);assert.equal(f.links.list('project',f.project.id)[0].missing,true)
 assert.equal(f.links.counts().document,0);assert.ok(!f.links.resources().some(r=>r.id===f.doc.id))
 const backup=buildLibraryBackup(f.db);restoreLibraryBackup(f.db,backup)
 await f.recycle.restore(record.id);assert.equal(f.docs.list()[0].id,f.doc.id);assert.equal(f.docs.annotations(f.doc.id)[0].id,f.note.id)
 assert.equal(f.links.list('project',f.project.id)[0].missing,false)
})
test('选定源文件进入回收站；原路径重名不覆盖，另选位置恢复同一资料',async t=>{
 const f=await fixture(t),record=await f.recycle.remove(await f.recycle.plan(f.doc.id,[f.source]))
 assert.equal(record.state,'recycled');assert.ok(!existsSync(f.source));assert.ok(existsSync(record.files[0].stored))
 assert.equal(record.expiresAt,new Date(2028,1,29,12,30).getTime())
 await fs.writeFile(f.source,'后来放入的文件');await assert.rejects(f.recycle.restore(record.id),/占用/)
 assert.equal(await fs.readFile(f.source,'utf8'),'后来放入的文件')
 const target=path.join(f.root,'恢复资料.txt');await f.recycle.restore(record.id,{[f.source]:target})
 assert.equal(f.docs.require(f.doc.id).path,target);assert.equal(await fs.readFile(target,'utf8'),'留住证据');assert.equal(f.docs.annotations(f.doc.id)[0].id,f.note.id)
})
test('自然月到期仅清理登记且校验未变化的文件，失败可重试',async t=>{
 const f=await fixture(t),record=await f.recycle.remove(await f.recycle.plan(f.doc.id,[f.source]))
 const loose=path.join(f.data,'回收站','手动放入.txt');await fs.writeFile(loose,'不属于抱一回收记录')
 f.setNow(record.expiresAt-1);await f.recycle.cleanup();assert.ok(existsSync(record.files[0].stored))
 f.setNow(record.expiresAt+1);await f.recycle.cleanup();assert.ok(!existsSync(record.files[0].stored));assert.ok(existsSync(loose));assert.equal(f.recycle.list()[0].state,'purged')
 assert.equal(f.addCalendarMonth(new Date(2027,0,31,10).getTime()),new Date(2027,1,28,10).getTime())
 assert.equal(f.addCalendarMonth(new Date(2027,11,31,10).getTime()),new Date(2028,0,31,10).getTime())
})
test('预览后文件变化、被替换回收文件和目录链接均不得删除',async t=>{
 const f=await fixture(t),plan=await f.recycle.plan(f.doc.id,[f.source]);await fs.writeFile(f.source,'新版本')
 await assert.rejects(f.recycle.remove(plan),/变化/);assert.ok(existsSync(f.source));assert.equal(f.docs.list().length,1)
 const record=await f.recycle.remove(await f.recycle.plan(f.doc.id,[f.source]));await fs.writeFile(record.files[0].stored,'替换内容');f.setNow(record.expiresAt+1)
 await f.recycle.cleanup();assert.equal(await fs.readFile(record.files[0].stored,'utf8'),'替换内容');assert.ok(f.recycle.list()[0].error)
})
test('恢复失败后即使到期也保留回收副本供再次恢复',async t=>{
 const f=await fixture(t),record=await f.recycle.remove(await f.recycle.plan(f.doc.id,[f.source]))
 await fs.writeFile(f.source,'占用文件');await assert.rejects(f.recycle.restore(record.id),/占用/)
 f.setNow(record.expiresAt+1);await f.recycle.cleanup()
 assert.ok(existsSync(record.files[0].stored),'恢复中断的副本不可被自动清理')
})
test('回收备份拒绝行与载荷编号不一致和目录外文件',async t=>{
 const f=await fixture(t);await f.recycle.remove(await f.recycle.plan(f.doc.id,[f.source]))
 const backup=buildLibraryBackup(f.db),rows=(backup as any).tables.document_recycle
 const payload=JSON.parse(rows[0].payload);payload.documentId='forged';rows[0].payload=JSON.stringify(payload)
 assert.throws(()=>restoreLibraryBackup(f.db,backup),/回收|recycle|ownership|disagree/)
})
