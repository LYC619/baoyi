/** Real Hermes + explicitly staged model configuration, synthetic archive only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {ArchiveAssistant} from '../electron/archive/service.ts'
import {textPdf} from './helpers/pdf-fixture.ts'
import type {AIConfig} from '../src/types/index.ts'
import type {ArchiveEvent} from '../src/types/archive.ts'

assert.ok(process.argv.includes('--staged-config'),'请先明确暂存本次验收的模型配置，并传 --staged-config；本脚本不会读取日常资料库')
// Staging is a separate read-only step. This networked runner only consumes the
// task-local file and never opens the user's database or launches a settings reader.
let config:AIConfig
const configFile=path.resolve('output/archive-assistant-2026-11-05/.live-model-config.json')
try{config=JSON.parse(await fs.readFile(configFile,'utf8'))}finally{await fs.unlink(configFile)}
assert.ok(config.enabled&&config.api_key&&config.api_url&&config.model,'现有模型配置不完整')
const output=path.resolve('output/archive-assistant-2026-11-05/live');await fs.mkdir(output,{recursive:true})
const root=await fs.mkdtemp(path.join(output,'run-')),home=path.join(root,'assistant')
const db=new DatabaseSync(path.join(root,'fixture.db'));db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
const docs=new DocumentLibrary(db),events:ArchiveEvent[]=[],checks:string[]=[]
let done:((event:ArchiveEvent)=>void)|undefined,assistant:ArchiveAssistant
function create(){return new ArchiveAssistant({db,home,runtime:path.resolve('output/hermes-runtime'),bridge:path.resolve('resources/hermes/bridge.py'),assets:path.resolve('dist/pdfjs'),
  hideHentai:()=>true,current:()=>true,config:()=>config,operation:async action=>action(),changed:()=>{},updateResource:()=>{throw new Error('本次合成样例不含此类型')},
  event:event=>{events.push(event);if(event.event==='tool_start')console.log('Tool: '+event.name);if(event.event==='finished')done?.(event)}})}
async function turn(text:string,sessionId?:string,contextIds?:string[]){
  let timer:ReturnType<typeof setTimeout>|undefined
  const result=new Promise<ArchiveEvent>((resolve,reject)=>{done=resolve;timer=setTimeout(()=>{void assistant.cancel();reject(new Error('真实模型任务超过 5 分钟'))},300000)})
  try{assistant.send({text,sessionId,contextIds});const event=await result;assert.equal(event.run.status,'completed',event.run.error);return event}
  finally{clearTimeout(timer);done=undefined}
}
const redact=(text:string)=>text.replaceAll(config.api_key,'[redacted]')
async function save(status:string,error?:unknown){await fs.writeFile(path.join(root,'result.json'),redact(JSON.stringify({status,model:config.model,at:new Date().toISOString(),root,checks,error:error?String(error):undefined,events},null,2)))}
assistant=create()
try{
  console.log('Live model: '+config.model+'; fixture: '+root)
  const file=path.join(root,'青松桥验收.md'),pdf=path.join(root,'设备巡检.pdf')
  await fs.writeFile(file,'# 青松桥验收\n作者：合成验收组\n验收口令：翠竹白鹭。\n桥长 42 米。该档案是完全虚构的测试材料。')
  await fs.writeFile(pdf,textPdf('Synthetic test. Alarm: 37 C. Limit: 12 racks.'))
  const a=await docs.register(file),b=await docs.register(pdf)
  const first=await turn('这些全部是虚构测试资料。请实际阅读附带的两份原文。创建资料分类“隔离工程验收”，在其下面创建分组“2026 验收”；将两份资料都放入该分类分组，保留原有标签并加“已核验”。青松桥备注写入实际口令与桥长，PDF 备注写入实际告警温度与机柜数量。以上修改明确授权，直接执行。最后附可点击来源，并说清楚 PDF 的页码。',undefined,[a.id,b.id])
  const category=docs.categories().find(x=>x.name==='隔离工程验收'),group=docs.customGroups().find(x=>x.name==='2026 验收')
  assert.ok(category&&group);assert.equal(group.categoryId,category.id)
  for(const doc of [a,b]){const item=docs.require(doc.id);assert.equal(item.type,category.id);assert.equal(item.customGroupId,group.id);assert.ok(item.tags.includes('已核验'))}
  assert.match(docs.require(a.id).notes,/翠竹白鹭/);assert.match(docs.require(a.id).notes,/42/)
  assert.match(docs.require(b.id).notes,/37/);assert.match(docs.require(b.id).notes,/12/)
  assert.match(first.result.final_response,new RegExp('baoyi://resource/'+a.id));assert.match(first.result.final_response,/(第\s*1\s*页|页码.{0,6}1|[Pp]age\s*1)/)
  checks.push('live mixed MD/PDF reading, new category/group, real metadata saves, source citations');console.log('PASS '+checks.at(-1))

  const second=await turn('记住我的长期归档偏好：不同版本都保留，文件名保留年份。明确保存到记忆。另外新增待办“复核青松桥验收”，到期日 2026-11-12，正文“核对原件与副本”，不要重复创建。将刚才的归档步骤保存成名为 baoyi-synthetic-archive-check 的可复用归档方法，注明这些资料是合成验收样本。',first.sessionId)
  const todos=db.prepare("SELECT * FROM personal_records WHERE kind='todo' AND name='复核青松桥验收'").all() as any[]
  assert.equal(todos.length,1);assert.equal(JSON.parse(todos[0].data).dueOn,'2026-11-12')
  const memory=await assistant.runtime.request('memory');assert.match(JSON.stringify(memory),/版本/);assert.match(JSON.stringify(memory),/年份/)
  const skills=await assistant.runtime.request('skills');assert.match(JSON.stringify(skills),/baoyi-synthetic-archive-check/)
  checks.push('live native memory/skills and personal task persistence');console.log('PASS '+checks.at(-1))

  await assistant.dispose();assistant=create()
  const recall=await turn('我之前明确保存的归档偏好是什么？请只按已保存记忆回答。再查一下“复核青松桥验收”待办的实际到期日，不要创建或修改任何条目。')
  assert.match(recall.result.final_response,/版本/);assert.match(recall.result.final_response,/年份/);assert.match(recall.result.final_response,/2026.{0,3}11.{0,3}12/)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM personal_records WHERE kind='todo'").get() as any).n,1)
  checks.push('cold-start new session recalls native memory and queries actual personal record');console.log('PASS '+checks.at(-1))

  const target=path.join(root,'整理副本');await fs.mkdir(target)
  const copy=await turn(`请把刚才两份合成验收资料复制整理到这个目录：${target}。明确授权复制，保留原文件；先预览，再直接执行，将实际结果和保存位置告诉我。`,second.sessionId)
  assert.ok(events.some(e=>e.sessionId===copy.sessionId&&e.event==='tool_end'&&e.name==='archive_organize'&&e.args?.action==='execute'))
  const copies=db.prepare('SELECT path FROM document_files WHERE resource_id IN (?,?)').all(a.id,b.id) as Array<{path:string}>
  for(const doc of [a,b]){const content=await fs.readFile(doc.path);assert.ok(copies.some(x=>x.path.startsWith(target)));const expected=copies.find(x=>path.basename(x.path)===path.basename(doc.path));assert.ok(expected);assert.deepEqual(await fs.readFile(expected.path),content)}
  checks.push('live preview and actual file-copy organization preserves originals');console.log('PASS '+checks.at(-1))
  await save('passed');console.log('PASS live acceptance: '+checks.length+' groups')
}catch(error){await save('failed',error);console.error(redact(String(error)));process.exitCode=1}
finally{await assistant.dispose();db.close()}
