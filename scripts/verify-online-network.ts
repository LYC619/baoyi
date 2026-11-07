/** Runs the production session wiring with Electron boundaries injected, without remote requests. */
import assert from 'node:assert/strict'
import { createRendererLoader } from './helpers/renderer-harness.ts'
import { ONLINE_SOURCE_PARTITION, ONLINE_BROWSER_PARTITION, ONLINE_USER_AGENT } from '../electron/services/online-network-rules.ts'
let rule = 'system://'
const sessions = new Map<string, { rules: unknown[]; ua: string[]; requests: Array<{ url: string; init: RequestInit }> }>()
const load = createRendererLoader({
  electron: { session: { fromPartition(partition: string) {
    if (!sessions.has(partition)) sessions.set(partition, { rules: [], ua: [], requests: [] })
    const record = sessions.get(partition)!
    return {
      setUserAgent: (ua: string) => record.ua.push(ua),
      setProxy: async (config: unknown) => { record.rules.push(config) },
      fetch: async (url: string, init: RequestInit) => { record.requests.push({ url, init }); return new Response('ok') },
      resolveProxy: async () => rule === 'system://' ? 'PROXY fixture:1234' : 'DIRECT'
    }
  } } },
  './database.ts': { getSettings: () => ({ video_online_proxy: rule, proxy: 'socks5://hanime-only:4321' }) }
}, { URL, Response })
const network = load('electron/services/online-network.ts') as typeof import('../electron/services/online-network.ts')
await Promise.all([network.onlineFetch('https://example.org/list'), network.onlineFetch('https://example.org/detail')])
assert.deepEqual([...sessions.keys()], [ONLINE_SOURCE_PARTITION, ONLINE_BROWSER_PARTITION])
for (const record of sessions.values()) {
  assert.equal(record.rules.length, 1); assert.equal((record.rules[0] as { mode: string }).mode, 'system')
  assert.equal(record.ua[0], ONLINE_USER_AGENT)
}
const source = sessions.get(ONLINE_SOURCE_PARTITION)!
assert.equal(source.requests.length, 2)
assert.ok(source.requests.every(request => request.init.credentials === 'include'))
assert.equal((await network.onlineNetworkStatus('https://example.org')).resolved, 'PROXY fixture:1234')
rule = ''
await network.onlineFetch('https://example.org/next')
assert.equal((source.rules[1] as { mode: string }).mode, 'direct')
assert.equal(source.rules.length, 2)
assert.equal(sessions.has('persist:hanime-network'), false)
console.log('PASS shared source sessions, credentials, proxy serialization, live rule changes and Hanime isolation')
