import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanVideoRoot } from '../electron/kinds/video/scanner.ts'

test('课程目录将不同章节标题的数字序列作为一个合集', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-course-'))
  try {
    const course=path.join(root,'大学物理--清华张云翼老师主讲');fs.mkdirSync(course)
    for(let i=1;i<=14;i++)fs.writeFileSync(path.join(course,`${i}.章节${i}.mp4`),'fixture')
    const result=scanVideoRoot(course)
    assert.equal(result.length,1);assert.equal(result[0].video_type,'series')
    assert.equal(result[0].title_zh,path.basename(course));assert.equal(result[0].path,course)
    assert.deepEqual(result[0].episodes.map(e=>e.episode),Array.from({length:14},(_,i)=>i+1))
    assert.equal(result[0].episodes[9].title,'10.章节10')
    assert.equal(scanVideoRoot(root).length,1)
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})

test('普通电影混合目录不按数字前缀强制合并', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'baoyi-movies-'))
  try {
    for(const name of ['1.星际穿越.mp4','2.沙丘.mp4','3.降临.mp4'])fs.writeFileSync(path.join(root,name),'fixture')
    assert.equal(scanVideoRoot(root).length,3)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})
