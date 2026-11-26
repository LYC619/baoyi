const assert=require('node:assert/strict')
const fs=require('node:fs/promises')
const path=require('node:path')
const http=require('node:http')
const {chromium}=require('playwright')

async function main(){
  const { buildSite } = await import('./build-site.mjs')
  await buildSite()
  const root=path.resolve('output/site'),evidence=path.resolve('output/site-checks')
  const config=JSON.parse(await fs.readFile('docs/site/site.json','utf8'))
  const prefix=new URL(process.env.SITE_URL||config.url).pathname.replace(/\/?$/,'/')
  await fs.mkdir(evidence,{recursive:true})
  const server=http.createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://127.0.0.1').pathname
      if(!pathname.startsWith(prefix)){res.writeHead(404).end();return}
      let target=path.resolve(root,pathname.slice(prefix.length))
      if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403).end();return}
      if((await fs.stat(target)).isDirectory())target=path.join(target,'index.html')
      res.setHeader('Content-Type',target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':target.endsWith('.png')?'image/png':'text/html; charset=utf-8')
      res.end(await fs.readFile(target))
    }catch{res.writeHead(404).end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  let browser
  try{
    browser=await chromium.launch({headless:true,...(process.env.BAOYI_TEST_BROWSER?{executablePath:process.env.BAOYI_TEST_BROWSER}:{})})
    const page=await browser.newPage(),errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    const base=`http://127.0.0.1:${server.address().port}${prefix}`
    for(const width of [1440,390])for(const language of ['en','zh-CN']){
      await page.setViewportSize({width,height:960})
      await page.goto(base+language+'/',{waitUntil:'networkidle'})
      assert.equal(await page.locator('html').getAttribute('lang'),language)
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow: '+language+'/'+width)
      for(const item of await page.locator('header a,.actions a').all())assert.ok(await item.isVisible())
      await page.screenshot({path:path.join(evidence,`${language}-${width}.png`),fullPage:true})
      await page.locator('header nav a').first().click()
      assert.ok(page.url().endsWith('/guide/'))
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Guide fits viewport')
      await page.locator('header nav a').last().click()
      assert.ok(page.url().endsWith((language==='en'?'zh-CN':'en')+'/guide/'),'Language switch retains page')
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height:960})
      await page.goto(base+'404.html', {waitUntil:'networkidle'})
      assert.ok(await page.locator('main.language-home').isVisible())
      assert.ok(await page.evaluate(() => document.styleSheets.length > 0 && document.documentElement.scrollWidth <= innerWidth + 1), 'Styled 404 fits the viewport')
      await page.screenshot({path:path.join(evidence,`404-${width}.png`),fullPage:true})
      await page.getByRole('link', {name:'English home'}).click()
      assert.ok(page.url().endsWith('/en/'))
    }
    const noScript=await browser.newContext({javaScriptEnabled:false})
    const simple=await noScript.newPage();await simple.goto(base+'en/');assert.ok(await simple.locator('h1').isVisible());await simple.locator('.actions a').last().click();assert.ok(simple.url().endsWith('/guide/'));await noScript.close()
    assert.deepEqual(errors,[])
    console.log('PASS desktop/mobile English/Chinese layout, documentation navigation, language switch and JavaScript-disabled reading')
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
