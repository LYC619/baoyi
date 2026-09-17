/**
 * 拿 Electron 自己的网络栈（Chromium + BoringSSL）探一次 hanime，走代理。
 *
 *   npx electron scripts/probe-hanime-proxy.cjs [socks5://127.0.0.1:10808]
 *
 * 为什么不能拿 curl 的结论当准：git-bash 那个 curl 只有 Schannel 一个 TLS 后端，
 * 它报 `failed to receive handshake` 有可能是后端自己的毛病，而应用真正用的是
 * Chromium 的栈。两者结论可能不同，所以要在真栈上问一次。
 *
 * 探到就把页面存进 `doc/fixtures/`，那是待确认 H 想要的真实语料。
 */
const { app, session, net } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PROXY = process.argv[2] || 'socks5://127.0.0.1:10808'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

const TARGETS = [
  ['search', 'https://hanime1.me/search?genre=%E8%A3%8F%E7%95%AA'],
  ['watch', 'https://hanime1.me/watch?v=86994'],
  ['home', 'https://hanime1.me/'],
  ['control', 'https://example.com/']
]

const OUT = path.join(__dirname, '..', 'doc', 'fixtures')

let hanimeSession

function get(url) {
  return new Promise((resolve) => {
    const started = Date.now()
    let req
    try {
      req = net.request({ url, method: 'GET', session: hanimeSession, useSessionCookies: true })
    } catch (err) {
      return resolve({ ok: false, err: `request() 就抛了：${err.message}` })
    }
    req.setHeader('User-Agent', UA)
    req.setHeader('Accept-Language', 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7')
    req.setHeader(
      'Accept',
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    )
    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {}
      resolve({ ok: false, err: `超时（30s）`, ms: Date.now() - started })
    }, 30_000)

    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
          ms: Date.now() - started
        })
      })
      res.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, err: `响应流错误：${e.message}`, ms: Date.now() - started })
      })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, err: err.message, ms: Date.now() - started })
    })
    req.end()
  })
}

app.whenReady().then(async () => {
  console.log(`\n代理：${PROXY}\n`)
  hanimeSession = session.fromPartition('persist:hanime-network-probe')
  await hanimeSession.setProxy({ proxyRules: PROXY })
  const resolved = await hanimeSession.resolveProxy('https://hanime1.me/')
  console.log(`resolveProxy 说：${resolved}\n`)

  fs.mkdirSync(OUT, { recursive: true })
  const summary = []

  for (const [name, url] of TARGETS) {
    const r = await get(url)
    if (!r.ok) {
      console.log(`  ✗ ${name.padEnd(8)} ${url}\n      ${r.err}（${r.ms ?? '?'}ms）`)
      summary.push({ name, ok: false, err: r.err })
      continue
    }
    const title = (r.body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || ''
    console.log(
      `  ✓ ${name.padEnd(8)} ${r.status} ${String(r.body.length).padStart(7)} 字节  ${r.ms}ms  «${title.trim().slice(0, 60)}»`
    )
    summary.push({ name, ok: true, status: r.status, bytes: r.body.length, title: title.trim() })

    /*
     * **只存 2xx，而且只存不像盾页的。**
     *
     * 第一版只判 `name !== 'control'` 就写盘，于是代理换节点之后 Cloudflare 回的
     * 那三个 403「Sorry, you have been blocked」被当成真页面存进了
     * `doc/fixtures/` —— 文件名叫 `hanime-search.html`、5485 字节、看着齐全。
     *
     * 那比不存更糟：fixture 是要长期当回归语料用的，存一份盾页进去，
     * 以后拿它验选择器会得到「所有选择器都失效了」的假结论，而真正的原因是
     * 语料本身是假的。`net.request` 不会因为 403 就 reject，所以「拿到响应」
     * 和「拿到内容」必须自己分清。
     */
    const looksBlocked =
      /Attention Required|Just a moment|cf-error-details|you have been blocked/i.test(r.body)
    if (name === 'control') continue
    if (r.status < 200 || r.status >= 300) {
      console.log(`      不存：HTTP ${r.status} 不是内容（存进 fixture 会污染回归语料）`)
      continue
    }
    if (looksBlocked) {
      console.log(`      不存：像盾页，不是内容`)
      continue
    }
    const f = path.join(OUT, `hanime-${name}.html`)
    fs.writeFileSync(f, r.body, 'utf-8')
    console.log(`      存了 ${path.relative(path.join(__dirname, '..'), f)}`)
  }

  fs.writeFileSync(path.join(OUT, 'probe-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  console.log('')
  app.exit(summary.some((s) => s.ok && s.name !== 'control') ? 0 : 1)
})
