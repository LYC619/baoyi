import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
import { WorkspaceLinks } from '../electron/workspace/links.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { TimelineLibrary } from '../electron/workspace/timeline.ts'
import { workspaceOperation, workspaceBusy } from '../electron/workspace/activity.ts'

test('workspace IPC rejects other windows/frames and imports only approved preview files', async t => {
  assert.ok(fs.existsSync('electron/ipc/workspace.ts'), 'workspace IPC is required')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-workspace-ipc-'))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS)
  t.after(() => { db.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(root, {recursive:true,force:true}) })
  const selected = path.join(root, 'selected.md'), outside = path.join(root, 'outside.md')
  fs.writeFileSync(selected, '# selected'); fs.writeFileSync(outside, '# outside')
  const controls = { cancelled:false, busy:false }
  const contents = { mainFrame:{}, send:()=>{} }, win = {isDestroyed:()=>false,webContents:contents}
  const event = {sender:contents,senderFrame:contents.mainFrame}, handlers = new Map<string,Function>()
  const load = createRendererLoader({
    'node:fs/promises':{...fs.promises,default:fs.promises},'node:path':{...path,default:path},
    electron:{app:{on(){},getPath:(name:string)=>{assert.equal(name,'userData');return root}},dialog:{showOpenDialog:async()=>({canceled:controls.cancelled,filePaths:[selected]}),showSaveDialog:async()=>({canceled:false,filePath:selected})},shell:{}},
    '../services/database.ts': { getDb:()=>db },
    '../services/settings-store.ts': { getSettings:()=>({hide_hentai:true,ai:{}}) },
    './library-backup.ts':{assertLibraryIdle:()=>{if(controls.busy||workspaceBusy())throw new Error('busy')}},
    './archive.ts':{startImportedInsights:async()=>''},
    '../workspace/documents.ts':{DocumentLibrary},'../workspace/links.ts':{WorkspaceLinks},
    '../workspace/personal.ts':{PersonalLibrary},'../workspace/timeline.ts':{TimelineLibrary},
    '../workspace/activity.ts':{workspaceOperation},
    '../workspace/assistant.ts':{generateTimeline:async()=>null,cancelTimeline:()=>{}},
    '../workspace/evidence.ts':{collectEvidence:async()=>null},
    '../services/window-focus.ts':{restoreWindowFocus:()=>{}}
  },{setInterval:()=>({unref(){}}),clearInterval(){},Buffer,Uint8Array,Date,Set,URL,structuredClone})
  const organized:string[]=[]
  load('electron/ipc/workspace.ts').registerWorkspaceIpc(()=>win,{handle:(name:string,fn:Function)=>handlers.set(name,fn)}, {organize:(id:string)=>{organized.push(id);return {id:'persistent-session'}},cancelProject:()=>{}})
  // A real app boundary also starts the recycle cleanup; wait for it to finish.
  const readyBy=Date.now()+5000
  while(workspaceBusy()&&Date.now()<readyBy)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(workspaceBusy(),false,'startup cleanup must finish before import assertions')
  const invoke = (name:string,...args:any[])=>Promise.resolve().then(()=>handlers.get('workspace:'+name)!(event,...args))
  assert.equal((await invoke('timeline:generate','project-fixture',true)).id,'persistent-session')
  assert.deepEqual(organized,['project-fixture'])
  assert.throws(()=>handlers.get('workspace:documents:list')!({...event,senderFrame:{} }), /主窗口/)
  for(const channel of ['documents:covers:get','documents:covers:source','documents:covers:put','links:project-references'])assert.throws(()=>handlers.get('workspace:'+channel)!({...event,senderFrame:{} }),/主窗口/)
  const preview = await invoke('documents:prepare-import',false,'certificate')
  assert.equal(preview.categoryId,'certificate','预览应继承当前分类')
  await assert.rejects(invoke('documents:confirm-import',preview.token,[outside]),/预览/)
  assert.equal(new DocumentLibrary(db).list().length,0)
  assert.equal((await invoke('documents:confirm-import',preview.token,[selected])).imported,1)
  assert.equal(new DocumentLibrary(db).list()[0].type,'certificate','确认时仍使用预览绑定的分类')
  const doc=new DocumentLibrary(db).list()[0],annotation=new DocumentLibrary(db).annotate(doc.id,{kind:'excerpt',quote:'selected',note:'',location:{page:1,offset:0}})
  const reads=await Promise.all([invoke('documents:content',doc.id),invoke('documents:content',doc.id)])
  assert.ok(reads.every(value=>value.text==='# selected'),'快速切换或重复读取不应互相阻塞')
  await assert.rejects(invoke('documents:export',doc.id,[annotation.id]),/原文件/)
  assert.equal(fs.readFileSync(selected,'utf8'),'# selected')
  await assert.rejects(invoke('documents:confirm-import',preview.token,[selected]),/失效/)
  controls.cancelled=true;assert.equal(await invoke('documents:prepare-import',false),null)
  controls.busy=true
  await assert.rejects(invoke('personal:save',{kind:'skill',name:'test',body:'',data:{}}),/busy/)
  assert.equal(new PersonalLibrary(db).list().length,0)
})
