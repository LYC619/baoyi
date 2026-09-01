/**
 * 代理规则的纯函数部分。**这个文件不 import `electron`。**
 *
 * 拆出来的理由和 `hentai/selectors.ts` 对 `hanime.ts` 一样：`agent-selfcheck.ts`
 * 在纯 Node 下跑，而 `services/proxy.ts` 顶层就 `import { app, net, session }
 * from 'electron'` —— 自检一 import 它就崩在加载阶段，连一条断言都跑不到。
 */

/**
 * 规范化用户填的那串代理地址。
 *
 * 只做两件事：去空白、把裸 `host:port` 补成 Chromium 认的形式。
 *
 * **不校验协议名和端口范围**，这是刻意的：Chromium 自己会拒，而在这里重写一遍
 * 校验只会和它的规则打架并且必然漏 —— 它支持 `socks5://h:p`、`http://h:p`、
 * `direct://`、分号分隔的多条规则、`scheme=proxy` 这种按协议分流的写法。
 * 少写一种就等于把用户填对的东西判成错的。
 */
export function normalizeProxyRules(raw: string): string {
  const s = String(raw ?? '').trim()
  if (s === '') return ''
  // 裸 host:port（既没有 :// 也没有 = 的单条规则）当 HTTP 代理，
  // 和 Chromium 命令行 --proxy-server 的默认行为一致
  if (!s.includes('://') && !s.includes('=')) return `http://${s}`
  return s
}
