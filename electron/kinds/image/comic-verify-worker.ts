import {parentPort} from 'node:worker_threads'
import {loadImage} from '@napi-rs/canvas'
import {createHash} from 'node:crypto'
import {readManifestPage} from './manifest.ts'
import {inspectImage} from './metadata.ts'

// Decode outside the UI/main thread; retain at most one page in this worker.
parentPort!.on('message',async ({directory,page})=>{
  try{
    const bytes=await readManifestPage(directory,page.file),info=inspectImage(bytes)
    if(info.width*info.height>40_000_000||bytes.length!==page.size||createHash('sha256').update(bytes).digest('hex')!==page.sha256)throw new Error('漫画页面与校验清单不符')
    const image=await loadImage(bytes)
    if(image.width!==info.width||image.height!==info.height)throw new Error('漫画页面无法完整解码')
    parentPort!.postMessage({ok:true})
  }catch(error){parentPort!.postMessage({error:(error as Error).message})}
})
