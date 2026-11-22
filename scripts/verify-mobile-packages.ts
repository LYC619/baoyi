import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planRoot } from '../electron/kinds/software/scanPlan.ts'
import { rootDirOf, alreadyOrganized } from '../electron/kinds/software/organize/plan.ts'
import { MOBILE_PACKAGE_EXTENSIONS, isSoftwareFile } from '../src/utils/software-package.ts'
import { createRendererLoader } from './helpers/renderer-harness.ts'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-mobile-'))
const revealed:string[]=[], categories:any[]=[], rows:any[]=[]
const database={getSoftware:(_db: unknown, id:string)=>rows.find(r=>r.id===id),recordLaunch:()=>{throw new Error('mobile packages must not count as launches')},listCategories:()=>categories,upsertCategory:(_db: unknown, c:any)=>categories.push(c),updateSoftware:(_db: unknown, id:string,p:any)=>Object.assign(rows.find(r=>r.id===id),p),insertScanned:(_db: unknown, facts:any[])=>facts.map(f=>{const row={...f,id:String(rows.length),launchers:[]};rows.push(row);return row})}
const load=createRendererLoader({'node:fs':{default:fs,...fs},'node:path':{default:path,...path},electron:{shell:{showItemInFolder:(file:string)=>revealed.push(file)}},'node:child_process':{spawn:()=>{throw new Error('must not execute mobile package')}},'../../services/storage/database': { getDb: () => ({}) }, './db.ts': database, '../../services/taxonomy/taxonomy-store.ts': database,'../../services/media/iconExtractor':{extractIcon:()=>{throw new Error('must not read PE icon from package')}},'./peReader':{readPeInfo:()=>{throw new Error('must not parse mobile package as PE')}}},{process,Buffer})
try{
 for(const ext of MOBILE_PACKAGE_EXTENSIONS){const file=path.join(dir,'样本.'+ext.toUpperCase());fs.writeFileSync(file,'fixture');assert.equal(isSoftwareFile(file),true);const [item]=await load('electron/kinds/software/scanner.ts').addSingleExe(file);assert.equal(item.category,'APP');assert.equal(item.is_portable,false);assert.equal(rootDirOf(item),file);assert.equal(alreadyOrganized(item,dir),false);assert.equal(await load('electron/kinds/software/launcher.ts').launchSoftware(item.id),true)}
 fs.writeFileSync(path.join(dir,'setup.exe'),'fixture');fs.writeFileSync(path.join(dir,'保留说明.txt'),'unchanged')
 const plan=await planRoot(dir);assert.equal(plan.units.length,1);assert.equal(plan.units[0].exe_count,6);assert.equal(plan.units[0].loose_only,true);assert.equal(revealed.length,6);assert.equal(categories.length,1);assert.equal(fs.readFileSync(path.join(dir,'保留说明.txt'),'utf8'),'unchanged');console.log('PASS six mobile formats, root scanning, APP category, reveal-only launcher and single-file ownership')
}finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
