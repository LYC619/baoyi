import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
import {DocumentFiles} from '../electron/workspace/document-files.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {createRendererLoader} from './helpers/renderer-harness.ts'
import {createWorkspaceAgent} from '../electron/workspace/agent.ts'
import {generateTimeline} from '../electron/workspace/assistant.ts'
import {collectEvidence} from '../electron/workspace/evidence.ts'
import {workspaceBusy,workspaceOperation} from '../electron/workspace/activity.ts'

test('项目文件 IPC 只接受原生选择和绑定预览，确认后沿用资料身份',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-file-ipc-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  t.after(()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true})})
  const projectDir=path.join(root,'project');fs.mkdirSync(projectDir)
  const project=new ProjectLibrary(db).register({path:projectDir,name:'附件测试',summary:'',category:'其他',source:'self',version:'',entries:[],evidence:'',suggested:true,warnings:[]})
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'已选择的资料')
  const handlers=new Map<string,Function>(),contents={mainFrame:{},send:()=>{}},win={isDestroyed:()=>false,webContents:contents}
  const load=createRendererLoader({'../workspace/activity.ts':{workspaceOperation},'node:path':{...path,default:path},'../workspace/agent.ts':{createWorkspaceAgent},'../workspace/assistant.ts':{generateTimeline},'../workspace/evidence.ts':{collectEvidence},electron:{app:{on(){},getPath:()=>root},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[source]})},shell:{}},'../services/database.ts':{getDb:()=>db,getSettings:()=>({hide_hentai:true,ai:{}})},'./library-backup.ts':{assertLibraryIdle:()=>{}},'../workspace/document-files.ts':{DocumentFiles},'../workspace/documents.ts':{DocumentLibrary},'../services/window-focus.ts':{restoreWindowFocus:()=>{}}},{setInterval:()=>({unref(){}}),clearInterval(){},Buffer,Uint8Array,Date,Set,URL})
  load('electron/ipc/workspace.ts').registerWorkspaceIpc(()=>win,{handle:(name:string,fn:Function)=>handlers.set(name,fn)})
  const readyBy=Date.now()+5000
  while(workspaceBusy()&&Date.now()<readyBy)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(workspaceBusy(),false,'startup cleanup must finish before file operations')
  const invoke=(name:string,...args:any[])=>Promise.resolve().then(()=>handlers.get('workspace:'+name)!({sender:contents,senderFrame:contents.mainFrame},...args))
  assert.ok(handlers.has('workspace:files:choose'),'项目需要电脑文件选择入口')
  await assert.rejects(invoke('files:preview','forged','copy','project','a.txt'),/失效|选择/)
  const choice=await invoke('files:choose',project.id)
  await assert.rejects(invoke('files:preview',choice.token,'copy','project','../escape.txt'),/文件名/)
  const preview=await invoke('files:preview',choice.token,'copy','project','copied.txt')
  const result=await invoke('files:confirm',preview.token)
  assert.equal(result.state,'done');assert.equal(fs.readFileSync(path.join(projectDir,'copied.txt'),'utf8'),'已选择的资料')
  assert.ok(fs.existsSync(source));assert.equal(new DocumentLibrary(db).list().length,1)
  await assert.rejects(invoke('files:confirm',preview.token),/失效/)
})
