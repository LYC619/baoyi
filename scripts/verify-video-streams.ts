import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRendererLoader } from './helpers/renderer-harness.ts'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-streams-'))
const load = createRendererLoader({
  'node:fs': { default: fs, ...fs }, 'node:path': { default: path, ...path },
  './ffmpeg.ts': { remuxToMp4: async (_exe: string, inputs: string | string[], output: string) => {
    const files = Array.isArray(inputs) ? inputs : [inputs]
    assert.ok(files.every(file => fs.statSync(file).size > 0))
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), ...files.map(file => fs.readFileSync(file))]))
  } }
}, { process, Buffer, URL, Headers, Response, Request, AbortSignal, AbortController, ReadableStream, setTimeout, clearTimeout, Date, TextDecoder })
try {
  const hls = load('electron/kinds/video/download/hls.ts')
  const existing = path.join(root, 'existing.mp4'); fs.writeFileSync(existing, 'original')
  let requests = 0
  const fetcher: any = async (url: string) => { requests++; return new Response(url.endsWith('.m3u8') ? '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST' : 'segment') }
  await assert.rejects(hls.downloadHls({ url: 'https://media.test/a.m3u8', destination: existing, headers: {}, signal: new AbortController().signal, fetch: fetcher, ffmpeg: 'fixture', retries: 0 }), /存在/)
  assert.equal(requests, 0); assert.equal(fs.readFileSync(existing, 'utf8'), 'original')
  const success = await hls.downloadHls({ url: 'https://media.test/a.m3u8', destination: path.join(root,'hls.mp4'), headers: {}, signal: new AbortController().signal, fetch: fetcher, ffmpeg: 'fixture', retries: 0 })
  assert.ok(success.receivedBytes > 0)
  assert.equal(success.receivedBytes,fs.statSync(success.destination).size,'published metadata must use the remuxed file size')
  const competitor = path.join(root, 'competitor.mp4')
  await assert.rejects(hls.downloadHls({ url: 'https://media.test/a.m3u8', destination: competitor, headers: {}, signal: new AbortController().signal, ffmpeg: 'fixture', retries: 0,
    fetch: async (url: string) => { if (!url.endsWith('.m3u8')) fs.writeFileSync(competitor, 'competitor'); return fetcher(url) }
  }), /存在/)
  assert.equal(fs.readFileSync(competitor,'utf8'), 'competitor')
  await assert.rejects(hls.downloadHls({ url: 'https://media.test/stalled.m3u8', destination: path.join(root,'stall.mp4'), headers: {}, signal: new AbortController().signal, ffmpeg: 'fixture', retries: 0, idleTimeoutMs: 20, fetch: () => new Promise(() => {}) }), /超时/)
  const dash = load('electron/kinds/video/download/dash.ts')
  const mpd = `<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="init-$RepresentationID$.m4s" media="$Number%03d$.m4s"/><Representation id="v" height="720" bandwidth="100"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation id="a"><SegmentList><Initialization sourceURL="audio-init.m4s"/><SegmentURL media="a1.m4s"/><SegmentURL media="a2.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>`
  const tracks = dash.parseDash(mpd, 'https://media.test/manifest.mpd')
  assert.equal(tracks.length, 2)
  assert.deepEqual(Array.from(tracks[0].segments,(s: any) => s.url), ['https://media.test/init-v.m4s','https://media.test/001.m4s','https://media.test/002.m4s'])
  assert.throws(() => dash.parseDash(mpd.replace('type="static"','type="dynamic"'), 'https://media.test/a.mpd'), /直播|动态/)
  assert.throws(() => dash.parseDash(mpd.replace('<Representation id="v"', '<ContentProtection schemeIdUri="urn:test"/><Representation id="v"'), 'https://media.test/a.mpd'), /保护|DRM/)
  const timeline = `<MPD mediaPresentationDuration="PT6S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v"><BaseURL>sub/</BaseURL><SegmentTemplate timescale="1" initialization="init.m4s" media="$Time$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`
  assert.deepEqual(Array.from(dash.parseDash(timeline,'https://media.test/a.mpd')[0].segments,(s: any) => s.url), ['https://media.test/sub/init.m4s','https://media.test/sub/0.m4s','https://media.test/sub/2.m4s','https://media.test/sub/4.m4s'])
  const output = path.join(root,'dash.mp4')
  const result = await dash.downloadDash({ url:'https://media.test/manifest.mpd',destination:output,headers:{},signal:new AbortController().signal,ffmpeg:'fixture',retries:0,
    fetch: async (url: string) => new Response(url.endsWith('.mpd') ? mpd : 'track-fragment') })
  assert.ok(result.receivedBytes > 0); assert.ok(fs.statSync(output).size > 0)
  assert.equal(result.receivedBytes,fs.statSync(output).size)
  assert.throws(()=>hls.parsePlaylist('#EXTM3U\n#EXT-X-BYTERANGE:5\nx.ts\n#EXT-X-ENDLIST','https://media.test/a.m3u8'),/范围|BYTERANGE/)
  await assert.rejects(hls.downloadHls({url:'https://media.test/live.m3u8',destination:path.join(root,'live.mp4'),headers:{},signal:new AbortController().signal,ffmpeg:'fixture',retries:0,fetch:async()=>new Response('#EXTM3U\n#EXTINF:2,\nlive.ts')}),/直播|完整/)
  const calls:any[]=[]
  const audioLoad=createRendererLoader({'node:fs':{default:fs,...fs},'node:path':{default:path,...path},
    './ffmpeg.ts':{remuxToMp4:async(_exe:string,inputs:string|string[],target:string)=>{calls.push(inputs);fs.writeFileSync(target,Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from('muxed')]))}}},
    {process,Buffer,URL,Headers,Response,AbortSignal,AbortController,ReadableStream,setTimeout,clearTimeout,Date})
  const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=640x360,AUDIO="audio"\nvideo.m3u8'
  await audioLoad('electron/kinds/video/download/hls.ts').downloadHls({url:'https://media.test/master.m3u8',destination:path.join(root,'audio-hls.mp4'),headers:{},signal:new AbortController().signal,ffmpeg:'fixture',retries:0,
    fetch:async(url:string)=>new Response(url.endsWith('master.m3u8')?master:url.endsWith('.m3u8')?'#EXTM3U\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST':'part')})
  assert.ok(calls.some(inputs=>Array.isArray(inputs)&&inputs.length===2),'HLS audio renditions must be muxed with their video')
  assert.ok(!fs.readdirSync(root).some(name => name.endsWith('.baoyi-part.mp4')))
  console.log('PASS HLS/DASH format, separate audio/video, templates, timeline, dependency boundary, stalls and safe publication')
} finally { assert.equal(path.dirname(root),path.resolve(os.tmpdir())); fs.rmSync(root,{recursive:true,force:true}) }
