import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ComicCoverCache} from '../electron/kinds/image/comic-cover-cache.ts'
const bytes=Buffer.from([255,216,10,20,255,217]),cover='data:image/jpeg;base64,'+bytes.toString('base64')
test('cover cache: disk hits, expiry, corruption, bounds and cancellation',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-cover-')),signal=new AbortController().signal
  try{
    let loads=0;const load=async()=>{loads++;return cover}
    const cache=new ComicCoverCache(root,{ttl:60000,count:2,bytes:12})
    assert.equal(await cache.get('123',signal,load),cover)
    assert.equal(await new ComicCoverCache(root).get('123',signal,load),cover);assert.equal(loads,1)
    await fs.writeFile(path.join(root,'123.jpg'),'broken')
    assert.equal(await cache.get('123',signal,load),cover);assert.equal(loads,2)
    await fs.utimes(path.join(root,'123.jpg'),new Date(0),new Date(0))
    await cache.get('123',signal,load);assert.equal(loads,3)
    await cache.get('124',signal,load);await cache.get('125',signal,load)
    assert.equal((await fs.readdir(root)).length,2)
    assert.equal(await fs.stat(path.join(root,'123.jpg')).catch(()=>null),null)
    const controller=new AbortController()
    await assert.rejects(cache.get('126',controller.signal,async()=>{controller.abort();return cover}))
    assert.equal(await fs.stat(path.join(root,'126.jpg')).catch(()=>null),null)
    await assert.rejects(cache.get('../escape',signal,load),/编号/)
  }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('cover cache write failures reach the caller',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-cover-failure-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const blocked=path.join(root,'blocked')
  await fs.writeFile(blocked,'fixture')
  const cache=new ComicCoverCache(blocked)
  await assert.rejects(cache.get('123',new AbortController().signal,async()=>cover),{code:'EEXIST'})
})
