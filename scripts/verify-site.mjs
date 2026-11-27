import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'node-html-parser'
import { buildSite, renderMarkdown, rewriteMarkdownLinks } from './build-site.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
if (process.argv.includes('--build') || process.env.BAOYI_TEST_DATA_DIR) await buildSite()
const config=JSON.parse(await fs.readFile(path.join(root,'docs/site/site.json'),'utf8'))
const base=new URL(process.env.SITE_URL||config.url);base.pathname=base.pathname.replace(/\/?$/,'/')
const output=path.join(root,'output/site')
const slugs=['','guide','development','deployment','privacy','faq']
const titles=new Set(), descriptions=new Set()
for(const lang of ['en','zh-CN'])for(const slug of slugs){
  const relative=`${lang}/${slug?slug+'/':''}`,canonical=new URL(relative,base).href
  const source=await fs.readFile(path.join(output,relative,'index.html'),'utf8'),page=parse(source)
  assert.equal(page.querySelector('html').getAttribute('lang'),lang,relative)
  assert.equal(page.querySelectorAll('h1').length,1,relative)
  const title=page.querySelector('title').text,description=page.querySelector('meta[name="description"]').getAttribute('content')
  assert.ok(title.length>10&&!titles.has(title),'Unique descriptive title: '+relative);titles.add(title)
  assert.ok(description.length>15&&!descriptions.has(description),'Unique description: '+relative);descriptions.add(description)
  assert.equal(page.querySelector('link[rel="canonical"]').getAttribute('href'),canonical)
  assert.equal(page.querySelector('meta[property="og:url"]').getAttribute('content'),canonical)
  for(const alternate of ['en','zh-CN','x-default'])assert.equal(page.querySelector(`link[hreflang="${alternate}"]`).getAttribute('href'),new URL(`${alternate==='x-default'?'en':alternate}/${slug?slug+'/':''}`,base).href)
  assert.equal(page.querySelector('meta[name="twitter:card"]').getAttribute('content'),'summary_large_image')
  const schema=JSON.parse(page.querySelector('script[type="application/ld+json"]').text)
  assert.equal(schema['@type'],slug?'TechArticle':'SoftwareApplication');assert.equal(schema.url,canonical)
  assert.ok(!('aggregateRating' in schema),'No invented reviews')
  assert.equal(page.querySelectorAll('script').length,1,'Site works without application JavaScript')
  assert.ok(page.querySelector('a.skip[href="#main"]')&&page.querySelector('main#main'))
  for(const element of page.querySelectorAll('a[href],link[href],img[src]')){
    const raw=element.getAttribute('href')||element.getAttribute('src')
    if(raw.startsWith('#')){assert.ok(page.querySelector(raw),'Fragment target: '+raw);continue}
    const link=new URL(raw,canonical)
    if(link.origin!==base.origin||!link.pathname.startsWith(base.pathname))continue
    let target=path.join(output,decodeURIComponent(link.pathname.slice(base.pathname.length)))
    if((await fs.stat(target)).isDirectory())target=path.join(target,'index.html')
    await fs.access(target)
    if(link.hash){
      const targetDoc=parse(await fs.readFile(target,'utf8'))
      const fragmentId=decodeURIComponent(link.hash.slice(1))
      assert.ok(targetDoc.querySelector(`[id="${fragmentId}"]`),'Cross-page fragment target: '+raw)
    }
  }
  if(slug){
    const h2s=page.querySelectorAll('article.prose h2')
    assert.ok(h2s.length>0&&h2s.every(h=>!!h.getAttribute('id')),'Doc h2 headings must have ids: '+relative)
  }
}
const rootIndex=parse(await fs.readFile(path.join(output,'index.html'),'utf8'))
assert.ok(rootIndex.querySelector('main.language-home')&&rootIndex.querySelector('a[href$="en/"]')&&rootIndex.querySelector('a[href$="zh-CN/"]'))
const sitemap=await fs.readFile(path.join(output,'sitemap.xml'),'utf8')
assert.equal((sitemap.match(/<loc>/g)||[]).length,slugs.length*2)
assert.ok(sitemap.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'))
assert.ok((await fs.readFile(path.join(output,'robots.txt'),'utf8')).includes(new URL('sitemap.xml',base).href))
const card=await fs.readFile(path.join(output,'assets/social.png'))
assert.equal(card.readUInt32BE(16),1200);assert.equal(card.readUInt32BE(20),630)
const missing = parse(await fs.readFile(path.join(output,'404.html'),'utf8'))
assert.equal(missing.querySelector('meta[name="robots"]').getAttribute('content'), 'noindex')
assert.equal(missing.querySelector('link[rel="stylesheet"]').getAttribute('href'), base.pathname + 'assets/site.css')
assert.ok(missing.querySelector('main.language-home'))
assert.equal(rewriteMarkdownLinks('<a href="guide.md#language">Language</a><a href="faq.md">FAQ</a>'), '<a href="../guide/#language">Language</a><a href="../faq/">FAQ</a>')
assert.equal(rewriteMarkdownLinks('<a href="https://example.org/guide.md#language">External</a>'), '<a href="https://example.org/guide.md#language">External</a>')
assert.ok(renderMarkdown('# Top\n\n## Install and open\n\n## 语言切换\n').includes('<h2 id="install-and-open">Install and open</h2>'))
assert.ok(renderMarkdown('# Top\n\n## 语言切换\n').includes('<h2 id="语言切换">语言切换</h2>'))
if(process.env.SITE_URL&&base.pathname==='/'&&!base.hostname.endsWith('.github.io'))assert.equal((await fs.readFile(path.join(output,'CNAME'),'utf8')).trim(),base.hostname)
else await assert.rejects(fs.access(path.join(output,'CNAME')),{code:'ENOENT'})
console.log('PASS bilingual pages, internal links, language alternates, canonical URLs, metadata, sitemap and social image')
