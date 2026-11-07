import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { pngImage } from './helpers/test-images.ts'
const output=path.resolve('output/photo-library-2026-10-29');fs.mkdirSync(output,{recursive:true})
const fixture=fs.mkdtempSync(path.join(output,'migration-fixture-')),root=path.join(fixture,'图片'),profile=path.join(fixture,'profile'),evidence=path.join(fixture,'evidence')
fs.mkdirSync(profile);const db=new DatabaseSync(path.join(profile,'baoyi.db'));initSchema(db,KINDS)
const lib=new ImageLibrary(db),group=lib.saveGroup({name:'漫画分类'})
for(const [name,type]of [['漫画分类/作品一','comic'],['作品二','comic'],['AI生图/插图组','photo'],['照片/旅行','photo']]as const){
 const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'1.png'),pngImage(100,150));fs.writeFileSync(path.join(dir,'附带说明.txt'),'preserve me')
 if(name.startsWith('照片'))continue
 const item=lib.register((await scanImageImport(dir,type,false))[0]);if(type==='comic'){lib.update(item.id,{groupId:group.id});lib.saveProgress(item.id,lib.pages(item.id)[0].id,.3)}
}
fs.mkdirSync(path.join(root,'照片','录像'));fs.writeFileSync(path.join(root,'照片','录像','1.mp4'),'synthetic video')
db.close()
const result=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','scripts/organize-photo-data.ts',profile,root,evidence,'--fixture'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr)
const report=JSON.parse(fs.readFileSync(path.join(evidence,'result.json'),'utf8'))
assert.equal(report.originalFiles,9);assert.equal(report.imports.length,1);assert.equal(report.skipped.length,1)
assert.ok(fs.existsSync(path.join(root,'漫画','漫画分类','作品二','1.png')))
assert.ok(fs.existsSync(path.join(root,'杂图','插图组','附带说明.txt')))
const check=new DatabaseSync(path.join(profile,'baoyi.db'),{readOnly:true});assert.equal(new ImageLibrary(check).list({type:'misc'}).length,1);check.close()
console.log('PASS actual migration script on isolated filesystem/database, sidecars, videos, categories, IDs and progress')
