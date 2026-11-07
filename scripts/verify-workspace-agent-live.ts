/** Real model acceptance; only AI settings are read from the user's DB. All records are disposable fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {createWorkspaceAgent} from '../electron/workspace/agent.ts'
import {PersonalLibrary} from '../electron/workspace/personal.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {WorkspaceLinks} from '../electron/workspace/links.ts'
import type {AIConfig} from '../src/types/index.ts'
const source=new DatabaseSync(process.env.BAOYI_LIVE_AI_DB||path.join(process.env.APPDATA||'','抱一','baoyi.db'),{readOnly:true})
let config:AIConfig
try {config=JSON.parse(String(source.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value||'{}'))} finally {source.close()}
assert.ok(config.enabled&&config.api_key&&config.api_url&&config.model,'现有 AI 配置不完整')
const output=path.resolve('output/agent-revision'),root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-workspace-live-'));await fs.mkdir(output,{recursive:true})
const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
let label='',sessionId='',timer:ReturnType<typeof setTimeout>|undefined
const manager=createWorkspaceAgent({db,config:()=>config,changed:session=>{const current=session.messages.at(-1)?.events.at(-1)?.label||session.status;if(current!==label){label=current;console.log('Agent:',label)}}})
try {
  const file=path.join(root,'抱一测试训练证书.txt');await fs.writeFile(file,'抱一验收样本：完成训练课程。虚构凭证，不对应任何真实个人。')
  const doc=await new DocumentLibrary(db).register(file,'certificate'),session=manager.create('personal');sessionId=session.id
  console.log('Live model:',config.model)
  timer=setTimeout(()=>manager.cancel(sessionId),180000)
  const first=await manager.send(sessionId,'这是一组隔离验收样本，不是真实个人信息。帮我登记一个名为「验收云服务器」的 VPS，每月 8 美元，2026 年 11 月 20 日到期，用于测试服务。请直接保存。')
  clearTimeout(timer);assert.equal(first.status,'idle',first.error)
  const personal=new PersonalLibrary(db),asset=personal.list('asset')[0];assert.ok(asset);assert.equal(asset.data.cost,8);assert.equal(asset.data.cycle,'monthly')
  timer=setTimeout(()=>manager.cancel(sessionId),180000)
  const second=await manager.send(sessionId,'把刚登记的服务器改成每年付费，费用和到期日期保持不变。另外补充一条经历「完成验收训练」，日期 2026-10-21，关联资料库中的「抱一测试训练证书」。都是这次测试的虚构记录，请直接保存。')
  clearTimeout(timer);assert.equal(second.status,'idle',second.error)
  assert.equal(personal.list('asset').length,1);assert.equal(personal.get(asset.id)?.data.cycle,'yearly');assert.equal(personal.get(asset.id)?.data.cost,8)
  const experience=personal.list('experience')[0];assert.ok(experience)
  assert.ok(new WorkspaceLinks(db).list('experience',experience.id).some(l=>l.resourceId===doc.id))
  const change=manager.changes(sessionId).find(c=>c.targetId===asset.id&&c.before&&c.after.data?.cycle==='yearly')!;assert.ok(change)
  assert.equal(manager.undo(sessionId,change.id).undone,true);assert.equal(personal.get(asset.id)?.data.cycle,'monthly')
  const report={status:'passed',model:config.model,at:new Date().toISOString(),checks:['natural-language-asset-save','same-record-update','experience-document-link','undo-restores-cost-cycle'],records:personal.list(),changes:manager.changes(sessionId),session:manager.get(sessionId)}
  await fs.writeFile(path.join(output,'workspace-agent-live.json'),JSON.stringify(report,null,2));console.log('PASS live workspace agent saved, updated, linked, and undid fixture records')
}catch(error){const message=String(error).replaceAll(config.api_key,'[redacted]');await fs.writeFile(path.join(output,'workspace-agent-live.json'),JSON.stringify({status:'failed',model:config.model,error:message,session:manager.get(sessionId)},null,2));console.error(message);process.exitCode=1}
finally {clearTimeout(timer);manager.dispose();db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})}
