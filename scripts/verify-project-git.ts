import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {ProjectGitCache,parseGitStatus} from '../electron/kinds/project/git-status.ts'
const exec=promisify(execFile)
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-git-status-'))
  t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-git-status-')));await fs.rm(root,{recursive:true,force:true})});return root
}
const git=(root:string,...args:string[])=>exec('git',['-C',root,...args],{windowsHide:true})
async function init(root:string){await fs.mkdir(root,{recursive:true});await git(root,'init','-b','main');await fs.writeFile(path.join(root,'原 文件.md'),'start');await git(root,'add','.');await git(root,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','fixture')}
test('NUL 状态解析正确计数改名、复制、中文与换行文件名',()=>{
  const value=parseGitStatus('R  新名\n文档.txt\0原名.txt\0 M normal.txt\0?? 中文 文件.md\0 C copy.txt\0old.txt\0')
  assert.equal(value.changed,4);assert.ok(value.status.includes('新名\\n文档'));assert.ok(value.status.includes('原名.txt'));assert.ok(!value.truncated)
})
test('真实 Git 改名只算一个，缓存30秒、主动刷新、detached 与取消',async t=>{
  const root=await fixture(t);await init(root);const cache=new ProjectGitCache()
  await git(root,'mv','原 文件.md','新 文件.md');const first=await cache.read(root)
  assert.equal(first.available,true);assert.equal(first.changed,1);assert.equal(first.branch,'main');assert.equal(first.head.length,40)
  await fs.writeFile(path.join(root,'extra.txt'),'next')
  assert.equal((await cache.read(root)).changed,1);assert.equal((await cache.read(root,{refresh:true})).changed,2)
  await git(root,'checkout','--detach');assert.match((await cache.read(root,{refresh:true})).branch,/^detached /)
  const controller=new AbortController();controller.abort();await assert.rejects(cache.read(root,{signal:controller.signal}))
  assert.ok(cache.peek(root));cache.clear();assert.equal(cache.peek(root),undefined)
})
test('不读取上级仓库；单子仓库自动选，多子仓库必须选；越界/链接拒绝',async t=>{
  const root=await fixture(t);await init(root);const project=path.join(root,'project');await fs.mkdir(project)
  const cache=new ProjectGitCache();assert.equal((await cache.read(project)).available,false)
  await init(path.join(project,'one'));let value=await cache.read(project,{refresh:true});assert.equal(value.repoPath,'one');assert.equal(value.available,true)
  await init(path.join(project,'two'));value=await cache.read(project,{refresh:true});assert.equal(value.available,false);assert.deepEqual(value.candidates.sort(),['one','two'])
  assert.equal((await cache.read(project,{repoPath:'two'})).repoPath,'two')
  assert.equal((await cache.read(project,{repoPath:'..'})).available,false)
  await fs.symlink(root,path.join(project,'link'),'junction');assert.equal((await cache.read(project,{repoPath:'link'})).available,false)
})
