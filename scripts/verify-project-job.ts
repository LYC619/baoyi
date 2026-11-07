import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const root=path.resolve('output/p1-p2-project-2026-11-06/fixtures'),python=path.resolve('output/hermes-runtime/python/python.exe'),supervisor=path.resolve('resources/project-runner/supervisor.py')
const environment=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value&&/^(SystemRoot|WINDIR|PATH|TEMP|TMP|ComSpec|PATHEXT)$/i.test(key))) as Record<string,string>
async function until(condition:()=>boolean|Promise<boolean>,timeout=15000){const deadline=Date.now()+timeout;while(!await condition()){if(Date.now()>deadline)throw new Error('Timed out waiting for fixture process');await delay(30)}}
function alive(pid:number){try{process.kill(pid,0);return true}catch{return false}}
async function fixture(t:test.TestContext,mode:'tree'|'orphan'|'stubborn'){
  await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'job-'))
  await fs.writeFile(path.join(dir,'grandchild.cjs'),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(dir,'grandchild.pid'))},String(process.pid));process.on('SIGBREAK',()=>${mode==='stubborn'?'{}':'process.exit(0)'});setInterval(()=>{},100);`)
  await fs.writeFile(path.join(dir,'child.cjs'),`const {spawn}=require('node:child_process');const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(dir,'child.pid'))},String(process.pid));spawn(process.execPath,[${JSON.stringify(path.join(dir,'grandchild.cjs'))}],{stdio:'inherit',detached:${mode==='orphan'},windowsHide:true});${mode==='orphan'?'setTimeout(()=>process.exit(0),200);':`process.on('SIGBREAK',()=>${mode==='stubborn'?'{}':'process.exit(0)'});setInterval(()=>{},100);`}`)
  await fs.writeFile(path.join(dir,'parent.cjs'),`const {spawn}=require('node:child_process');spawn(process.execPath,[${JSON.stringify(path.join(dir,'child.cjs'))}],{stdio:'inherit',detached:${mode==='orphan'},windowsHide:true});console.log('synthetic 项目日志');${mode==='orphan'?'setTimeout(()=>process.exit(0),500);':`process.on('SIGBREAK',()=>${mode==='stubborn'?'{}':'process.exit(0)'});setInterval(()=>{},100);`}`)
  const runner:ChildProcessWithoutNullStreams=spawn(python,['-I','-S','-u',supervisor],{stdio:'pipe',windowsHide:true,env:environment})
  const events:any[]=[];let stderr='',closed=false
  runner.stderr.on('data',b=>stderr+=b);runner.on('close',()=>closed=true)
  const lines=createInterface({input:runner.stdout});lines.on('line',line=>events.push(JSON.parse(line)))
  runner.stdin.write(JSON.stringify({version:1,command:process.execPath,args:[path.join(dir,'parent.cjs')],cwd:dir,env:environment})+'\n')
  t.after(async()=>{
    runner.stdin.destroy();if(!closed)await until(()=>closed,8000).catch(()=>runner.kill())
    await fs.writeFile(path.join(dir,'result.json'),JSON.stringify({mode,events,stderr,pids:await Promise.all(['child.pid','grandchild.pid'].map(async name=>({name,pid:await fs.readFile(path.join(dir,name),'utf8').catch(()=>'')})))},null,2))
  })
  await until(()=>events.some(e=>e.type==='started')||events.some(e=>e.type==='error')||closed)
  assert.equal(events.find(e=>e.type==='error')?.message,undefined,JSON.stringify(events)+' '+stderr)
  await until(async()=>{try{await fs.stat(path.join(dir,'grandchild.pid'));return true}catch{return false}})
  const pids=[events.find(e=>e.type==='started').pid,Number(await fs.readFile(path.join(dir,'child.pid'),'utf8')),Number(await fs.readFile(path.join(dir,'grandchild.pid'),'utf8'))]
  return {runner,events,pids,closed:()=>closed}
}
test('Windows Job 停止真实父/子/孙进程，独立进程继续存活',async t=>{
  const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,env:environment})
  t.after(()=>other.kill())
  const {runner,pids,events}=await fixture(t,'tree');assert.ok(pids.every(alive))
  runner.stdin.write('{"type":"stop"}\n')
  await until(()=>pids.every(pid=>!alive(pid)))
  assert.ok(alive(other.pid!));await until(()=>events.some(e=>e.type==='exited'))
  assert.ok(events.some(e=>e.type==='stopping'&&e.graceful===true),'正常停止应成功发送 console break')
})
test('初始父进程已退出仍管理孙进程，停止不依赖旧 PID',async t=>{
  const {runner,pids,events}=await fixture(t,'orphan')
  await until(()=>!alive(pids[0])&&!alive(pids[1]));assert.ok(alive(pids[2]),JSON.stringify({pids,events}));assert.ok(!events.some(e=>e.type==='exited'))
  runner.stdin.write('{"type":"stop"}\n');await until(()=>!alive(pids[2]))
})
test('拒绝正常停止的进程在五秒后结束；关闭 supervisor 句柄也清理 Job',async t=>{
  const {runner,pids,events}=await fixture(t,'stubborn'),started=Date.now()
  runner.stdin.write('{"type":"stop"}\n');await until(()=>pids.every(pid=>!alive(pid)))
  assert.ok(Date.now()-started>=4900);assert.ok(events.some(e=>e.type==='stopping'))
  const second=await fixture(t,'stubborn');second.runner.kill();await until(()=>second.pids.every(pid=>!alive(pid)))
})
