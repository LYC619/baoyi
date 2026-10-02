/** Local VideoObject demonstration; binds loopback only. */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const root = path.join(__dirname, 'assets')
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  const name = pathname === '/' ? 'index.html' : pathname.slice(1)
  if (!/^[a-z0-9.-]+$/.test(name) || !/\.(html|png|webm)$/.test(name)) {
    response.writeHead(404); response.end(); return
  }
  const file = path.join(root, name)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return }
  const bytes = fs.readFileSync(file)
  response.setHeader('Content-Type', name.endsWith('.webm') ? 'video/webm' : name.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8')
  response.setHeader('Accept-Ranges', 'bytes')
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
  if (range) {
    const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1)
    if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); response.end(); return }
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 })
    response.end(bytes.subarray(start, end + 1)); return
  }
  response.setHeader('Content-Length', bytes.length); response.end(bytes)
})
server.on('error', error => { console.error(error.message); process.exitCode = 1 })
server.listen(18765, '127.0.0.1', () => {
  console.log('本机演示：http://127.0.0.1:18765/index.html\n在抱一「影视 → 找视频」粘贴该地址，点击「接入海报墙」。\n打开森林纪行，可观看并下载保存。保持此窗口打开；Ctrl+C 结束。')
})
