/**
 * MissAV 解析 + HLS 清单解析离线回归。不联网。
 * 其中一个用例用真实 MissAV 页面里抽出的压缩脚本（fixtures/missav-packed.txt）当输入。
 *
 * node --experimental-strip-types --no-warnings scripts/verify-missav-parse.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { findMissavDetail, extractMissavM3u8, missavPageCandidates } from '../electron/kinds/video/discovery/missav.ts'
import { parsePlaylist } from '../electron/kinds/video/download/hls.ts'

const base = 'https://cdn.example/hls/master.m3u8'

// —— MissAV：真实页面里抽出的压缩脚本能解出 m3u8 ——
const packed = readFileSync('scripts/fixtures/missav-packed.txt', 'utf8')
const html = `<!doctype html><html><body><script>${packed}</script></body></html>`
assert.equal(extractMissavM3u8(html), 'https://surrit.com/0c73d32d-45a1-411c-9c38-d20308920041/playlist.m3u8')

// 普通 HTML 兜底
assert.equal(extractMissavM3u8('<html><body>src="https://x.test/a/master.m3u8"</body></html>'), 'https://x.test/a/master.m3u8')
assert.equal(extractMissavM3u8('<html></html>'), '')

// 番号 → 候选地址
assert.deepEqual(missavPageCandidates('SSIS-001', 'missav.ws'), ['https://missav.ws/ssis-001', 'https://missav.ws/search/ssis-001'])
assert.deepEqual(missavPageCandidates('', 'missav.ws'), [])

// 站内搜索结果里按番号找详情页
const search = '<a href="/dm44/ssis-001">SSIS-001 女友不在的三天</a><a href="/dm9/abcd-999">无关</a>'
assert.equal(findMissavDetail(search, 'SSIS-001', 'missav.ws')?.url, 'https://missav.ws/dm44/ssis-001')
assert.equal(findMissavDetail('<a href="/x">no</a>', 'SSIS-001', 'missav.ws'), null)

// —— HLS：主清单选画质 ——
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\n360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080/index.m3u8\n'
const parsedMaster = parsePlaylist(master, base)
assert.equal(parsedMaster.type, 'master')
if (parsedMaster.type === 'master') {
  assert.equal(parsedMaster.variants.length, 2)
  assert.equal(parsedMaster.variants[0].url, 'https://cdn.example/hls/360/index.m3u8')
  assert.equal(parsedMaster.variants[1].height, 1080)
}

// —— HLS：媒体清单（AES-128 + BYTERANGE + MEDIA-SEQUENCE）——
const media = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000A\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-BYTERANGE:200@400\n#EXTINF:4.0,\nseg1.ts\n'
const parsedMedia = parsePlaylist(media, base)
assert.equal(parsedMedia.type, 'media')
if (parsedMedia.type === 'media') {
  assert.equal(parsedMedia.segments.length, 2)
  assert.equal(parsedMedia.segments[0].sequence, 10)
  assert.equal(parsedMedia.segments[0].key?.method, 'AES-128')
  assert.equal(parsedMedia.segments[0].key?.url, 'https://cdn.example/hls/key.bin')
  assert.equal(parsedMedia.segments[1].sequence, 11)
  assert.deepEqual(parsedMedia.segments[1].range, { start: 400, end: 599 })
}

// 不支持的加密方式要明确拒绝，不静默
assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:1,\ns.ts\n', base), /不支持的加密方式/)
assert.throws(() => parsePlaylist('<html>not a playlist</html>', base), /有效 M3U8/)

console.log('verify-missav-parse: all assertions passed')
