import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','output','site')
const config=JSON.parse(await fs.readFile(new URL('../docs/site/site.json',import.meta.url),'utf8'))
const prefix=new URL(process.env.SITE_URL||config.url).pathname.replace(/\/?$/,'/')
const port=Number(process.env.PORT||4173)
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535')
await fs.access(path.join(root,'index.html'))
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8'}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return}
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname)
    if(pathname==='/'&&prefix!=='/'){res.writeHead(302,{Location:prefix}).end();return}
    if(!pathname.startsWith(prefix)){res.writeHead(404).end('Not found');return}
    const relative=pathname.slice(prefix.length)
    let target=path.resolve(root,relative)
    if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403).end('Forbidden');return}
    const stat=await fs.stat(target)
    if(stat.isDirectory()){
      if(!pathname.endsWith('/')){res.writeHead(301,{Location:pathname+'/'}).end();return}
      target=path.join(target,'index.html')
    }
    const data=await fs.readFile(target)
    res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
    res.end(req.method==='HEAD'?undefined:data)
  }catch(error){res.writeHead(error.code==='ENOENT'?404:400,{'Content-Type':'text/plain; charset=utf-8'}).end('Page unavailable')}
})
server.on('error',error=>{console.error(error.message);process.exitCode=1})
server.listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}${prefix}`))
