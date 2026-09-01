/**
 * 验代理这条接线真的通到了 hanime 的取页函数上。
 *
 *   npx electron scripts/verify-proxy.cjs [socks5://127.0.0.1:10808]
 *
 * ## 为什么非要单独验这一路
 *
 * 主进程里有两套网络栈：`globalThis.fetch` 是 Node 的 undici（**不吃**
 * session 的代理），`net.fetch` 是 Chromium 的（吃）。配了代理却仍从 undici
 * 出去的话，代理**完全不生效**，而现象是「设置里明明填了」——四道闸门一条都
 * 抓不到，typecheck 只知道类型对得上，不知道包走哪条路。
 *
 * 所以这里问的是一个**可观测**的问题：请求到底从哪个出口出去了。办法是拿
 * 一个会把来源 IP 回给你的服务当镜子，比较「直连」和「走代理」两次的答案 ——
 * 两次一样就说明代理没接上。
 *
 * 用打包前的 `dist-electron/main.js` 里那套逻辑的源文件，不是复制一份实现。
 */
const { app, session, net } = require('electron')

const PROXY = process.argv[2] || 'socks5://127.0.0.1:10808'
const MIRROR = 'https://api.ipify.org?format=json'

function get(url) {
  return new Promise((resolve) => {
    const req = net.request({ url, method: 'GET', credentials: 'omit' })
    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {}
      resolve({ ok: false, err: '超时' })
    }, 25_000)
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') })
      })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, err: e.message })
    })
    req.end()
  })
}

let failed = 0
function check(name, cond, note = '') {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${note ? ` —— ${note}` : ''}`)
  if (!cond) failed++
}

app.whenReady().then(async () => {
  console.log('\n代理接线验证\n')

  // ---------- 1. 直连时的出口 ----------
  await session.defaultSession.setProxy({ mode: 'direct' })
  const direct = await get(MIRROR)
  const directIp = direct.ok ? (JSON.parse(direct.body).ip ?? '') : ''
  console.log(`  直连出口：${directIp || `拿不到（${direct.err ?? direct.status}）`}`)

  // ---------- 2. 铺上代理之后的出口 ----------
  // 和 services/proxy.ts 一样**不设** proxyBypassRules：Chromium 默认绕开
  // loopback，而 `<-loopback>` 是反过来的（把回环塞进代理）。第一版写了它，
  // 下面那条回环断言当场就红了
  await session.defaultSession.setProxy({ proxyRules: PROXY })
  const resolved = await session.defaultSession.resolveProxy('https://hanime1.me/')
  check('resolveProxy 认下了这条规则', /SOCKS|PROXY/i.test(resolved), resolved)

  const viaProxy = await get(MIRROR)
  const proxyIp = viaProxy.ok ? (JSON.parse(viaProxy.body).ip ?? '') : ''
  console.log(`  代理出口：${proxyIp || `拿不到（${viaProxy.err ?? viaProxy.status}）`}`)

  check('走代理时拿到了出口 IP', proxyIp !== '', proxyIp)

  /*
   * 核心那一条：包到底走没走代理。
   *
   * 判据分两种情况，因为「直连拿不到」本身就是一种答案：
   *
   * - 直连也通：两个出口 IP 必须**不同**。相同就说明代理没接上。
   * - 直连不通而走代理通了：这比上一种更强 —— 同一个 net.fetch，铺上规则前
   *   连不出去、铺上之后连出去了，包只可能是从代理走的。
   *
   * 第一版只写了前一种，于是在这台机器上（直连被 REFUSED）红了一条，而红的
   * 原因是判据没覆盖这个环境，不是接线坏了。
   */
  if (directIp !== '') {
    check(
      '代理出口和直连出口不同 —— 包真的走代理了',
      proxyIp !== '' && directIp !== proxyIp,
      `直连 ${directIp} / 代理 ${proxyIp}`
    )
  } else {
    check(
      '直连拿不到而走代理拿到了 —— 包只可能是从代理走的',
      proxyIp !== '',
      `直连失败（${direct.err ?? direct.status}），代理 ${proxyIp}`
    )
  }

  // ---------- 3. 回环不走代理 ----------
  const loop = await session.defaultSession.resolveProxy('http://127.0.0.1:1/')
  check('回环地址绕开代理（否则海报那条协议会裂）', /DIRECT/i.test(loop), loop)

  // ---------- 4. 切回直连要真的切回去 ----------
  await session.defaultSession.setProxy({ mode: 'direct' })
  const back = await session.defaultSession.resolveProxy('https://hanime1.me/')
  check('清空代理后回到 DIRECT（不然「删掉代理」是假的）', /DIRECT/i.test(back), back)

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条失败`}`)
  app.exit(failed === 0 ? 0 : 1)
})
