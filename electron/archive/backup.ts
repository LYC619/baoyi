import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {app} from 'electron'
export const assistantDirectory=()=>path.join(app.getPath('userData'),'archive-assistant')
function command(method:'export'|'stage',input?:unknown){
  const python=path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'hermes-runtime':'output/hermes-runtime','python/python.exe')
  const script=path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),app.isPackaged?'hermes/state.py':'resources/hermes/state.py')
  try{return JSON.parse(execFileSync(python,['-X','utf8',script,method,assistantDirectory()],{windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:180*1024*1024,input:input?JSON.stringify(input):undefined}))}
  catch(e){throw new Error('归档助理备份未能完成：'+(String((e as any).stderr||'请检查运行组件和可用空间').slice(0,600)))}
}
export function exportAssistantState(){return fs.existsSync(assistantDirectory())?command('export'):undefined}
export function stageAssistantState(input:unknown):string{
  if(input)return command('stage',input).stage
  // A pre-assistant backup represents empty assistant state. Keep the current
  // history in recovery, instead of mixing it with a different restored library.
  const stage=path.join(app.getPath('userData'),'archive-assistant-restore-'+randomUUID())
  fs.mkdirSync(stage);return stage
}
export function discardAssistantStage(stage:string|undefined){
  if(stage&&path.dirname(stage)===app.getPath('userData')&&path.basename(stage).startsWith('archive-assistant-restore-'))fs.rmSync(stage,{recursive:true,force:true})
}
/** Keep the original directory as a recoverable pre-restore snapshot. */
export function installAssistantState(stage:string,recovery:string){
  const root=assistantDirectory(),original=path.join(recovery,'archive-assistant-'+Date.now()+'-'+randomUUID().slice(0,8))
  const exists=fs.existsSync(root)
  if(exists)fs.renameSync(root,original)
  try{fs.renameSync(stage,root)}catch(e){if(exists)fs.renameSync(original,root);throw e}
  return ()=>{fs.renameSync(root,stage);if(exists)fs.renameSync(original,root)}
}
