export const ONLINE_SOURCE_PARTITION = 'persist:video-discovery'
export const ONLINE_BROWSER_PARTITION = 'persist:general-web-browser'
export const ONLINE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function onlineVerificationPage(html: string): boolean {
  return /cf-browser-verification|__cf_chl|Just a moment|Checking your browser|Attention Required|you have been blocked/i.test(html.slice(0,200000))
}

export function onlineConnectionClosed(cause: unknown): boolean {
  return /ERR_CONNECTION_(?:CLOSED|RESET)|ERR_NETWORK_CHANGED|ECONNRESET/i.test(cause instanceof Error ? cause.message : String(cause))
}
export function onlineErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = message.match(/(?:net::)?(ERR_[A-Z_]+)/)?.[1]
  if (code) return `网站连接失败（${code}）。请在右上角设置 → 影视 → 找视频 · 网站与代理检查线路，或打开来源网页完成验证后重试。已缓存的资料仍保留。`
  return message
}
