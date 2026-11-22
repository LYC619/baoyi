import vm from 'node:vm'
import {transform} from 'esbuild'
import {createBackup,previewRestore,restoreBackup,backupScope} from '../electron/kinds/game/backup.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {initSchema,setSchemaVersion} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {VIDEO_JOBS_SQL} from '../electron/kinds/video/download/jobs.ts'
import {insertGame,getGame,updateGame} from '../electron/kinds/game/db.ts'
import {listGameNotes,saveGameNote,removeGameNote} from '../electron/kinds/game/notes.ts'
import {patchGameLink,setDefaultGameEntry} from '../electron/kinds/game/workspace.ts'
import {previewGameLink} from '../electron/kinds/game/preview.ts'
import {buildLibraryBackup,restoreLibraryBackup,previewLibraryBackup} from '../electron/services/storage/library-backup.ts'
import {markdownLines,toggleMarkdownTask} from '../src/utils/game-notes.ts'
import {zipWorkbook} from './helpers/game-workbook.ts'

function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-workspace-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL);const write=(name:string,data:string|Buffer='fixture')=>{const file=path.join(root,name);fs.writeFileSync(file,data);return file};const id=insertGame(db,{exe_path:write('game.cmd'),name_zh:'隔离游戏',name_en:'Test',summary:'',description:'',category:'RPG',tags:[],official_url:'',source_dir:root,file_size:1,save_paths:[],linked_files:[]}).id;return {root,db,id,write,close(){db.close();fs.rmSync(root,{recursive:true,force:true})}}}
test('schema 30 migration preserves legacy text and does not resurrect deleted notes',()=>{const f=fixture();try{updateGame(f.db,f.id,{notes:'旧笔记\n原文'});setSchemaVersion(f.db,30);initSchema(f.db,KINDS);const notes=listGameNotes(f.db,f.id);assert.equal(notes.length,1);assert.equal(notes[0].body,'旧笔记\n原文');removeGameNote(f.db,f.id,notes[0].id,notes[0].updated_at);initSchema(f.db,KINDS);assert.equal(listGameNotes(f.db,f.id).length,0);assert.equal(getGame(f.db,f.id)!.notes,'旧笔记\n原文')}finally{f.close()}})
test('notes detect stale writes/deletes and enforce game ownership and sizes',()=>{const f=fixture();try{const n=saveGameNote(f.db,f.id,{title:'进度',body:'- [ ] 收集'});const next=saveGameNote(f.db,f.id,{id:n.id,title:n.title,body:'- [x] 收集',expectedUpdatedAt:n.updated_at});assert.ok(next.updated_at>n.updated_at);assert.throws(()=>saveGameNote(f.db,f.id,{id:n.id,title:'stale',body:'bad',expectedUpdatedAt:n.updated_at}),/其他位置/);assert.throws(()=>removeGameNote(f.db,f.id,n.id,n.updated_at),/变化/);assert.throws(()=>saveGameNote(f.db,'other',{id:n.id,title:'x',body:'x'}),/不存在/);assert.throws(()=>saveGameNote(f.db,f.id,{title:'x',body:'字'.repeat(400000)}),/1 MB/);assert.equal(listGameNotes(f.db,f.id)[0].body,'- [x] 收集')}finally{f.close()}})
test('full metadata backup restores notes, focus and trainer extras; schema 30 imports migrate notes',()=>{const f=fixture(),g=fixture();try{updateGame(f.db,f.id,{cover_focus:'12,80',notes:'旧内容',linked_files:[{path:f.write('tool.cmd'),label:'工具',type:'trainer',features:[{key:'F1',label:'示例'}],launch_with_game:true}]});saveGameNote(f.db,f.id,{title:'当前笔记',body:'## 路线\n\n内容'});const backup=buildLibraryBackup(f.db);previewLibraryBackup(g.db,backup);restoreLibraryBackup(g.db,backup);assert.equal(listGameNotes(g.db,f.id)[0].title,'当前笔记');assert.equal(getGame(g.db,f.id)!.cover_focus,'12,80');assert.equal(getGame(g.db,f.id)!.linked_files[0].launch_with_game,true);const old:any=structuredClone(backup);old.schema_version=30;delete old.tables.game_notes;for(const row of old.tables.game_meta)delete row.cover_focus;restoreLibraryBackup(g.db,old);assert.equal(listGameNotes(g.db,f.id)[0].body,'旧内容');assert.equal(getGame(g.db,f.id)!.cover_focus,'')}finally{f.close();g.close()}})
test('linked edits detect conflicts and default entry preserves all old launchers',()=>{const f=fixture();try{const target=f.write('alternate.cmd'),tool=f.write('tool.cmd');updateGame(f.db,f.id,{linked_files:[{path:target,label:'备用',type:'other',role:'launcher'},{path:tool,label:'工具',type:'trainer'}]});const old=getGame(f.db,f.id)!.linked_files[1];patchGameLink(f.db,f.id,tool,{features:[{key:'',label:'功能'}],read_progress:.5},JSON.stringify(old));assert.throws(()=>patchGameLink(f.db,f.id,tool,null,JSON.stringify(old)),/变化/);assert.throws(()=>setDefaultGameEntry(f.db,f.id,tool),/入口/);const original=getGame(f.db,f.id)!.path;const result=setDefaultGameEntry(f.db,f.id,target)!;assert.equal(result.path,target);assert.ok(result.linked_files.some(f=>f.path===original&&f.role==='launcher'));assert.throws(()=>updateGame(f.db,f.id,{cover_focus:'101,30'}),/超出/);assert.ok(fs.existsSync(original))}finally{f.close()}})
test('previews require a registered file, bound text bytes and handle missing/unsupported files',async()=>{const f=fixture();try{const target=f.write('large.md','中文'.repeat(100000));const links=[{path:target,label:'文档',type:'guide' as const}];assert.equal((await previewGameLink(links,target)).truncated,true);assert.ok((await previewGameLink(links,target)).text.length<210000);await assert.rejects(()=>previewGameLink([],target),/未关联/);const other=f.write('other.pdf');assert.equal((await previewGameLink([{...links[0],path:other}],other)).kind,'unsupported');fs.unlinkSync(target);await assert.rejects(()=>previewGameLink(links,target),/ENOENT/)}finally{f.close()}})
test('XLSX previews resolve workbook relations, shared/inline cells and fifty-row limit',async()=>{const f=fixture();try{const target=f.write('guide.xlsx',zipWorkbook(60));const p=await previewGameLink([{path:target,label:'表格',type:'guide'}],target);assert.equal(p.kind,'xlsx');assert.deepEqual(p.sheets,['路线']);assert.equal(p.rows?.length,50);assert.equal(p.rows?.[0][0],'第一章');assert.equal(p.rows?.[0][2],'物品');assert.equal(p.truncated,true);const bad=f.write('broken.xlsx','bad');await assert.rejects(()=>previewGameLink([{path:bad,label:'坏表',type:'guide'}],bad),/结构/)}finally{f.close()}})
test('task edits follow rendered markdown order, preserving fenced/indented code and raw HTML',()=>{const text='## 路线\n\n```\n- [ ] 代码\n```\n\n    - [ ] 缩进代码\n\n> - [ ] 引用任务\n\n- [ ] 一级\n  - [x] 子级\n\n<div>\n- [ ] HTML\n</div>\n\n### 备忘';const parsed=markdownLines(text);assert.equal(parsed.tasks.length,3);assert.equal(parsed.headings.length,2);const toggled=toggleMarkdownTask(text,1);assert.ok(toggled.includes('- [x] 一级'));assert.ok(toggled.includes('- [ ] 代码'));assert.ok(toggled.includes('- [ ] HTML'));assert.equal(toggleMarkdownTask(text,99),text)})


test('restore preview shows real byte differences, checks stale content and supports migration',async()=>{
  const f=fixture();try{
    const source=path.join(f.root,'original'),target=path.join(f.root,'moved'),backupRoot=path.join(f.root,'backups')
    fs.mkdirSync(source);fs.mkdirSync(target)
    fs.writeFileSync(path.join(source,'slot1'),'old');fs.writeFileSync(path.join(source,'slot2'),'new');fs.writeFileSync(path.join(source,'same'),'same')
    const made=await createBackup(f.db,getGame(f.db,f.id)!,source,{backupRoot});assert.ok(made.ok)
    fs.writeFileSync(path.join(target,'slot1'),'now');fs.writeFileSync(path.join(target,'extra'),'extra');fs.writeFileSync(path.join(target,'same'),'same')
    const p=await previewRestore(f.db,made.backup!.id,{backupRoot,target})
    assert.deepEqual(p.added,['slot2']);assert.deepEqual(p.changed,['slot1']);assert.deepEqual(p.removed,['extra']);assert.equal(p.unchanged,1)
    fs.writeFileSync(path.join(target,'slot1'),'xxx')
    assert.equal((await restoreBackup(f.db,made.backup!.id,getGame(f.db,f.id)!,{backupRoot,target,expected:p.expected})).ok,false)
    assert.equal(fs.readFileSync(path.join(target,'slot1'),'utf8'),'xxx')
    const fresh=await previewRestore(f.db,made.backup!.id,{backupRoot,target})
    const restored=await restoreBackup(f.db,made.backup!.id,getGame(f.db,f.id)!,{backupRoot,target,expected:fresh.expected})
    assert.ok(restored.ok,restored.message);assert.ok(restored.safety);assert.equal(fs.readFileSync(path.join(target,'slot1'),'utf8'),'old');assert.ok(!fs.existsSync(path.join(target,'extra')))
    assert.equal(fs.readFileSync(path.join(restored.safety!.backup_dir,'save','extra'),'utf8'),'extra')
    assert.equal(fs.readFileSync(path.join(source,'slot1'),'utf8'),'old')
  }finally{f.close()}
})
test('restore detects changed payload and rejects incompatible or linked destinations',async()=>{
  const f=fixture();try{
    const source=f.write('single.sav','original'),backupRoot=path.join(f.root,'backups'),target=path.join(f.root,'renamed.sav')
    const made=await createBackup(f.db,getGame(f.db,f.id)!,source,{backupRoot});assert.ok(made.ok)
    const p=await previewRestore(f.db,made.backup!.id,{backupRoot,target})
    fs.writeFileSync(path.join(made.backup!.backup_dir,'save','single.sav'),'modified')
    assert.equal((await restoreBackup(f.db,made.backup!.id,getGame(f.db,f.id)!,{backupRoot,target,expected:p.expected})).ok,false);assert.ok(!fs.existsSync(target))
    await assert.rejects(()=>previewRestore(f.db,made.backup!.id,{backupRoot,target:f.root}),/类型不同|备份根/)
    const p2=await previewRestore(f.db,made.backup!.id,{backupRoot,target})
    assert.ok((await restoreBackup(f.db,made.backup!.id,getGame(f.db,f.id)!,{backupRoot,target,expected:p2.expected})).ok)
    assert.equal(fs.readFileSync(target,'utf8'),'modified')
    const linked=path.join(f.root,'linked');fs.symlinkSync(backupRoot,linked,'junction')
    await assert.rejects(()=>previewRestore(f.db,made.backup!.id,{backupRoot,target:path.join(linked,'target')}),/链接/)
    fs.unlinkSync(linked)
  }finally{f.close()}
})


test('full backup scope counts over 500 files; simultaneous reservations remain independent',async()=>{
  const f=fixture();try{
    const source=path.join(f.root,'many'),backupRoot=path.join(f.root,'backups');fs.mkdirSync(source)
    for(let i=0;i<501;i++)fs.writeFileSync(path.join(source,String(i)),'x')
    const p=await backupScope(source);assert.equal(p.files,501);assert.equal(p.bytes,501)
    const opts={backupRoot,now:1234567890000};const results=await Promise.all([createBackup(f.db,getGame(f.db,f.id)!,source,opts),createBackup(f.db,getGame(f.db,f.id)!,source,opts)])
    assert.ok(results.every(r=>r.ok),JSON.stringify(results));assert.notEqual(results[0].backup!.backup_dir,results[1].backup!.backup_dir)
    for(const r of results)assert.equal((await backupScope(path.join(r.backup!.backup_dir,'save'))).files,501)
  }finally{f.close()}
})


test('leaving a game cancels pending save confirmations and stale retention prompts',async()=>{
  const source=fs.readFileSync(new URL('../src/pages/game/Detail.vue',import.meta.url),'utf8')
  const extract=async(name:string,endMarker:string)=>{const start=source.indexOf('async function '+name+'('),end=source.indexOf(endMarker,start);return (await transform(source.slice(start,end),{loader:'ts',format:'esm'})).code}
  const backup=await extract('backupSave','\n/**'),restore=await extract('restore','\nasync function dropBackup')
  const lifecycle=(await transform(source.slice(source.indexOf('let saveAction:'),source.indexOf('async function loadBackups')),{loader:'ts',format:'esm'})).code
  const make=()=>{const calls:string[]=[],unmount:Array<()=>void>=[];const context={AbortController,onBeforeUnmount:(fn:()=>void)=>unmount.push(fn),unmount:()=>unmount.forEach(fn=>fn()),calls,item:{value:{id:'A'}},props:{id:'A'},backingUp:{value:''},restoring:{value:''},restoreTargets:{value:{}},formatBytes:String,formatDateTime:String,refreshBackups:async()=>{},success:()=>{},pruneOver:async()=>{calls.push('prune')},error:()=>{},errorMessage:String,window:{confirm:()=>{calls.push('confirm');return true},baoyi:{game:{previewBackup:async(..._args:any[])=>({files:1,bytes:1}),backupSave:async(id:string)=>{calls.push('backup '+id);return {ok:true,backup:{size_bytes:1},over:[{}]}},previewRestore:async(..._args:any[])=>({added:[],changed:[],removed:[],unchanged:0}),restoreBackup:async()=>{calls.push('restore');return {ok:true}}}}}};vm.createContext(context);vm.runInContext(lifecycle,context);return context}
  for(const method of ['backup','restore']){
    const c=make();let release!:(value:any)=>void;const gate=new Promise<any>(r=>release=r)
    c.window.baoyi.game[method==='backup'?'previewBackup':'previewRestore']=async()=>gate
    const pending=vm.runInContext((method==='backup'?backup:restore)+(method==='backup'?'\nbackupSave("shared")':'\nrestore({id:"old",save_path:"shared"})'),c)
    c.unmount();release({files:1,bytes:1,added:[],changed:[],removed:[]});await pending;assert.deepEqual(c.calls,[])
  }
  const c=make();let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>arrived=r)
  c.refreshBackups=async()=>{arrived();await gate};const pending=vm.runInContext(backup+'\nbackupSave("shared")',c)
  await waiting;c.unmount();release();await pending;assert.deepEqual(c.calls,['confirm','backup A'])
})
