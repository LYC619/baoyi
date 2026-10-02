/**
 * JAVDB 解析器离线回归。使用手工构造的合成 HTML（不联网、不访问真实站点），
 * 只验证解析逻辑本身。真实选择器仍需用真实页面样本复核。
 *
 * node --experimental-strip-types --no-warnings scripts/verify-javdb-parse.ts
 */
import assert from 'node:assert/strict'
import { isJavdbUrl, javdbUid, normalizeCode, parseJavdbDetail, parseJavdbList } from '../electron/kinds/video/discovery/adapters/javdb.ts'

const LIST_URL = 'https://javdb.com/search?q=abc'
const DETAIL_URL = 'https://javdb.com/v/AbC123'
const LIST_HTML = `<!doctype html><html><head><meta property="og:site_name" content="JavDB"><title>搜尋</title></head><body>
<div class="movie-list">
  <div class="item"><a class="box" href="/v/AbC123">
    <div class="cover"><img data-src="https://c0.jdbstatic.com/covers/ab/abc123.jpg" src="/placeholder.png"></div>
    <div class="video-title"><strong>ABC-123</strong> Test Title One</div>
    <div class="score">8.5分</div>
    <div class="meta">2024-05-01</div>
    <div class="tags"><span class="tag">Tag A</span><a class="tag">Tag B</a></div>
  </a></div>
  <div class="item"><a class="box" href="/v/xyz789">
    <div class="cover"><img src="https://c0.jdbstatic.com/covers/xy/xyz789.jpg"></div>
    <div class="video-title"><strong>XYZ-789</strong> Test Title Two</div>
    <div class="score">7.0</div>
    <div class="meta">2023-01-02</div>
    <div class="tags"></div>
  </a></div>
</div>
<nav class="pagination"><ul class="pagination-list"><li><a href="/search?q=abc&amp;page=2">下一頁</a></li></ul></nav>
</body></html>`

const DETAIL_HTML = `<!doctype html><html><head><meta property="og:description" content="An offline synopsis.">
<meta property="og:image" content="https://c0.jdbstatic.com/covers/ab/abc123.jpg"></head><body>
<div class="video-detail">
  <h2 class="title is-4"><strong>ABC-123</strong> Test Title One</h2>
  <img class="video-cover" src="https://c0.jdbstatic.com/covers/ab/abc123.jpg">
  <div class="panel-block"><strong>日期:</strong><span class="value">2024-05-01</span></div>
  <div class="panel-block"><strong>類別:</strong><span class="value"><a href="/tags/a">Tag A</a><a href="/tags/b">Tag B</a></span></div>
  <div class="panel-block"><strong>演員:</strong><span class="value"><a href="/actors/x">Actor X</a></span></div>
  <div class="panel-block"><strong>片商:</strong><span class="value">Studio S</span></div>
  <div class="panel-block"><strong>評分:</strong><span class="value">8.5分</span></div>
</div>
</body></html>`

function main(): void {
  assert.equal(isJavdbUrl('https://javdb.com/v/abc123'), true)
  assert.equal(isJavdbUrl('https://www.javdb.me/v/abc'), true)
  assert.equal(isJavdbUrl('https://example.org/v/abc'), false)
  assert.equal(isJavdbUrl('not a url'), false)

  assert.equal(javdbUid('https://javdb.com/v/AbC123'), 'abc123')
  assert.equal(javdbUid('/v/xyz789'), 'xyz789')
  assert.equal(javdbUid('https://javdb.com/tags/a'), '')

  assert.equal(normalizeCode('abc-123'), 'ABC-123')
  assert.equal(normalizeCode('SSIS 001'), 'SSIS-001')
  assert.equal(normalizeCode('FC2-PPV-1234567'), 'FC2-PPV-1234567')
  assert.equal(normalizeCode('no code here'), '')

  const list = parseJavdbList({ html: LIST_HTML, url: LIST_URL })
  assert.equal(list.entries.length, 2)
  const first = list.entries[0]
  assert.equal(first.id, 'abc123')
  assert.equal(first.code, 'ABC-123')
  assert.equal(first.title, 'Test Title One')
  assert.equal(first.coverUrl, 'https://c0.jdbstatic.com/covers/ab/abc123.jpg')
  assert.equal(first.pageUrl, 'https://javdb.com/v/AbC123')
  assert.equal(first.year, 2024)
  assert.deepEqual(first.tags, ['Tag A', 'Tag B'])
  assert.equal(first.rating?.value, 8.5)
  assert.equal(list.entries[1].id, 'xyz789')
  assert.equal(list.entries[1].coverUrl, 'https://c0.jdbstatic.com/covers/xy/xyz789.jpg')
  assert.equal(list.nextPageUrl, 'https://javdb.com/search?q=abc&page=2')

  const detail = parseJavdbDetail({ html: DETAIL_HTML, url: DETAIL_URL })
  assert.equal(detail.code, 'ABC-123')
  assert.equal(detail.title, 'Test Title One')
  assert.equal(detail.description, '')
  assert.equal(detail.coverUrl, 'https://c0.jdbstatic.com/covers/ab/abc123.jpg')
  assert.equal(detail.year, 2024)
  assert.equal(detail.rating?.value, 8.5)
  assert.ok(detail.tags?.includes('Tag A') && detail.tags?.includes('Tag B'))
  assert.ok(detail.tags?.includes('Actor X'))
  assert.ok(detail.tags?.includes('Studio S'))

  // 空页面不能抛错，返回空结果
  assert.deepEqual(parseJavdbList({ html: '', url: LIST_URL }).entries, [])
  assert.equal(parseJavdbDetail({ html: '', url: DETAIL_URL }).code, '')

  console.log('verify-javdb-parse: all assertions passed')
}

main()
