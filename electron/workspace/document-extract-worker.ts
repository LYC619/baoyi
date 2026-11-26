import {parentPort,workerData} from 'node:worker_threads'
import {extractDocumentFile} from './document-extract-core.ts'
void extractDocumentFile(workerData,(page,total)=>parentPort!.postMessage({type:'progress',page,total}))
  .then(result=>parentPort!.postMessage({type:'result',result}),error=>parentPort!.postMessage({type:'error',error:error.name==='PasswordException'?'PDF 已加密，请先解密后读取':error.message}))
  .finally(()=>parentPort!.close())
