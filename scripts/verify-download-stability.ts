import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'
import { transferAccelerated } from '../electron/kinds/video/download/ranges.ts'
import { readDownloadResource, retryableDownloadError } from '../electron/kinds/video/download/resource.ts'
import { createBudgetedFetch, createDownloadLimiter } from '../electron/kinds/video/download/limiter.ts'
import { downloadHls } from '../electron/kinds/video/download/hls.ts'
import { downloadDash } from '../electron/kinds/video/download/dash.ts'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-stability-'))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let passed = 0, failed = 0
async function test(name: string, run: () => Promise<void>) { try { await run(); passed++; console.log('PASS ' + name) } catch (error) { failed++; console.error('FAIL ' + name, error) } }
const media = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(512 * 1024, 29)])
try {
  await test('small network chunks are buffered before Range disk writes without losing bytes', async () => {
    const open = fs.open
    let writes = 0
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.segment')) {
        const write = handle.write.bind(handle)
        handle.write = (async (...params: any[]) => { writes++; return (write as any)(...params) }) as typeof handle.write
      }
      return handle
    }) as typeof fs.open
    try {
      const fetcher: typeof fetch = async (_url, init) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!
        const start = Number(match[1]), end = Number(match[2])
        let offset = start
        const body = new ReadableStream({ pull(controller) {
          if (offset > end) { controller.close(); return }
          const next = Math.min(offset + 1024, end + 1)
          controller.enqueue(media.subarray(offset, next)); offset = next
        } })
        return new Response(body, { status:206, headers:{'Content-Range':`bytes ${start}-${end}/${media.length}`,ETag:'"buffered"'} })
      }
      const started = performance.now()
      const result = await transferAccelerated({url:'https://cdn.test/small-chunks.mp4',destination:path.join(root,'buffered.mp4'),referer:'https://hanime1.me/watch?v=1',signal:new AbortController().signal,fetch:fetcher,workers:4})
      assert.deepEqual(await fs.readFile(result.destination),media)
      console.log(`Range small-chunk sample: ${writes} writes, ${Math.round(performance.now()-started)} ms`)
      assert.ok(writes <= Math.ceil(media.length/(128*1024))+8, `small chunks triggered ${writes} disk writes`)
    } finally { fs.open = open }
  })
  await test('continuous CDN avoids Range on first download and resumes a verified checkpoint', async () => {
    const requests: Array<string|null> = []
    const fetcher: typeof fetch = async (_url, init) => {
      const range = new Headers(init?.headers).get('range'); requests.push(range)
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range)
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : media.length-1
      let offset = start
      const body = new ReadableStream({ pull(controller) {
        if(offset>end){controller.close();return}
        const next=Math.min(offset+8192,end+1);controller.enqueue(media.subarray(offset,next));offset=next
      } })
      return new Response(body,{status:range?206:200,headers:{'Content-Length':String(end-start+1),ETag:'"continuous"',...(range?{'Content-Range':'bytes '+start+'-'+end+'/'+media.length}:{})}})
    }
    const options={url:'https://vdownload.hembed.com/file.mp4',destination:path.join(root,'continuous.mp4'),referer:'https://hanime1.me/watch?v=1',fetch:fetcher,workers:4}
    const result=await transferAccelerated({...options,signal:new AbortController().signal})
    assert.deepEqual(await fs.readFile(result.destination),media)
    assert.deepEqual(requests,[null],'first transfer must reuse one full response rather than issue small Range requests')
    requests.length=0
    const destination=path.join(root,'continuous-resume.mp4'),stop=new AbortController()
    await assert.rejects(transferAccelerated({...options,destination,signal:stop.signal,onProgress:p=>{if(p.receivedBytes>0)stop.abort(new Error('pause continuous'))}}),/pause continuous/)
    requests.length=0
    const resumed=await transferAccelerated({...options,destination,signal:new AbortController().signal})
    assert.deepEqual(await fs.readFile(resumed.destination),media)
    assert.ok(requests.some(range=>range && /^bytes=[1-9]\d*-/.test(range)),'retry must retain and continue the verified prefix')
  })
  for(const mode of ['weak-validator','no-validator','corrupt-cache','changed-entity','ignored-range'])await test('continuous resume protects against '+mode,async()=>{
    let resumed=false
    const requests:Array<string|null>=[]
    const replacement=Buffer.from(media);replacement.fill(41,32)
    const fetcher:typeof fetch=async(_url,init)=>{
      const range=new Headers(init?.headers).get('range');requests.push(range)
      const partial=!!range && mode!=='ignored-range'
      const start=partial?Number(/^bytes=(\d+)-$/.exec(range!)![1]):0
      const bytes=resumed && mode==='changed-entity'?replacement:media
      const etag=mode==='no-validator'?undefined:mode==='weak-validator'?'W/"weak"':resumed && mode==='changed-entity'?'"new"':'"old"'
      let offset=start
      return new Response(new ReadableStream({pull(controller){
        if(offset===bytes.length){controller.close();return}
        const next=Math.min(offset+8192,bytes.length);controller.enqueue(bytes.subarray(offset,next));offset=next
      }}),{status:partial?206:200,headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.length-start),...(etag?{ETag:etag}:{}),...(partial?{'Content-Range':`bytes ${start}-${bytes.length-1}/${bytes.length}`}:{})}})
    }
    const destination=path.join(root,'continuous-'+mode+'.mp4'),control=new AbortController()
    const options={url:'https://vdownload.hembed.com/file.mp4',destination,referer:'https://hanime1.me/watch?v=1',fetch:fetcher}
    await assert.rejects(transferAccelerated({...options,signal:control.signal,onProgress:p=>{if(p.receivedBytes)control.abort(new Error('pause fixture'))}}),/pause fixture/)
    const workspace=path.join(root,'.'+path.basename(destination)+'.baoyi-ranges')
    if(mode==='corrupt-cache')await fs.writeFile(path.join(workspace,'0.segment'),Buffer.alloc(8192,99))
    resumed=true;requests.length=0
    const result=await transferAccelerated({...options,signal:AbortSignal.timeout(5000)})
    assert.deepEqual(await fs.readFile(destination),mode==='changed-entity'?replacement:media)
    if(mode==='ignored-range')assert.deepEqual(requests,[null,'bytes=8192-',null])
    else assert.deepEqual(requests,[null],'untrusted cached prefix must be discarded before consuming the full response')
    await assert.rejects(fs.stat(workspace),/ENOENT/)
    assert.equal(result.receivedBytes,media.length)
  })
  await test('stalled initial full response is cancelled before retrying with one connection',async()=>{
    const requests:Array<string|null>=[];let cancelled=0
    const fetcher=createBudgetedFetch(async(_url,init)=>{
      const range=new Headers(init?.headers).get('range');requests.push(range)
      const body=range?media:new ReadableStream({cancel(){cancelled++}})
      return new Response(body,{status:range?206:200,headers:{'Content-Length':String(media.length),ETag:'"stalled"',...(range?{'Content-Range':`bytes 0-${media.length-1}/${media.length}`}:{})}})
    },createDownloadLimiter(()=>1))
    const result=await transferAccelerated({url:'https://vdownload.hembed.com/stall.mp4',destination:path.join(root,'continuous-stall.mp4'),referer:'https://hanime1.me/watch?v=1',fetch:fetcher,signal:AbortSignal.timeout(5000),idleTimeoutMs:30,retries:0})
    assert.equal(cancelled,1);assert.deepEqual(requests,[null,'bytes=0-'])
    assert.deepEqual(await fs.readFile(result.destination),media)
  })
  await test('HTTP2/QUIC connection interruptions are retryable but identity errors are fatal', async () => {
    for (const message of ['net::ERR_HTTP2_PING_FAILED','net::ERR_QUIC_PROTOCOL_ERROR','net::ERR_HTTP2_PROTOCOL_ERROR','EHOSTUNREACH','terminated']) assert.ok(retryableDownloadError(new Error(message)), message)
    assert.equal(retryableDownloadError(new Error('视频身份发生变化')), false)
  })
  await test('a connection queued behind a healthy body does not consume the network timeout', async () => {
    const fetcher = createBudgetedFetch(async () => new Response('queued-data'), createDownloadLimiter(() => 1))
    const held = await fetcher('https://cdn.test/first', { signal: new AbortController().signal })
    const queued = readDownloadResource({ url: 'https://cdn.test/second', fetch: fetcher, headers: {}, signal: new AbortController().signal, idleTimeoutMs: 20, retries: 0 }).catch(error => ({ error }))
    await wait(65); await held.body!.cancel()
    const result = await queued
    assert.ok(!('error' in result), 'healthy queue wait must not be reported as stalled network')
    assert.equal((result as any).data.toString(), 'queued-data')
  })
  await test('stalled parallel range waits for healthy ranges and is completed with one connection', async () => {
    let healthyFinished = false, healthyAborted = false, deferredCalls = 0
    const quarter = Math.ceil(media.length / 8)
    const server = createServer((req, res) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')!
      const start = Number(match[1]), end = Math.min(Number(match[2]), media.length - 1)
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${media.length}`, 'Content-Length': end-start+1, ETag: '"stable"', 'Content-Type': 'video/mp4' })
      if (start === 0 && end === 0) { res.end(media.subarray(0,1)); return }
      if (start === quarter) { deferredCalls++; if (!healthyFinished) { res.flushHeaders(); return } }
      if (start === 0) {
        let cursor = start
        const timer = setInterval(() => {
          const next = Math.min(cursor + 8192, end + 1); res.write(media.subarray(cursor,next)); cursor = next
          if (cursor > end) { clearInterval(timer); healthyFinished = true; res.end() }
        }, 10)
        res.on('close', () => { clearInterval(timer); if (!healthyFinished) healthyAborted = true })
      } else res.end(media.subarray(start,end+1))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}/video.mp4`
      const result = await transferAccelerated({ url, destination: path.join(root,'deferred.mp4'), referer:'https://hanime1.me/watch?v=1', signal:new AbortController().signal, fetch, workers:4, idleTimeoutMs:35, retries:0 })
      assert.equal(healthyAborted, false); assert.ok(deferredCalls >= 2)
      assert.deepEqual(await fs.readFile(result.destination), media)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  await test('interrupted Range keeps received bytes and retries only the unfinished suffix', async () => {
    let interrupted = false; const ranges: Array<[number,number]> = []
    const fetcher: typeof fetch = async (_url, init) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!
      const start=Number(match[1]),end=Number(match[2]); ranges.push([start,end])
      const body = start === 0 && end > 0 && !interrupted ? new ReadableStream({ start(controller) { interrupted=true; controller.enqueue(media.subarray(0,32768)); setTimeout(() => controller.error(new Error('net::ERR_HTTP2_PING_FAILED')), 5) } }) : media.subarray(start,end+1)
      return new Response(body,{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${media.length}`,'Content-Length':String(end-start+1),ETag:'"stable"','Content-Type':'video/mp4'}})
    }
    const result = await transferAccelerated({url:'https://cdn.test/video.mp4',destination:path.join(root,'resume.mp4'),referer:'https://hanime1.me/watch?v=1',signal:new AbortController().signal,fetch:fetcher,workers:4})
    assert.ok(ranges.some(([start,end]) => start === 32768 && end > start), 'must continue after bytes already received')
    assert.deepEqual(await fs.readFile(result.destination),media); assert.equal(result.receivedBytes,media.length)
  })
  await test('cancelled Range resumes from a verified disk checkpoint even after connection limits change', async () => {
    let resumed=false; const continued:number[]=[]
    const fetcher:typeof fetch=async(_url,init)=>{
      const m=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!,start=Number(m[1]),end=Number(m[2])
      if(resumed && end>0)continued.push(start)
      return new Response(media.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${media.length}`,'Content-Length':String(end-start+1),ETag:'"same-content"','Content-Type':'video/mp4'}})
    }
    const destination=path.join(root,'disk-resume.mp4'),controller=new AbortController()
    const options={url:'https://cdn.test/asset.mp4?token=old',resumeKey:'hanime:1:720p',destination,referer:'https://hanime1.me/watch?v=1',fetch:fetcher,workers:4}
    await assert.rejects(transferAccelerated({...options,signal:controller.signal,onProgress:p=>{if(p.receivedBytes>0)controller.abort(new Error('user stopped'))}}),/user stopped/)
    const workspace=path.join(root,'.disk-resume.mp4.baoyi-ranges')
    const journal=JSON.parse(await fs.readFile(path.join(workspace,'manifest.json'),'utf8'))
    assert.ok(Object.values(journal.files).some((v:any)=>v.size>0),'completed disk bytes must be checkpointed')
    resumed=true
    const result=await transferAccelerated({...options,url:'https://cdn.test/asset.mp4?token=new',workers:1,signal:new AbortController().signal})
    assert.deepEqual(await fs.readFile(result.destination),media)
    const chunkSize=Math.ceil(media.length/8)
    assert.ok(continued.length)
    for(const start of continued){const index=Math.floor(start/chunkSize);assert.equal(start,index*chunkSize+(journal.files[index]?.size||0),'verified bytes must not be downloaded again')}
    await assert.rejects(fs.stat(workspace),/ENOENT/)
  })
  for(const mode of ['corrupt-cache','changed-entity'])await test(mode+' is revalidated before resuming',async()=>{
    let fresh=false;const starts:number[]=[]
    const replacement=Buffer.from(media);replacement.fill(17,32)
    const fetcher:typeof fetch=async(_url,init)=>{
      const m=/^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!,start=Number(m[1]),end=Number(m[2])
      if(fresh && end>0)starts.push(start)
      const bytes=fresh && mode==='changed-entity'?replacement:media
      return new Response(bytes.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1),ETag:fresh && mode==='changed-entity'?'"new"':'"old"','Content-Type':'video/mp4'}})
    }
    const destination=path.join(root,mode+'.mp4'),control=new AbortController()
    const options={url:'https://cdn.test/asset.mp4',resumeKey:'hanime:2:720p',destination,referer:'https://hanime1.me/watch?v=2',fetch:fetcher,workers:4}
    await assert.rejects(transferAccelerated({...options,signal:control.signal,onProgress:p=>{if(p.receivedBytes)control.abort(new Error('stop'))}}),/stop/)
    const workspace=path.join(root,'.'+mode+'.mp4.baoyi-ranges'),journal=JSON.parse(await fs.readFile(path.join(workspace,'manifest.json'),'utf8'))
    if(mode==='corrupt-cache')for(const [index,row]of Object.entries(journal.files) as Array<[string,{size:number}]>){if(row.size){await fs.writeFile(path.join(workspace,index+'.segment'),Buffer.alloc(row.size,99));break}}
    fresh=true
    const result=await transferAccelerated({...options,signal:new AbortController().signal})
    assert.ok(starts.includes(0),'changed/corrupt bytes must be downloaded again')
    assert.deepEqual(await fs.readFile(result.destination),mode==='changed-entity'?replacement:media)
  })
  for (const kind of ['hls','dash'] as const) await test(kind + ' reports bytes before a full fragment is received', async () => {
    let complete = false, reportedDuringRead = false
    const fetcher: typeof fetch = async input => {
      const url=String(input)
      if(url.endsWith('.m3u8'))return new Response('#EXTM3U\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST')
      if(url.endsWith('.mpd'))return new Response('<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v"><SegmentList><SegmentURL media="part.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>')
      return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(4096,3));setTimeout(()=>{complete=true;controller.enqueue(Buffer.alloc(4096,4));controller.close()},55)}}))
    }
    const run = kind === 'hls' ? downloadHls : downloadDash
    await assert.rejects(run({url:'https://cdn.test/index.'+(kind==='hls'?'m3u8':'mpd'),destination:path.join(root,kind+'.mp4'),headers:{},signal:new AbortController().signal,fetch:fetcher,ffmpeg:path.join(root,'missing-ffmpeg'),retries:0,workers:1,onProgress:p=>{if(p.receivedBytes>0&&!complete)reportedDuringRead=true}}))
    assert.ok(reportedDuringRead, 'fragment byte progress must reach the caller before completion')
  })
  assert.ok(!(await fs.readdir(root)).some(name => name.endsWith('.baoyi-part') || name.endsWith('.baoyi-part.mp4')))
} finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root,{recursive:true,force:true}) }
console.log(`Download stability: ${passed} passed / ${failed} failed`)
if(failed)process.exitCode=1
