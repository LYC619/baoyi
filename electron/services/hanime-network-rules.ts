/**
 * Hanime 的内置 Hosts 规则。
 *
 * 这是纯数据/纯函数模块，不能 import Electron：自检脚本在 Node 下直接复用它。
 *
 * 两层用法，对应 Chromium 的一条硬限制 —— `--host-resolver-rules` 只在 app ready
 * 之前读一次，一个域名也只能 MAP 到一个地址：
 *
 * 1. 启动前：把地址池的第一个 IP 写进 host-resolver-rules，专用 session 里的
 *    页面、验证窗口、下载全都吃这一条（`main.ts`）。
 * 2. 运行时：Chromium 那条连不上时，取页层按地址池顺序换下一个 IP 直连重试
 *    （`proxy.ts` 的 hanimeFetch + `hanime-direct.ts`）。哪一个通了就记住，下次先试它，
 *    并写进设置：下次启动的 Chromium 规则直接用它（`pickStartupIp`）。
 *
 * 用户可以在设置里关掉内置 Hosts：关掉后两层都不做，走系统 DNS。
 */

export const HANIME_HOSTS = [
  'hanime1.me',
  'hanime1.com',
  'hanimeone.me',
  'javchu.com'
] as const

export const HANIME_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Cloudflare 地址池，顺序即尝试顺序。来自 Han1meViewer 的 HDns.kt。
 * 第一个用于 Chromium 启动规则，其余供运行时回退。
 */
export const HANIME_CLOUDFLARE_IPS = [
  '172.64.229.154',
  '104.25.254.167',
  '172.67.75.184',
  '104.21.7.20',
  '172.67.187.141'
] as const

/**
 * 生成 Chromium `--host-resolver-rules` 的值。
 *
 * 规则以逗号分隔。每个镜像单独 MAP，避免把规则扩大到 TMDB、豆瓣或其他域名。
 * Chromium 会保留请求里的 Host/SNI，因此 Cloudflare 地址仍能按镜像域名路由。
 */
export function buildHanimeHostResolverRules(
  hosts: readonly string[] = HANIME_HOSTS,
  ip: string = HANIME_CLOUDFLARE_IPS[0]
): string {
  const address = String(ip ?? '').trim()
  if (!address) return ''

  return hosts
    .map((host) => String(host).trim().toLowerCase())
    .filter(Boolean)
    .map((host) => `MAP ${host} ${address}`)
    .join(', ')
}

export function isHanimeHost(hostname: string): boolean {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '')
  return (HANIME_HOSTS as readonly string[]).includes(host)
}

/**
 * 运行时回退的尝试顺序：上次通的那个排最前，其余按地址池顺序；`exclude` 里的
 * （通常是 Chromium 刚刚失败的启动地址）不再试。
 */
export function orderedHanimeIps(
  preferred = '',
  exclude: readonly string[] = [],
  pool: readonly string[] = HANIME_CLOUDFLARE_IPS
): string[] {
  const skip = new Set(exclude)
  const rest = pool.filter((ip) => ip !== preferred && !skip.has(ip))
  return preferred && !skip.has(preferred) && pool.includes(preferred) ? [preferred, ...rest] : rest
}

/**
 * 「线路不通」和「站点拒绝」要分开：只有前者值得换 IP 重试。
 * 403 / 挑战页是有回应的，换地址也还是那面盾，交给上层处理。
 */
export function isConnectionFailure(cause: unknown): boolean {
  const text = cause instanceof Error ? `${cause.name} ${cause.message} ${(cause as { code?: string }).code ?? ''} ${cause.cause instanceof Error ? cause.cause.message : ''}` : String(cause ?? '')
  return /net::ERR_(?!ABORTED)|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|TimeoutError|timed out/i.test(text)
}

export interface HanimeHostsState {
  enabled: boolean
  /** 本次启动写进 Chromium 规则的地址（上次记住的可用地址，没有就是地址池第一个） */
  startupIp: string
  /** 运行时回退最近一次成功的地址；空串 = 还没回退过 */
  activeIp: string
}

/**
 * 决定启动时写进 Chromium 规则的地址：上次运行时回退通了的那个优先，
 * 不在地址池里（池子改过、设置被手改）就退回第一个。这样启动地址死了一次之后，
 * 下次启动验证窗口和下载就不会再撞同一堵墙。
 */
export function pickStartupIp(remembered = '', pool: readonly string[] = HANIME_CLOUDFLARE_IPS): string {
  const ip = String(remembered ?? '').trim()
  return ip && pool.includes(ip) ? ip : pool[0]
}

/**
 * 验证窗口主框架加载失败时，判断是不是「根本连不上」：这种情况下窗口等多久都没用，
 * 应当立刻结束而不是耗满 120 秒。`code` 是 Chromium 的 net error（-3 = ERR_ABORTED，
 * 属于被新导航顶掉，不算失败）；`description` 是 Electron 给的 `ERR_*` 名字。
 */
export function isUnreachableLoadError(code: number, description = ''): boolean {
  if (code === -3) return false
  return /^ERR_(TIMED_OUT|CONNECTION_\w+|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_\w+)$/.test(String(description ?? '').trim())
}

export function getHanimeHostsStatus(state: Partial<HanimeHostsState> = {}) {
  const enabled = state.enabled !== false
  const startupIp = pickStartupIp(state.startupIp)
  return {
    enabled,
    hosts: [...HANIME_HOSTS],
    ips: [...HANIME_CLOUDFLARE_IPS],
    startupIp: enabled ? startupIp : '',
    activeIp: enabled ? state.activeIp ?? '' : '',
    resolverRules: enabled ? buildHanimeHostResolverRules(HANIME_HOSTS, startupIp) : ''
  } as const
}
