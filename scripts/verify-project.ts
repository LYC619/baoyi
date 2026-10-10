import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

test('项目扫描识别用途、候选边界和多种入口，且不执行脚本', async () => {
  const { scanProjects } = await import('../electron/kinds/project/scanner.ts')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-project-scan-'))
  try {
    const code = path.join(root, '工具'), report = path.join(root, '调研'), loose = path.join(root, '素材')
    await fs.mkdir(code); await fs.mkdir(report); await fs.mkdir(loose)
    await fs.writeFile(path.join(code, 'package.json'), JSON.stringify({ name:'arc',description:'写作工具',version:'1.2',scripts:{dev:'echo nope'} }))
    await fs.writeFile(path.join(code, 'README.md'), '# Arc\n\n写作工具说明。')
    await fs.writeFile(path.join(code, '启动.bat'), '@echo off\necho must not run')
    await fs.mkdir(path.join(report,'.git')); await fs.writeFile(path.join(report,'项目目录说明.md'),'# 要报\n\n正文草稿.docx：提交版。')
    await fs.writeFile(path.join(report,'正文草稿.docx'),'test'); await fs.writeFile(path.join(report,'图表.py'),'# helper')
    await fs.writeFile(path.join(loose,'photo.png'),'x'); await fs.writeFile(path.join(root,'诗词.md'),'# 诗词'); await fs.writeFile(path.join(root,'处理.py'),'# must not run')
    const candidates = await scanProjects(root,'discover')
    assert.equal(candidates.find(c=>c.path===code)?.category,'软件项目')
    assert.equal(candidates.find(c=>c.path===report)?.category,'调研写作')
    assert.equal(candidates.find(c=>c.path===loose)?.suggested,false)
    assert.ok(candidates.find(c=>c.path===code)?.entries.some(e=>e.path.endsWith('.bat')))
    assert.ok(candidates.some(c=>c.path.endsWith('诗词.md')))
    assert.ok(candidates.some(c=>c.path.endsWith('处理.py')))
    assert.equal((await scanProjects(code,'single')).length,1)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('项目入库保留人工字段、备份关系和入口校验', async () => {
  const { ProjectLibrary } = await import('../electron/kinds/project/library.ts')
  const { scanProjects } = await import('../electron/kinds/project/scanner.ts')
  const db = new DatabaseSync(':memory:'); initSchema(db,KINDS)
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-db-'))
  try {
    const library = new ProjectLibrary(db), [scan] = await scanProjects(root,'single')
    const item = library.register(scan)
    library.update(item.id,{name:'我的名字',pinned:true,source:'self',group:'工作'})
    assert.equal(library.register({...scan,name:'扫描名'}).name,'我的名字')
    assert.equal(library.get(item.id)?.pinned,true)
    assert.throws(()=>library.update(item.id,{defaultEntryId:'missing'}),/入口/)
    library.remove(item.id)
    assert.equal(library.list().length,0)
    assert.equal(await fs.stat(root).then(s=>s.isDirectory()),true)
  } finally { db.close(); await fs.rm(root,{recursive:true,force:true}) }
})

test('移动更新项目和关联软件路径，外部参考保持原位，可保留旧入口', async () => {
  const { ProjectLibrary } = await import('../electron/kinds/project/library.ts')
  const { scanProjects } = await import('../electron/kinds/project/scanner.ts')
  const { planProjectMove, executeProjectMove } = await import('../electron/kinds/project/move.ts')
  const db = new DatabaseSync(':memory:'); initSchema(db,KINDS)
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-move-'))
  try {
    const source=path.join(base,'old'),target=path.join(base,'new'); await fs.mkdir(source)
    await fs.writeFile(path.join(source,'README.md'),'# Test')
    const library=new ProjectLibrary(db),item=library.register((await scanProjects(source,'single'))[0])
    db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name) VALUES('s','software',1,1,?,'app.exe')").run(path.join(source,'app.exe'))
    db.prepare("INSERT INTO software_meta(resource_id,launchers) VALUES('s',?)").run(JSON.stringify([{path:path.join(source,'app.exe')}]))
    const plan=await planProjectMove(db,item.id,target,{keepLink:true})
    await executeProjectMove(db,plan,{journalDir:path.join(base,'journals')})
    assert.equal(library.get(item.id)?.path,target)
    assert.equal((db.prepare("SELECT path FROM resource WHERE id='s'").get() as any).path,path.join(target,'app.exe'))
    assert.equal(await fs.readFile(path.join(source,'README.md'),'utf8'),'# Test')
    assert.equal((await fs.lstat(source)).isSymbolicLink(),true)
    assert.ok(library.get(item.id)!.entries.every(e=>e.path.startsWith(target)))
  } finally { db.close(); await fs.rm(base,{recursive:true,force:true}) }
})

test('数据库提交失败时同卷文件回退；跨卷失败保留原件及恢复记录', async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {planProjectMove,executeProjectMove,projectMoveRecords,recoverProjectMove}=await import('../electron/kinds/project/move.ts')
  for(const copy of [false,true]){
    const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
    const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-rollback-'))
    try{
      const source=path.join(base,'source'),target=path.join(base,'target'),journalDir=path.join(base,'journals');await fs.mkdir(source);await fs.writeFile(path.join(source,'notes.md'),'valuable')
      const lib=new ProjectLibrary(db),item=lib.register((await scanProjects(source,'single'))[0]),plan=await planProjectMove(db,item.id,target,{keepLink:false})
      await assert.rejects(executeProjectMove(db,plan,{journalDir,beforeCommit:()=>{throw new Error('injected db failure')},...(copy?{rename:async()=>{throw Object.assign(new Error('cross device'),{code:'EXDEV'})}}:{})}),/injected/)
      assert.equal(lib.get(item.id)?.path,source);assert.equal(await fs.readFile(path.join(source,'notes.md'),'utf8'),'valuable')
      const [record]=await projectMoveRecords(journalDir);assert.ok(record)
      if(copy){assert.equal(await fs.readFile(path.join(target,'notes.md'),'utf8'),'valuable');await recoverProjectMove(db,journalDir,record.id);assert.equal((await projectMoveRecords(journalDir))[0].phase,'rolled-back')}
      else assert.equal(await fs.stat(target).catch(()=>null),null)
    }finally{db.close();await fs.rm(base,{recursive:true,force:true})}
  }
})

test('跨卷核验保留符号链接且回收后建立旧入口', async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {planProjectMove,executeProjectMove}=await import('../electron/kinds/project/move.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-copy-'))
  try{
    const source=path.join(base,'source'),target=path.join(base,'target'),external=path.join(base,'external');await fs.mkdir(source);await fs.mkdir(external);await fs.writeFile(path.join(external,'kept.txt'),'external');await fs.writeFile(path.join(source,'notes.md'),'valuable');await fs.symlink(external,path.join(source,'linked'),'junction')
    const lib=new ProjectLibrary(db),item=lib.register((await scanProjects(source,'single'))[0]),plan=await planProjectMove(db,item.id,target,{keepLink:true})
    await executeProjectMove(db,plan,{journalDir:path.join(base,'journal'),rename:async()=>{throw Object.assign(new Error('cross device'),{code:'EXDEV'})},trash:async file=>fs.rename(file,path.join(base,'recycled'))})
    assert.equal(lib.get(item.id)?.path,target);assert.equal(await fs.readFile(path.join(source,'notes.md'),'utf8'),'valuable');assert.equal(await fs.readFile(path.join(external,'kept.txt'),'utf8'),'external');assert.equal((await fs.lstat(path.join(target,'linked'))).isSymbolicLink(),true)
  }finally{db.close();await fs.rm(base,{recursive:true,force:true})}
})

test('项目备份恢复包含入口，兼容 v13 且重置级联清空项目元数据',async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {buildLibraryBackup,restoreLibraryBackup}=await import('../electron/services/library-backup.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL)
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-backup-'))
  try{
    const lib=new ProjectLibrary(db),item=lib.register((await scanProjects(root,'single'))[0]);lib.update(item.id,{source:'third-party',group:'测试'})
    const backup=buildLibraryBackup(db);assert.equal(backup.tables.project_meta.length,1)
    lib.remove(item.id);restoreLibraryBackup(db,backup);assert.equal(lib.get(item.id)?.source,'third-party')
    const invalid=structuredClone(backup);invalid.tables.project_meta[0].default_entry='nonexistent';assert.throws(()=>restoreLibraryBackup(db,invalid),/entry/);assert.equal(lib.get(item.id)?.group,'测试')
    db.exec('DELETE FROM resource');assert.equal((db.prepare('SELECT count(*) n FROM project_meta').get() as any).n,0)
    const legacy:any=buildLibraryBackup(db);legacy.schema_version=13;delete legacy.tables.project_meta;restoreLibraryBackup(db,legacy);assert.equal(lib.list().length,0)
  }finally{db.close();await fs.rm(root,{recursive:true,force:true})}
})

test('移动拒绝碰撞、自包含路径及 Git 外部工作树', async () => {
  const { ProjectLibrary } = await import('../electron/kinds/project/library.ts')
  const { scanProjects } = await import('../electron/kinds/project/scanner.ts')
  const { planProjectMove } = await import('../electron/kinds/project/move.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-guard-'))
  try {
    const source=path.join(base,'source'),target=path.join(base,'target');await fs.mkdir(source);await fs.mkdir(target)
    const item=new ProjectLibrary(db).register((await scanProjects(source,'single'))[0])
    await assert.rejects(planProjectMove(db,item.id,target),/存在/)
    await assert.rejects(planProjectMove(db,item.id,path.join(source,'nested')),/子目录/)
    await fs.writeFile(path.join(source,'.git'),'gitdir: C:/elsewhere/worktree')
    await assert.rejects(planProjectMove(db,item.id,path.join(base,'safe')),/工作树/)
  } finally { db.close();await fs.rm(base,{recursive:true,force:true}) }
})


test('单文件移动保留内容、更新父目录，过期预览与变化源被拒绝', async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {planProjectMove,executeProjectMove}=await import('../electron/kinds/project/move.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-file-'))
  try{
    const source=path.join(base,'文稿.md'),parent=path.join(base,'sorted'),target=path.join(parent,'报告.md');await fs.mkdir(parent);await fs.writeFile(source,'正文内容')
    const lib=new ProjectLibrary(db),item=lib.register((await scanProjects(source,'single'))[0]),plan=await planProjectMove(db,item.id,target)
    assert.equal(plan.keepLink,false)
    await assert.rejects(executeProjectMove(db,{...plan,createdAt:Date.now()-11*60_000},{journalDir:path.join(base,'journal')}),/过期/)
    await assert.rejects(executeProjectMove(db,{...plan,sourceIdentity:'changed'},{journalDir:path.join(base,'journal')}),/变化/)
    await executeProjectMove(db,plan,{journalDir:path.join(base,'journal'),trash:async file=>fs.rename(file,path.join(base,'recycled.md'))})
    assert.equal(await fs.readFile(target,'utf8'),'正文内容');assert.equal(lib.get(item.id)?.path,target)
    assert.equal((db.prepare('SELECT source_dir,file_name FROM resource WHERE id=?').get(item.id) as any).source_dir,parent)
    assert.equal(await fs.lstat(source).catch(()=>null),null)
  }finally{db.close();await fs.rm(base,{recursive:true,force:true})}
})

test('不能移动正在运行的抱一或数据目录中的子目录',async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {planProjectMove}=await import('../electron/kinds/project/move.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-protected-'))
  try{
    const protectedRoot=path.join(base,'app'),source=path.join(protectedRoot,'resources');await fs.mkdir(source,{recursive:true})
    const item=new ProjectLibrary(db).register((await scanProjects(source,'single'))[0])
    await assert.rejects(planProjectMove(db,item.id,path.join(base,'new'),{protectedPaths:[protectedRoot]}),/受保护/)
  }finally{db.close();await fs.rm(base,{recursive:true,force:true})}
})

test('复制中断后不接管内容已改变的新位置，提交中断后补回旧入口',async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {planProjectMove,executeProjectMove,projectMoveRecords,recoverProjectMove}=await import('../electron/kinds/project/move.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-recovery-'))
  try{
    const source=path.join(base,'source'),target=path.join(base,'target'),journalDir=path.join(base,'journals');await fs.mkdir(source);await fs.writeFile(path.join(source,'notes.md'),'original')
    const lib=new ProjectLibrary(db),item=lib.register((await scanProjects(source,'single'))[0]),plan=await planProjectMove(db,item.id,target)
    await assert.rejects(executeProjectMove(db,plan,{journalDir,rename:async()=>{throw Object.assign(new Error('EXDEV'),{code:'EXDEV'})},beforeCommit:()=>{throw new Error('fault')}}),/fault/)
    const [record]=await projectMoveRecords(journalDir);await fs.rename(source,path.join(base,'preserved'))
    await fs.writeFile(path.join(target,'notes.md'),'changed')
    await assert.rejects(recoverProjectMove(db,journalDir,record.id),/内容|核验/)
    assert.equal(lib.get(item.id)?.path,source)
    await fs.writeFile(path.join(target,'notes.md'),'original');await recoverProjectMove(db,journalDir,record.id)
    assert.equal(lib.get(item.id)?.path,target);assert.equal((await fs.lstat(source)).isSymbolicLink(),true)
    await fs.unlink(source);record.phase='committed';await fs.writeFile(path.join(journalDir,record.id+'.json'),JSON.stringify(record))
    await recoverProjectMove(db,journalDir,record.id);assert.equal((await fs.lstat(source)).isSymbolicLink(),true)
  }finally{db.close();await fs.rm(base,{recursive:true,force:true})}
})

test('真实跨盘移动在隔离目录核验后回收原件',async(t)=>{
  if(process.platform!=='win32'||path.parse(os.tmpdir()).root.toLowerCase()===path.parse(process.cwd()).root.toLowerCase()){t.skip('需要两个可用卷');return}
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {planProjectMove,executeProjectMove,projectMoveRecords}=await import('../electron/kinds/project/move.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-crossdrive-')),output=path.resolve('output');await fs.mkdir(output,{recursive:true})
  const destination=await fs.mkdtemp(path.join(output,'project-crossdrive-'))
  try{
    const source=path.join(base,'source'),target=path.join(destination,'target');await fs.mkdir(source);await fs.writeFile(path.join(source,'notes.md'),'cross-volume content')
    const item=new ProjectLibrary(db).register((await scanProjects(source,'single'))[0]),journalDir=path.join(base,'journal')
    await executeProjectMove(db,await planProjectMove(db,item.id,target),{journalDir,trash:async file=>fs.rename(file,path.join(base,'recycled'))})
    assert.equal(await fs.readFile(path.join(source,'notes.md'),'utf8'),'cross-volume content');assert.equal((await projectMoveRecords(journalDir))[0].copied,true)
  }finally{db.close();await fs.rm(base,{recursive:true,force:true});await fs.rm(destination,{recursive:true,force:true})}
})


test('跨库重定位更新结构化路径并保留路径形状的标签与备注',async()=>{
  const {ProjectLibrary}=await import('../electron/kinds/project/library.ts')
  const {scanProjects}=await import('../electron/kinds/project/scanner.ts')
  const {rebaseLibraryPaths}=await import('../electron/kinds/project/paths.ts')
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-paths-'))
  try{
    const source=path.join(base,'old'),target=path.join(base,'new');await fs.mkdir(source)
    const lib=new ProjectLibrary(db),item=lib.register((await scanProjects(source,'single'))[0])
    const entry={...item.entries[0],label:source,cwd:source,args:[source,path.join(base,'external')],role:'工具'}
    lib.update(item.id,{entries:[entry],notes:source})
    db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name) VALUES('s','software',1,1,?,'app.exe')").run(path.join(source,'app.exe'))
    db.prepare("INSERT INTO software_meta(resource_id,link_target) VALUES('s',?)").run(path.join(source,'app.exe'))
    rebaseLibraryPaths(db,source,target)
    const moved=lib.get(item.id)!
    assert.equal(moved.entries[0].label,source);assert.equal(moved.notes,source)
    assert.deepEqual(moved.entries[0].args,[target,path.join(base,'external')]);assert.equal(moved.entries[0].cwd,target)
    assert.equal((db.prepare("SELECT link_target FROM software_meta WHERE resource_id='s'").get() as any).link_target,path.join(target,'app.exe'))
  }finally{db.close();await fs.rm(base,{recursive:true,force:true})}
})


test('v13 库升级新增项目表并保留既有资源与自定义分类',()=>{
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS.filter(k=>k.kind!=='project'))
  try{
    db.prepare("UPDATE settings SET value='13' WHERE key='_schema'").run()
    db.prepare("INSERT INTO resource(id,kind,created_at,updated_at,path,file_name,notes) VALUES('old-resource','software',1,1,'D:\\fixture\\app.exe','app.exe','保留旧备注')").run()
    db.prepare("INSERT INTO software_meta(resource_id) VALUES('old-resource')").run()
    db.prepare("INSERT INTO categories(id,kind,name) VALUES('custom-before-upgrade','software','我的自定义类别')").run()
    initSchema(db,KINDS)
    assert.equal((db.prepare("SELECT value FROM settings WHERE key='_schema'").get() as any).value,'15')
    assert.equal((db.prepare("SELECT notes FROM resource WHERE id='old-resource'").get() as any).notes,'保留旧备注')
    assert.ok(db.prepare("SELECT id FROM categories WHERE id='custom-before-upgrade'").get())
    assert.equal((db.prepare('SELECT COUNT(*) n FROM project_meta').get() as any).n,0)
    initSchema(db,KINDS)
    assert.equal((db.prepare('SELECT COUNT(*) n FROM resource').get() as any).n,1)
  }finally{db.close()}
})
