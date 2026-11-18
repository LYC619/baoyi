import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SqlDb } from '../services/schema.ts'
import type { EvidenceReport } from '../../src/types/workspace.ts'
import { ProjectLibrary } from '../kinds/project/library.ts'
import { readProjectText } from '../kinds/project/workspace.ts'
import { TimelineLibrary } from './timeline.ts'
const exec = promisify(execFile)
const excluded = /^(?:\.|node_modules$|dist$|dist-electron$|build$|release$|output$|cache$|venv$|__pycache__$)|credential|secret|password|cookie|token|密钥|密码|私钥|\.(?:pem|key|p12|pfx)$/i
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export async function collectEvidence(db: SqlDb, id: string): Promise<EvidenceReport> {
  const item = new ProjectLibrary(db).get(id); if (!item) throw new Error('项目不存在')
  const timeline = new TimelineLibrary(db), stat = await fs.lstat(item.path)
  if (stat.isSymbolicLink()) throw new Error('请使用实际项目目录')
  const run = (args: string[]) => exec('git', ['--no-optional-locks', '-C', item.path, ...args], { timeout: 8000, maxBuffer: 512000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  let git = false
  if (stat.isDirectory()) try { git = path.resolve((await run(['rev-parse', '--show-toplevel'])).stdout.trim()).toLowerCase() === path.resolve(item.path).toLowerCase() } catch { /* Manual/directory projects remain fully usable without Git. */ }
  if (git) {
    const output = (await run(['log', '-80', '--format=%H%x09%aI%x09%D%x09%s', '--no-show-signature'])).stdout.trim()
    const commits = output.split('\n').filter(Boolean).map(line => { const [sha, at, decorations, ...subject] = line.split('\t'); return { sha, at, decorations, subject: subject.join(' ') } })
    const evidence = commits.map(c => `commit:${c.sha} ${c.at} ${c.subject}`.slice(0, 1000))
    const notes: string[] = []
    for (const file of ['README.md', 'CHANGELOG.md', 'docs/changes/2026-10-01-to-07.md']) {
      try { notes.push(`${file}\n${await readProjectText(item.path, file)}`) } catch { /* Optional evidence is absent in many projects. */ }
    }
    const version = commits[0]?.decorations.match(/tag: ([^,)]+)/)?.[1] || ''
    return { source: 'git', key: commits.length ? 'git:' + digest(commits.map(c => c.sha).join(',')) : '', title: `${commits.length} 次提交的项目记录`,
      text: evidence.join('\n') + (notes.length ? '\n\n已有说明（可能含历史信息，以提交与日期核对）：\n' + notes.join('\n\n') : ''), evidence,
      message: commits.length ? `快速预览最近 ${commits.length} 次提交；AI 整理可分页回顾全部历史` : '尚无提交', occurredAt: commits[0] ? Date.parse(commits[0].at) : Date.now(), version }
  }
  const snapshot: Record<string, string> = {}; let count = 0
  const walk = async (root: string, file: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 12 || ++count > 10000) throw new Error('目录内容较多，请选择更具体的项目目录后检查变化')
    const s = await fs.lstat(file); if (s.isSymbolicLink()) return
    if (s.isDirectory()) { for (const entry of await fs.readdir(file, { withFileTypes: true })) if (!excluded.test(entry.name) && !entry.isSymbolicLink()) await walk(root, path.join(file, entry.name), prefix, depth + 1) }
    else if (s.isFile()) snapshot[prefix + path.relative(root, file).split(path.sep).join('/')] = `${s.size}:${Math.trunc(s.mtimeMs)}`
  }
  await walk(stat.isDirectory() ? item.path : path.dirname(item.path), item.path, '主目录/', 0)
  for (const entry of item.entries.filter(e => e.type === 'path' && path.resolve(e.path) !== path.resolve(item.path)).slice(0, 10)) {
    const s = await fs.lstat(entry.path).catch(cause => { if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null; throw cause })
    if (s?.isDirectory() && !s.isSymbolicLink()) await walk(entry.path, entry.path, `关联目录(${entry.label})/`, 0)
  }
  const saved = timeline.baseline(id), current = JSON.stringify(snapshot)
  if (!saved) { timeline.baseline(id, current); return { source: 'directory', key: '', title: '建立目录基线', text: '', evidence: [], message: '已建立目录基线，下次检查时会比较文件变化', occurredAt: Date.now(), version: '' } }
  const previous = JSON.parse(saved) as Record<string, string>, changes: string[] = []
  for (const [file, stamp] of Object.entries(snapshot)) if (previous[file] !== stamp) changes.push(`${file in previous ? '修改' : '新增'}：${file}`)
  for (const file of Object.keys(previous)) if (!(file in snapshot)) changes.push(`移除：${file}`)
  if (changes.length > 500) throw new Error('本次变化超过 500 项，请缩小项目关联范围后再检查')
  return { source: 'directory', key: changes.length ? 'directory:' + digest(saved + '\n' + current) : '', title: `目录发生 ${changes.length} 项变化`,
    text: changes.join('\n'), evidence: changes, snapshot: current, message: changes.length ? `发现 ${changes.length} 项文件变化，可整理为一条记录` : '目录没有新变化', occurredAt: Date.now(), version: '' }
}
