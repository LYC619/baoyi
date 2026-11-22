import assert from 'node:assert/strict'
import { buildHanimeHostResolverRules, getHanimeHostsStatus, isHanimeHost } from '../electron/services/hanime/hanime-network-rules.ts'

// The watch page is reachable while an older HLS CDN has poisoned system DNS.
// Keep the original URL/Host/SNI, resolve its stable provider alias dynamically.
const cdn = 'abre-videos.youjizz.com'
const alias = 'abre-videos.youjizz.com.lds.rncdn7.com'
const status = getHanimeHostsStatus({ startupIp: '104.25.254.167' })
assert.ok(status.resolverRules.split(', ').includes(`MAP ${cdn} ${alias}`), 'built-in routing must cover the HLS CDN, not just the watch page')
assert.ok(status.hosts.includes(cdn), 'settings must show the media domain actually covered')
assert.match(status.resolverRules, /MAP hanime1\.me 104\.25\.254\.167/)
assert.equal(isHanimeHost(cdn), false, 'media CDN must not become an allowed watch/verification host')
assert.equal(getHanimeHostsStatus({ enabled: false }).resolverRules, '', 'disabling built-in hosts disables CDN mapping too')
assert.equal(buildHanimeHostResolverRules([], '192.0.2.1'), '', 'explicit empty scope must stay empty')
assert.equal(buildHanimeHostResolverRules(['hanime1.me'], '192.0.2.1'), 'MAP hanime1.me 192.0.2.1', 'explicit site-only scope stays unchanged')
assert.ok(!status.resolverRules.includes('MAP *'), 'no wildcard remapping')
console.log('PASS Hanime CDN routing, site scope, disabled mode and settings coverage')
