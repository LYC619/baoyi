import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { scanVideoRoot } from '../electron/kinds/video/scanner.ts'
import { mergeFacts } from '../electron/kinds/video/facts.ts'
import { mapMediaInfo } from '../electron/kinds/video/mediainfo.ts'
import { registerLocalVideoFacts } from '../electron/kinds/video/registration.ts'
import { listVideos, updateVideo } from '../electron/kinds/video/db.ts'
import {audioFile,audioResponse} from '../electron/kinds/video/audio-playback.ts'
import {listEpisodes} from '../electron/kinds/video/db.ts'
import {persistVideoWorkBundle} from '../electron/kinds/video/local-sync.ts'
import {registerVideoBundle} from '../electron/kinds/video/registration.ts'

test('同一课程目录中的音频与视频保持独立归属',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-course-audio-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try{
    for(const name of ['01.讲义.mp3','02.讲义.mp3','1.入门.mp4','2.进阶.mp4'])fs.writeFileSync(path.join(root,name),'fixture')
    const candidates=scanVideoRoot(root)
    assert.equal(candidates.length,2)
    assert.ok(candidates.every(c=>c.shared_directory),'neither work owns the mixed folder')
    for(const c of [...candidates].reverse())registerLocalVideoFacts(db,mergeFacts(c,null,new Map(),new Map()))
    assert.equal(listVideos(db,{type:'audio'}).length,1)
    assert.equal(listVideos(db,{type:'other'}).length,1)
    assert.ok(listVideos(db).every(v=>listEpisodes(db,v.id).length===2))
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('音频目录导入曲目、读取标签，并可按音频类型筛选', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-audio-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    for(const name of ['01.晨曲.mp3','02.夜曲.flac'])fs.writeFileSync(path.join(root,name),'fixture')
    const rows=scanVideoRoot(root)
    assert.equal(rows.length,1);assert.equal(rows[0].episodes.length,2)
    const info=mapMediaInfo({media:{track:[{'@type':'General',Album:'山水',Performer:'演奏者',Track:'晨曲',Duration:'63'},{'@type':'Audio',Format:'FLAC',SamplingRate:'48000',BitDepth:'24',BitRate:'920000'}]}})
    assert.deepEqual(info.music,{title:'晨曲',artist:'演奏者',album:'山水',track:0,sampleRate:48000,bitDepth:24,bitRate:920000})
    const facts=mergeFacts(rows[0],null,new Map(),new Map())
    registerLocalVideoFacts(db,facts)
    assert.equal(listVideos(db,{type:'audio'}).length,1)
    assert.equal(listVideos(db,{type:'other'}).length,0)
    assert.equal(listVideos(db,{type:'movie'}).length,0)
    updateVideo(db,listVideos(db,{type:'audio'})[0].id,{category:'古典音乐'})
    assert.equal(listVideos(db,{type:'audio'}).length,1,'custom categories must not lose audio type')
    const item=listVideos(db,{type:'audio'})[0],episode=listEpisodes(db,item.id)[0]
    assert.equal(audioFile(db,item.id,episode.id),path.join(root,'01.晨曲.mp3'))
    assert.throws(()=>audioFile(db,item.id,'foreign-episode'),/不可用/)
    const response=await audioResponse(db,new Request(`baoyi://audio/${item.id}/${episode.id}`,{headers:{Range:'bytes=1-3'}}))
    assert.equal(response.status,206);assert.equal(await response.text(),'ixt')
    assert.equal((await audioResponse(db,new Request(`baoyi://audio/${item.id}/${episode.id}`,{headers:{Range:'bytes=900-'}}))).status,416)
    persistVideoWorkBundle(db,item.id,root)
    db.prepare('DELETE FROM resource WHERE id=?').run(item.id)
    registerVideoBundle(db,root,true)
    assert.equal(listVideos(db,{type:'audio'}).length,1,'audio type survives manifest export and reimport')
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true})}
})
