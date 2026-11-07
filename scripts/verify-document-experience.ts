import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { WorkspaceLinks } from '../electron/workspace/links.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'

test('阅读位置估算、真实阅读分组与标签统计', async () => {
  const { documentProgress, groupDocuments, tagCounts, projectCounts } = await import('../src/utils/document-library-view.ts')
  const a: any = { id:'a',name:'乙',readable:true,readState:'reading',pageCount:10,position:{page:6,offset:.8},lastReadAt:10,updatedAt:100,tags:['研究'] }
  assert.equal(documentProgress(a),58)
  assert.equal(documentProgress({...a,pageCount:0}),null)
  assert.equal(documentProgress({...a,readable:false}),null)
  assert.equal(documentProgress({...a,readState:'read'}),100)
  assert.equal(documentProgress({...a,position:{page:10,offset:1}}),99)
  assert.equal(documentProgress({...a,pageCount:1,position:{page:1,offset:0}}),0)
  assert.equal(documentProgress({...a,position:{page:NaN,offset:Infinity}}),0)
  const b={...a,id:'b',name:'甲',lastReadAt:20,updatedAt:1,tags:['研究','阅读']}
  assert.deepEqual(groupDocuments([a,b],'updated').recent.map(i=>i.id),['b','a'])
  assert.deepEqual(groupDocuments([a,b],'name').recent.map(i=>i.id),['b','a'], '切换排序保留最近在读')
  assert.deepEqual(groupDocuments([{...a,readState:'unread'},{...b,readState:'unread'}],'name').remaining.map(i=>i.id),['b','a'])
  const many=Array.from({length:8},(_,i)=>({...a,id:String(i),lastReadAt:i+1}))
  assert.equal(groupDocuments(many,'updated').recent.length,6)
  assert.equal(groupDocuments(many,'updated').remaining.length,2)
  assert.deepEqual(tagCounts([a,b]),[{name:'研究',count:2},{name:'阅读',count:1}])
  assert.equal(projectCounts([{documentId:'a',projectId:'p'},{documentId:'a',projectId:'p'},{documentId:'a',projectId:'q'}] as any).get('a'),2)
})

test('lastReadAt 不随编辑变化，项目及事件引用去重并精确区分摘录', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-experience-'))
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
  t.after(async()=>{db.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true})})
  const docs=new DocumentLibrary(db),links=new WorkspaceLinks(db),projects=new ProjectLibrary(db),timeline=new TimelineLibrary(db)
  const file=path.join(root,'source.txt');await fs.writeFile(file,'Reading source')
  const doc=await docs.register(file,'book'),second=path.join(root,'second.txt');await fs.writeFile(second,'Other')
  const other=await docs.register(second)
  assert.equal(doc.lastReadAt,0)
  docs.savePosition(doc.id,{page:6,offset:.8},10)
  const readAt=docs.require(doc.id).lastReadAt;assert.ok(readAt>0)
  docs.update(doc.id,{name:'Edited'});assert.equal(docs.require(doc.id).lastReadAt,readAt)
  const register=(name:string)=>projects.register({path:root,name,summary:'',category:'调研写作',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  const p=register('项目 A');const dir=path.join(root,'b');await fs.mkdir(dir)
  const q=projects.register({path:dir,name:'项目 B',summary:'',category:'调研写作',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  const event=timeline.save(p.id,{title:'事件',body:'',occurredAt:Date.now(),milestone:false,version:''})
  const mark=docs.annotate(doc.id,{kind:'excerpt',quote:'Reading',note:'',location:{page:1,offset:0}})
  const mark2=docs.annotate(doc.id,{kind:'excerpt',quote:'source',note:'',location:{page:1,offset:0}})
  const link=links.add('project',p.id,doc.id,mark.id);assert.equal(links.add('project',p.id,doc.id,mark.id).id,link.id)
  links.add('event',event.id,doc.id,mark.id);links.add('project',p.id,doc.id,mark2.id);links.add('project',q.id,doc.id)
  const skill=new PersonalLibrary(db).save({kind:'skill',name:'技能',body:'',data:{}});links.add('skill',skill.id,doc.id)
  assert.equal(typeof links.projectReferences,'function')
  let refs=links.projectReferences([doc.id,doc.id]);assert.equal(refs.length,4)
  assert.equal(new Set(refs.map(r=>r.projectId)).size,2)
  assert.equal(refs.filter(r=>r.annotationId===mark.id).length,2)
  assert.equal(refs.filter(r=>r.annotationId===mark2.id).length,1)
  assert.deepEqual(links.projectReferences([]),[])
  assert.throws(()=>links.projectReferences('bad' as any))
  assert.throws(()=>links.projectReferences(Array(501).fill(doc.id)))
  assert.throws(()=>links.add('project',p.id,other.id,mark.id))
  db.prepare('DELETE FROM resource WHERE id=?').run(p.id)
  refs=links.projectReferences([doc.id]);assert.equal(refs.length,1);assert.equal(refs[0].projectId,q.id)
  assert.throws(()=>links.add('project',p.id,doc.id,mark.id))
  docs.remove(doc.id);assert.deepEqual(links.projectReferences([doc.id]),[])
})
