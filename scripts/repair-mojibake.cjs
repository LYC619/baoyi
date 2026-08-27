// Repair mojibake damage by splicing back the exact bytes a '?' consumed.
//
// The corruption replaced a short run of bytes with a single 0x3F. Byte alignment
// recovers immediately after (verified in probe-loss.ps1), so every site is a local
// hole with intact bytes on both sides:
//
//   original   ... E5 90 8E | E5 BE 97 3C | 2F 73 70 61 6E ...
//   damaged    ... E5 90 8E | E5 BE 3F    | 2F 73 70 61 6E ...
//                            ^^^^^ valid prefix of a truncated 3-byte char
//
// Repair is therefore a lookup, not a guess: take the intact bytes before the hole
// (including the truncated char's surviving prefix) and the intact bytes after it,
// find that pair in a reference copy, and read out whatever sat between them.
//
// Two rules keep this honest:
//   - the recovered bytes must be IDENTICAL across every reference that matches;
//     any disagreement leaves the site untouched and reported.
//   - context windows never cross a neighbouring hole, so no '?' is ever matched
//     against reference text. Sites hemmed in by neighbours get too little context
//     to resolve on the first pass, so the whole thing runs iteratively -- each
//     repaired site lengthens its neighbours' context for the next pass.
//
// Usage: node scripts/repair-mojibake.cjs [--apply]
//        (dry run by default; prints what it would change)
const fs = require('fs')
const path = require('path')

const APPLY = process.argv.includes('--apply')
const REFS_DIR = path.join(process.cwd(), '.recover', 'refs')
const BACKUP_DIR = path.join(process.cwd(), '.recover', 'before')

const TARGETS = [
  ['TitleBar.vue', 'src/components/TitleBar.vue'],
  ['Sidebar.vue', 'src/components/software/Sidebar.vue'],
  ['Onboarding.vue', 'src/pages/Onboarding.vue'],
  ['Settings.vue', 'src/pages/Settings.vue'],
  ['Confirm.vue', 'src/pages/software/Confirm.vue'],
  ['Home.vue', 'src/pages/software/Home.vue'],
  ['Organize.vue', 'src/pages/software/Organize.vue'],
  ['global.scss', 'src/styles/global.scss'],
  ['variables.scss', 'src/styles/variables.scss'],
]

const CTX_MAX = 32 // bytes of context on each side, trimmed toward CTX_MIN on miss
const CTX_MIN = 6
const GAP_MAX = 6 // largest run of bytes a single '?' is allowed to have eaten
// Sites can sit so close together that neither has room for context -- "步 —— 列"
// loses a byte on each side of the dash, leaving only the 3 bytes of the first dash
// between them. Neither resolves alone at any window size, and no amount of
// iterating breaks the deadlock. So a stuck site is retried merged with its
// neighbours, recovering the whole span (holes and surviving bytes alike) at once.
const MERGE_MAX = 6
const GAP_MAX_MERGED = 40

// How many bytes the lead byte of a UTF-8 sequence promises, 0 if not a lead.
function seqLen(b) {
  if (b < 0x80) return 1
  if (b >= 0xc2 && b <= 0xdf) return 2
  if (b >= 0xe0 && b <= 0xef) return 3
  if (b >= 0xf0 && b <= 0xf4) return 4
  return 0
}
const isCont = (b) => b >= 0x80 && b <= 0xbf

// Walk the buffer as strict UTF-8; every truncated sequence followed by 0x3F is a
// damage site. Returns {start, prefixEnd, holeEnd}: bytes [start, prefixEnd) are the
// surviving prefix, [prefixEnd, holeEnd) is the 0x3F standing in for lost bytes.
function findSites(buf) {
  const sites = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) { i++; continue }
    const L = seqLen(b)
    if (L === 0) { i++; continue }
    let k = 1
    while (k < L && i + k < buf.length && isCont(buf[i + k])) k++
    if (k === L) { i += L; continue }
    // Truncated sequence. A damage site only if a '?' sits where the rest should be.
    if (i + k < buf.length && buf[i + k] === 0x3f) {
      sites.push({ start: i, prefixEnd: i + k, holeEnd: i + k + 1 })
      i += k + 1
    } else {
      i += k
    }
  }
  return sites
}

function loadRefs(leaf) {
  const dir = path.join(REFS_DIR, leaf)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .sort()
    .reverse() // newest transcript line first; only affects report order
    .map((f) => ({ name: f, buf: fs.readFileSync(path.join(dir, f)) }))
}

// Every distinct byte-run a reference says belongs in the hole between before/after.
function candidatesFrom(refBuf, before, after, gapMax) {
  const found = new Set()
  let from = 0
  for (;;) {
    const at = refBuf.indexOf(before, from)
    if (at < 0) break
    const holeStart = at + before.length
    for (let gap = 1; gap <= gapMax; gap++) {
      const tail = holeStart + gap
      if (tail + after.length > refBuf.length) break
      if (refBuf.compare(after, 0, after.length, tail, tail + after.length) === 0) {
        found.add(refBuf.subarray(holeStart, tail).toString('hex'))
        break // shortest gap wins; longer ones would re-match after's own bytes
      }
    }
    from = at + 1
  }
  return found
}

function lineOf(buf, offset) {
  let n = 1
  for (let i = 0; i < offset && i < buf.length; i++) if (buf[i] === 0x0a) n++
  return n
}

const report = []
const unresolved = []
let totalFixed = 0
let totalLeft = 0

if (APPLY) fs.mkdirSync(BACKUP_DIR, { recursive: true })

for (const [leaf, rel] of TARGETS) {
  const abs = path.join(process.cwd(), rel)
  if (!fs.existsSync(abs)) { console.log(`SKIP missing ${rel}`); continue }

  let buf = fs.readFileSync(abs)
  const original = Buffer.from(buf)
  const refs = loadRefs(leaf)
  if (refs.length === 0) { console.log(`SKIP no refs for ${leaf}`); continue }

  let fixedHere = 0
  let pass = 0
  for (;;) {
    pass++
    const sites = findSites(buf)
    if (sites.length === 0) break

    // Splices are collected then applied right-to-left so earlier offsets stay valid.
    const splices = []
    let s = 0
    while (s < sites.length) {
      let done = null

      // Try this site alone first, then widened to swallow stuck neighbours.
      for (let m = 1; m <= MERGE_MAX && s + m <= sites.length; m++) {
        const first = sites[s]
        const last = sites[s + m - 1]
        // Clip context so it never reaches into a hole outside the merged group.
        const floor = s > 0 ? sites[s - 1].holeEnd : 0
        const ceil = s + m < sites.length ? sites[s + m].start : buf.length
        const gapMax = m === 1 ? GAP_MAX : GAP_MAX_MERGED

        let resolved = null
        for (let ctx = CTX_MAX; ctx >= CTX_MIN; ctx -= 4) {
          const bStart = Math.max(floor, first.prefixEnd - ctx)
          const aEnd = Math.min(ceil, last.holeEnd + ctx)
          const before = buf.subarray(bStart, first.prefixEnd)
          const after = buf.subarray(last.holeEnd, aEnd)
          if (before.length < CTX_MIN || after.length < CTX_MIN) continue

          const all = new Set()
          const sources = []
          for (const ref of refs) {
            const cands = candidatesFrom(ref.buf, before, after, gapMax)
            if (cands.size > 0) sources.push(ref.name)
            for (const c of cands) all.add(c)
          }
          if (all.size === 1) { resolved = { hex: [...all][0], ctx, sources } ; break }
          if (all.size > 1) {
            // References disagree, so the window cannot pin the bytes down. A wider
            // window already failed; shrinking further only adds ambiguity.
            break
          }
        }

        if (resolved) {
          done = {
            holeStart: first.prefixEnd,
            holeEnd: last.holeEnd,
            start: first.start,
            prefixEnd: first.prefixEnd,
            bytes: Buffer.from(resolved.hex, 'hex'),
            meta: { ...resolved, merged: m },
          }
          break
        }
      }

      if (!done) { s++; continue }
      splices.push(done)
      s += done.meta.merged
    }

    if (splices.length === 0) break

    for (let i = splices.length - 1; i >= 0; i--) {
      const sp = splices[i]
      const ctxBefore = buf.subarray(Math.max(0, sp.start - 18), sp.start).toString('utf8')
      const restored = Buffer.concat([buf.subarray(sp.start, sp.prefixEnd), sp.bytes])
      report.push({
        rel,
        line: lineOf(buf, sp.start),
        merged: sp.meta.merged,
        was: ctxBefore.replace(/\n/g, '\\n') + '?',
        now: (ctxBefore + restored.toString('utf8')).replace(/\n/g, '\\n'),
        hex: sp.meta.hex,
        ctx: sp.meta.ctx,
        refs: sp.meta.sources.length,
      })
      buf = Buffer.concat([
        buf.subarray(0, sp.holeStart),
        sp.bytes,
        buf.subarray(sp.holeEnd),
      ])
      fixedHere += sp.meta.merged
    }
  }

  const left = findSites(buf)
  for (const site of left) {
    unresolved.push({
      rel,
      line: lineOf(buf, site.start),
      ctxBefore: buf.subarray(Math.max(0, site.start - 40), site.prefixEnd).toString('utf8'),
      ctxAfter: buf.subarray(site.holeEnd, Math.min(buf.length, site.holeEnd + 40)).toString('utf8'),
      prefixHex: buf.subarray(site.start, site.prefixEnd).toString('hex'),
    })
  }

  totalFixed += fixedHere
  totalLeft += left.length
  console.log(
    `${rel.padEnd(38)} fixed=${String(fixedHere).padStart(4)}  left=${String(left.length).padStart(4)}  passes=${pass}  refs=${refs.length}`
  )

  if (APPLY && fixedHere > 0) {
    fs.writeFileSync(path.join(BACKUP_DIR, leaf + '.bak'), original)
    fs.writeFileSync(abs, buf)
  }
}

fs.mkdirSync(path.join(process.cwd(), '.recover'), { recursive: true })
fs.writeFileSync(
  path.join(process.cwd(), '.recover', 'repair-report.json'),
  JSON.stringify({ fixed: report, unresolved }, null, 2),
  'utf8'
)

console.log(`\nTOTAL fixed=${totalFixed}  unresolved=${totalLeft}`)
console.log(`report -> .recover/repair-report.json`)
if (!APPLY) console.log('DRY RUN -- rerun with --apply to write files')
