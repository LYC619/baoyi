import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runPiAgent } from '../electron/services/agent/pi-adapter.ts'

test('Pi 自定义兼容地址：流式工具、历史、无工具及取消', async t=>{
  const requests:any[]=[]
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    const payload=JSON.parse(body);requests.push(payload)
    assert.equal(req.url,'/v1/chat/completions')
    res.writeHead(200,{'content-type':'text/event-stream'})
    const chunk=(delta:any,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta,finish_reason}]})+'\n\n')
    if(payload.tools?.length&&!payload.messages.some((m:any)=>m.role==='tool')){
      chunk({role:'assistant',tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'lookup',arguments:'{"query":"跑步"}'}}]});chunk({},'tool_calls')
    }else{chunk({role:'assistant',content:'已'});chunk({content:'读取'});chunk({},'stop')}
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  const config={enabled:true,api_url:`http://127.0.0.1:${(server.address() as any).port}/v1`,api_key:'local-test',model:'test'}
  let calls=0
  const options={config,system:'test',user:'查跑步',tools:[{name:'lookup',description:'查记录',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']},execute:async(args:any)=>{assert.equal(args.query,'跑步');calls++;return '51 分钟'}}]}
  const result=await runPiAgent(options)
  assert.equal(result.stopReason,'done',result.error);assert.equal(result.text,'已读取');assert.equal(calls,1)
  assert.equal(requests[0].stream,true)
  const simple=await runPiAgent({...options,tools:[],history:[{role:'user',content:'上一轮'}]})
  assert.equal(simple.text,'已读取');assert.ok(!requests.at(-1).tools?.length)
  const controller=new AbortController();controller.abort()
  assert.equal((await runPiAgent({...options,signal:controller.signal})).stopReason,'aborted')
})
