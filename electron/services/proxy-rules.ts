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

export type ProxyInput =
  | { mode: 'direct' }
  | { mode: 'system' }
  | { mode: 'http' | 'socks5'; host: string; port: number }
  | { mode: 'custom'; rules: string }

export type ElectronProxyConfig =
  | { mode: 'direct' | 'system' }
  | { proxyRules: string }

export function parseProxyInput(raw: string): ProxyInput {
  const value = String(raw ?? '').trim()
  if (!value) return { mode: 'direct' }
  if (value.toLowerCase() === 'direct://') return { mode: 'direct' }
  if (value.toLowerCase() === 'system://' || value.toLowerCase() === 'system') {
    return { mode: 'system' }
  }

  const normalized = normalizeProxyRules(value)
  const match = /^(https?|socks5):\/\/([^/:]+|\[[^\]]+\]):(\d+)$/.exec(normalized)
  if (!match) {
    if (normalized.includes('=') || normalized.includes(';')) {
      return { mode: 'custom', rules: normalized }
    }
    throw new Error('代理地址必须是 system://、http://host:port 或 socks5://host:port')
  }

  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理端口必须在 1-65535 之间')
  }

  return {
    mode: match[1].toLowerCase() === 'socks5' ? 'socks5' : 'http',
    host: match[2],
    port
  }
}

export function serializeProxyInput(input: ProxyInput): string {
  if (input.mode === 'direct') return ''
  if (input.mode === 'system') return 'system://'
  if (input.mode === 'custom') return input.rules
  return `${input.mode === 'socks5' ? 'socks5' : 'http'}://${input.host}:${input.port}`
}

export function toElectronProxyConfig(input: ProxyInput): ElectronProxyConfig {
  if (input.mode === 'direct' || input.mode === 'system') return { mode: input.mode }
  return { proxyRules: serializeProxyInput(input) }
}

export function usesChromiumFetch(input: ProxyInput): boolean {
  // Hanime 的内置 Hosts/DNS 规则由 Chromium 网络栈承载，直连也必须走这里。
  // 代理模式只决定 session 的路由，不决定是否启用这条网络栈。
  void input
  return true
}
