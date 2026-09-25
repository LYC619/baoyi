import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'
import { pngImage } from './helpers/test-images.ts'

const extension = String.raw`
contents[0].published_at=Date.UTC(2024,0,2)
contents[1].published_at=Date.UTC(2026,5,4)
Object.assign(contents[0],{original_title:'Light and color',description:'这是用于检查简介布局的合成资料。竖向海报与横向预览并排等高，正文展示在右侧。\n\n名称、发布时间和简介可以直接阅读。',poster_path:'D:/Fixture/portrait.png',thumbnail_path:'D:/Fixture/landscape.png',tags:['摄影','光线']})
work.needs_review=true
work.pending_reasons=['metadata']
window.baoyi.hanimeBrowser={open:async()=>{calls.push(['open-hanime']);return true},onDownload:()=>()=>{}}
await window.__fixture.videoStore.reload()
`
const fixture = await createWorkflowRendererFixture(extension)
const { page, errors } = fixture
const output=path.resolve(process.argv[2] || 'output/video-library-usability-20260913/renderer')
fs.mkdirSync(output,{recursive:true})
let passed=0,failed=0
async function test(name:string,run:()=>Promise<void>){try{await run();passed++}catch(e){failed++;console.error('FAIL '+name+': '+(e instanceof Error?e.message:e));await page.screenshot({path:path.join(output,'failure-'+failed+'.png')})}}
async function route(name:string,params={}){await page.evaluate(({name,params}:any)=>(window as any).__fixture.router.push({name,params}),{name,params});await page.waitForFunction(()=>!document.querySelector('.page-enter-active,.page-leave-active')&&!document.querySelector('.detail__state')?.textContent?.includes('载入中'))}
async function paintImages(){const images=[pngImage(180,270),pngImage(320,180)].map(p=>'data:image/png;base64,'+p.toString('base64'));await page.locator('.episode-artwork img').evaluateAll((els:HTMLImageElement[],values:string[])=>els.forEach((e,i)=>e.src=values[i%values.length]),images)}
try {
  await page.goto(fixture.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForFunction(()=>!!(window as any).__fixture)
  await test('collection header lists earliest and latest episode publication dates',async()=>{
    await route('video-detail',{id:'work-1'})
    assert.match(await page.locator('.hero__meta').innerText(),/最早 2024-01-02.*最晚 2026-06-04/)
  })
  await test('scope buttons preserve selection while checking files',async()=>{
    await page.getByRole('tab',{name:'剧情简介',exact:true}).click()
    const scope=page.getByRole('group',{name:'选择简介范围',exact:true})
    await scope.getByRole('button',{name:'第 1 集',exact:true}).click()
    assert.equal(await scope.getByRole('button',{name:'第 1 集',exact:true}).getAttribute('aria-pressed'),'true')
    await page.getByRole('tab',{name:/作品内容/}).click();await page.getByRole('button',{name:'检查文件',exact:true}).click()
    await page.getByRole('tab',{name:'剧情简介',exact:true}).click()
    assert.equal(await scope.getByRole('button',{name:'第 1 集',exact:true}).getAttribute('aria-pressed'),'true')
  })
  await test('portrait and landscape have equal heights and open a keyboard-dismissable enlarged view',async()=>{
    await paintImages()
    for(const width of [1280,960,680]){
      await page.setViewportSize({width,height:960})
      const layout=await page.evaluate(()=>{const images=[...document.querySelectorAll('.episode-artwork img')].map(e=>e.getBoundingClientRect());const text=document.querySelector('.episode-copy')!.getBoundingClientRect();return{equal:Math.abs(images[0].height-images[1].height)<1,beside:Math.abs(images[0].top-images[1].top)<1,textRight:text.x>=images[1].right,overflow:document.documentElement.scrollWidth>innerWidth}})
      assert.equal(layout.equal,true);assert.equal(layout.beside,true);assert.equal(layout.overflow,false)
      if(width>=960)assert.equal(layout.textRight,true)
      await page.screenshot({path:path.join(output,'description-'+width+'.png'),fullPage:true})
    }
    await page.setViewportSize({width:1280,height:960})
    await page.getByRole('button',{name:'放大横向预览图',exact:true}).click()
    assert.equal(await page.getByRole('dialog',{name:'查看图片'}).isVisible(),true)
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'查看图片'}).isVisible(),false)
  })
  await test('search filter sends dates and state together and clears them',async()=>{
    await route('video-home')
    await page.getByRole('button',{name:'筛选',exact:true}).click()
    const form=page.getByRole('form',{name:'筛选影视'})
    await form.getByLabel('开始日期').fill('2025-01-01');await form.getByLabel('结束日期').fill('2026-06-04')
    await form.getByLabel('观看状态').selectOption('watching');await form.getByLabel('本地内容').selectOption('available')
    await form.getByRole('button',{name:'应用筛选',exact:true}).click()
    const query=await page.evaluate(()=>(window as any).__fixture.calls.filter((c:any)=>c[0]==='list').at(-1)[1])
    assert.equal(query.publishedFrom,'2025-01-01');assert.equal(query.publishedTo,'2026-06-04');assert.equal(query.status,'watching');assert.equal(query.local,'available')
    await page.getByRole('button',{name:/^筛选/}).click();await page.screenshot({path:path.join(output,'filters.png')})
    await page.getByRole('button',{name:'清空筛选',exact:true}).click()
    assert.equal(await page.evaluate(()=>(window as any).__fixture.videoStore.hasFilters),false)
  })
  await test('Agent review is explicit and the Hanime entry follows the private content scope',async()=>{
    await page.getByRole('button',{name:'批量管理',exact:true}).click()
    await page.getByRole('button',{name:'全选当前范围',exact:true}).click()
    await page.getByRole('button',{name:'Agent 复查所选',exact:true}).click()
    await page.waitForFunction(()=>(window as any).__fixture.calls.filter((c:any)=>c[0]==='reidentify').length===2)
    await page.getByRole('button',{name:'退出批量管理',exact:true}).click()
    // 「打开 Hanime」并进了「从 Hanime 添加」面板：站内窗口从面板里的「在 Hanime 里找」开，隐藏里番时按钮禁用
    assert.equal(await page.getByRole('button',{name:'打开 Hanime',exact:true}).count(),0)
    await page.getByRole('button',{name:'从 Hanime 添加',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'从 Hanime 添加作品'})
    await dialog.getByRole('button',{name:'在 Hanime 里找',exact:true}).click()
    assert.ok(await page.evaluate(()=>(window as any).__fixture.calls.some((c:any)=>c[0]==='open-hanime')))
    await page.evaluate(()=>(window as any).__fixture.setHidden(true))
    await page.waitForFunction(()=>(document.querySelector('.download-url__input button[type=button]') as HTMLButtonElement)?.disabled===true)
    await page.evaluate(()=>(window as any).__fixture.setHidden(false))
    await dialog.getByRole('button',{name:'关闭下载面板',exact:true}).click()
  })
  assert.deepEqual(errors,[])
}finally{await fixture.close()}
console.log(`Video library usability renderer: ${passed} passed / ${failed} failed`);process.exitCode=failed?1:0
