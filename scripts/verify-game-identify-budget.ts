import assert from 'node:assert/strict'
import { runAgent } from '../electron/services/agent/loop.ts'
const original = globalThis.fetch
const requested: string[][] = []
let registered = 0
try {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)), names = body.tools.map((tool:any)=>tool.function.name)
    requested.push(names)
    const name = names.includes('list_directory') ? 'list_directory' : 'register_game'
    return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call-'+requested.length,type:'function',function:{name,arguments:JSON.stringify({path:'dir-'+requested.length})}}]}}],usage:{total_tokens:10}}))
  }
  const result = await runAgent({config:{api_url:'https://unused.test',api_key:'',model:'fixture',enabled:true},system:'test',user:'test',maxTurns:6,
    finalTools:['register_game','skip_directory'],finalTurns:2,
    tools:[{name:'list_directory',description:'list',parameters:{},execute:async()=> 'directory listing'}, {name:'register_game',description:'register',parameters:{},execute:async()=>{registered++;return 'registered'}}]
  } as any)
  assert.equal(registered,1,'reserve a conclusion before consuming the round budget')
  assert.equal(result.stopReason,'done');assert.ok(result.turns<=6)
  assert.deepEqual(requested.at(-1),['register_game'])
  console.log('PASS game identification reserves finalization turns without further browsing')
} finally {globalThis.fetch=original}
