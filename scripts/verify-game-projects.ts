import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { previewGameProjects, importGameProjects, checkGameProjects } from '../electron/kinds/game/project-catalog.ts'
import { gameLinkStates, readGameLink } from '../electron/kinds/game/link-reader.ts'
import { getGame, updateGame, insertGame } from '../electron/kinds/game/db.ts'
import {isWindowsGameEntry} from '../src/utils/game-entry.ts'
import { buildLibraryBackup, previewLibraryBackup, restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { createCanvas } from '@napi-rs/canvas'
import { restoreProjectArtwork } from '../electron/kinds/game/project-artwork.ts'
import { projectOf } from '../src/utils/game-project.ts'

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-game-projects-')),db=new DatabaseSync(':memory:')
  initSchema(db,KINDS); db.exec(VIDEO_JOBS_SQL)
  const write=(file:string,content='fixture')=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file}
  const entry=(id:string,status='runtime_verified')=>{
    const assetRoot=path.join(root,"游戏 ' "+id),launcher=write(path.join(assetRoot,'启动游戏.bat')),exe=write(path.join(assetRoot,'bin','game.exe')),report=write(path.join(root,'.user','reports',id+'.md'),'限定验收'),usage=write(path.join(assetRoot,'修改器','使用说明.txt'),'先退出游戏'),tool=write(path.join(assetRoot,'修改器','启动修改器.bat')),guide=write(path.join(assetRoot,'攻略.md'),'# 合成攻略\n\n保留原文件。')
    return {id,name:'合成游戏 '+id,kind:'game',platform:'Windows',availability:'present',category:'1.SLG',assetRoot,launchers:[{path:launcher},{path:exe}],refinement:{status,report,guide:'机制已核对',runtime:'限定运行验证',remaining:['完整体验未验收']},trainer:{title:'存档工具',launchers:[{path:tool}],usage,validationSummary:'隔离数据通过'},guides:{docFiles:[{path:guide,name:'攻略'},{path:usage,name:'使用说明'},{path:report,name:'精修报告'}],htmlFiles:[]},save:{locationHint:'用户目录；未自动推断活跃存档',files:[{path:write(path.join(assetRoot,'随附存档','save.dat'))}]}}
  }
  const data={root,entries:[entry('one'),entry('two'),entry('pending','in_progress')]},source=path.join(root,'.user','library.json')
  const save=()=>write(source,JSON.stringify(data));save()
  return{root,db,write,data,source,save,close:()=>{db.close();fs.rmSync(root,{recursive:true,force:true})}}
}

function artworkFixture() {
  const f=fixture(),context={coversDir:path.join(f.root,'profile','covers'),recoveryDir:path.join(f.root,'profile','recovery')}
  const writeImage=(name:string,color:string)=>{const canvas=createCanvas(600,900),ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,600,900);const file=path.join(f.root,name+'.png');fs.writeFileSync(file,canvas.toBuffer('image/png'));return file}
  const asset=(file:string)=>({path:file,source:'https://example.test/cover.png',kind:'local',form:'original',layout:'原图'})
  const portrait=writeImage('portrait','red'),wide=writeImage('wide','blue')
  Object.assign(f.data.entries[0],{artwork:{portrait:asset(portrait),wide:asset(wide)}});f.save()
  return {...f,context,writeImage,asset}
}

test('artwork choices import only selected orientation, cache sources and repeat without writes',()=>{
  const f=artworkFixture();try{
    const result=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['wide']},f.context),id=result.items[0].id
    const game=getGame(f.db,id)!;assert.equal(game.cover_path,'');assert.ok(fs.existsSync(game.background_path));assert.equal(result.artworkUpdated,1)
    assert.equal(projectOf(game)!.artwork!.wide!.form,'original')
    const before=getGame(f.db,id);assert.equal(importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).unchanged,1);assert.deepEqual(getGame(f.db,id),before)
    assert.deepEqual(restoreProjectArtwork(f.db,result.artworkReceipt!,f.context),[game.name_zh])
    updateGame(f.db,id,{notes:'登记后新笔记'})
    restoreProjectArtwork(f.db,result.artworkReceipt!,f.context,true)
    assert.equal(getGame(f.db,id)!.background_path,'');assert.equal(getGame(f.db,id)!.notes,'登记后新笔记')
  }finally{f.close()}
})

test('artwork missing cache is recoverable and missing source does not block document import',()=>{
  const f=artworkFixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['portrait']},f.context).items[0].id
    const file=getGame(f.db,id)!.cover_path;fs.unlinkSync(file)
    let p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].artwork![0].state,'recover')
    importGameProjects(f.db,p,['one'],{one:['portrait']},f.context);assert.ok(fs.existsSync(getGame(f.db,id)!.cover_path))
    fs.unlinkSync(p.candidates[0].artwork![0].path)
    p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].problem,'');assert.equal(p.candidates[0].artwork![0].state,'unavailable')
    assert.equal(importGameProjects(f.db,p,['one']).unchanged,1)
    fs.unlinkSync(getGame(f.db,id)!.cover_path)
    assert.equal(checkGameProjects(f.db)[0].state,'unavailable');assert.match(checkGameProjects(f.db)[0].detail,/图片来源不可用/)
  }finally{f.close()}
})

test('manual portrait, manual landscape and focus cannot be overwritten by catalog choices',()=>{
  const f=artworkFixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['portrait','wide']},f.context).items[0].id
    updateGame(f.db,id,{cover_source:'manual',background_path:f.writeImage('manual','green')})
    let p=previewGameProjects(f.db,f.source);assert.ok(p.candidates[0].artwork!.every(i=>i.state==='protected'))
    assert.throws(()=>importGameProjects(f.db,p,['one'],{one:['wide']},f.context),/不可更新/)
    updateGame(f.db,id,{cover_source:'local',cover_focus:'30,40'})
    p=previewGameProjects(f.db,f.source);assert.ok(p.candidates[0].artwork!.every(i=>i.state==='protected'))
    importGameProjects(f.db,p,['one']);assert.equal(getGame(f.db,id)!.cover_focus,'30,40')
  }finally{f.close()}
})

test('changed image bytes invalidate preview and database failure rolls back both orientations',()=>{
  const f=artworkFixture();try{
    const p=previewGameProjects(f.db,f.source);f.writeImage('portrait','yellow')
    assert.throws(()=>importGameProjects(f.db,p,['one'],{one:['portrait']},f.context),/图片.*变化/)
    f.db.exec("CREATE TRIGGER reject_artwork BEFORE UPDATE ON game_meta WHEN NEW.background_path != '' BEGIN SELECT RAISE(ABORT, 'reject artwork'); END")
    assert.throws(()=>importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['portrait','wide']},f.context),/reject artwork/)
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM resource').get() as any).n,0)
  }finally{f.close()}
})

test('update and selective recovery preserve documents and reject later image edits',()=>{
  const f=artworkFixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['portrait','wide']},f.context).items[0].id
    const before=getGame(f.db,id)!,p1=before.cover_path
    f.writeImage('portrait','purple');f.save()
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].artwork![0].state,'changed')
    const result=importGameProjects(f.db,p,['one'],{one:['portrait']},f.context)
    fs.unlinkSync(p1);updateGame(f.db,id,{notes:'keep me'})
    restoreProjectArtwork(f.db,result.artworkReceipt!,f.context,true)
    assert.equal(getGame(f.db,id)!.cover_path,p1);assert.ok(fs.existsSync(p1));assert.equal(getGame(f.db,id)!.notes,'keep me')
    const result2=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['portrait']},f.context)
    updateGame(f.db,id,{cover_path:f.writeImage('manual2','orange')})
    assert.throws(()=>restoreProjectArtwork(f.db,result2.artworkReceipt!,f.context,true),/再次变化/)
  }finally{f.close()}
})

test('first artwork registration preserves a manually selected identical landscape',()=>{
  const f=artworkFixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    fs.mkdirSync(f.context.coversDir,{recursive:true})
    const wide=path.join(f.context.coversDir,id+'-background.manual.png');fs.copyFileSync(path.join(f.root,'wide.png'),wide)
    updateGame(f.db,id,{background_path:wide})
    assert.equal(previewGameProjects(f.db,f.source).candidates[0].artwork![1].state,'protected')
    f.writeImage('wide','yellow');assert.equal(previewGameProjects(f.db,f.source).candidates[0].artwork![1].state,'protected')
    assert.equal(getGame(f.db,id)!.background_path,wide)
  }finally{f.close()}
})

test('staging-time personal edits cancel the whole import before writes',()=>{
  const f=artworkFixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    const p=previewGameProjects(f.db,f.source),manual=f.writeImage('user-pick','orange')
    const context={...f.context,validate:()=>{updateGame(f.db,id,{cover_path:manual,cover_source:'manual'});return {ok:true,message:''}}}
    assert.throws(()=>importGameProjects(f.db,p,['one'],{one:['portrait']},context),/准备期间游戏库已变化/)
    assert.equal(getGame(f.db,id)!.cover_path,manual);assert.equal(getGame(f.db,id)!.cover_source,'manual')
    assert.equal(projectOf(getGame(f.db,id)!)!.artwork,undefined)
  }finally{f.close()}
})

test('staging-time current image edits or disappearance cancel all selected registrations',()=>{
  for (const change of ['edit','remove','reappear']) {
    const f=artworkFixture();try{
      const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['portrait','wide']},f.context).items[0].id
      const before=getGame(f.db,id)!,oldPath=before.cover_path,edited=f.writeImage('user-edit','orange')
      if(change==='reappear')fs.unlinkSync(oldPath)
      f.writeImage('portrait','purple');f.writeImage('wide','pink');f.data.entries[0].refinement.guide='new guide';f.save()
      const p=previewGameProjects(f.db,f.source)
      let once=false
      const context={...f.context,validate:()=>{if(!once){once=true;if(change==='remove')fs.unlinkSync(oldPath);else fs.copyFileSync(edited,oldPath)};return {ok:true,message:''}}}
      assert.throws(()=>importGameProjects(f.db,p,['two','one'],{one:['portrait','wide']},context),/当前封面文件已变化/)
      assert.deepEqual(getGame(f.db,id),before)
      assert.equal((f.db.prepare("SELECT COUNT(*) n FROM resource WHERE kind='game'").get() as any).n,1)
      if(change==='remove')assert.equal(fs.existsSync(oldPath),false)
      else assert.deepEqual(fs.readFileSync(oldPath),fs.readFileSync(edited))
    }finally{f.close()}
  }
})

test('artwork undo refuses an in-place image change',()=>{
  const f=artworkFixture();try{
    const r=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'],{one:['wide']},f.context),game=getGame(f.db,r.items[0].id)!
    fs.copyFileSync(f.writeImage('changed-cache','orange'),game.background_path)
    assert.throws(()=>restoreProjectArtwork(f.db,r.artworkReceipt!,f.context,true),/图片文件已再次变化/)
    assert.equal(getGame(f.db,game.id)!.background_path,game.background_path)
  }finally{f.close()}
})
test('only explicitly completed projects; atomic registration and repeat import',()=>{
  const f=fixture();try{
    f.data.entries.push({...f.data.entries[2],id:'android',platform:'Android'});f.save()
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates.length,2);assert.equal(p.excluded,2);assert.ok(p.candidates.every(c=>!c.problem),JSON.stringify(p.candidates))
    const result=importGameProjects(f.db,p,p.candidates.map(c=>c.key));assert.equal(result.created,2)
    const game=getGame(f.db,result.items[0].id)!;assert.equal(game.source_dir,f.data.entries[0].assetRoot);assert.deepEqual(game.save_paths,[]);assert.equal(game.play_status,'unplayed')
    assert.ok(game.linked_files.some(f=>f.type==='trainer'&&f.role==='usage'));assert.ok(game.linked_files.some(f=>f.type==='guide'&&f.role==='report'));assert.ok(game.description.includes('完整体验未验收'))
    const again=previewGameProjects(f.db,f.source);assert.equal(importGameProjects(f.db,again,again.candidates.map(c=>c.key)).unchanged,2)
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM resource WHERE kind='game'").get() as any).n,2)
  }finally{f.close()}
})
test('static PC and Android retain evidence boundaries, tool metadata and distinct entry types',()=>{
  const f=fixture();try{
    const pc=f.data.entries[0],android=f.data.entries[1]
    pc.refinement.status='static_complete';android.refinement.status='static_complete';android.platform='Android'
    const helper=f.write(path.join(pc.assetRoot,'存档与设置管理.bat'))
    pc.launchers.unshift({path:helper});Object.assign(pc.trainer,{features:['完整备份与恢复'],validationSummary:'合成数据验证，游戏内未验'})
    const apk=f.write(path.join(android.assetRoot,'game.apk'))
    android.launchers=[{path:android.trainer.launchers[0].path},{path:apk}];f.save()
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates.length,2);assert.ok(p.candidates.every(c=>!c.problem))
    assert.equal(p.candidates[0].launcher,pc.launchers[1].path);assert.equal(p.candidates[1].launcher,apk)
    const r=importGameProjects(f.db,p,['one','two']);const games=r.items.map(x=>getGame(f.db,x.id)!)
    assert.ok(isWindowsGameEntry(games[0].path));assert.equal(isWindowsGameEntry(games[1].path),false)
    assert.ok(games[0].linked_files.some(l=>l.path===helper&&l.type==='trainer'))
    assert.ok(games[0].linked_files.some(l=>l.features?.[0].label==='完整备份与恢复'))
    assert.ok(games[1].description.includes('不执行 APK'));assert.ok(games[1].tags.includes('静态检查'));assert.ok(!games[1].tags.includes('限定运行验证'))
    assert.ok(games[0].linked_files.find(l=>l.role==='report')!.note!.includes('完整体验未验收'))
  }finally{f.close()}
})
test('explicit absent previous root reuses resource ID and relocates without losing personal data',()=>{
  const f=fixture();try{
    const old=path.join(f.root,'旧目录'),e=f.data.entries[0]
    const id=insertGame(f.db,{exe_path:path.join(old,'game.exe'),source_dir:old,file_size:1,name_zh:'个人名称',name_en:'',category:'个人分类',tags:['我的'],summary:'个人摘要',description:'个人介绍',official_url:'',save_paths:[],linked_files:[]}).id
    updateGame(f.db,id,{notes:'保留笔记',total_playtime_sec:123,cover_path:'cover.png'})
    Object.assign(e,{previousRoots:[old]});f.save()
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].existingId,id);assert.equal(p.candidates[0].relocate,true)
    assert.equal(importGameProjects(f.db,p,['one']).updated,1)
    const game=getGame(f.db,id)!;assert.equal(game.path,e.launchers[0].path);assert.equal(game.notes,'保留笔记');assert.equal(game.total_playtime_sec,123);assert.equal(game.cover_path,'cover.png');assert.equal(game.summary,'个人摘要')
    const again=previewGameProjects(f.db,f.source);assert.equal(importGameProjects(f.db,again,['one']).unchanged,1)
    f.write(path.join(old,'still-here.txt'));assert.match(previewGameProjects(f.db,f.source).candidates[0].problem,/旧目录/)
  }finally{f.close()}
})
test('repeat import refreshes generated work note while retaining personal link edits and reading progress',()=>{
  const f=fixture();try{
    const first=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']),id=first.items[0].id
    const game=getGame(f.db,id)!;const links=game.linked_files.map(l=>l.role==='report'?{...l,label:'我的报告',read_progress:.7}:l.type==='trainer'&&l.role==='launcher'?{...l,usage:'个人用法',features:[{key:'',label:'手写功能'}]}:l)
    updateGame(f.db,id,{linked_files:links});f.data.entries[0].refinement.guide='新增的实际修复说明';f.save()
    assert.equal(importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).updated,1)
    const next=getGame(f.db,id)!;const report=next.linked_files.find(l=>l.role==='report')!
    assert.equal(report.label,'我的报告');assert.equal(report.read_progress,.7);assert.ok(report.note?.includes('新增的实际修复说明'))
    assert.ok(next.linked_files.some(l=>l.usage==='个人用法'&&l.features?.[0].label==='手写功能'))
    updateGame(f.db,id,{linked_files:next.linked_files.map(l=>l.role==='report'?{...l,note:'个人报告备注'}:l)})
    f.data.entries[0].refinement.guide='再更新';f.save();importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'])
    assert.equal(getGame(f.db,id)!.linked_files.find(l=>l.role==='report')!.note,'个人报告备注')
  }finally{f.close()}
})
test('match an existing executable inside a project and preserve user fields/history',()=>{
  const f=fixture();try{
    const e=f.data.entries[0];const {id}=insertGame(f.db,{exe_path:e.launchers[1].path,source_dir:path.dirname(e.launchers[1].path),file_size:1,name_zh:'自定名称',name_en:'',category:'自定分类',tags:['个人'],summary:'个人摘要',description:'个人说明',official_url:'',save_paths:[{path:path.join(f.root,'active'),verified_at:1}],linked_files:[{path:e.guides.docFiles[0].path,label:'我的攻略',type:'guide'}]})
    updateGame(f.db,id,{notes:'重要笔记',total_playtime_sec:987,play_status:'playing',cover_path:'keep.jpg'})
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].existingId,id);const result=importGameProjects(f.db,p,['one']);assert.equal(result.updated,1)
    const game=getGame(f.db,id)!;assert.equal(game.name_zh,'自定名称');assert.equal(game.notes,'重要笔记');assert.equal(game.total_playtime_sec,987);assert.equal(game.cover_path,'keep.jpg');assert.equal(game.linked_files[0].label,'我的攻略');assert.equal(game.save_paths.length,1);assert.deepEqual(game.tags,['个人']);assert.equal(game.description,'个人说明')
  }finally{f.close()}
})
test('reject unknown status, missing evidence, missing attachments and paths outside library',()=>{
  const f=fixture();try{
    fs.unlinkSync(f.data.entries[0].refinement.report)
    f.data.entries[1].guides.docFiles[0].path=path.join(os.tmpdir(),'outside.txt');f.save()
    const p=previewGameProjects(f.db,f.source);assert.ok(p.candidates.every(c=>c.problem));assert.throws(()=>importGameProjects(f.db,p,['one']));assert.equal((f.db.prepare('SELECT COUNT(*) n FROM resource').get() as any).n,0)
  }finally{f.close()}
})
test('recheck manifest and missing files at commit',()=>{
  const f=fixture();try{
    const p=previewGameProjects(f.db,f.source);f.data.entries[0].name='changed';f.save();assert.throws(()=>importGameProjects(f.db,p,['one']),/清单已变化/)
    const p2=previewGameProjects(f.db,f.source);fs.unlinkSync(f.data.entries[1].trainer.usage);assert.throws(()=>importGameProjects(f.db,p2,['one','two']));assert.equal((f.db.prepare('SELECT COUNT(*) n FROM resource').get() as any).n,0)
  }finally{f.close()}
})
test('rollback all writes on a later database failure',()=>{
  const f=fixture();try{
    f.db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON resource WHEN NEW.name_zh = '合成游戏 two' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
    const p=previewGameProjects(f.db,f.source);assert.throws(()=>importGameProjects(f.db,p,['one','two']),/fixture failure/)
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM resource').get() as any).n,0);assert.equal((f.db.prepare('SELECT COUNT(*) n FROM game_meta').get() as any).n,0)
  }finally{f.close()}
})
test('detect ambiguous existing records and reject library changes after preview',()=>{
  const f=fixture();try{
    const stale=previewGameProjects(f.db,f.source);importGameProjects(f.db,stale,['one']);assert.throws(()=>importGameProjects(f.db,stale,['one']),/游戏库已变化/)
    const e=f.data.entries[0];insertGame(f.db,{exe_path:e.launchers[1].path,source_dir:e.assetRoot,file_size:1,name_zh:'重复',name_en:'',summary:'',description:'',category:'',tags:[],official_url:'',save_paths:[],linked_files:[]})
    assert.match(previewGameProjects(f.db,f.source).candidates[0].problem,/多个游戏/)
  }finally{f.close()}
})
test('text reader enforces membership, format and size; missing paths visible',async()=>{
  const f=fixture();try{
    const file=f.data.entries[0].guides.docFiles[0].path,links=[{path:file,label:'攻略',type:'guide' as const}]
    assert.equal((await readGameLink(links,file)).format,'markdown');assert.ok(gameLinkStates(links)[0].readable)
    await assert.rejects(()=>readGameLink(links,f.source),/未关联/)
    const exe=f.data.entries[0].launchers[0].path;await assert.rejects(()=>readGameLink([{path:exe,label:'启动',type:'trainer'}],exe),/Markdown 和 TXT/)
    fs.writeFileSync(file,Buffer.alloc(1024*1024+1));await assert.rejects(()=>readGameLink(links,file),/1 MB/)
    fs.unlinkSync(file);assert.equal(gameLinkStates(links)[0].exists,false)
  }finally{f.close()}
})
test('JSON backup retains project link roles and notes without a schema change',()=>{
  const f=fixture();try{
    const p=previewGameProjects(f.db,f.source),result=importGameProjects(f.db,p,['one']),id=result.items[0].id
    const before=getGame(f.db,id)!.linked_files,backup=buildLibraryBackup(f.db)
    previewLibraryBackup(f.db,backup);restoreLibraryBackup(f.db,backup)
    assert.deepEqual(getGame(f.db,id)!.linked_files,before)
  }finally{f.close()}
})


test('updates refresh source fields, preserve manual edits and acknowledge retired links',()=>{
  const f=fixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    const entry=f.data.entries[0], initial=getGame(f.db,id)!
    const tool=initial.linked_files.find(l=>l.type==='trainer'&&l.role==='launcher')!
    tool.usage='个人用法';tool.label='我的工具';tool.read_progress=.4
    updateGame(f.db,id,{linked_files:initial.linked_files})
    Object.assign(entry.trainer,{features:['新版功能'],purpose:'backup',validationSummary:'新证据'})
    entry.guides.docFiles=entry.guides.docFiles.filter(d=>d.name!=='攻略');f.save()
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].changes.retired.length,1)
    importGameProjects(f.db,p,['one'])
    const after=getGame(f.db,id)!,changed=after.linked_files.find(l=>l.path===tool.path)!
    assert.equal(changed.usage,'个人用法');assert.equal(changed.label,'我的工具');assert.equal(changed.purpose,'backup');assert.equal(changed.read_progress,.4)
    assert.equal(changed.features![0].label,'新版功能');assert.ok(after.linked_files.some(l=>l.catalog?.retired))
    assert.equal(checkGameProjects(f.db)[0].state,'current')
    assert.equal(importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).unchanged,1)
    assert.equal(after.linked_files.find(l=>l.project)!.project!.history.length,2)
  }finally{f.close()}
})
test('file changes and concurrent personal edits invalidate an import preview',()=>{
  const f=fixture();try{
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    let p=previewGameProjects(f.db,f.source)
    fs.appendFileSync(f.data.entries[0].refinement.report,'changed evidence')
    assert.equal(checkGameProjects(f.db)[0].state,'changed');assert.throws(()=>importGameProjects(f.db,p,['one']),/变化/)
    p=previewGameProjects(f.db,f.source);updateGame(f.db,id,{notes:'刚写下的笔记'})
    assert.throws(()=>importGameProjects(f.db,p,['one']),/变化/);assert.equal(getGame(f.db,id)!.notes,'刚写下的笔记')
  }finally{f.close()}
})
test('project identity survives launcher and report replacement, with one active record',()=>{
  const f=fixture();try{
    const e=f.data.entries[0], id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    const oldReport=e.refinement.report
    e.refinement.report=f.write(path.join(f.root,'.user','new-report.md'),'new version')
    e.guides.docFiles=e.guides.docFiles.filter(d=>d.path!==oldReport)
    Object.assign(e,{followup:{guidePath:f.write(path.join(e.assetRoot,'navigation.md'),'# navigation'),family:'one'}})
    f.save();const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].existingId,id);importGameProjects(f.db,p,['one'])
    const links=getGame(f.db,id)!.linked_files
    assert.equal(links.filter(l=>l.project).length,1);assert.ok(links.some(l=>l.label==='使用与攻略导航'))
    assert.ok(links.find(l=>l.path===oldReport)!.catalog!.retired)
    assert.equal(checkGameProjects(f.db)[0].state,'current')
  }finally{f.close()}
})


test('explicitly cleared imported tool fields remain empty on later imports',()=>{
  const f=fixture();try{
    Object.assign(f.data.entries[0].trainer,{features:['功能'],purpose:'backup'});f.save()
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    const game=getGame(f.db,id)!,tool=game.linked_files.find(l=>l.type==='trainer'&&l.role==='launcher')!
    tool.usage='';tool.features=[];tool.note='';updateGame(f.db,id,{linked_files:game.linked_files})
    Object.assign(f.data.entries[0].trainer,{features:['新功能'],validationSummary:'新证据'});f.save()
    importGameProjects(f.db,previewGameProjects(f.db,f.source),['one'])
    const updated=getGame(f.db,id)!.linked_files.find(l=>l.path===tool.path)!
    assert.equal(updated.usage,'');assert.deepEqual(updated.features,[]);assert.equal(updated.note,'')
  }finally{f.close()}
})


test('Android relocation preserves identity and moves APK references without running it',()=>{
  const f=fixture();try{
    const e=f.data.entries[0];e.platform='Android';e.launchers=[{path:f.write(path.join(e.assetRoot,'game.apk'))}];f.save()
    const id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id,old=e.assetRoot,next=path.join(f.root,'moved-android')
    assert.ok(old.startsWith(f.root+path.sep)&&next.startsWith(f.root+path.sep));fs.renameSync(old,next)
    f.data.entries[0]=JSON.parse(JSON.stringify(e).split(JSON.stringify(old).slice(1,-1)).join(JSON.stringify(next).slice(1,-1)))
    Object.assign(f.data.entries[0],{previousRoots:[old]});f.save()
    const p=previewGameProjects(f.db,f.source);assert.equal(p.candidates[0].problem,'');assert.equal(p.candidates[0].existingId,id);assert.equal(p.candidates[0].relocate,true)
    importGameProjects(f.db,p,['one']);assert.equal(getGame(f.db,id)!.path,path.join(next,'game.apk'));assert.equal(getGame(f.db,id)!.use_count,0)
  }finally{f.close()}
})
test('renamed source and new report retire old source once and keep one current project',()=>{
  const f=fixture();try{
    const e=f.data.entries[0],id=importGameProjects(f.db,previewGameProjects(f.db,f.source),['one']).items[0].id
    e.refinement.report=f.write(path.join(f.root,'.user','replacement.md'),'replacement');e.guides.docFiles=[]
    const source=f.write(path.join(f.root,'.user','renamed.json'),JSON.stringify(f.data));importGameProjects(f.db,previewGameProjects(f.db,source),['one'])
    const game=getGame(f.db,id)!;assert.equal(game.linked_files.filter(l=>l.project).length,1);assert.equal(game.linked_files.find(l=>l.project)!.project!.source,source)
    assert.equal(previewGameProjects(f.db,source).candidates[0].changes.retired.length,0);assert.equal(checkGameProjects(f.db)[0].state,'current')
  }finally{f.close()}
})
