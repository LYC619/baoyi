import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'docs/site'), output = path.join(root, 'output/site')
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const languages = ['en', 'zh-CN'], slugs = ['', 'guide', 'development', 'deployment', 'privacy', 'faq']
const copy = {
  en: { home:'Overview', guide:'User guide', development:'Build from source', deployment:'Deployment', privacy:'Privacy', faq:'Questions', download:'View releases', skip:'Skip to content', tagline:'A home for the things you keep.', lead:'Bring your files, projects and personal records into one local workspace. Find what matters, pick up where you left off, and keep your collection in your hands.', eyebrow:'YOUR FILES. YOUR CONTEXT.', platform:'Windows desktop · Open source · Local storage', intro:'Keep the context, too.', detail:'A document belongs to a project. A project develops a skill. BaoYi keeps those connections alongside the files.', release:'Download availability and version details are listed on GitHub Releases. This website may describe features newer than the latest binary.', footer:'Built for a considered collection.', language:'简体中文', switch:'zh-CN', preview:'Illustrative workspace · sample content', cards:[['01','Things','Read documents, browse photos and comics, play media, and organize software and games.'],['02','Projects','Keep a current note, useful files, launch commands and the next step together.'],['03','Personal','Record skills, practice, costs, reminders and the things you want to remember.']], sample:['WORKSPACE','Library','Projects','Personal','Continue where you left off','Field notes','Research / reading','A quiet workspace','Project / next step','Practice journal','Personal / skills'] },
  'zh-CN': { home:'产品介绍', guide:'使用指南', development:'源码构建', deployment:'部署说明', privacy:'隐私说明', faq:'常见问题', download:'查看发布版本', skip:'跳到正文', tagline:'让收藏，回到生活里。', lead:'把文件、项目与个人记录放进同一个本地工作区。找回需要的东西，接着上次继续，也为值得留下的内容保留位置。', eyebrow:'抱一 · 知止而后得', platform:'Windows 桌面应用 · 开源 · 本地保存', intro:'留下文件，也留下来由。', detail:'一份资料可以关联项目，一个项目可以连接技能实践。抱一把这些关系保留在文件旁边。', release:'可下载版本与具体更新内容以 GitHub Releases 为准。网站可能介绍了尚未打包发布的新功能。', footer:'有所取，也有所留。', language:'English', switch:'en', preview:'工作区示意 · 示例内容', cards:[['01','物','阅读资料、浏览照片和漫画、播放影音，整理软件与游戏。'],['02','事','把当前进展、相关文件、启动命令和下一步放在项目里。'],['03','我','记录技能、实践、费用、到期提醒，以及日常值得记下的小事。']], sample:['工作区','资料库','项目','个人','接着上次继续','田野笔记','资料 / 阅读','安静的工作台','项目 / 下一步','实践日志','个人 / 技能'] }
}
const route = (lang, slug) => `${lang}/${slug ? slug + '/' : ''}`

export const slugifyHeading = text => String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[\s_]+/g, '-')
export const rewriteMarkdownLinks = html => html.replace(/href="(guide|privacy|development|deployment|faq)\.md(#[^"]*)?"/g, 'href="../$1/$2"')

export function renderMarkdown(markdown) {
  const seen = new Map()
  const md = new Marked({
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens)
        if (depth === 1) return `<h1>${inner}</h1>\n`
        const baseId = slugifyHeading(text) || 'section'
        const count = (seen.get(baseId) || 0) + 1
        seen.set(baseId, count)
        const id = count === 1 ? baseId : `${baseId}-${count}`
        return `<h${depth} id="${esc(id)}">${inner}</h${depth}>\n`
      }
    }
  })
  return rewriteMarkdownLinks(md.parse(markdown))
}

export async function buildSite() {
  const config = JSON.parse(await fs.readFile(path.join(source, 'site.json'), 'utf8'))
  const base = new URL(process.env.SITE_URL || config.url)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('SITE_URL must be an HTTPS URL without credentials, query or fragment')
  base.pathname = base.pathname.replace(/\/?$/, '/')
  const url = relative => new URL(relative, base).href
  const local = relative => base.pathname + relative
  const alternates = slug => languages.map(lang => `<link rel="alternate" hreflang="${lang}" href="${esc(url(route(lang,slug)))}">`).join('') + `<link rel="alternate" hreflang="x-default" href="${esc(url(route('en',slug)))}">`
  const navigation = (lang, slug) => {
    const t = copy[lang]
    const brandName = lang === 'en' ? '<span lang="zh-CN">抱一</span>' : '抱一'
    return `<a class="skip" href="#main">${t.skip}</a><header><a class="brand" href="${local(route(lang,''))}"><img src="${local('assets/icon.svg')}" width="32" height="32" alt=""><span>${brandName} <small>BAOYI</small></span></a><nav aria-label="${lang==='en'?'Main navigation':'主导航'}"><a href="${local(route(lang,'guide'))}">${t.guide}</a><a href="${config.repository}">GitHub ↗</a><a lang="${t.switch}" hreflang="${t.switch}" href="${local(route(t.switch,slug))}">${t.language}</a></nav></header>`
  }
  const footer = lang => `<footer><p>${lang === 'en' ? '<span lang="zh-CN">抱一</span>' : '抱一'} · BaoYi <span>${copy[lang].footer}</span></p><div><a href="${local(route(lang,'privacy'))}">${copy[lang].privacy}</a><a href="${local(route(lang,'deployment'))}">${copy[lang].deployment}</a><a href="${config.repository}/blob/main/LICENSE">MIT</a></div></footer>`
  const shell = (lang, slug, title, description, body) => {
    const schema = slug ? { '@context':'https://schema.org','@type':'TechArticle',headline:title,description,inLanguage:lang,url:url(route(lang,slug)),isPartOf:{'@type':'WebSite',name:'BaoYi',url:base.href} } : { '@context':'https://schema.org','@type':'SoftwareApplication',name:'BaoYi',alternateName:'抱一',description,operatingSystem:'Windows',applicationCategory:'UtilitiesApplication',url:url(route(lang,'')),downloadUrl:config.releases,codeRepository:config.repository,license:config.repository+'/blob/main/LICENSE',inLanguage:['en','zh-CN'] }
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="theme-color" content="#f6f4ed"><meta name="robots" content="index,follow"><link rel="canonical" href="${esc(url(route(lang,slug)))}">${alternates(slug)}<meta property="og:type" content="${slug?'article':'website'}"><meta property="og:site_name" content="BaoYi"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url(route(lang,slug)))}"><meta property="og:locale" content="${lang==='en'?'en_US':'zh_CN'}"><meta property="og:locale:alternate" content="${lang==='en'?'zh_CN':'en_US'}"><meta property="og:image" content="${esc(url('assets/social.png'))}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="BaoYi — A home for the things you keep"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(url('assets/social.png'))}"><link rel="icon" href="${local('assets/icon.svg')}" type="image/svg+xml"><link rel="stylesheet" href="${local('assets/site.css')}"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script></head><body>${navigation(lang,slug)}${body}${footer(lang)}</body></html>`
  }

  await fs.mkdir(path.join(output,'assets'),{recursive:true})
  for (const file of ['site.css','social.png']) await fs.copyFile(path.join(source,file),path.join(output,'assets',file))
  await fs.copyFile(path.join(root,'resources/icon.svg'),path.join(output,'assets/icon.svg'))
  for(const lang of languages){
    const t=copy[lang],s=t.sample
    const preview=`<figure class="workspace"><figcaption><span class="window-dots">● ● ●</span><span>${t.preview}</span></figcaption><div class="workspace-body"><aside><small>${s[0]}</small>${s.slice(1,4).map((x,i)=>`<span class="${i===0?'active':''}">${x}</span>`).join('')}</aside><div class="workspace-content"><span class="fine">BAOYI / 001</span><h2>${s[4]}</h2>${[5,7,9].map((i,n)=>`<div class="sample-row"><span class="sample-icon" aria-hidden="true">${['文','事','我'][n]}</span><div><strong>${s[i]}</strong><small>${s[i+1]}</small></div><span>↗</span></div>`).join('')}</div></div></figure>`
    const home=`<main id="main"><section class="hero"><p class="eyebrow">${t.eyebrow}</p><h1>${t.tagline}</h1><p class="lead">${t.lead}</p><div class="actions"><a class="button primary" href="${config.releases}">${t.download} <span>↗</span></a><a class="button" href="${local(route(lang,'guide'))}">${t.guide} <span>→</span></a></div><p class="fine">${t.platform}</p>${preview}</section><section class="features"><div><p class="eyebrow">01 — ${lang==='en'?'A CONNECTED COLLECTION':'物 · 事 · 我'}</p><h2>${t.intro}</h2><p>${t.detail}</p></div><div class="feature-list">${t.cards.map(([num,title,desc])=>`<article><span>${num}</span><div><h3>${title}</h3><p>${desc}</p></div></article>`).join('')}</div></section><section class="closing"><h2>${lang==='en'?'Start with one folder.':'从一个文件夹开始。'}</h2><p>${t.release}</p><a class="text-link" href="${local(route(lang,'development'))}">${t.development} →</a></section></main>`
    for(const slug of slugs){
      let body=home,title=lang==='en'?'BaoYi — A local workspace for files, projects and personal records':'抱一 BaoYi — 文件、项目与个人记录的本地工作区',description=t.lead
      if(slug){
        const markdown=await fs.readFile(path.join(source,lang,slug+'.md'),'utf8'),lines=markdown.split(/\r?\n/)
        const heading=lines.find(line=>line.startsWith('# '))?.slice(2)
        if(!heading)throw new Error('Missing heading: '+lang+'/'+slug)
        title=heading+' · BaoYi';description=lines.find(line=>line.trim()&&!line.startsWith('#'))||heading
        const navLabel = lang === 'en' ? 'Documentation' : '文档目录'
        body=`<main id="main" class="docs"><aside class="docs-nav"><nav aria-label="${navLabel}"><p>${navLabel}</p>${slugs.map(key=>`<a ${slug===key?'aria-current="page"':''} href="${local(route(lang,key))}">${key?t[key]:t.home}</a>`).join('')}</nav></aside><article class="prose">${renderMarkdown(markdown)}</article></main>`
      }
      const dir=path.join(output,route(lang,slug));await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'index.html'),shell(lang,slug,title,description,body))
    }
  }
  const chooser=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BaoYi · 抱一 — Choose your language</title><meta name="description" content="BaoYi is a local Windows workspace for files, projects and personal records. 抱一，让文件、项目和个人记录各归其位。"><link rel="canonical" href="${base.href}">${alternates('')}<link rel="stylesheet" href="${local('assets/site.css')}"></head><body><main class="language-home"><img src="${local('assets/icon.svg')}" alt="" width="64" height="64"><h1>BaoYi · <span lang="zh-CN">抱一</span></h1><p>A home for the things you keep. · <span lang="zh-CN">让收藏，回到生活里。</span></p><nav aria-label="Choose language"><a class="button primary" lang="en" href="${local('en/')}">English →</a><a class="button" lang="zh-CN" href="${local('zh-CN/')}">简体中文 →</a></nav></main></body></html>`
  await fs.writeFile(path.join(output,'index.html'),chooser)
  await fs.writeFile(path.join(output,'404.html'),`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found · BaoYi</title><link rel="stylesheet" href="${local('assets/site.css')}"></head><body><main class="language-home"><p class="eyebrow">404 · BAOYI</p><h1>Page not found<br><span lang="zh-CN">页面未找到</span></h1><nav aria-label="Choose language"><a class="button primary" href="${local('en/')}">English home</a><a class="button" lang="zh-CN" href="${local('zh-CN/')}">返回中文首页</a></nav></main></body></html>`)
  const urls=slugs.flatMap(slug=>languages.map(lang=>`<url><loc>${esc(url(route(lang,slug)))}</loc>${languages.map(other=>`<xhtml:link rel="alternate" hreflang="${other}" href="${esc(url(route(other,slug)))}"/>`).join('')}<xhtml:link rel="alternate" hreflang="x-default" href="${esc(url(route('en',slug)))}"/></url>`)).join('')
  await fs.writeFile(path.join(output,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`)
  await fs.writeFile(path.join(output,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${url('sitemap.xml')}\n`)
  await fs.writeFile(path.join(output,'.nojekyll'),'')
  if(process.env.SITE_URL&&base.pathname==='/'&&!base.hostname.endsWith('.github.io'))await fs.writeFile(path.join(output,'CNAME'),base.hostname+'\n')
  else await fs.rm(path.join(output,'CNAME'),{force:true})
  console.log('Built bilingual site: '+output+'\nCanonical URL: '+base.href)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSite()
