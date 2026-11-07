import test from 'node:test'
import assert from 'node:assert/strict'
import {comicWorkId,comicName,comicDirectory,comicCatalog,comicProxy,JM_ADAPTER_VERSION} from '../electron/kinds/image/comic-source-rules.ts'
test('只识别明确作品 ID 与固定站点链接，目录适配 Windows',()=>{
  for(const input of ['123','JM123','jm123','https://18comic.vip/album/123/'])assert.equal(comicWorkId(input),'123')
  for(const input of ['随便写123','https://example.org/album/123','file:///album/123','https://18comic.vip.evil/album/123','https://user@18comic.vip/album/123','https://18comic.vip/album/123?token=x','0','01'])assert.throws(()=>comicWorkId(input))
  assert.equal(comicName('CON'),'_CON');assert.equal(comicName('a/b. '),'a_b');assert.equal(comicName('e\u0301'),'é');assert.equal(comicDirectory({name:'作品',authors:[]}),'[未知作者] 作品')
})
test('三种代理可选择，裸地址规范化，拒绝凭据或脚本规则',()=>{
  assert.deepEqual(comicProxy({mode:'system'}),{mode:'system'});assert.deepEqual(comicProxy({mode:'builtin'}),{mode:'builtin'})
  assert.deepEqual(comicProxy({mode:'custom',url:'127.0.0.1:7890'}),{mode:'custom',url:'http://127.0.0.1:7890'})
  for(const url of ['http://user:secret@localhost:7890','direct://','http=foo:123;socks=bar:456','localhost:99999'])assert.throws(()=>comicProxy({mode:'custom',url}))
})
test('目录指纹固定页面身份顺序，不混入来源 URL；重复页面或改变指纹拒绝',()=>{
  const source={provider:'jm',workId:'123',name:'示例',authors:[],description:'',tags:[],publication:'ongoing',adapterVersion:JM_ADAPTER_VERSION,catalogFingerprint:'',chapters:[{id:'123',title:'第一章',order:1,pageIds:['00001.jpg']}]}
  const a=comicCatalog(source),b=comicCatalog({...source,name:'改名'});assert.equal(a.catalogFingerprint,b.catalogFingerprint)
  assert.throws(()=>comicCatalog({...a,chapters:[{...a.chapters[0],pageIds:['00002.jpg']}]}),/指纹/)
  assert.throws(()=>comicCatalog({...source,chapters:[{...source.chapters[0],pageIds:['p1','p1']}]}),/清单/)
})
