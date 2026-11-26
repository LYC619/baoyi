import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLaunchProfiles } from '../electron/kinds/project/launch-profiles.ts'
import { previewProjectLaunch,projectChildEnvironment,resolveProjectLauncher } from '../electron/kinds/project/launch-resolution.ts'
import { ProjectRuns } from '../electron/kinds/project/runs.ts'
import type { ProjectRun } from '../src/types/project-launch.ts'

async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw new Error('Timed out waiting for run');await delay(40)}}
test('真实受控 HTTP 服务：确认、重复点击去重、动态端口、停止、上次重跑及源变撤销信任',async t=>{
  const root=path.resolve('output/p1-p2-project-2026-11-06/fixtures');await fs.mkdir(root,{recursive:true})
  const dir=await fs.mkdtemp(path.join(root,'runs-')),project=path.join(dir,"中文 & 项目 ' 测试");await fs.mkdir(project)
  const script=path.join(project,'server.cjs')
  await fs.writeFile(script,"const http=require('node:http');const s=http.createServer((q,r)=>r.end('synthetic'));s.listen(0,'127.0.0.1',()=>console.log('Local: http://localhost:'+s.address().port+'/'));process.on('SIGBREAK',()=>s.close(()=>process.exit(0)));console.log('secret inherited: '+Boolean(process.env.BAOYI_FIXTURE_SECRET));")
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  db.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at) VALUES('p','project',?,'fixture',1,1)").run(project);db.exec("INSERT INTO project_meta(resource_id) VALUES('p')")
  const profiles=new ProjectLaunchProfiles(db),profile=profiles.save('p',{name:'本机服务',kind:'script',command:process.execPath,args:['server.cjs'],source:'manual',sourceRef:'server.cjs',cwd:'',port:null,url:'',enabled:true})
  const events:ProjectRun[]=[],options={db:()=>db,directory:path.join(dir,'state'),python:path.resolve('output/hermes-runtime/python/python.exe'),supervisor:path.resolve('resources/project-runner/supervisor.py'),changed:(run:ProjectRun)=>events.push(run)},runs=new ProjectRuns(options)
  t.after(async()=>{await runs.stopAll();db.close();await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2))})
  process.env.BAOYI_FIXTURE_SECRET='synthetic-only';t.after(()=>delete process.env.BAOYI_FIXTURE_SECRET)
  const preview=await previewProjectLaunch(db,'p',profile.id);assert.equal(preview.trusted,false)
  await assert.rejects(()=>runs.start('p',profile.id),/确认/)
  const [one,two]=await Promise.all([runs.start('p',profile.id,{stamp:preview.stamp,remember:true}),runs.start('p',profile.id,{stamp:preview.stamp,remember:true})])
  assert.equal(one.id,two.id)
  await until(()=>events.some(e=>!!e.previewUrl))
  const url=events.findLast(e=>e.previewUrl)!.previewUrl
  const response=await fetch(url,{signal:AbortSignal.timeout(2000)});assert.equal(await response.text(),'synthetic')
  await runs.stop(one.id);const last=await runs.last('p');assert.equal(last?.status,'exited');assert.ok(last?.lines.includes('secret inherited: false'))
  await assert.rejects(()=>fetch(url,{signal:AbortSignal.timeout(1000)}))
  assert.equal((await previewProjectLaunch(db,'p',profile.id)).trusted,true)
  const rerun=await runs.start('p',last!.profileId);assert.notEqual(rerun.id,last?.id);await runs.stop(rerun.id)
  await fs.appendFile(script,'\n// changed source\n');assert.equal((await previewProjectLaunch(db,'p',profile.id)).trusted,false)
  await assert.rejects(()=>runs.start('p',profile.id,{stamp:preview.stamp,remember:true}),/变化/)
  const restored=new ProjectRuns({...options,changed:()=>{}});assert.equal((await restored.last('p'))?.id,rerun.id)
})
test('开发子进程只继承必要环境；npm.cmd 解析为 Node 与真实 JS 入口',async()=>{
  const env=projectChildEnvironment({SystemRoot:'C:/Windows',PATH:'tools',OPENAI_API_KEY:'synthetic',BAOYI_API_KEY:'synthetic',SECRET:'synthetic'})
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.BAOYI_API_KEY,undefined);assert.equal(env.SECRET,undefined);assert.equal(env.PATH,'tools')
  const launch=await resolveProjectLauncher('npm',['run','dev'])
  assert.ok(launch.command.toLowerCase().endsWith('node.exe'));assert.ok(launch.args[0].endsWith('npm-cli.js'));assert.deepEqual(launch.args.slice(1),['run','dev'])
})
