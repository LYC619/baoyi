import assert from 'node:assert/strict'
import { rangeSelection } from '../src/utils/range-selection.ts'
import { collectionName, seriesPart } from '../src/utils/video-series.ts'
import { videoEpisodeLabel, registeredVideoContent } from '../src/utils/video-content.ts'
assert.deepEqual(rangeSelection(['a','b','c','d'], ['b'], 'd', 'b', true), ['b','c','d'])
assert.deepEqual(rangeSelection(['a','b','d'], ['b'], 'd', 'b', true), ['b','d'])
assert.deepEqual(rangeSelection(['a','b','c'], ['a','b','c'], 'c', 'a', true), [])
assert.equal(collectionName(['示例作品 第一集', '示例作品 第二集']), '示例作品 1-2')
assert.equal(collectionName(['Sample Vol.1 [中文字幕]', 'Sample Vol.2 [中文字幕]']), 'Sample 1-2')
assert.equal(seriesPart('Sample S01E02')?.number, 2)
assert.equal(seriesPart('作者 - 不同作品 A'), null)
assert.equal(videoEpisodeLabel({ season: 1, episode: 2, display_label: '' }, true), '第 1 部 · 第 2 集')
assert.equal(videoEpisodeLabel({ season: 0, episode: 2, display_label: '' }, true), '第 2 集')
assert.equal(videoEpisodeLabel({ season: 1, episode: 2, display_label: '' }), '第 1 季 · 第 2 集')
assert.equal(registeredVideoContent({ path: '', assets: [] }), false)
assert.equal(registeredVideoContent({ path: 'X:/missing.mp4', assets: [] }), true)
assert.equal(registeredVideoContent({ path: '', assets: [{ role: 'poster' }] }), false)
assert.equal(registeredVideoContent({ path: '', assets: [{ role: 'video' }] }), true)
console.log('Video batch UX: 14 assertions passed')
