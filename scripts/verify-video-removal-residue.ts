import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { reserveWorkDirectory, writeBundleFiles } from '../electron/kinds/video/bundle.ts'
import { registerVideoBundleData } from '../electron/kinds/video/registration.ts'
import { previewVideoRemoval, applyVideoRemoval } from '../electron/kinds/video/management.ts'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-residue-'))
const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
try {
  for(const mode of ['clean','edited','retry']) {
    const edited=mode==='edited'
    const {directory,bundleId}=reserveWorkDirectory(root,'清理样例-'+mode,'fixture-'+mode)
    const video=path.join(directory,'1.mp4');fs.writeFileSync(video,'fixture')
    const artwork=path.join(root,'poster.png');fs.writeFileSync(artwork,'fixture artwork')
    const input={directory,bundleId,title:'测试作品',description:'测试简介',poster:{path:artwork},files:[{path:video,title:'第一集',order:1}]}
    writeBundleFiles(input);const {bundle}=writeBundleFiles(input)
    const id=registerVideoBundleData(db,directory,bundle).resourceId
    const recordOnly=previewVideoRemoval(db,{resourceIds:[id],action:'remove',deleteLocal:false})
    assert.ok(recordOnly.files.length)
    const episode=db.prepare('SELECT id FROM episode WHERE resource_id=?').get(id)!.id as string
    assert.ok(!previewVideoRemoval(db,{resourceIds:[id],episodeId:episode,action:'remove',deleteLocal:true}).files.some(f=>path.basename(f.path)==='baoyi.json'),'single episode preserves work manifest')
    if(edited){fs.writeFileSync(path.join(directory,'简介.md'),'我的笔记');fs.writeFileSync(path.join(directory,'.baoyi','keep.txt'),'保留')}
    const preview=previewVideoRemoval(db,{resourceIds:[id],action:'remove',deleteLocal:true})
    assert.ok(preview.files.some(f=>path.basename(f.path)==='baoyi.json'),'whole-work removal must include bundle manifest')
    assert.ok(preview.files.some(f=>path.basename(f.path)==='.baoyi-owner.json'),'owner marker included')
    if(edited){fs.appendFileSync(video,'changed');await assert.rejects(applyVideoRemoval(db,preview,async()=>{throw Error('must not delete')}),/已变化/)}
    if(mode==='retry') {
      await assert.rejects(applyVideoRemoval(db,preview,async file=>{if(path.basename(file)==='baoyi.json.bak')throw Error('busy fixture');fs.unlinkSync(file)}),/busy fixture/)
      assert.ok(fs.existsSync(path.join(directory,'baoyi.json')),'keep authoritative manifest until companion cleanup succeeds')
    }
    await applyVideoRemoval(db,previewVideoRemoval(db,preview.request),async file=>{assert.ok(path.resolve(file).startsWith(root+path.sep));fs.unlinkSync(file)})
    if(!edited)assert.equal(fs.existsSync(directory),false,'no managed residue or empty work folder')
    else {assert.equal(fs.readFileSync(path.join(directory,'简介.md'),'utf8'),'我的笔记');assert.ok(fs.existsSync(path.join(directory,'.baoyi','keep.txt')))}
  }
  console.log('PASS complete work cleanup and preservation of edited/unknown files')
}finally{db.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true})}
