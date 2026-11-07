import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ProjectLibrary } from '../electron/kinds/project/library.ts'
import { projectEntry, inspectProject } from '../electron/kinds/project/scanner.ts'
import { projectOverview,discoverProjectScripts,resolveProjectFile,readProjectTextPage,listProjectFilesPage } from '../electron/kinds/project/workspace.ts'
import { projectPreferences } from '../electron/kinds/project/agent.ts'
import {filterProjects} from '../src/utils/project-view.ts'
import {projectTerminalLaunch} from '../electron/kinds/project/terminal.ts'

async function fixture(t:test.TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-workbench-'))
  t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-workbench-')));await fs.rm(root,{recursive:true,force:true})})
  return root
}
function database(t:test.TestContext) {const db=new DatabaseSync(':memory:');initSchema(db,KINDS);t.after(()=>db.close());return db}

test('超过目录预览上限仍能发现 package 脚本并标注完整目录数量',async t=>{
  const root=await fixture(t)
  for(let i=0;i<165;i++)await fs.mkdir(path.join(root,'dir-'+i))
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({packageManager:'pnpm@9.0.0',scripts:{dev:'vite'}}))
  const overview=await projectOverview(root)
  assert.equal(overview.scripts[0]?.name,'dev','不能根据截断的目录预览判断 package.json 不存在')
  assert.equal(overview.totalFiles,166)
  assert.equal(overview.scripts[0]?.runCommand,'pnpm run dev')
})

test('默认栏目兼容旧偏好，拒绝无效栏目且保留先前配置',t=>{
  const db=database(t),preferences=projectPreferences(db)
  assert.equal(preferences.defaultTab,'timeline')
  const next=projectPreferences(db,{...preferences,defaultTab:'overview'})
  assert.equal(next.defaultTab,'overview')
  assert.throws(()=>projectPreferences(db,{...next,defaultTab:'unknown' as any}),/栏目|偏好/)
  assert.equal(projectPreferences(db).defaultTab,'overview')
})

test('入口单项保存保留别的新增入口，并拒绝覆盖已变化的同一项',async t=>{
  const db=database(t),root=await fixture(t),library=new ProjectLibrary(db)
  const item=library.register(await inspectProject(root)),original=item.entries[0]
  assert.equal(typeof library.saveEntry,'function','入口编辑应使用单项修改接口')
  const added=projectEntry(path.join(root,'notes.md'))
  library.saveEntry(item.id,added)
  library.saveEntry(item.id,{...original,label:'自定义入口'},original)
  assert.ok(library.get(item.id)?.entries.some(e=>e.id===added.id))
  assert.throws(()=>library.saveEntry(item.id,{...original,label:'过期编辑'},original),/变化|更新/)
  assert.throws(()=>library.removeEntry(item.id,original.id,original),/变化|更新/)
  const current=library.get(item.id)!
  library.removeEntry(item.id,original.id,current.entries.find(e=>e.id===original.id)!)
  assert.equal(library.get(item.id)?.defaultEntryId,added.id)
  assert.ok(await fs.stat(root))
})

test('子目录命令发现区分管理器冲突、Makefile 目标和不安全名称，不执行代码',async t=>{
  const root=await fixture(t),child=path.join(root,'前端');await fs.mkdir(child)
  await fs.writeFile(path.join(child,'package.json'),JSON.stringify({scripts:{dev:'echo NEVER_EXECUTE','x&calc':'echo no'}}))
  await fs.writeFile(path.join(child,'pnpm-lock.yaml'),'');await fs.writeFile(path.join(child,'yarn.lock'),'')
  await fs.writeFile(path.join(child,'Makefile'),'.PHONY: serve check\nserve: ## start\n%.o: %.c\nunsafe;target: input\n$(NAME):\n\t@echo nothing')
  const result=await discoverProjectScripts(root,'前端')
  assert.ok(result.warnings.some(s=>s.includes('多种')))
  assert.equal(result.scripts.find(s=>s.name==='dev')?.runCommand,null)
  assert.deepEqual(result.scripts.filter(s=>s.source.endsWith('Makefile')).map(s=>s.name),['serve','check'])
  assert.ok(result.scripts.every(s=>s.cwd==='前端'))
  await fs.rm(path.join(child,'yarn.lock'))
  const resolved=await discoverProjectScripts(root,'前端')
  assert.equal(resolved.scripts.find(s=>s.name==='dev')?.runCommand,'pnpm run dev')
  assert.equal(resolved.scripts.find(s=>s.name==='x&calc')?.runCommand,null)
  await fs.writeFile(path.join(child,'package.json'),'broken')
  assert.ok((await discoverProjectScripts(root,'前端')).warnings.some(s=>s.includes('格式无效')))
})

test('浏览与打开使用同一项目范围，拒绝凭据、链接逃逸和失效文本续读',async t=>{
  const root=await fixture(t),outside=await fixture(t)
  await fs.writeFile(path.join(root,'.env'),'private')
  await fs.writeFile(path.join(root,'draft.md'),'汉字😀'.repeat(5000))
  await fs.symlink(outside,path.join(root,'elsewhere'),'junction')
  await assert.rejects(resolveProjectFile(root,'../outside'),/范围/)
  await assert.rejects(resolveProjectFile(root,'.env'),/敏感|凭据/)
  await assert.rejects(resolveProjectFile(root,'elsewhere'),/范围/)
  const listing=await listProjectFilesPage(root)
  assert.deepEqual(listing.files.map(f=>f.path),['draft.md'])
  const first=await readProjectTextPage(root,'draft.md');assert.ok(first.next)
  await fs.appendFile(path.join(root,'draft.md'),'changed')
  await assert.rejects(readProjectTextPage(root,'draft.md',1,first.next!),/失效/)
})

test('多词可跨名称、分组和入口匹配，位置筛选不更改已有记录',async t=>{
  const db=database(t),root=await fixture(t),library=new ProjectLibrary(db)
  const a=library.register(await inspectProject(root));library.update(a.id,{name:'资料研究',group:'工作',pinned:true})
  const other=await fixture(t),b=library.register(await inspectProject(other));library.update(b.id,{name:'资料研究 2',group:'兴趣'})
  const items=library.list(),filters={search:'资料 工作',category:'',group:'',source:'',state:'',pinned:false,availability:'',sort:'name'}
  assert.deepEqual(filterProjects(items,filters).map(p=>p.id),[a.id])
  assert.deepEqual(filterProjects(items,{...filters,search:'',availability:'missing'}),[])
  assert.equal(library.list().length,2)
})

test('终端目录作为 PowerShell 字面量传递，空格引号与特殊字符不成为命令',()=>{
  const cwd="D:\\work space\\单引号'与$变量&分号;"
  const launch=projectTerminalLaunch(cwd,'C:\\Windows')
  const decoded=Buffer.from(launch.args.at(-1)!,'base64').toString('utf16le')
  assert.match(decoded,/-WorkingDirectory 'D:\\work space\\单引号''与\$变量&分号;'/)
  assert.match(decoded,/-WindowStyle Normal -PassThru/)
  assert.deepEqual(launch.args.slice(0,-1),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand'])
  assert.throws(()=>projectTerminalLaunch('relative','C:\\Windows'),/工作目录/)
})
