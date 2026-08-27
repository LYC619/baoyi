// Fill the four holes no reference copy could resolve, because the surrounding code
// was written after the corruption and exists in no transcript.
//
// Each is still pinned down: the truncated char's first two bytes survive, which
// narrows the candidates to a handful, and only one of those is a Chinese sentence.
//   E5 80 ?? -> E5 80 BC (值)   "重置后要跟着回到当前值"
//   E3 80 ?? -> E3 80 82 (。)   sentence-final, before a newline
//   E5 92 ?? -> E5 92 8C (和)   "和 organize/plan.ts 的 defaultAction 是同一条规则"
//
// Byte-level splicing, not text editing: a hole is invalid UTF-8, so it cannot be
// matched or round-tripped as a string. Each patch states the bytes it expects to
// find and refuses to write if they are not there.
//
// Usage: node scripts/patch-last-holes.cjs [--apply]
const fs = require('fs')

const APPLY = process.argv.includes('--apply')

const PATCHES = [
  {
    file: 'src/pages/Settings.vue',
    // "...回到当前<hole>    fillForm(settings.settings.ai)"
    before: Buffer.from('重置后要跟着回到当前', 'utf8'),
    after: Buffer.from('    fillForm(settings.settings.ai)', 'utf8'),
    fill: Buffer.from([0xe5, 0x80, 0xbc, 0x0a]),
    note: '值 + newline',
  },
  {
    file: 'src/pages/Settings.vue',
    // "...一起清掉<hole>            </p>"
    before: Buffer.from('「清空识别数据」一起清掉', 'utf8'),
    after: Buffer.from('            </p>', 'utf8'),
    fill: Buffer.from([0xe3, 0x80, 0x82, 0x0a]),
    note: '。 + newline',
  },
  {
    file: 'src/pages/software/Confirm.vue',
    // "...还是链接<hole> * <hole>organize/plan.ts" -- two holes, one splice
    before: Buffer.from('这一条按现在的判断会走剪切还是链接', 'utf8'),
    after: Buffer.from('organize/plan.ts', 'utf8'),
    fill: Buffer.concat([
      Buffer.from([0xe3, 0x80, 0x82, 0x0a]), // 。 + newline
      Buffer.from(' * ', 'utf8'),
      Buffer.from([0xe5, 0x92, 0x8c, 0x20]), // 和 + space
    ]),
    note: '。+ newline, " * ", 和 + space',
  },
]

let failed = 0
const dirty = new Map()

for (const p of PATCHES) {
  const buf = dirty.get(p.file) || fs.readFileSync(p.file)

  const at = buf.indexOf(p.before)
  if (at < 0) { console.log(`FAIL ${p.file}: anchor not found (${p.note})`); failed++; continue }
  if (buf.indexOf(p.before, at + 1) >= 0) {
    console.log(`FAIL ${p.file}: anchor is not unique (${p.note})`); failed++; continue
  }
  const holeStart = at + p.before.length
  const holeEnd = buf.indexOf(p.after, holeStart)
  if (holeEnd < 0) { console.log(`FAIL ${p.file}: tail not found (${p.note})`); failed++; continue }

  const hole = buf.subarray(holeStart, holeEnd)
  // Sanity: the span being replaced must be short and must actually contain a '?'.
  if (hole.length > 12 || !hole.includes(0x3f)) {
    console.log(`FAIL ${p.file}: span is not a hole -- ${hole.toString('hex')} (${p.note})`)
    failed++
    continue
  }

  const next = Buffer.concat([buf.subarray(0, holeStart), p.fill, buf.subarray(holeEnd)])
  dirty.set(p.file, next)

  const preview = next
    .subarray(Math.max(0, holeStart - 30), holeStart + p.fill.length + 26)
    .toString('utf8')
    .replace(/\n/g, '\\n')
  console.log(`OK   ${p.file}  ${hole.toString('hex')} -> ${p.fill.toString('hex')}  (${p.note})`)
  console.log(`     ...${preview}...`)
}

if (failed > 0) { console.log(`\n${failed} patch(es) failed -- nothing written`); process.exit(1) }

if (APPLY) {
  for (const [file, buf] of dirty) fs.writeFileSync(file, buf)
  console.log(`\nwrote ${dirty.size} file(s)`)
} else {
  console.log('\nDRY RUN -- rerun with --apply to write files')
}
