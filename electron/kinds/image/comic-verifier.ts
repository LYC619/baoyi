import {Worker} from 'node:worker_threads'
export type ComicPageVerifier=(directory:string,page:{file:string;sha256:string;size:number})=>Promise<void>
export function createComicVerifier(file:URL):{verify:ComicPageVerifier;close:()=>Promise<unknown>}{
  const worker=new Worker(file),waiting:Array<{resolve:()=>void;reject:(error:Error)=>void}>=[]
  let failure:Error|undefined
  const fail=(error:Error)=>{failure=error;for(const row of waiting.splice(0))row.reject(error)}
  worker.on('error',fail);worker.on('exit',()=>fail(new Error('漫画图片校验组件已退出')))
  worker.on('message',value=>{const row=waiting.shift();if(value.error)row?.reject(new Error(value.error));else row?.resolve()})
  return {
    verify:(directory,page)=>new Promise((resolve,reject)=>{
      if(failure)return reject(failure)
      const timer=setTimeout(()=>{fail(new Error('漫画图片校验超时'));void worker.terminate()},30000)
      waiting.push({resolve:()=>{clearTimeout(timer);resolve()},reject:error=>{clearTimeout(timer);reject(error)}})
      worker.postMessage({directory,page})
    }),
    close:()=>worker.terminate()
  }
}
