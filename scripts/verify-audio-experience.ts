import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {registerVideoContent} from '../electron/kinds/video/registration.ts'
import {listEpisodes} from '../electron/kinds/video/db.ts'
import {registerVideoAsset} from '../electron/kinds/video/library.ts'
import {audioResponse} from '../electron/kinds/video/audio-playback.ts'
import {parseLyrics,activeLyricIndex} from '../src/utils/lyrics.ts'

test('LRC combines translated timestamps, repeated tags, fractions and offset',()=>{
  const parsed=parseLyrics('[ti:歌曲]\n[offset:-500]\n[00:02.50][00:05.125]同一句\n[00:02.500]Translation\n[00:00.20]开场\n[ar:演奏者]')
  assert.equal(parsed.timed,true)
  assert.deepEqual(parsed.lines,[{time:0,text:'开场'},{time:2,text:'同一句\nTranslation'},{time:4.625,text:'同一句'}])
  assert.equal(activeLyricIndex(parsed.lines,1),0);assert.equal(activeLyricIndex(parsed.lines,2),1)
  assert.equal(activeLyricIndex([{time:5,text:'later'}],1),-1)
  assert.deepEqual(parseLyrics('[ti:标题]\n第一行\n\n<script>文字原样保留</script>'),{timed:false,lines:[{time:null,text:'第一行'},{time:null,text:'<script>文字原样保留</script>'}]})
})

function fixture(run:(db:DatabaseSync,root:string,id:string,episodes:ReturnType<typeof listEpisodes>)=>Promise<void>){return async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-lyrics-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try{
    const items=['晨光','晚风'].map((title,i)=>{const file=path.join(root,title+'.wav');fs.writeFileSync(file,'audio');return{title,order:i+1,files:[{path:file}]}})
    const {resourceId:id}=registerVideoContent(db,{mediaKind:'audio',title:'合成专辑',category:'音频',items})
    await run(db,root,id,listEpisodes(db,id))
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true})}
}}
const lyrics=async(db:DatabaseSync,id:string,episode:string)=>{const response=await audioResponse(db,new Request(`baoyi://audio/${id}/${episode}?lyrics=1`));assert.equal(response.status,200);return response.json()}

test('same-name sidecars belong to their own track, plain text and UTF-16 decode',fixture(async(db,root,id,ep)=>{
  fs.writeFileSync(path.join(root,'晨光.lrc'),'[00:01]晨光歌词')
  fs.writeFileSync(path.join(root,'晚风.txt'),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('晚风歌词\n第二行','utf16le')]))
  assert.equal((await lyrics(db,id,ep[0].id)).lines[0].text,'晨光歌词')
  const second=await lyrics(db,id,ep[1].id);assert.equal(second.timed,false);assert.equal(second.lines[0].text,'晚风歌词')
  assert.equal((await audioResponse(db,new Request(`baoyi://audio/${id}/foreign?lyrics=1`))).status,404)
}))
test('downloaded registered lyrics have priority and missing registration is explicit',fixture(async(db,root,id,ep)=>{
  const file=path.join(root,'下载歌词.lrc');fs.writeFileSync(file,'[00:03]已登记歌词')
  registerVideoAsset(db,{resourceId:id,episodeId:ep[0].id,path:file,role:'attachment'})
  assert.equal((await lyrics(db,id,ep[0].id)).source,file)
  assert.equal((await lyrics(db,id,ep[1].id)).status,'none')
  fs.unlinkSync(file);const missing=await lyrics(db,id,ep[0].id);assert.equal(missing.status,'unavailable');assert.match(missing.message,/缺失/)
}))
test('empty and oversized lyrics produce an honest state without leaking arbitrary query paths',fixture(async(db,root,id,ep)=>{
  const file=path.join(root,'晨光.lrc');fs.writeFileSync(file,'[ti:元信息]\n')
  assert.match((await lyrics(db,id,ep[0].id)).message,/为空/)
  fs.writeFileSync(file,Buffer.alloc(512*1024+1,65));assert.match((await lyrics(db,id,ep[0].id)).message,/512 KB/)
  fs.unlinkSync(file)
  const outsider=path.join(root,'private.txt');fs.writeFileSync(outsider,'PRIVATE')
  const response=await audioResponse(db,new Request(`baoyi://audio/${id}/${ep[0].id}?lyrics=${encodeURIComponent(outsider)}`))
  const value=await response.json();assert.equal(value.status,'none');assert.equal(JSON.stringify(value).includes('PRIVATE'),false)
}))
test('hidden audio and missing media cannot be used to read lyrics',fixture(async(db,_root,id,ep)=>{
  db.prepare('UPDATE resource SET category=? WHERE id=?').run('里番',id)
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('hide_hentai','true')
  assert.equal((await audioResponse(db,new Request(`baoyi://audio/${id}/${ep[0].id}?lyrics=1`))).status,404)
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('false','hide_hentai')
  fs.unlinkSync(ep[0].path);assert.equal((await audioResponse(db,new Request(`baoyi://audio/${id}/${ep[0].id}?lyrics=1`))).status,404)
}))
