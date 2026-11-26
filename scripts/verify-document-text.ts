import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'
import {DocumentLibrary} from '../electron/workspace/documents.ts'
import {textPdf} from './helpers/pdf-fixture.ts'
test('资料正文工具实际提取 PDF 文字层并返回页码；大文本按来源范围续读',async t=>{
  assert.ok(existsSync('electron/workspace/document-text.ts'),'需要受范围约束的资料正文读取')
  const {readDocumentText}=await import('../electron/workspace/document-text.ts')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-doc-text-')),db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  t.after(async()=>{db.close();assert.ok(root.startsWith(os.tmpdir()+path.sep));await fs.rm(root,{recursive:true,force:true})})
  const docs=new DocumentLibrary(db),pdfFile=path.join(root,'source.pdf'),textFile=path.join(root,'large.markdown')
  await fs.writeFile(pdfFile,textPdf());await fs.writeFile(textFile,'内容😀\n'.repeat(140000))
  const pdf=await docs.register(pdfFile),text=await docs.register(textFile)
  const page=await readDocumentText(db,pdf.id)
  assert.match(page.text,/Evidence belongs/);assert.equal(page.source.documentId,pdf.id);assert.equal(page.source.page,1);assert.equal(page.next,null)
  const first=await readDocumentText(db,text.id);assert.ok(first.next);assert.ok(first.text.length<10000)
  const next=await readDocumentText(db,text.id,{cursor:first.next!});assert.ok(next.source.startLine!>first.source.startLine!)
  await fs.appendFile(textFile,'变化');await assert.rejects(readDocumentText(db,text.id,{cursor:next.next!}),/失效|变化/)
  await fs.writeFile(path.join(root,'scan.pdf'),textPdf(''));const scan=await docs.register(path.join(root,'scan.pdf'))
  await assert.rejects(readDocumentText(db,scan.id),/文字层|扫描/)
  const namedGuide=path.join(root,'access-token-guide.md');await fs.writeFile(namedGuide,'# 令牌设计教程\n这是用户明确导入的公开教程，不是凭据。')
  const registeredGuide=await docs.register(namedGuide);assert.match((await readDocumentText(db,registeredGuide.id)).text,/公开教程/)
  const copy=path.join(root,'copy.md');await fs.copyFile(namedGuide,copy)
  db.prepare('INSERT INTO document_files(id,resource_id,path,created_at) VALUES(?,?,?,?)').run('copy',registeredGuide.id,copy,new Date().toISOString())
  await fs.unlink(namedGuide);assert.match((await readDocumentText(db,registeredGuide.id)).text,/公开教程/)
  await fs.unlink(copy)
  await assert.rejects(readDocumentText(db,registeredGuide.id),error=>{assert.match((error as Error).message,/未在本地找到/);assert.doesNotMatch((error as Error).message,/ENOENT/);return true})
})
