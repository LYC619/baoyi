import assert from 'node:assert/strict'
import { PicacomicSource } from '../electron/kinds/image/source.ts'
import { pngImage } from './helpers/test-images.ts'

const row={_id:'work1',title:'测试作品',author:'作者',epsCount:2,pagesCount:10,finished:true,thumb:{fileServer:'https://images.picacomic.com',path:'covers/封面.jpg'}}
const calls:Array<{url:string;init?:RequestInit}>=[]
let data:unknown={comics:{docs:[row],pages:3}}
const source=new PicacomicSource({token:()=> 'fixture-token',fetch:async(url,init)=>{
  calls.push({url,init})
  if(url.includes('/static/'))return new Response(new Uint8Array(pngImage(12,18)))
  return Response.json({code:200,data})
}})
assert.equal(typeof source.favorites,'function','必须恢复账号收藏接口')
const favorites=await source.favorites(2,'da')
assert.equal(calls.at(-1)?.url,'https://picaapi.picacomic.com/users/favourite?s=da&page=2')
assert.equal(calls.at(-1)?.init?.method,'GET')
assert.equal(favorites.pages,3)
assert.equal(favorites.items[0].title,row.title)
assert.equal(favorites.items[0].coverUrl,'https://images.picacomic.com/static/covers/%E5%B0%81%E9%9D%A2.jpg')
assert.match(await source.cover(favorites.items[0].coverUrl!),/^data:image\/png;base64,/)
assert.equal(calls.at(-1)?.init?.headers,undefined,'封面请求不得携带账号 token')
await assert.rejects(source.cover('https://unregistered.example/a'),/封面/)
for(const period of ['H24','D7','D30'] as const){
  data={comics:[row]}
  const ranking=await source.ranking(period)
  assert.equal(calls.at(-1)?.url,`https://picaapi.picacomic.com/comics/leaderboard?tt=${period}&ct=VC`)
  assert.equal(ranking.items[0].title,row.title)
  assert.equal(ranking.pages,1)
}
data={comics:{docs:[row],pages:1}}
assert.equal((await source.search('测试')).items[0].coverUrl,favorites.items[0].coverUrl)
data={comics:{docs:[{...row,thumb:{fileServer:'http://localhost',path:'x'}}],pages:1}}
assert.equal((await source.favorites()).items[0].coverUrl,'','非法封面不影响作品浏览')
data={comics:{docs:[],pages:0}}
assert.deepEqual(await source.favorites(),{items:[],pages:0})
data={comics:{docs:[],pages:'bad'}}
await assert.rejects(source.favorites(),/分页/)
data={comics:{docs:[]}}
await assert.rejects(source.ranking(),/排行榜/)
await assert.rejects(source.favorites(0),/页码/)
await assert.rejects(source.favorites(1,'bad' as any),/排序/)
await assert.rejects(source.ranking('bad' as any),/周期/)
const expired=new PicacomicSource({token:()=>'',fetch:async()=>new Response('',{status:401})})
await assert.rejects(expired.favorites(),/登录/)
for(const response of [
  ()=>new Response('<html>not an image</html>'),
  ()=>new Response('large',{headers:{'content-length':String(6*1024**2)}}),
  ()=>new Response('',{status:404})
]){
  const badCover=new PicacomicSource({token:()=>'',fetch:async url=>url.includes('/static/')?response():Response.json({code:200,data:{comics:[row]}})})
  const works=await badCover.ranking()
  await assert.rejects(badCover.cover(works.items[0].coverUrl!),/图片|大小限制|封面/)
}
console.log('PASS 收藏分页排序、日周月榜、名称封面、封面凭据隔离、输入及响应校验、认证过期')
