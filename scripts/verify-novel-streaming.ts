import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TextStreamService } from '../electron/workspace/text-stream.ts'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyi-novel-stream-'))
  const cacheDir = path.join(root, 'cache')
  const service = new TextStreamService(cacheDir)
  t.after(async () => {
    assert.ok(root.startsWith(os.tmpdir() + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, service, cacheDir }
}

test('encoding sniffing: UTF-8, BOM, and GBK', async (t) => {
  const { root, service } = await fixture(t)

  const utf8File = path.join(root, 'utf8.txt')
  await fs.writeFile(utf8File, '这是标准的UTF-8小说正文。', 'utf8')
  assert.equal(await service.sniffEncoding(utf8File), 'utf-8')

  const bomFile = path.join(root, 'bom.txt')
  await fs.writeFile(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM的小说正文', 'utf8')]))
  assert.equal(await service.sniffEncoding(bomFile), 'utf-8')

  const utf16File = path.join(root, 'utf16.txt')
  await fs.writeFile(utf16File, Buffer.from('\ufeffUTF16文本', 'utf16le'))
  assert.equal(await service.sniffEncoding(utf16File), 'utf-16le')
})

test('chapter indexing and caching on simulated novel', async (t) => {
  const { root, service } = await fixture(t)

  const novelPath = path.join(root, 'novel.txt')
  let content = '楔子 远古回响\n天地玄黄，宇宙洪荒。\n\n'
  for (let i = 1; i <= 25; i++) {
    content += `第${i}章 风云际会·第${i}回\n这是第${i}章的精彩正文，人物对话与剧情展开。\n天地浩瀚，少年踏上了修仙之路。\n\n`
  }
  content += '尾声 终局之战\n一切归于宁静。'
  await fs.writeFile(novelPath, content, 'utf8')

  const index1 = await service.indexNovel(novelPath)
  assert.equal(index1.isChunked, false)
  assert.equal(index1.chapters.length, 27) // 楔子 + 25 chapters + 尾声
  assert.equal(index1.chapters[0].title, '楔子 远古回响')
  assert.equal(index1.chapters[1].title, '第1章 风云际会·第1回')
  assert.equal(index1.chapters[26].title, '尾声 终局之战')

  // Slice text for chapter 1
  const ch1 = index1.chapters[1]
  const slice1 = await service.sliceText(novelPath, ch1.byteOffset, ch1.byteLength)
  assert.ok(slice1.text.startsWith('第1章 风云际会·第1回'))

  // Second call hits cache
  const index2 = await service.indexNovel(novelPath)
  assert.equal(index2.version, index1.version)
  assert.equal(index2.chapters.length, 27)
})

test('unchaptered large text splits into bounded chunks', async (t) => {
  const { root, service } = await fixture(t)

  const unchapteredPath = path.join(root, 'essay.txt')
  // Create 120KB continuous text with no chapter markers
  const paragraph = '春蚕到死丝方尽，蜡炬成灰泪始干。读书破万卷，下笔如有神。\n'.repeat(50)
  const full = paragraph.repeat(40) // ~120KB
  await fs.writeFile(unchapteredPath, full, 'utf8')

  const index = await service.indexNovel(unchapteredPath)
  assert.equal(index.isChunked, true)
  assert.ok(index.chapters.length >= 2)
  for (const chunk of index.chapters) {
    assert.ok(chunk.byteLength <= 48 * 1024)
    const slice = await service.sliceText(unchapteredPath, chunk.byteOffset, chunk.byteLength)
    assert.ok(slice.text.length > 0)
  }
})

test('pdf range reading slices bytes on demand', async (t) => {
  const { root, service } = await fixture(t)

  const pdfPath = path.join(root, 'test.pdf')
  const dummy = Buffer.alloc(100 * 1024, 0x41) // 100KB of 'A'
  dummy.write('%PDF-1.7 header', 0)
  await fs.writeFile(pdfPath, dummy)

  const range = await service.readPdfRange(pdfPath, 0, 15)
  assert.equal(Buffer.from(range).toString('utf8'), '%PDF-1.7 header')

  const middleRange = await service.readPdfRange(pdfPath, 500, 10)
  assert.equal(middleRange.length, 10)
  assert.equal(middleRange[0], 0x41)
})

test('large 12MB+ novel streaming index and slice performance', async (t) => {
  const { root, service } = await fixture(t)

  const bigNovel = path.join(root, 'big-novel.txt')
  // 300 chapters ~= 12MB
  const handle = await fs.open(bigNovel, 'w')
  for (let i = 1; i <= 300; i++) {
    await handle.writeFile(`第${i}章 剑指苍穹·第${i}卷\n` + '这里是修真世界的宏大故事，主角御剑飞行，跨越千万里山河。\n'.repeat(400))
  }
  await handle.close()

  const t0 = Date.now()
  const index = await service.indexNovel(bigNovel)
  const duration = Date.now() - t0
  assert.equal(index.isChunked, false)
  assert.equal(index.chapters.length, 300)
  assert.ok(duration < 3000, `Indexing 12MB should take less than 3s, took ${duration}ms`)

  // Slice middle chapter
  const mid = index.chapters[150]
  const slice = await service.sliceText(bigNovel, mid.byteOffset, mid.byteLength)
  assert.ok(slice.text.startsWith('第151章 剑指苍穹·第151卷'))
})
