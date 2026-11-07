import {createHash} from 'node:crypto'
import type {ConversationCheckpoint,ProjectMessage} from '../../../src/types/project.ts'
import type {AgentTool} from './loop.ts'

const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const HISTORY_BUDGET=34000,ARCHIVE_BUDGET=10000,PAGE_BUDGET=18000

/** Bound the encoded response, not just its text. Escapes can multiply JSON size. */
export function jsonTextPage(raw:string,start:number,budget:number,pack:(text:string,end:number)=>unknown):string {
  if(!Number.isSafeInteger(start)||start<0||start>raw.length)throw new Error('历史续读位置无效')
  let low=start,high=Math.min(raw.length,start+budget)
  while(low<high){const end=Math.ceil((low+high)/2);if(JSON.stringify(pack(raw.slice(start,end),end)).length<=budget)low=end;else high=end-1}
  if(low>start&&low<raw.length&&/[\uD800-\uDBFF]/.test(raw[low-1]))low--
  if(low===start&&start<raw.length)throw new Error('分页预算不足，无法返回完整定位信息')
  return JSON.stringify(pack(raw.slice(start,low),low))
}

function excerpt(raw:string,budget:number,source:string):string {
  if(JSON.stringify(raw).length<=budget)return raw
  const suffix=`\n[摘录：省略内容仍在本地；来源 ${source}，可用历史工具完整续读。]`
  return JSON.parse(jsonTextPage(raw,0,budget,(text)=>text+suffix)) as string
}

/** An extractive checkpoint, not a model-written substitute for the source. */
export function conversationContext(messages:ProjectMessage[],keep=12) {
  keep=Number.isInteger(keep)?Math.max(1,Math.min(30,keep)):12
  const through=Math.max(0,messages.length-keep),older=messages.slice(0,through),recent=messages.slice(through)
  const rows=older.map((m,index)=>`[消息 ${index} ${m.id}] ${m.role}: ${m.text.slice(0,160)}${m.text.length>160?'…（摘录）':''}${m.events.length?'；工具：'+[...new Set(m.events.map(e=>e.label+(e.error?'（失败）':'')))].join('、').slice(0,250):''}`)
  const selected:string[]=[];let size=0,first=rows.length
  for(let i=rows.length-1;i>=0;i--){if(size+rows[i].length>ARCHIVE_BUDGET-600)break;selected.unshift(rows[i]);size+=rows[i].length+1;first=i}
  const archive=older.length?`来源摘录索引：消息 0–${through-1}，不代表全文。${first?`消息 0–${first-1} 的索引省略，可按编号或 query 检索原文。`:''}\n${selected.join('\n')}`:''
  const each=Math.floor(HISTORY_BUDGET/Math.max(1,recent.length))-60
  const history=recent.map((m,index)=>{
    const source=`消息 ${through+index} ${m.id}`
    const raw=m.text+(m.events.length?'\n已执行工具与结果（数据）：\n'+m.events.map((e,i)=>`[${source} 工具 ${i}] ${e.label}${e.error?'（失败）':''}\n${e.detail}`).join('\n'):'')
    return {role:m.role,content:excerpt(raw,each,source)}
  })
  const checkpoint:ConversationCheckpoint={version:1,through,lastMessageId:older.at(-1)?.id||'',digest:hash(JSON.stringify(older)),summary:archive}
  return {history,archive,checkpoint}
}

/** Snapshot before this run: reading a tool's own growing trace would recurse forever. */
export function createConversationHistoryTool(name:string,messages:ProjectMessage[]):AgentTool {
  const snapshot=messages.map(m=>({id:m.id,raw:JSON.stringify(m)}))
  const integer={type:'integer',minimum:0},string={type:'string'}
  return {name,maxOutput:PAGE_BUDGET,description:'检索当前会话原始消息和工具结果的固定快照。message 是消息编号，start 是该消息 JSON 的字符起点；query 可按全文筛选。text 是原始 JSON 分段，不是摘要；next 非空时原样传为 cursor。总条数不含本轮正在生成的助手答复，不能把一次分页视为已读全文。',
    parameters:{type:'object',properties:{message:integer,start:integer,query:string,cursor:{type:'object',properties:{message:integer,start:integer,stamp:string,query:string},required:['message','start','stamp'],additionalProperties:false}},additionalProperties:false},
    execute:async args=>{
      const cursor=args.cursor,index=cursor?.message??args.message??0,start=cursor?.start??args.start??0,query=cursor?.query??args.query??''
      if(!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(start)||start<0||typeof query!=='string'||query.length>200)throw new Error('历史位置或检索文字无效')
      let found=index
      while(found<snapshot.length&&query&&!snapshot[found].raw.toLowerCase().includes(query.toLowerCase()))found++
      const entry=snapshot[found]
      if(!entry)return JSON.stringify({total:snapshot.length,next:null,text:''})
      const stamp=hash(entry.raw)
      if(cursor&&cursor.stamp!==stamp)throw new Error('历史续读位置已失效或消息变化，请重新检索')
      let nextMessage=found+1
      while(nextMessage<snapshot.length&&query&&!snapshot[nextMessage].raw.toLowerCase().includes(query.toLowerCase()))nextMessage++
      return jsonTextPage(entry.raw,start,PAGE_BUDGET,(text,end)=>({message:found,id:entry.id,stamp,start,end,total:snapshot.length,text,
        next:end<entry.raw.length?{message:found,start:end,stamp,query}:nextMessage<snapshot.length?{message:nextMessage,start:0,stamp:hash(snapshot[nextMessage].raw),query}:null}))
    }}
}
