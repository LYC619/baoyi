// Read-only library inspection after the explicitly authorized data migration.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const require=createRequire(import.meta.url),{_electron}=require('playwright')
const report=JSON.parse(fs.readFileSync('output/photo-library-2026-10-29/real-data/result.json','utf8'))
function fingerprint(){const db=new DatabaseSync(path.join(report.profile,'baoyi.db'),{readOnly:true});const rows=['resource','image_meta','image_groups','image_pages','image_progress','image_bookmarks','image_reader_state','image_chapters','image_collections','image_collection_members'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]);db.close();return createHash('sha256').update(JSON.stringify(rows)).digest('hex')}
const before=fingerprint(),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const app=await _electron.launch({executablePath:path.resolve('release/0.17.7/win-unpacked/抱一.exe'),args:[],env})
try{
 assert.equal(path.resolve(await app.evaluate(({app}:any)=>app.getPath('userData'))),path.resolve(report.profile))
 assert.equal(await app.evaluate(({app}:any)=>app.getVersion()),'0.17.7')
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.baoyi?.image)
 const counts=await page.evaluate(async()=>{
  const all=await window.baoyi.image.list(),groups=await window.baoyi.image.groups(),out=[]
  for(const type of ['comic','photo','misc'] as const){const rows=all.filter(i=>i.type===type);out.push({type,items:rows.length,pages:rows.reduce((n,i)=>n+i.pageCount,0),groups:groups.filter(g=>g.type===type).length})}
  // Decode each photo/misc cover with the actual packaged protocol. No reader
  // is opened, so inspection creates no progress, bookmarks or test records.
  let decoded=0
  for(const item of all.filter(i=>i.type!=='comic')){const image=new Image();image.src='baoyi://image/'+item.coverPageId+'?thumb=1';await image.decode();if(!image.naturalWidth)throw Error('Cover decode failed');decoded++}
  return {out,decoded}
 })
 for(const expected of report.counts){const observed=counts.out.find((c:any)=>c.type===expected.item_type);assert.equal(observed.items,expected.items);assert.equal(observed.pages,expected.pages)}
 fs.writeFileSync('output/photo-library-2026-10-29/real-runtime.json',JSON.stringify({status:'passed',version:'0.17.7',...counts},null,2))
 console.log('PASS real migrated library counts and '+counts.decoded+' actual cover decodes')
}finally{await app.close()}
assert.equal(fingerprint(),before,'Actual library records must remain unchanged by runtime inspection')
console.log('PASS actual resource, category, page, chapter, bookmark and progress records unchanged by runtime inspection')
