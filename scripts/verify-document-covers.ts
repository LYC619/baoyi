import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { DocumentLibrary } from '../electron/workspace/documents.ts'
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==','base64'))

test('cover cache validates sources, tokens, PNG and library identity',async t=>{
  const {DocumentCovers}=await import('../electron/workspace/document-covers.ts')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-covers-'))
  const makeDb=()=>{const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);return db}
  const originalDb=makeDb(),otherDb=makeDb();let active=originalDb,now=1000
  t.after(async()=>{originalDb.close();otherDb.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true})})
  const docs=new DocumentLibrary(originalDb),source=path.join(root,'a.pdf');await fs.writeFile(source,'fake pdf data')
  const a=await docs.register(source),bFile=path.join(root,'b.pdf');await fs.writeFile(bFile,'b');const b=await docs.register(bFile)
  const cache=path.join(root,'cache','document-covers','v1'),service=new DocumentCovers(()=>active,cache,()=>now)
  const miss=await service.get(a.id);assert.equal(miss.state,'render');if(miss.state!=='render')return
  assert.equal((await service.source(a.id,miss.token)).format,'pdf')
  assert.equal(await service.put(a.id,miss.token,png).then(r=>r.stored),true)
  const hit=await service.get(a.id);assert.equal(hit.state,'ready');assert.equal(hit.key,miss.key)
  await fs.writeFile(path.join(cache,miss.key+'.png'),'broken cache');assert.equal((await service.get(a.id)).state,'render')
  const old=await service.get(a.id);if(old.state!=='render')throw Error('expected miss')
  await fs.writeFile(source,'modified source bytes');const changed=await service.get(a.id);assert.notEqual(changed.key,old.key)
  assert.equal((await service.put(a.id,old.token,png)).stored,false)
  await assert.rejects(()=>service.source(a.id,old.token))
  if(changed.state!=='render')throw Error('expected render')
  await assert.rejects(()=>service.source(b.id,changed.token))
  assert.equal((await service.put(b.id,changed.token,png)).stored,false)
  await assert.rejects(()=>service.put(a.id,changed.token,new Uint8Array([1,2,3])))
  await assert.rejects(()=>service.put(a.id,changed.token,new Uint8Array(2*1024*1024+1)))
  const corrupt=png.slice();corrupt[corrupt.length-15]^=1;await assert.rejects(()=>service.put(a.id,changed.token,corrupt))
  now+=600001;assert.equal((await service.put(a.id,changed.token,png)).stored,false)
  const fresh=await service.get(a.id);if(fresh.state!=='render')throw Error('expected render')
  active=otherDb;assert.equal((await service.put(a.id,fresh.token,png)).stored,false);active=originalDb
  const relocated=await service.get(a.id);if(relocated.state!=='render')throw Error('expected render')
  const moved=path.join(root,'moved.pdf');await fs.rename(source,moved);await docs.relocate(a.id,moved)
  assert.notEqual((await service.get(a.id)).key,relocated.key)
  assert.equal((await service.put(a.id,relocated.token,png)).stored,false)
  const newToken=await service.get(a.id);if(newToken.state!=='render')throw Error('expected render')
  await fs.unlink(moved);assert.equal((await service.get(a.id)).state,'unavailable');await assert.rejects(()=>service.source(a.id,newToken.token))
  const md=path.join(root,'text.md');await fs.writeFile(md,'# title');assert.equal((await service.get((await docs.register(md)).id)).state,'unavailable')
  assert.equal(await fs.readFile(bFile,'utf8'),'b','cache does not modify sources')
})
