import {parentPort,workerData} from 'node:worker_threads'
import fs from 'node:fs/promises'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {readContainerInfo} from './mediainfo.ts'
async function main(){
  if(workerData.kind==='info')return readContainerInfo(workerData.file)
  const canvas=createCanvas(1920,720),context=canvas.getContext('2d');context.fillStyle='#111';context.fillRect(0,0,1920,720)
  for(let index=0;index<workerData.frames.length;index++){
    const image=await loadImage(workerData.frames[index]),scale=Math.min(320/image.width,180/image.height),width=image.width*scale,height=image.height*scale
    context.drawImage(image,(index%6)*320+(320-width)/2,Math.floor(index/6)*180+(180-height)/2,width,height)
  }
  const bytes=await canvas.encode('jpeg',70)
  if(bytes.length>4*1024*1024)throw new Error('预览帧超过单项 4 MiB 缓存预算')
  await fs.writeFile(workerData.output,bytes);return {bytes:bytes.length}
}
main().then(value=>parentPort!.postMessage({value}),error=>parentPort!.postMessage({error:(error as Error).message}))
