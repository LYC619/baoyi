// Extract every uncorrupted copy of the damaged files from Claude Code session
// transcripts, to serve as a reference corpus for context-matched repair.
//
// Sources, all equally useful because repair matches on LOCAL context rather than
// whole files: Read results (full or partial, line numbers stripped), Write inputs,
// and Edit old_string/new_string fragments.
//
// A transcript copy taken AFTER the corruption is itself damaged, so any candidate
// containing a damage site ('?' preceded by a non-ASCII char) is dropped.
//
// Usage: node scripts/extract-refs.cjs
const fs = require('fs')
const path = require('path')

const SESSION_DIR = 'C:\\Users\\yicha\\.claude\\projects\\D--8-Project-0-0------'
const OUT_DIR = path.join(process.cwd(), '.recover', 'refs')

const WANTED = new Set([
  'Sidebar.vue', 'TitleBar.vue', 'Confirm.vue', 'Home.vue',
  'Organize.vue', 'Onboarding.vue', 'Settings.vue',
  'global.scss', 'variables.scss',
])

// A '?' directly after a non-ASCII char is the corruption signature.
function damageSites(text) {
  let n = 0
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '?' && text.charCodeAt(i - 1) > 0x7f) n++
  }
  return n
}

// Read results come back as `N\t<line>` per line; strip that back to source text.
function stripLineNumbers(body) {
  const lines = body.split('\n')
  const out = []
  for (const line of lines) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line)
    if (!m) return null // not a line-numbered body
    out.push(m[2])
  }
  return out.join('\n')
}

fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

const sessions = fs.readdirSync(SESSION_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f, mtime: fs.statSync(path.join(SESSION_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

let kept = 0
let dropped = 0
const perLeaf = new Map()

function emit(leaf, sid, lineNo, kind, text) {
  if (!text || text.length < 20) return
  if (damageSites(text) > 0) { dropped++; return }
  const dir = path.join(OUT_DIR, leaf)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${String(lineNo).padStart(6, '0')}-${kind}-${sid.slice(0, 8)}.txt`
  fs.writeFileSync(path.join(dir, name), text, 'utf8')
  kept++
  perLeaf.set(leaf, (perLeaf.get(leaf) || 0) + text.length)
}

for (const { f } of sessions) {
  const sid = f.replace(/\.jsonl$/, '')
  const raw = fs.readFileSync(path.join(SESSION_DIR, f), 'utf8').split('\n')

  // tool_use id -> {leaf} for Reads we care about, so pass 2 can claim the bodies.
  const readIds = new Map()
  const parsed = []
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i]) { parsed.push(null); continue }
    let o = null
    try { o = JSON.parse(raw[i]) } catch { /* partial write, skip */ }
    parsed.push(o)
    if (!o || !o.message) continue
    const content = o.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type !== 'tool_use') continue
      const fp = b.input && (b.input.file_path || b.input.notebook_path)
      if (!fp) continue
      const leaf = String(fp).split(/[\\/]/).pop()
      if (!WANTED.has(leaf)) continue

      if (b.name === 'Read') {
        readIds.set(b.id, leaf)
      } else if (b.name === 'Write' && typeof b.input.content === 'string') {
        emit(leaf, sid, i, 'write', b.input.content)
      } else if (b.name === 'Edit') {
        emit(leaf, sid, i, 'edit-old', b.input.old_string)
        emit(leaf, sid, i, 'edit-new', b.input.new_string)
      }
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i]
    if (!o || !o.message) continue
    const content = o.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type !== 'tool_result') continue
      const leaf = readIds.get(b.tool_use_id)
      if (!leaf) continue
      let body = ''
      if (typeof b.content === 'string') body = b.content
      else if (Array.isArray(b.content)) {
        body = b.content.map((x) => (x.type === 'text' ? x.text : '')).join('')
      }
      const text = stripLineNumbers(body)
      if (text !== null) emit(leaf, sid, i, 'read', text)
    }
  }
}

// git HEAD copies: the last committed state, uncorrupted by definition.
const { execFileSync } = require('child_process')
const HEAD_PATHS = [
  ['Sidebar.vue', 'src/components/Sidebar.vue'],
  ['TitleBar.vue', 'src/components/TitleBar.vue'],
  ['Confirm.vue', 'src/pages/Confirm.vue'],
  ['Home.vue', 'src/pages/Home.vue'],
  ['Onboarding.vue', 'src/pages/Onboarding.vue'],
  ['Settings.vue', 'src/pages/Settings.vue'],
  ['global.scss', 'src/styles/global.scss'],
  ['variables.scss', 'src/styles/variables.scss'],
]
for (const [leaf, rel] of HEAD_PATHS) {
  try {
    const text = execFileSync('git', ['show', `HEAD:${rel}`], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    emit(leaf, 'HEAD0000', 999999, 'gitHEAD', text)
  } catch {
    console.log(`  no HEAD copy for ${rel}`)
  }
}

console.log(`refs kept = ${kept}, dropped (self-damaged) = ${dropped}`)
for (const [leaf, chars] of [...perLeaf].sort()) {
  console.log(`  ${leaf.padEnd(16)} corpus = ${chars.toLocaleString()} chars`)
}
