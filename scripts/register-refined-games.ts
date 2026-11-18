/** Explicit, auditable local registration using the same implementation as the app. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { previewGameProjects,importGameProjects } from '../electron/kinds/game/project-catalog.ts'
import { getGame } from '../electron/kinds/game/db.ts'
import type { LinkedFile } from '../src/types/game.ts'
import type { GameArtworkChoices, GameArtworkDifference } from '../src/types/game-project.ts'

const argument=(name:string)=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1)||''
const database=path.resolve(argument('--database')),source=path.resolve(argument('--catalog')),output=path.resolve(argument('--output')),apply=process.argv.includes('--apply')
let keys=argument('--keys').split(',').filter(Boolean)
if(!argument('--database')||!argument('--catalog')||!argument('--output')||(!keys.length&&!process.argv.includes('--all')))throw Error('Required: --database=... --catalog=... --output=... --keys=id,id or --all [--apply]')
fs.mkdirSync(output,{recursive:true})
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const db=new DatabaseSync(database,{readOnly:!apply})
try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
  const preview=previewGameProjects(db,source)
  if(process.argv.includes('--all'))keys=preview.candidates.map(c=>c.key)
  const candidates=keys.map(key=>{
    const value=preview.candidates.find(c=>c.key===key);assert.ok(value&&!value.problem,`${key}: ${value?.problem||'not eligible'}`);return value
  })
  const artwork: GameArtworkChoices = process.argv.includes('--artwork') ? Object.fromEntries(candidates.map(c=>[c.key,(c.artwork||[]).filter(a=>!['protected','unavailable','current'].includes(a.state)).map(a=>a.role)])) : {}
  const context={coversDir:path.join(path.dirname(database),'covers'),recoveryDir:path.join(path.dirname(database),'project-artwork-recovery')}
  fs.writeFileSync(path.join(output,'registration-preview.json'),JSON.stringify(preview,null,2))
  if(!apply){console.log(JSON.stringify(candidates.map(c=>({key:c.key,name:c.name,existingId:c.existingId,links:c.links.length})),null,2))}
  else{
    const backup=path.join(output,'before-registration-full.db');assert.ok(!fs.existsSync(backup),'Backup already exists; use a fresh output directory')
    db.prepare('VACUUM INTO ?').run(backup)
    const verify=new DatabaseSync(backup,{readOnly:true});assert.equal((verify.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');verify.close()
    const files=[...new Set([source,...candidates.flatMap(c=>[...c.launchers,...c.links.map(f=>f.path)])])]
    const fingerprint=(file:string)=>{const st=fs.statSync(file);return {path:file,bytes:st.size,mtime:st.mtimeMs,kind:st.isDirectory()?'directory':'file',sha256:st.isFile()&&st.size<=16*1024*1024?hash(fs.readFileSync(file)):null}}
    const sourceFiles=files.map(fingerprint)
    fs.writeFileSync(path.join(output,'source-files-before.json'),JSON.stringify(sourceFiles,null,2))
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(r=>r.name)
    const snapshot=()=>Object.fromEntries(tables.map(table=>{
      const columns=db.prepare(`PRAGMA table_info("${table.replaceAll('"','""')}")`).all() as {name:string;pk:number}[]
      const order=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>'"'+c.name.replaceAll('"','""')+'"').join(',')||'rowid'
      const records=db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}" ORDER BY ${order}`).all() as Record<string,unknown>[]
      const primary=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk)
      return [table,Object.fromEntries(records.map((row,index)=>[primary.length?JSON.stringify(primary.map(c=>row[c.name])):String(index),row]))]
    }))
    const verifyBefore=new DatabaseSync(backup,{readOnly:true})
    db.exec('BEGIN IMMEDIATE')
    let result
    try{
      const before=snapshot();result=importGameProjects(db,preview,keys,artwork,context);const after=snapshot()
      const existing=new Map(candidates.filter(c=>c.existingId).map(c=>[c.existingId!,c]))
      assert.equal(result.created,candidates.filter(c=>!c.existingId).length)
      for(const table of tables){
        const old=before[table],next=after[table]
        if(!['resource','game_meta','categories'].includes(table)){assert.deepEqual(next,old,`${table} changed`);continue}
        for(const [key,row] of Object.entries(old)){
          assert.ok(next[key],`Existing ${table} row removed`)
          const previous={...row},current={...next[key]},candidate=existing.get(String(row.id||row.resource_id))
          if(candidate&&table==='resource'){
            for(const field of ['updated_at',...(!row.summary?['summary']:[]),...(!row.description?['description']:[]),...(candidate.relocate?['path','source_dir','file_name','file_size']:[])]){delete previous[field];delete current[field]}
          }
          if(candidate&&table==='game_meta'){
            const oldGame=getGame(verifyBefore,candidate.existingId!)!
            const rebase=(target:string)=>candidate.relocate&&target&&path.relative(oldGame.source_dir,target)!=='..'&&!path.relative(oldGame.source_dir,target).startsWith('..'+path.sep)&&!path.isAbsolute(path.relative(oldGame.source_dir,target))?path.join(candidate.root,path.relative(oldGame.source_dir,target)):target
            const links=JSON.parse(String(current.linked_files))
            for(const link of JSON.parse(String(row.linked_files))){
              const found=links.find((l:any)=>l.path===rebase(link.path));assert.ok(found,'Old attachment removed')
              const incoming: LinkedFile | undefined=candidate.links.find(l=>path.resolve(l.path).toLowerCase()===path.resolve(rebase(link.path)).toLowerCase())
              for(const [field,value] of Object.entries(link)){
                if(field==='catalog'&&incoming){assert.deepEqual(found.catalog,incoming.catalog,'Catalog provenance differs from preview');continue}
                if(field==='project'&&incoming?.project){
                  const {history:actualHistory,artwork:actualArtwork,...actualProject}=found.project
                  const {history:previewHistory,...previewProject}=incoming.project
                  assert.deepEqual(actualProject,previewProject,'Project state differs from preview')
                  for(const role of ['portrait','wide'] as const){
                    if(artwork[candidate.key]?.includes(role)){
                      const image: GameArtworkDifference=candidate.artwork!.find(a=>a.role===role)!
                      assert.equal(actualArtwork?.[role]?.sha256,image.sha256)
                      assert.equal(hash(fs.readFileSync(actualArtwork[role].installedPath)),image.sha256)
                    }else assert.deepEqual(actualArtwork?.[role],link.project.artwork?.[role],'Personal artwork record changed')
                  }
                  const previous=link.project
                  if(previous.revision===found.project.revision)assert.deepEqual(actualHistory,previous.history)
                  else{
                    assert.deepEqual(actualHistory.slice(0,-1),previous.history.slice(-19),'Project history was not preserved')
                    assert.equal(actualHistory.at(-1).revision,found.project.revision)
                  }
                  continue
                }
                if(incoming&&['note','features','usage','fit_version','purpose'].includes(field)&&link.catalog&&JSON.stringify(value)===JSON.stringify(link.catalog.fields[field])){
                  assert.deepEqual(found[field],incoming[field as keyof typeof incoming]??value,`Generated ${field} differs from preview`);continue
                }
                if(field==='path')continue
                if(!link.catalog&&incoming&&(field==='note'&&String(value).startsWith('【项目精修档案】')||['usage','fit_version','features'].includes(field)&&(!value||Array.isArray(value)&&!value.length))){
                  assert.deepEqual(found[field],incoming[field as keyof typeof incoming]??value,`Initial generated ${field} differs from preview`);continue
                }
                assert.deepEqual(found[field],value,`Personal attachment ${field} changed`)
              }
            }
            delete previous.linked_files;delete current.linked_files
            for(const role of artwork[candidate.key]||[]){
              const image: GameArtworkDifference=candidate.artwork!.find(a=>a.role===role)!,key=role==='portrait'?'cover_path':'background_path'
              assert.equal(hash(fs.readFileSync(String(current[key]))),image.sha256)
              for(const field of [key,...(role==='portrait'?['cover_source','cover_source_url','cover_status','cover_detail']:[])]){delete previous[field];delete current[field]}
            }
            if(candidate.relocate){
              assert.equal(current.save_paths,JSON.stringify(oldGame.save_paths.map(v=>({...v,path:rebase(v.path),verified_at:0}))))
              assert.equal(current.cover_path,rebase(oldGame.cover_path));assert.equal(current.background_path,rebase(oldGame.background_path))
              for(const field of ['save_paths','cover_path','background_path']){delete previous[field];delete current[field]}
            }
          }
          assert.deepEqual(current,previous,`Unexpected existing ${table} change`)
        }
      }
      assert.equal(Object.keys(after.resource).length-Object.keys(before.resource).length,result.created)
      assert.equal(Object.keys(after.game_meta).length-Object.keys(before.game_meta).length,result.created)
      for(const file of sourceFiles)assert.deepEqual(fingerprint(file.path),file,`Source changed: ${file.path}`)
      assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok')
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
      fs.writeFileSync(path.join(output,'table-audit.json'),JSON.stringify({before:Object.fromEntries(Object.entries(before).map(([table,rows])=>[table,hash(JSON.stringify(rows))])),after:Object.fromEntries(Object.entries(after).map(([table,rows])=>[table,hash(JSON.stringify(rows))]))},null,2))
      db.exec('COMMIT')
    }catch(error){db.exec('ROLLBACK');throw error}finally{verifyBefore.close()}
    const items=result.items.map(value=>getGame(db,value.id)!)
    const audit={date:new Date().toISOString(),database,backup,backupSha256:hash(fs.readFileSync(backup)),catalogSha256:preview.digest,result,items:items.map(g=>({id:g.id,name:g.name_zh,path:g.path,source_dir:g.source_dir,links:g.linked_files.length,play_status:g.play_status,save_paths:g.save_paths})),sourceFilesVerified:sourceFiles.length,personalDataPreserved:true,otherTablesUnchanged:true,integrity:'ok'}
    fs.writeFileSync(path.join(output,'registration-result.json'),JSON.stringify(audit,null,2))
    console.log(JSON.stringify({created:result.created,updated:result.updated,unchanged:result.unchanged,links:items.reduce((sum,g)=>sum+g.linked_files.length,0),sourceFilesVerified:sourceFiles.length,backup,items:audit.items.map(g=>({id:g.id,name:g.name}))},null,2))
  }
}finally{db.close()}
