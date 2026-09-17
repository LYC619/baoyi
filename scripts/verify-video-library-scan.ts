/** Real temporary file trees; no library, Electron profile, network or media required. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanVideoRoot } from '../electron/kinds/video/scanner.ts'
import { mergeFacts } from '../electron/kinds/video/facts.ts'
import { videoCandidatePrompt, fillVideoSystem } from '../electron/kinds/video/prompts.ts'
import { VIDEO_CATEGORIES } from '../electron/kinds/video/taxonomy.ts'

let passed = 0; let failed = 0
function test(name: string, run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-scan-regression-'))
  try { run(root); passed++ }
  catch (error) { failed++; console.error('FAIL', name, error instanceof Error ? error.message : error) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}
function files(root: string, names: string[]) {
  for (const name of names) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
  }
}
test('meaningful movie filename wins over its storage folder', root => {
  files(root, ['Downloads/Zeta.2021.1080p.mkv'])
  const [c] = scanVideoRoot(root)
  assert.equal(c.title_en, 'Zeta')
  const facts = mergeFacts(c, null, new Map(), new Map())
  assert.equal(facts.dir, path.join(root, 'Downloads'))
  assert.match(videoCandidatePrompt(facts), /Zeta\.2021\.1080p\.mkv/)
  assert.match(videoCandidatePrompt(facts), /Downloads/)
})
test('generic filename can use the title from its folder', root => {
  files(root, ['沙丘 (2021)/movie.mkv'])
  assert.equal(scanVideoRoot(root)[0].title_zh, '沙丘')
})
test('different series and standalone recordings in one folder remain separate', root => {
  files(root, ['合集/Alpha.S01E01.mkv', '合集/Alpha.S01E02.mkv', '合集/Beta.S01E01.mkv', '合集/教学录屏.mp4'])
  const list = scanVideoRoot(root)
  assert.equal(list.length, 3)
  assert.equal(new Set(list.map(c => c.path)).size, 3)
  const alpha = list.find(c => c.title_en === 'Alpha')!
  const beta = list.find(c => c.title_en === 'Beta')!
  assert.equal(alpha.episodes.length, 2)
  assert.equal(beta.episodes.length, 1)
  assert.equal(list.find(c => c.title_zh === '教学录屏')?.files.length, 1)
  assert.equal(mergeFacts(alpha, null, new Map(), new Map()).dir, path.join(root, '合集'))
  const prompt = videoCandidatePrompt(mergeFacts(alpha, null, new Map(), new Map()))
  assert.match(prompt, /Alpha\.S01E01\.mkv/)
  assert.match(prompt, /Beta/)
})
test('same filename title across seasons stays one series', root => {
  files(root, ['下载/Season 1/Alpha.S01E01.2023.mkv', '下载/Season 2/Alpha.S02E01.2024.mkv', '下载/Specials/Alpha.E01.mkv'])
  const [c, second] = scanVideoRoot(root)
  assert.equal(second, undefined)
  assert.equal(c.title_en, 'Alpha')
  assert.deepEqual(c.episodes.map(e => [e.season, e.episode]), [[0, 1], [1, 1], [2, 1]])
})
test('episode-only names in a season folder share the folder title', root => {
  files(root, ['Alpha/Season 1/S01E01.mkv', 'Alpha/Season 1/S01E02.mkv'])
  const list = scanVideoRoot(root)
  assert.equal(list.length, 1)
  assert.equal(list[0].title_en, 'Alpha')
  assert.equal(list[0].episodes.length, 2)
})
test('unnumbered videos beside a series are not silently lost', root => {
  files(root, ['Alpha/Season 1/Alpha.S01E01.mkv', 'Alpha/Season 1/会议记录.mp4'])
  const list = scanVideoRoot(root)
  const found = list.flatMap(c => [...c.files, ...c.episodes.flatMap(e => e.files)]).map(f => f.name)
  assert.deepEqual(found.sort(), ['Alpha.S01E01.mkv', '会议记录.mp4'].sort())
})
test('three consistent numbered filenames form a series without consuming other files', root => {
  files(root, ['合集/Show.01.mkv', '合集/Show.02.mkv', '合集/Show.03.mkv', '合集/会议录像.mp4'])
  const list = scanVideoRoot(root)
  assert.equal(list.length, 2)
  assert.equal(list.find(c => c.video_type === 'series')?.episodes.length, 3)
  assert.equal(list.find(c => c.video_type === 'series')?.title_en, 'Show')
})
test('shared folder does not lend one movie another movie sidecars', root => {
  files(root, ['合集/Alpha.mp4', '合集/Alphabet.mp4', '合集/Alpha.nfo', '合集/Alphabet.nfo', '合集/poster.jpg'])
  const list = scanVideoRoot(root)
  const a = list.find(c => c.title_en === 'Alpha')!
  assert.deepEqual(a.sidecars.nfo.map(x => path.basename(x)), ['Alpha.nfo'])
  assert.equal(a.sidecars.images.length, 0)
})
test('folders named other, clips or shorts keep standalone user videos', root => {
  files(root, ['other/会议录屏.mp4', 'clips/旅行短视频.mp4', 'shorts/手机录像.mp4'])
  assert.equal(scanVideoRoot(root).length, 3)
})
test('identify instructions retain recordings and allow evidence-based collections', () => {
  const system = fillVideoSystem(VIDEO_CATEGORIES, [], false, false)
  assert.match(system, /收藏分组只能由用户/)
  assert.match(system, /录屏[\s\S]{0,100}其他|其他[\s\S]{0,100}录屏/)
  assert.doesNotMatch(system, /用 `skip_entry` 跳过并说明原因。比如：[\s\S]*教学录屏/)
})

console.log(`视频文件识别回归：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
