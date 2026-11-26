import { getDb } from '../storage/database.ts'
import { session } from 'electron'
import { getSettings } from '../storage/settings-store.ts'
import { parseProxyInput, serializeProxyInput, toElectronProxyConfig } from './proxy-rules.ts'
import { ONLINE_SOURCE_PARTITION, ONLINE_BROWSER_PARTITION, ONLINE_USER_AGENT, onlineErrorMessage, onlineVerificationPage } from './online-network-rules.ts'
import type { OnlineNetworkProbe } from '../../../src/types/video-discovery.ts'
let applied: string | null = null
let queue: Promise<void> = Promise.resolve()

/** A distinct setting for online sources; never changes the Hanime session. */
export function ensureOnlineNetwork(): Promise<void> {
  const raw = getSettings(getDb()).video_online_proxy ?? 'system://'
  const input = parseProxyInput(raw), rules = serializeProxyInput(input)
  const next = queue.then(async () => {
    if (applied === rules) return
    for (const partition of [ONLINE_SOURCE_PARTITION, ONLINE_BROWSER_PARTITION]) {
      const network = session.fromPartition(partition)
      network.setUserAgent(ONLINE_USER_AGENT, 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7')
      await network.setProxy(toElectronProxyConfig(input))
    }
    applied = rules
  })
  queue = next.catch(() => { /* 原始 Promise 的错误已交给调用方；这里只释放队列或监听。 */ })
  return next
}

export const onlineFetch: typeof globalThis.fetch = async (input, init) => {
  await ensureOnlineNetwork()
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return session.fromPartition(ONLINE_SOURCE_PARTITION).fetch(url, { ...init, credentials: 'include' })
}

export async function onlineNetworkStatus(url: string): Promise<{ resolved: string }> {
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('请输入有效的网站地址')
  await ensureOnlineNetwork()
  return { resolved: await session.fromPartition(ONLINE_SOURCE_PARTITION).resolveProxy(target.href) }
}

export async function probeOnlineNetwork(url: string): Promise<OnlineNetworkProbe> {
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('请输入有效的网站地址')
  await ensureOnlineNetwork()
  const network = session.fromPartition(ONLINE_SOURCE_PARTITION)
  const resolved = await network.resolveProxy(target.href)
  let response: Response
  try {
    response = await onlineFetch(target.href, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(15000)
    })
  } catch (cause) {
    throw new Error(`代理路由：${resolved}。${onlineErrorMessage(cause)}`)
  }
  const contentType = response.headers.get('content-type') || ''
  const result: OnlineNetworkProbe = {resolved,status:response.status,statusText:response.statusText,finalUrl:response.url,contentType,outcome:'response_received',pageInspected:false,sampleTruncated:false}
  if (response.status === 407) result.outcome = 'proxy_auth_required'
  else if (response.status === 429) result.outcome = 'rate_limited'
  else if ([401,403].includes(response.status)) result.outcome = 'restricted'
  else if (response.status >= 500) result.outcome = 'server_error'
  else if (!response.ok) result.outcome = 'http_error'
  if (response.ok && (!contentType || /text\/html|application\/xhtml\+xml/i.test(contentType)) && response.body) {
    const reader = response.body.getReader(), chunks: Uint8Array[] = [], budget = 64 * 1024
    let length = 0
    try {
      while (length < budget) {
        const {done,value} = await reader.read()
        if (done) break
        const part = value.slice(0,budget-length); chunks.push(part); length += part.length
        if (length === budget) result.sampleTruncated = true
      }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.length}
      result.pageInspected = true
      if (onlineVerificationPage(new TextDecoder().decode(bytes))) result.outcome = 'verification_required'
    } catch (cause) {
      throw new Error(`代理路由：${resolved}。读取网页诊断内容失败：${onlineErrorMessage(cause)}`)
    } finally {await reader.cancel().catch(() => { /* best-effort */ });reader.releaseLock()}
  } else await response.body?.cancel().catch(() => { /* best-effort */ })
  return result
}
