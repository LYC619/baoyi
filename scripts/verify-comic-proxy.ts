import test from 'node:test'
import assert from 'node:assert/strict'
import {comicProxyMap,curlProxy} from '../electron/kinds/image/comic-proxy.ts'
test('系统代理按各来源域名解析，内置配置独立应用，自定义 SOCKS5 使用远端 DNS',async()=>{
  const settings:unknown[]=[],urls:string[]=[]
  const network={setProxy:async(c:unknown)=>{settings.push(c)},resolveProxy:async(url:string)=>{urls.push(url);return url.includes('cdnhjk')?'PROXY 127.0.0.1:7890':'SOCKS5 127.0.0.1:1080'}}
  const system=await comicProxyMap({mode:'system'},'',network);assert.deepEqual(settings,[{mode:'system'}]);assert.equal(Object.keys(system).length,10);assert.equal(system['www.cdnhjk.net'],'http://127.0.0.1:7890');assert.equal(urls.length,10)
  await comicProxyMap({mode:'builtin'},'127.0.0.1:7890',network);assert.deepEqual(settings[1],{proxyRules:'http://127.0.0.1:7890'})
  const custom=await comicProxyMap({mode:'custom',url:'socks5://127.0.0.1:7890'},'',network);assert.equal(custom['www.cdnhjk.net'],'socks5h://127.0.0.1:7890');assert.equal(settings.length,2)
  assert.equal(curlProxy('DIRECT'),'');assert.throws(()=>curlProxy('SOCKS 127.0.0.1:1080'),/不支持/)
})
