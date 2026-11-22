import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { ProjectLaunchProfiles,validateLaunchInput } from '../electron/kinds/project/launch-profiles.ts'
import { buildLibraryBackup,restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { ProjectRunLog,detectPreviewUrl } from '../electron/kinds/project/run-log.ts'
import type { ProjectLaunchInput } from '../src/types/project-launch.ts'

function fixture(t:test.TestContext){
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  db.exec("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) VALUES('p','project','D:/synthetic/project','project',1,1); INSERT INTO project_meta(resource_id) VALUES('p');")
  t.after(()=>db.close());return {db,profiles:new ProjectLaunchProfiles(db)}
}
const input:ProjectLaunchInput={name:'开发服务',kind:'script',command:'npm',args:['run','dev'],cwd:'',source:'discovered',sourceRef:'package.json',port:null,url:'',enabled:true}
test('启动配置 CAS、信任撤销、备份恢复清信任，schema 27 兼容空配置',t=>{
  const {db,profiles}=fixture(t),first=profiles.save('p',input)
  profiles.trust('p',first.id,first.revision,'a'.repeat(64))
  assert.equal(profiles.get('p',first.id).trusted,true)
  const backup=buildLibraryBackup(db);restoreLibraryBackup(db,backup)
  assert.equal(profiles.get('p',first.id).trusted,false);assert.equal(profiles.get('p',first.id).trustStamp,'')
  profiles.trust('p',first.id,first.revision,'b'.repeat(64))
  const second=profiles.save('p',{...input,id:first.id,revision:first.revision,name:'调整后的服务'})
  assert.equal(second.trusted,false);assert.equal(second.revision,1)
  assert.throws(()=>profiles.save('p',{...input,id:first.id,revision:first.revision}),/变化/)
  assert.throws(()=>profiles.remove('p',first.id,first.revision),/变化/)
  assert.throws(()=>profiles.get('other',first.id),/项目/)
  const old=structuredClone(backup) as any;old.schema_version=27;delete old.tables.project_launch_profiles;restoreLibraryBackup(db,old)
  assert.deepEqual(profiles.list('p'),[])
})
test('相对工作目录、参数与回环预览约束',()=>{
  for(const cwd of ['../secret','C:\\project','/tmp','a/../../b'])assert.throws(()=>validateLaunchInput({...input,cwd}),/相对路径/)
  for(const url of ['file:///C:/x','https://example.com','http://localhost.evil:8000','http://user:pw@127.0.0.1:80'])assert.throws(()=>validateLaunchInput({...input,url}),/预览/)
  assert.deepEqual(validateLaunchInput({...input,command:'node',args:['a b.cjs','a&b','quote"value']} ).args,['a b.cjs','a&b','quote"value'])
})
test('Vite 动态端口跨 chunk/ANSI/UTF-8 正确识别；中途部分端口不发布',()=>{
  const log=new ProjectRunLog(),line=Buffer.from('\x1b[32m➜\x1b[0m  Local: http://localhost:5173/\n')
  log.feed(line.subarray(0,2));log.feed(line.subarray(2,line.length-3));assert.equal(log.previewUrl,'')
  log.feed(line.subarray(line.length-3));assert.equal(log.previewUrl,'http://localhost:5173/')
  assert.ok(log.lines[0].includes('➜'));assert.ok(!log.lines[0].includes('\x1b'))
  log.feed(Buffer.from('Server running on port 4321\n'));assert.equal(log.previewUrl,'http://127.0.0.1:4321/')
  assert.equal(detectPreviewUrl('Network: http://192.168.1.10:5173/'),null)
  assert.equal(detectPreviewUrl('Local: http://0.0.0.0:8080/app/'),'http://127.0.0.1:8080/app/')
  assert.equal(detectPreviewUrl('port: 99999'),null)
  log.feed(Buffer.from(Array.from({length:40},(_,i)=>`line ${i}\n`).join('')));assert.equal(log.lines.length,20)
})
