import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {DatabaseSync} from 'node:sqlite'

// Explicit local operation: backs up the real index, then uses the application's import API.
assert.ok(process.argv.includes('--apply'),'Pass --apply to register the current project in the real library')
const root=process.cwd(),profile=path.join(process.env.APPDATA!,'抱一'),database=path.join(profile,'baoyi.db')
const output=path.join(root,'output','field-20261007');fs.mkdirSync(output,{recursive:true})
const backup=path.join(output,'before-register-'+Date.now()+'.db')
if(fs.existsSync(database)){
  const db=new DatabaseSync(database,{readOnly:true})
  try{db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'")}finally{db.close()}
}
const require=createRequire(import.meta.url)
const {_electron}=require(process.env.BAOYI_PLAYWRIGHT||'C:/Users/yicha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const executable=path.join(root,'release','0.14.1','win-unpacked','抱一.exe'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const application=await _electron.launch({executablePath:executable,args:['--disable-gpu'],env,timeout:30000})
try {
  assert.equal(path.resolve(await application.evaluate(({app}:any)=>app.getPath('userData'))),profile)
  const page=await application.firstWindow();page.setDefaultTimeout(30000);await page.waitForFunction(()=>!!window.baoyi?.project)
  const existing=(await page.evaluate(()=>window.baoyi.project.list())).find((item:any)=>item.path.toLowerCase()===root.toLowerCase())
  let result:any={imported:0,errors:[],alreadyRegistered:!!existing}
  if(!existing){
    await application.evaluate(({dialog}:any,target:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[target]})},root)
    const preview=await page.evaluate(()=>window.baoyi.project.prepareImport('single'));assert.ok(preview)
    result=await page.evaluate((token:string)=>window.baoyi.project.confirmImport(token,[{index:0,name:'抱一',category:'软件项目',source:'self'}]),preview.token)
    assert.equal(result.imported,1);assert.deepEqual(result.errors,[])
  }
  const item=(await page.evaluate(()=>window.baoyi.project.list())).find((item:any)=>item.path.toLowerCase()===root.toLowerCase());assert.ok(item)
  const sessions=await page.evaluate((id:string)=>window.baoyi.project.sessions(id),item.id)
  await page.evaluate((id:string)=>{location.hash='/project/'+id},item.id)
  await page.getByRole('tab',{name:'工作区概览',exact:true}).waitFor()
  await page.waitForFunction(()=>!!document.querySelector('.workspace-grid'))
  await page.screenshot({path:path.join(output,'baoyi-project.png')})
  fs.writeFileSync(path.join(output,'registration.json'),JSON.stringify({executable,profile,backup,result,id:item.id,name:item.name,entries:item.entries.length,sessions:sessions.length},null,2))
  console.log(JSON.stringify({id:item.id,name:item.name,entries:item.entries.length,sessions:sessions.length,result,backup}))
}finally{await application.close()}
