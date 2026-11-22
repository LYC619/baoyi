import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {downloadTarget,rememberDownloadRoot,validateDownloadRoot} from '../electron/kinds/image/download-target.ts'
import {ImageLibrary} from '../electron/kinds/image/library.ts'
import {scanImageImport} from '../electron/kinds/image/scanner.ts'
import {pngImage} from './helpers/test-images.ts'
import {ComicRuntime} from '../electron/kinds/image/comic-runtime.ts'
const root=path.resolve('output/interaction-fixes-2026-11-07/source-tests');await fs.mkdir(root,{recursive:true})
test('目标目录记忆按来源隔离，兼容旧JM偏好，拒绝相对目录与文件',async()=>{
  const profile=await fs.mkdtemp(path.join(root,'profile-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  await fs.writeFile(path.join(profile,'comic-preferences.json'),JSON.stringify({root:profile}))
  assert.equal((await downloadTarget(db,profile,'jm')).root,profile)
  assert.equal((await downloadTarget(db,profile,'pica')).root,'')
  await Promise.all([rememberDownloadRoot(profile,'pica',profile),rememberDownloadRoot(profile,'jm',profile)]);assert.equal((await downloadTarget(db,profile,'jm')).root,profile);assert.equal((await downloadTarget(db,profile,'pica')).root,profile)
  assert.equal(await validateDownloadRoot(profile),profile)
  await assert.rejects(validateDownloadRoot('relative'),/选择/);await assert.rejects(validateDownloadRoot(path.join(profile,'comic-preferences.json')),/不是目录/);db.close()
})
test('新JM浏览协议读取轻量结果和分页，输入与过多结果受限',async()=>{
  const folder=await fs.mkdtemp(path.join(root,'protocol-')),bridge=path.join(folder,'fake.py')
  await fs.writeFile(bridge,`import json,sys\nr=json.loads(sys.stdin.readline());seq=0\ndef emit(event,**value):\n global seq\n seq+=1\n print(json.dumps(dict(protocolVersion=1,jobId=r['jobId'],sequence=seq,event=event,**value)),flush=True)\nassert r['action']=='browse' and 'workId' not in r\nfor i in range(101 if r.get('query')=='overflow' else 2):emit('browse_item',value=dict(id=str(i+1),title='fixture',tags=[]))\nemit('browse_page',page=r['page'],pages=4)\nemit('complete')\n`)
  const runtime=new ComicRuntime({python:path.resolve('output/hermes-runtime/python/python.exe'),runtime:folder,bridge,proxies:async()=>({})})
  const result=await runtime.browse('browse-fixture',{mode:'ranking',period:'all',page:2},new AbortController().signal)
  assert.equal(result.items.length,2);assert.equal(result.pages,4)
  await assert.rejects(runtime.browse('bad',{mode:'search',page:1,query:''},new AbortController().signal),/搜索条件/)
  await assert.rejects(runtime.browse('overflow',{mode:'search',page:1,query:'overflow'},new AbortController().signal),/列表格式/)
})

test('补章目标锁定到原作品目录和分类，来源记忆不能覆盖原位置',async()=>{
  const profile=await fs.mkdtemp(path.join(root,'bound-')),work=path.join(profile,'original-work');await fs.mkdir(work);await fs.writeFile(path.join(work,'1.png'),pngImage(20,30))
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS);const library=new ImageLibrary(db),item=library.register((await scanImageImport(work,'comic',false))[0])
  for(const provider of ['pica','jm'] as const){
    db.prepare('UPDATE image_meta SET source=?, source_id=? WHERE resource_id=?').run(provider,'123',item.id)
    await rememberDownloadRoot(profile,provider,path.join(profile,'other'))
    const target=await downloadTarget(db,profile,provider,'123');assert.equal(target.locked,true);assert.equal(target.root,profile);assert.equal(target.directory,'original-work');assert.equal(target.groupId,item.groupId)
  }
  db.close()
})
