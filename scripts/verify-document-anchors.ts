import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {WorkspaceLinks} from '../electron/workspace/links.ts'
import {PersonalLibrary} from '../electron/workspace/personal.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/storage/library-backup.ts'
test('文字范围区分重复句，更新后按上下文重定位；歧义不能伪造精确位置',async()=>{
  assert.ok(existsSync('src/utils/document-anchor.ts'),'需要持久文字范围与上下文锚点')
  const {makeTextAnchor,resolveTextAnchor}=await import('../src/utils/document-anchor.ts')
  const source='开头\n第一段：同一句话。\n第二段：同一句话。\n末尾',start=source.lastIndexOf('同一句话')
  const anchor=makeTextAnchor(source,start,start+5,'text')
  assert.deepEqual(resolveTextAnchor(source,anchor),{start,end:start+5,status:'exact'})
  assert.deepEqual(resolveTextAnchor('新增引言\n'+source,anchor),{start:start+5,end:start+10,status:'relocated'})
  assert.equal(resolveTextAnchor('同一句话。同一句话。',anchor),null)
  assert.equal(resolveTextAnchor('原句已经删除',anchor),null)
  assert.equal(resolveTextAnchor('同一句话。',undefined,'同一句话。')?.status,'relocated')
  assert.equal(resolveTextAnchor('同一句话。同一句话。',undefined,'同一句话。'),null)
})
test('锚点持久化、来源快照、备份恢复与旧数据迁移保留原资料编号',async t=>{
  assert.ok(existsSync('src/utils/document-anchor.ts'),'需要持久文字范围与上下文锚点')
  const {makeTextAnchor}=await import('../src/utils/document-anchor.ts')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-anchors-')),db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  t.after(async()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
  const docs=new DocumentLibrary(db),file=path.join(root,'source.txt');await fs.writeFile(file,'原文\n第二行')
  const doc=await docs.register(file),anchor=makeTextAnchor('原文\n第二行',0,6,'text')
  const note=docs.annotate(doc.id,{kind:'excerpt',quote:'原文\n第二',note:'想法',location:{page:1,offset:0,anchor}})
  assert.deepEqual(note.location.anchor,anchor)
  const owner=new PersonalLibrary(db).save({kind:'experience',name:'测试',body:'',data:{}}),links=new WorkspaceLinks(db),link=links.add('experience',owner.id,doc.id,note.id)
  assert.deepEqual(link.location?.anchor,anchor)
  const backup=buildLibraryBackup(db);restoreLibraryBackup(db,backup);assert.deepEqual(docs.annotations(doc.id)[0].location.anchor,anchor)
  docs.removeAnnotation(doc.id,note.id);assert.deepEqual(links.list('experience',owner.id)[0].location?.anchor,anchor)
  assert.throws(()=>docs.annotate(doc.id,{kind:'excerpt',quote:'无效',note:'',location:{page:1,offset:0,anchor:{...anchor,end:-1}}}),/锚点|范围/)
  const pdf={...anchor,kind:'pdf' as const,regions:[{x:.1,y:.2,width:.3,height:.02}]}
  assert.deepEqual(docs.annotate(doc.id,{kind:'excerpt',quote:'原文',note:'',location:{page:1,offset:0,anchor:pdf}}).location.anchor,pdf)
  assert.throws(()=>docs.annotate(doc.id,{kind:'excerpt',quote:'原文',note:'',location:{page:1,offset:0,anchor:{...pdf,regions:[{x:2,y:0,width:.1,height:.1}]}}}),/区域|锚点/)
  const multi={...pdf,pages:[{page:2,anchor:makeTextAnchor('第二页原句',0,5,'pdf')}]}
  const cross=docs.annotate(doc.id,{kind:'excerpt',quote:'原文\n第二页原句',note:'跨页',location:{page:1,offset:0,anchor:multi}})
  assert.deepEqual(cross.location.anchor,multi)
  const multiBackup=buildLibraryBackup(db);restoreLibraryBackup(db,multiBackup)
  assert.deepEqual(docs.annotations(doc.id).find(n=>n.id===cross.id)?.location.anchor,multi)
  for(const page of [1,0,2.5])assert.throws(()=>docs.annotate(doc.id,{kind:'excerpt',quote:'无效',note:'',location:{page:1,offset:0,anchor:{...multi,pages:[{page,anchor:multi.pages[0].anchor}]}}}),/页|锚点/)
  assert.throws(()=>docs.annotate(doc.id,{kind:'excerpt',quote:'无效',note:'',location:{page:1,offset:0,anchor:{...multi,pages:[{page:2,anchor:multi}]}}}),/页|锚点/)
  const legacy=structuredClone(backup) as any;legacy.schema_version=19;for(const row of legacy.tables.document_annotations)delete row.anchor
  restoreLibraryBackup(db,legacy);assert.equal(docs.annotations(doc.id)[0].location.anchor,undefined);assert.equal(docs.require(doc.id).id,doc.id)
})
