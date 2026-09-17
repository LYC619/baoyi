const { app, BrowserWindow, net, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const query = process.argv[2] || '妻NTR・凌辱輪迴'
const proxy = process.argv[3] || 'direct://'
const base = 'https://hanime1.me/'
const ua =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const profile = path.join(__dirname, '..', '.tmp-hanime-api-probe')

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.setPath('userData', profile)
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP hanime1.me 172.64.229.154, MAP hanime1.com 172.64.229.154, MAP hanimeone.me 172.64.229.154, MAP javchu.com 172.64.229.154'
)

function request(ses, url) {
  return new Promise((resolve) => {
    const req = net.request({ url, method: 'GET', session: ses, useSessionCookies: true })
    req.setHeader('User-Agent', ua)
    req.setHeader('Accept-Language', 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7')
    req.setHeader('Accept', 'text/html,application/xhtml+xml')
    const chunks = []
    const timer = setTimeout(() => {
      try { req.abort() } catch {}
      resolve({ ok: false, error: 'timeout' })
    }, 30000)
    req.on('response', (res) => {
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }) })
    })
    req.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }) })
    req.end()
  })
}

function summary(name, result) {
  if (!result.ok) return { name, ok: false, error: result.error }
  const title = (result.body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || ''
  const challengeRe = /cf-browser-verification|__cf_chl|Just a moment|Checking your browser|Attention Required|cf-error-details|you have been blocked|verify you are human/gi
  const matches = [...result.body.matchAll(challengeRe)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i)
  const challenge = matches.length > 0
  const ids = [...result.body.matchAll(/(?:watch\?[^"'<>]*?v=|data-video-id=["'])(\d{3,})/gi)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i)
  return { name, ok: true, status: result.status, bytes: result.body.length, title: title.trim(), challenge, matches, ids: ids.slice(0, 10) }
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:hanime-api-probe')
  await ses.setProxy(proxy === 'direct://' ? { mode: 'direct' } : { proxyRules: proxy })
  const resolved = await ses.resolveProxy(base)
  const targets = [
    ['search', `${base}search?query=${encodeURIComponent(query)}&genre=%E8%A3%8F%E7%95%AA`],
    ['watch', `${base}watch?v=86994`]
  ]
  const results = []
  console.log(JSON.stringify({ query, proxy, resolved, ua, profile }, null, 2))
  for (const [name, url] of targets) {
    const result = await request(ses, url)
    const row = summary(name, result)
    results.push(row)
    if (result.ok) fs.writeFileSync(path.join(profile, `${name}.html`), result.body, 'utf8')
    console.log(JSON.stringify({ url, ...row }, null, 2))
  }
  const cookies = await ses.cookies.get({ url: base })
  console.log(JSON.stringify({ cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, secure: c.secure })) }, null, 2))
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'summary.json'), JSON.stringify({ query, proxy, resolved, results, cookies }, null, 2))
  app.exit(results.some((r) => r.ok && r.status >= 200 && r.status < 300 && !r.challenge && r.ids?.length) ? 0 : 1)
})
