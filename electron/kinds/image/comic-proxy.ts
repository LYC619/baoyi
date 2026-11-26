import type {ComicProxy} from '../../../src/types/comic-ingest.ts'
import {comicProxy,JM_API_HOSTS,JM_IMAGE_HOSTS} from './comic-source-rules.ts'
import {parseProxyInput,toElectronProxyConfig,type ElectronProxyConfig} from '../../services/network/proxy-rules.ts'
export function curlProxy(route:string){
  const first=route.split(';')[0].trim()
  if(first==='DIRECT')return ''
  const match=/^(PROXY|HTTPS|SOCKS5)\s+(\[[0-9a-f:]+\]|[a-z0-9_.-]+):(\d+)$/i.exec(first)
  if(!match||+match[3]<1||+match[3]>65535)throw new Error('当前线路使用了不支持的代理，请指定 HTTP 或 SOCKS5 地址')
  return ({PROXY:'http',HTTPS:'https',SOCKS5:'socks5h'}[match[1].toUpperCase()]||'http')+'://'+match[2]+':'+match[3]
}
export async function comicProxyMap(input:ComicProxy,builtin:string,network:{setProxy:(config:ElectronProxyConfig)=>Promise<void>;resolveProxy:(url:string)=>Promise<string>}){
  const proxy=comicProxy(input)
  if(proxy.mode==='custom')return Object.fromEntries([...JM_API_HOSTS,...JM_IMAGE_HOSTS].map(host=>[host,proxy.url.replace(/^socks5:/,'socks5h:')]))
  await network.setProxy(proxy.mode==='system'?{mode:'system'}:toElectronProxyConfig(parseProxyInput(builtin)))
  const result:Record<string,string>={}
  for(const host of [...JM_API_HOSTS,...JM_IMAGE_HOSTS])result[host]=curlProxy(await network.resolveProxy('https://'+host+'/'))
  return result
}
