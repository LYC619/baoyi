import fs from 'node:fs'
import { Readable } from 'node:stream'
import type { SqlDb } from '../../services/schema.ts'
import { isAudioFile } from '../../../src/utils/audio.ts'
import { getVideo, listEpisodes } from './db.ts'
import { readContainerInfo } from './mediainfo.ts'

export function audioFile(db:SqlDb,resourceId:string,episodeId=''):string {
  const item=getVideo(db,resourceId)
  if(!item || item.media_kind!=='audio')throw new Error('音频不可用')
  const file=episodeId?listEpisodes(db,resourceId).find(e=>e.id===episodeId)?.path:item.parts[0]?.path||item.path
  if(!file || !isAudioFile(file))throw new Error('曲目不可用')
  return file
}
export async function audioResponse(db:SqlDb,request:Request):Promise<Response> {
  try {
    const url=new URL(request.url),[id,episode]=url.pathname.slice(1).split('/')
    const file=audioFile(db,id,episode),size=fs.statSync(file).size
    if(url.searchParams.has('info'))return Response.json(await readContainerInfo(file))
    const types:Record<string,string>={mp3:'audio/mpeg',m4a:'audio/mp4',flac:'audio/flac',wav:'audio/wav',ogg:'audio/ogg',opus:'audio/ogg',aac:'audio/aac'}
    const headers:Record<string,string>={'Content-Type':types[file.split('.').pop()!.toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store'}
    const range=request.headers.get('range')
    let start=0,end=size-1
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range)
      if(!match || (!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}})
      if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):end}
      else start=Math.max(0,size-Number(match[2]))
      if(start>end || start>=size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}})
      headers['Content-Range']=`bytes ${start}-${end}/${size}`
    }
    headers['Content-Length']=String(Math.max(0,end-start+1))
    const body=size?Readable.toWeb(fs.createReadStream(file,{start,end})):null
    return new Response(body as ReadableStream|null,{status:range?206:200,headers})
  }catch{return new Response('Audio unavailable',{status:404})}
}
