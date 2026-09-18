/** Actual Vue interactions with a synthetic library; native IPC is tested in the packaged suite. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'

const extension = String.raw`
work.name_zh = '合集演示'; work.episode_total = 3; work.tags = ['作品标签']; contents.splice(3)
contents.forEach((ep,i) => { ep.title = '单集演示 '+(i+1); ep.original_title='Original '+(i+1); ep.tags=['独立标签'+(i+1)]; ep.description='单独简介 '+(i+1) })
window.baoyi.video.bulkUpdate = async (ids,patch) => { structuredClone(ids);structuredClone(patch);calls.push(['bulk',ids,patch]); for(const id of ids) { const w=id===work.id?work:single; if(patch.collection!==undefined)w.collection_name=patch.collection;if(patch.addTags)w.tags=[...new Set([...w.tags,...patch.addTags])];if(patch.removeTags)w.tags=w.tags.filter(t=>!patch.removeTags.includes(t)) } return ids.length }
window.baoyi.video.previewRemoval = async request => { structuredClone(request); return { fingerprint:'fixture',request,titles:['所选内容'],episodeCount:request.episodeId?1:3,files:[{path:'D:/Fixture/sample.mp4',size:1024,present:true,shared:false}] } }
window.baoyi.video.applyRemoval = async preview => { structuredClone(preview);calls.push(['removal',preview.request]);if(preview.request.episodeId) { const index=contents.findIndex(ep=>ep.id===preview.request.episodeId);if(index>=0)contents.splice(index,1);work.episode_total=contents.length }return {detachedId:'',warnings:[]} }
await window.__fixture.videoStore.reload()
`
const fixture = await createWorkflowRendererFixture(extension), { page, errors } = fixture
const evidence=path.resolve(process.argv[2] || 'output/video-feedback-fixes-20260912/renderer');fs.mkdirSync(evidence,{recursive:true})
let passed=0,failed=0
const filter=process.argv.find(argument=>argument.startsWith('--filter='))?.slice(9)
async function test(name:string,run:()=>Promise<void>){if(filter&&!name.includes(filter))return;try{await run();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name,e instanceof Error?e.message:e);await page.screenshot({path:path.join(evidence,'failed-'+failed+'.png')})}}
async function route(name:string,params={}) {
  await page.evaluate(({name,params}:any)=>(window as any).__fixture.router.push({name,params}),{name,params})
  await page.waitForFunction(()=>!document.querySelector('.page-enter-active,.page-leave-active')&&!document.querySelector('.detail__state')?.textContent?.includes('载入中'))
}
try {
  await page.goto(fixture.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForFunction(()=>!!(window as any).__fixture)
  await test('首页展开合集，并由单集标签进入对应介绍',async()=>{
    await page.setViewportSize({width:1440,height:1000})
    await page.getByRole('button',{name:'展开 3 集',exact:true}).click()
    assert.equal(await page.locator('.collection-episodes button').count(),3)
    const layout = await page.evaluate(() => {
      const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      return { work: box(document.querySelector('.work-group .card')!), poster: box(document.querySelector('.work-group .card__poster')!),
        episodes: [...document.querySelectorAll('.collection-episodes button')].map(box),
        posters: [...document.querySelectorAll('.collection-episodes .card__poster')].map(box), text: document.querySelector('.collection-episodes')!.textContent }
    })
    assert.equal(layout.posters.length,3,'expanded episodes use full poster cards')
    assert.ok(layout.episodes.every((card:{width:number})=>Math.abs(card.width-layout.work.width)<1))
    assert.ok(layout.posters.every((poster:{width:number;height:number})=>Math.abs(poster.width-layout.poster.width)<1&&Math.abs(poster.height-layout.poster.height)<1))
    assert.ok(layout.episodes[1].x>layout.episodes[0].x&&Math.abs(layout.episodes[1].y-layout.episodes[0].y)<1,'episodes expand horizontally')
    assert.ok(!layout.text?.includes('独立标签'),'episode cards omit their tags')
    await page.screenshot({path:path.join(evidence,'expanded-full-cards.png')})
    await page.evaluate(()=>(window as any).__fixture.videoStore.select({kind:'tag',value:'独立标签2'}))
    await page.waitForFunction(()=>document.querySelectorAll('.collection-episodes button').length===1)
    assert.match(await page.locator('.collection-episodes').innerText(),/单集演示 2/)
    await page.locator('.collection-episodes button').click()
    await page.getByRole('button',{name:'编辑这一集',exact:true}).waitFor()
    assert.match(await page.getByRole('tabpanel',{name:'剧情简介',exact:true}).innerText(),/单独简介 2/)
  })
  await test('单集编辑保存独立标签，不更改相邻一集',async()=>{
    await page.getByRole('button',{name:'编辑这一集',exact:true}).click()
    const tags=page.getByPlaceholder('单集标签，用顿号分隔');await tags.fill('修改后的标签、保留标签');await tags.press('Enter')
    await page.waitForFunction(()=>(window as any).__fixture.contents[1].tags.includes('修改后的标签'))
    assert.deepEqual(await page.evaluate(()=>(window as any).__fixture.contents[0].tags),['独立标签1'])
    await page.getByRole('button',{name:'完成单集编辑',exact:true}).click()
  })
  await test('单集来源搜索提交准确的单集和来源编号',async()=>{
    await page.getByRole('button',{name:'更改来源',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'匹配单集来源'})
    await dialog.getByRole('button',{name:'搜索来源',exact:true}).click()
    await dialog.getByRole('button',{name:'选用并刮削',exact:true}).click();await dialog.waitFor({state:'hidden'})
    assert.ok(await page.evaluate(()=>(window as any).__fixture.calls.some((c:any[])=>c[0]==='bind-source'&&c[1]==='work-1'&&c[2]==='episode-1'&&c[3]==='200')))
  })
  await test('收藏分组可以直接修改，无需开启整页编辑',async()=>{
    await page.getByRole('tab',{name:'文件与资料',exact:true}).click()
    const group=page.getByLabel('视频分组');await group.fill('实测分组');await group.press('Tab')
    await page.waitForFunction(()=>(window as any).__fixture.work.collection_name==='实测分组')
  })
  await test('批量管理支持分组、标签和明确的本地删除选项',async()=>{
    await page.evaluate(()=>(window as any).__fixture.videoStore.select({kind:'all'}));await route('video-home')
    await page.getByRole('button',{name:'批量管理',exact:true}).click()
    await page.getByRole('button',{name:'选择作品：合集演示',exact:true}).click();await page.getByRole('button',{name:'选择作品：单视频作品',exact:true}).click()
    const bulk=page.getByRole('region',{name:'批量管理'})
    await bulk.getByLabel('收藏分组').fill('批量分组');await bulk.getByRole('button',{name:'设置分组',exact:true}).click()
    await page.waitForFunction(()=>(window as any).__fixture.single.collection_name==='批量分组')
    await bulk.getByLabel('作品标签').fill('批量标签');await bulk.getByRole('button',{name:'加标签',exact:true}).click()
    await page.waitForFunction(()=>(window as any).__fixture.single.tags.includes('批量标签'))
    await bulk.getByRole('button',{name:'删除所选…',exact:true}).click()
    const removal=page.getByRole('dialog',{name:'删除所选作品'})
    assert.equal(await removal.getByRole('checkbox').isChecked(),false)
    await removal.getByRole('checkbox').check()
    await removal.getByRole('button',{name:'删除记录并移入回收站',exact:true}).waitFor()
    await removal.getByRole('button',{name:'关闭',exact:true}).click()
    assert.equal(await page.evaluate(()=>(window as any).__fixture.calls.filter((c:any[])=>c[0]==='removal').length),0)
    await page.getByRole('button',{name:'退出批量管理',exact:true}).click()
  })
  assert.deepEqual(errors,[],'renderer must not throw')
} finally { await fixture.close() }
console.log('Video feedback renderer: '+passed+' passed / '+failed+' failed');process.exitCode=failed?1:0
