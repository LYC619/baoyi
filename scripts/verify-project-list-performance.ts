import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {ProjectLibrary} from '../electron/kinds/project/library.ts'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-project-list-')),db=new DatabaseSync(':memory:')
try{
  initSchema(db,KINDS)
  for(let i=0;i<1000;i++){
    const id='fixture-'+i,directory=path.join(root,id);await fs.mkdir(directory)
    db.prepare("INSERT INTO resource(id,kind,path,file_name,name_zh,created_at,updated_at) VALUES(?,'project',?,?,?,1,1)").run(id,directory,id,'合成项目 '+i)
    db.prepare('INSERT INTO project_meta(resource_id) VALUES(?)').run(id)
    db.prepare('INSERT INTO project_context(resource_id,current_text,next_text) VALUES(?,?,?)').run(id,'当前进度'.repeat(1000),'下一步'.repeat(600))
  }
  let queries=0
  const library=new ProjectLibrary({prepare:(sql:string)=>{queries++;return db.prepare(sql)},exec:(sql:string)=>db.exec(sql)} as any),samples:number[]=[]
  for(let i=0;i<35;i++){
    queries=0;const started=performance.now(),items=library.list(),ms=performance.now()-started
    assert.equal(items.length,1000);assert.equal(items[0].contextPreview!.current.length,90);assert.equal(queries,1)
    if(i>=5)samples.push(ms)
  }
  samples.sort((a,b)=>a-b);const p95=samples[Math.ceil(samples.length*.95)-1]
  const result={projects:1000,samples:30,queriesPerList:1,p95Ms:p95,medianMs:samples[15],maxMs:samples.at(-1),scope:'local temporary directories + in-memory SQLite; not network disks or renderer paint'}
  const output = process.env.BAOYI_TEST_DATA_DIR || root
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'list-performance.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result));assert.ok(p95<100,'本地1000项目列表 p95 应小于100ms')
}finally{db.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-project-list-')));await fs.rm(root,{recursive:true,force:true})}
