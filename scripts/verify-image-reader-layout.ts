import assert from 'node:assert/strict'
import fs from 'node:fs'
assert.ok(fs.existsSync(new URL('../src/utils/image-reader.ts', import.meta.url)), '必须提供封面独立的双页导航与画布尺寸规则')
const { imageSpread, imageCanvasLayout } = await import('../src/utils/image-reader.ts')
const pages = Array.from({ length: 8 }, (_, i) => ({ chapterId: i < 5 ? 'first' : 'second' }))
assert.deepEqual(pages.map((_, i) => imageSpread(pages, i, true)), [
  { start: 0, length: 1 }, { start: 1, length: 2 }, { start: 1, length: 2 }, { start: 3, length: 2 },
  { start: 3, length: 2 }, { start: 5, length: 2 }, { start: 5, length: 2 }, { start: 7, length: 1 },
])
assert.deepEqual(imageSpread(pages, 4, false), { start: 4, length: 1 })
assert.deepEqual(imageSpread(pages, 0, false), { start: 0, length: 2 })
assert.deepEqual(imageSpread(pages, -10, true), { start: 0, length: 1 })
assert.deepEqual(imageSpread([], 0, true), { start: 0, length: 0 })
let at = 7
const backwards = [at]
while (at > 0) { at = imageSpread(pages, at - 1, true).start; backwards.push(at) }
assert.deepEqual(backwards, [7, 5, 3, 1, 0])
const portrait = { width: 1500, height: 2100 }, viewport = { width: 900, height: 600 }
const solo = imageCanvasLayout([portrait], viewport, 'screen', 0)
assert.equal(solo.height, 600)
assert.ok(Math.abs(solo.width - 1500 / 2100 * 600) < 0.001)
const pair = imageCanvasLayout([portrait, portrait], viewport, 'screen', 0)
assert.ok(pair.width <= viewport.width && pair.height <= viewport.height)
const original = imageCanvasLayout([portrait], viewport, 'original', 0)
assert.deepEqual([original.width, original.height], [1500, 2100])
const rotated = imageCanvasLayout([portrait], viewport, 'original', 90)
assert.deepEqual([rotated.width, rotated.height], [2100, 1500])
assert.deepEqual([rotated.sheets[0].imageWidth, rotated.sheets[0].imageHeight], [1500, 2100])
console.log('PASS 独立封面、奇偶章节、双向翻页、定位、适配/原尺寸/旋转画布')
