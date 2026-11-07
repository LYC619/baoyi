import fs from 'node:fs/promises'
import path from 'node:path'
import {ComicRuntime} from '../electron/kinds/image/comic-runtime.ts'
import {JM_API_HOSTS,JM_IMAGE_HOSTS} from '../electron/kinds/image/comic-source-rules.ts'
const proxy=process.argv[2];if(!proxy)throw new Error('请显式提供本机 HTTP 或 SOCKS5 代理地址')
const output=path.resolve('output/interaction-fixes-2026-11-07'),results:any[]=[]
const runtime=new ComicRuntime({python:path.resolve('output/hermes-runtime/python/python.exe'),runtime:path.resolve('output/comic-runtime'),bridge:path.resolve('resources/comic/bridge.py'),proxies:async()=>Object.fromEntries([...JM_API_HOSTS,...JM_IMAGE_HOSTS].map(host=>[host,proxy]))})
for(const query of [{mode:'ranking',period:'day',page:1},{mode:'search',scope:'all',query:'test',page:1}] as const){
 const at=Date.now();try{const value=await runtime.browse('native-browse-'+query.mode,query,AbortSignal.timeout(65000));results.push({mode:query.mode,passed:true,count:value.items.length,pages:value.pages,milliseconds:Date.now()-at});console.log('PASS actual JM '+query.mode+' '+value.items.length+' summaries')}
 catch(cause){results.push({mode:query.mode,passed:false,error:String(cause),milliseconds:Date.now()-at});console.log('FAIL actual JM '+query.mode+' '+String(cause))}
}
await fs.writeFile(path.join(output,'actual-jm-browse.json'),JSON.stringify({runtime:'jmcomic 2.7.11 / Python 3.14.9',proxy:'explicit local route',results,noImagesDownloaded:true},null,2))
if(results.some(value=>!value.passed))process.exitCode=1
