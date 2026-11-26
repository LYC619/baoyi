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
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {WorkspaceLinks} from '../electron/workspace/links.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {buildLibraryBackup,restoreLibraryBackup} from '../electron/services/storage/library-backup.ts'

async function fixture(t:any){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-document-files-')),db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
  t.after(async()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
  const projectDir=path.join(root,'project');await fs.mkdir(projectDir)
  const project=new ProjectLibrary(db).register({path:projectDir,name:'附件样本',summary:'',category:'其他',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  return {root,db,project,docs:new DocumentLibrary(db),links:new WorkspaceLinks(db)}
}
async function service(db:any){assert.ok(existsSync('electron/workspace/document-files.ts'),'需要有日志和校验的资料文件服务');return new (await import('../electron/workspace/document-files.ts')).DocumentFiles(db)}
test('Windows 文件身份不依赖 Node 版本变化的 dev 字段',async()=>{
 if(process.platform!=='win32')return
 const {fileIdentity}=await import('../electron/workspace/document-files.ts')
 assert.equal(fileIdentity({dev:0,ino:12345,birthtimeMs:1000}),fileIdentity({dev:87654,ino:12345,birthtimeMs:1000}))
})
test('跨卷移动中断后核验恢复，保留原资料与标注',async t=>{
 const {root,db,project,docs}=await fixture(t),files=await service(db)
 const base=path.resolve('output/agent-revision');await fs.mkdir(base,{recursive:true});const destinationRoot=await fs.mkdtemp(path.join(base,'cross-volume-'))
 t.after(async()=>{assert.equal(path.dirname(destinationRoot),base);await fs.rm(destinationRoot,{recursive:true,force:true})})
 if(path.parse(root).root.toLowerCase()===path.parse(destinationRoot).root.toLowerCase()){t.skip('需要两个文件卷');return}
 const source=path.join(root,'cross-volume.txt'),target=path.join(destinationRoot,'copied.txt');await fs.writeFile(source,'跨盘原始内容')
 const doc=await docs.register(source),note=docs.annotate(doc.id,{kind:'excerpt',quote:'原始',note:'',location:{page:1,offset:0}})
 await assert.rejects(files.execute(await files.plan(project.id,source,'move',target),{afterCopy:()=>{throw new Error('跨盘中断')}}),/中断/)
 assert.ok(existsSync(source));assert.ok(existsSync(target));await files.recover(files.operations()[0].id)
 assert.ok(!existsSync(source));assert.equal(docs.require(doc.id).path,target);assert.equal(docs.annotations(doc.id)[0].id,note.id)
})
test('项目链接、复制和移动沿用同一资料，副本与标注来源保持一致',async t=>{
  const {root,db,project,docs,links}=await fixture(t),files=await service(db),source=path.join(root,'source.txt');await fs.writeFile(source,'原文证据')
  const linked=await files.execute(await files.plan(project.id,source,'link'))
  const doc=docs.require(linked.documentId),note=docs.annotate(doc.id,{kind:'excerpt',quote:'证据',note:'',location:{page:1,offset:0}})
  links.add('project',project.id,doc.id,note.id)
  const copy=path.join(project.path,'copy.txt');await files.execute(await files.plan(project.id,source,'copy',copy))
  assert.equal(await fs.readFile(copy,'utf8'),'原文证据');assert.equal(await fs.readFile(source,'utf8'),'原文证据')
  assert.equal((await docs.register(copy)).id,doc.id,'登记副本不能生成第二份元数据')
  const moved=path.join(project.path,'moved.txt');await files.execute(await files.plan(project.id,source,'move',moved))
  assert.equal(existsSync(source),false);assert.equal(docs.require(doc.id).path,moved);assert.equal(docs.annotations(doc.id)[0].id,note.id)
  assert.equal(files.locations(doc.id).length,2);assert.ok(links.list('project',project.id).every(l=>l.resourceId===doc.id&&!l.missing))
  await fs.unlink(moved);assert.equal(docs.require(doc.id).available,true,'主文件缺失时仍能使用已登记副本');assert.equal(docs.require(doc.id).path,copy)
  assert.ok(links.list('project',project.id).every(l=>!l.missing&&l.path===copy),'项目引用应使用同一可用副本')
  assert.equal((await docs.scan([copy])).items[0].existing,true)
  db.exec(VIDEO_JOBS_SQL);const backup=buildLibraryBackup(db);restoreLibraryBackup(db,backup)
  assert.equal(files.locations(doc.id).length,2);assert.equal(docs.annotations(doc.id)[0].id,note.id)
})
test('目标冲突和预览后源文件变化不得覆盖文件；中断复制可核验后恢复',async t=>{
  const {root,db,project}=await fixture(t),files=await service(db),source=path.join(root,'a.txt'),target=path.join(project.path,'a.txt');await fs.writeFile(source,'保留原文')
  const plan=await files.plan(project.id,source,'move',target);await fs.writeFile(target,'目标已有文件')
  await assert.rejects(files.execute(plan),/存在|冲突/);assert.equal(await fs.readFile(target,'utf8'),'目标已有文件');assert.ok(existsSync(source))
  await fs.unlink(target);const stale=await files.plan(project.id,source,'move',target);await fs.writeFile(source,'预览后的改动');await assert.rejects(files.execute(stale),/变化/);assert.ok(!existsSync(target))
  const fresh=await files.plan(project.id,source,'move',target)
  await assert.rejects(files.execute(fresh,{afterCopy:()=>{throw new Error('模拟断电')}}),/模拟断电/)
  assert.ok(existsSync(source));assert.ok(existsSync(target));const record=files.operations()[0];assert.equal(record.state,'attention')
  const restored=await files.recover(record.id);assert.equal(restored.state,'done');assert.ok(!existsSync(source));assert.equal(await fs.readFile(target,'utf8'),'预览后的改动')
  assert.equal((await files.recover(record.id)).state,'done','恢复必须幂等')
})
test('中断后的源或目标被替换时恢复保留双方文件',async t=>{
  const {root,db,project}=await fixture(t),files=await service(db),source=path.join(root,'a.txt'),target=path.join(project.path,'a.txt');await fs.writeFile(source,'原始版本')
  await assert.rejects(files.execute(await files.plan(project.id,source,'move',target),{afterCopy:()=>{throw new Error('中断')}}),/中断/)
  const record=files.operations()[0];await fs.writeFile(source,'源文件新内容')
  await assert.rejects(files.recover(record.id),/变化/);assert.equal(await fs.readFile(source,'utf8'),'源文件新内容')
  await fs.writeFile(target,'目标文件新内容');await assert.rejects(files.recover(record.id),/变化/);assert.equal(await fs.readFile(target,'utf8'),'目标文件新内容')
})
test('复制开始前中断且目标尚未生成时可以重试完成',async t=>{
 const {root,db,project}=await fixture(t),files=await service(db),source=path.join(root,'source.txt'),target=path.join(project.path,'target.txt');await fs.writeFile(source,'重试副本')
 await assert.rejects(files.execute(await files.plan(project.id,source,'move',target),{afterCopy:()=>{throw new Error('中断')}}),/中断/)
 const op=files.operations()[0];await fs.unlink(target);op.destinationIdentity='';op.state='prepared'
 db.prepare('UPDATE document_file_operations SET state=?,payload=? WHERE id=?').run(op.state,JSON.stringify(op),op.id)
 await files.recover(op.id);assert.ok(!existsSync(source));assert.equal(await fs.readFile(target,'utf8'),'重试副本')
})
test('未支持的附件可登记关联并外部打开，链接或目录穿越不得进入移动',async t=>{
  const {root,db,project,docs}=await fixture(t),files=await service(db),source=path.join(root,'package.bin');await fs.writeFile(source,'附件')
  const result=await files.execute(await files.plan(project.id,source,'link'));assert.equal(docs.require(result.documentId).format,'bin')
  await assert.rejects(docs.content(result.documentId),/外部|格式/)
  await assert.rejects(files.plan(project.id,source,'move',source),/自身|相同/)
  const alias=path.join(root,'alias');await fs.symlink(project.path,alias,'junction')
  await assert.rejects(files.plan(project.id,source,'copy',path.join(alias,'copy.bin')),/实际|链接/)
})
