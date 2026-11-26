import fs from 'node:fs/promises'
import path from 'node:path'
import type { SqlDb } from '../../services/storage/schema.ts'
import { getVideo } from './db.ts'
import { listVideoAssets } from './library.ts'
import { parseLyrics, type AudioLyrics } from '../../../src/utils/lyrics.ts'

const LIMIT=512*1024
const key=(value:string)=>path.resolve(value).toLowerCase()
function decode(bytes:Buffer):string {
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes)
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes)
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return new TextDecoder('gb18030').decode(bytes)}
}

/** file comes only from audioFile, after resource and episode ownership checks. */
export async function readTrackLyrics(db:SqlDb,id:string,episode:string,file:string):Promise<AudioLyrics> {
  const stem=path.basename(file,path.extname(file)),dir=path.dirname(file)
  const isLyric=(p:string)=>/\.lrc$/i.test(p)||(/\.txt$/i.test(p)&&(path.basename(p,path.extname(p)).toLowerCase()===stem.toLowerCase()||/歌词|lyrics/i.test(path.basename(p))))
  const registered=listVideoAssets(db,id,episode||undefined).filter(a=>a.role==='attachment'&&isLyric(a.path)).map(a=>a.path)
  // Legacy work-wide attachments need a matching filename to avoid another track's lyrics.
  registered.push(...(getVideo(db,id)?.linked_files||[]).map(f=>f.path).filter(p=>isLyric(p)&&path.basename(p,path.extname(p)).toLowerCase()===stem.toLowerCase()))
  registered.sort((a,b)=>Number(path.basename(b,path.extname(b)).toLowerCase()===stem.toLowerCase())-Number(path.basename(a,path.extname(a)).toLowerCase()===stem.toLowerCase()))
  const sidecars=[path.join(dir,stem+'.lrc'),path.join(dir,stem+'.txt')]
  const candidates=[...new Set([...registered,...sidecars])]
  let failure=''
  for(const candidate of candidates){
    let handle: Awaited<ReturnType<typeof fs.open>>|undefined
    try{
      if(!registered.some(p=>key(p)===key(candidate)) && key(path.dirname(await fs.realpath(candidate)))!==key(await fs.realpath(dir)))throw Error('歌词链接指向曲目目录之外')
      handle=await fs.open(candidate,'r')
      const stat=await handle.stat()
      if(!stat.isFile()||stat.size>LIMIT)throw Error('歌词须为不超过 512 KB 的文本文件')
      const buffer=Buffer.alloc(LIMIT+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0)
      if(bytesRead>LIMIT)throw Error('歌词文件过大')
      const parsed=parseLyrics(decode(buffer.subarray(0,bytesRead)))
      if(!parsed.lines.length){failure='歌词文件为空';continue}
      return {status:'available',source:candidate,...parsed,message:''}
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code
      if(code!=='ENOENT'||registered.some(p=>key(p)===key(candidate)))failure=code==='ENOENT'?'已关联的歌词文件缺失或所在磁盘未连接':error instanceof Error?error.message:'歌词读取失败'
    }finally{await handle?.close()}
  }
  return {status:failure?'unavailable':'none',source:'',lines:[],timed:false,message:failure||'暂无本地歌词。可将同名 .lrc 或 .txt 放在曲目旁，再点击刷新歌词。'}
}
