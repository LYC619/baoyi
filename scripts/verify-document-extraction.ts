import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {readDocumentText} from '../electron/workspace/document-text.ts'
import {extractDocument} from '../electron/workspace/document-extraction.ts'
import {outlinePdf,textPdf} from './helpers/pdf-fixture.ts'
const assets=path.resolve('dist/pdfjs')
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-extract-'))
  t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'baoyi-extract-')));await fs.rm(root,{recursive:true,force:true})});return root
}
test('31页PDF首尾提取、实际页码与内容指纹；30页仍完整提取',async t=>{
  const root=await fixture(t),file=path.join(root,'long.pdf');await fs.writeFile(file,outlinePdf(31,false))
  let ticks=0;const timer=setInterval(()=>ticks++,10)
  const value=await extractDocument({file,format:'pdf',assets});clearInterval(timer)
  assert.ok(ticks>1,'解析时主线程继续响应');assert.equal(value.coverage.strategy,'head-tail')
  assert.deepEqual(value.coverage.pages,[...Array.from({length:15},(_,i)=>i+1),...Array.from({length:10},(_,i)=>i+22)])
  assert.deepEqual(value.coverage.skippedPages,[16,17,18,19,20,21]);assert.equal(value.coverage.complete,false)
  assert.ok(value.fragments.some(part=>part.page===31&&part.text.includes('chapter 31')))
  assert.equal(value.fingerprint,createHash('sha256').update(await fs.readFile(file)).digest('hex'))
  await fs.writeFile(file,outlinePdf(30,false));const short=await extractDocument({file,format:'pdf',assets})
  assert.equal(short.coverage.complete,true);assert.equal(short.coverage.pages.length,30)
})
test('预算给尾部保留字符，不会被前言耗尽；空白页计入覆盖而不终止',async t=>{
  const root=await fixture(t),file=path.join(root,'budget.pdf');await fs.writeFile(file,outlinePdf(40,false,'Preface '.repeat(100)))
  const value=await extractDocument({file,format:'pdf',assets,maxChars:1000})
  assert.ok(value.fragments.some(part=>(part.page??0)>=31&&part.text.length>0));assert.ok(value.coverage.characters<=1000)
  assert.ok(value.coverage.truncatedPages.length>0);assert.equal(value.coverage.complete,false)
  await fs.writeFile(file,textPdf(''));const empty=await extractDocument({file,format:'pdf',assets})
  assert.deepEqual(empty.coverage.emptyPages,[1]);assert.equal(empty.coverage.characters,0);assert.equal(empty.coverage.complete,false)
})
test('文本截断不破坏Unicode，证据行号保留；全文指纹覆盖未读取的尾部',async t=>{
  const root=await fixture(t),file=path.join(root,'text.md');await fs.writeFile(file,'前言\n'+('中文😀\n'.repeat(2000)))
  const before=await extractDocument({file,format:'md',assets,maxChars:101})
  assert.equal(before.fragments[0].startLine,1);assert.ok(!/[\uD800-\uDBFF]$/.test(before.fragments.at(-1)!.text))
  assert.equal(before.coverage.complete,false);await fs.appendFile(file,'尾部变化')
  assert.notEqual((await extractDocument({file,format:'md',assets,maxChars:101})).fingerprint,before.fingerprint)
})
test('取消、超时与错误PDF后释放槽位；普通分页仍能续读',async t=>{
  const root=await fixture(t),file=path.join(root,'normal.pdf');await fs.writeFile(file,outlinePdf(3,false))
  const controller=new AbortController(),pending=extractDocument({file,format:'pdf',assets},{signal:controller.signal});controller.abort(new Error('用户取消'))
  await assert.rejects(pending,/取消/)
  await assert.rejects(extractDocument({file,format:'pdf',assets},{timeoutMs:1}),/超时/)
  const broken=path.join(root,'broken.pdf');await fs.writeFile(broken,'not a PDF');await assert.rejects(extractDocument({file:broken,format:'pdf',assets}))
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());initSchema(db,KINDS)
  const item=await new DocumentLibrary(db).register(file),first=await readDocumentText(db,item.id,{},assets)
  assert.equal(first.source.page,1);assert.equal(first.totalPages,3);assert.ok(first.next)
  const second=await readDocumentText(db,item.id,{cursor:first.next!},assets);assert.equal(second.source.page,2)
  await fs.appendFile(file,'\n');await assert.rejects(readDocumentText(db,item.id,{cursor:second.next!},assets),/变化/)
})
test('指定PDF中间页和文本起点续读，保留准确证据位置与覆盖',async t=>{
  const root=await fixture(t),file=path.join(root,'range.pdf');await fs.writeFile(file,outlinePdf(40,false))
  const middle=await extractDocument({file,format:'pdf',assets,fromPage:16,toPage:20})
  assert.deepEqual(middle.coverage.pages,[16,17,18,19,20]);assert.equal(middle.coverage.strategy,'range');assert.equal(middle.coverage.complete,false)
  assert.ok(middle.fragments.every(part=>part.page!>=16&&part.page!<=20))
  await assert.rejects(extractDocument({file,format:'pdf',assets,fromPage:39,toPage:42}),/范围|连续/)
  const text=path.join(root,'range.md'),prefix='前一部分\n'.repeat(9000);await fs.writeFile(text,prefix+'新的内容\n尾部资料')
  const next=await extractDocument({file:text,format:'md',assets,start:prefix.length,maxChars:1000})
  assert.equal(next.fragments[0].text,'新的内容\n尾部资料');assert.equal(next.fragments[0].start,prefix.length);assert.equal(next.fragments[0].startLine,9001);assert.equal(next.coverage.complete,false)
  assert.ok(!next.coverage.reasons.some(reason=>reason.includes('达到')))
})
