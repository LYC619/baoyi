import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)
const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
export interface HistoryCursor { head: string; offset: number; since?: string; until?: string;after?:string }
export interface HistoryCommit { sha: string; at: string; subject: string; refs: string }
export interface HistoryOptions { cursor?: HistoryCursor; limit?: number; since?: string; until?: string;after?:string;signal?:AbortSignal }

async function repository(root: string, signal?:AbortSignal) {
  signal?.throwIfAborted()
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择项目的实际 Git 根目录')
  const run = async (args: string[]) => (await exec('git', ['--no-optional-locks', '--no-pager', '-C', root, ...args], {
    timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '' }
  })).stdout
  const top = (await run(['rev-parse', '--show-toplevel'])).trim()
  if (path.resolve(top).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('此目录不是独立 Git 仓库根目录')
  return run
}

export async function projectHistory(root: string, options: HistoryOptions = {}) {
  const run = await repository(root, options.signal), limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每页提交数应为 1–100')
  let head = options.cursor?.head || ''
  if (!head) {
    try { head = (await run(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() }
    catch (error) {
      if ((error as {code?:number}).code === 1) return { head:'',commits:[] as HistoryCommit[],next:null }
      throw error
    }
  }
  const offset = options.cursor?.offset || 0, since = options.cursor?.since ?? options.since, until = options.cursor?.until ?? options.until
  const after = options.cursor?.after ?? options.after
  if (after && !shaPattern.test(after)) throw new Error('增量范围需要完整提交 SHA')
  if (!shaPattern.test(head) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('提交分页位置无效')
  const range: string[] = []
  for (const [name, value] of [['since', since], ['until', until]]) if (value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('历史日期请使用 YYYY-MM-DD')
    range.push(`--${name}=${value}${name === 'until' ? 'T23:59:59' : 'T00:00:00'}`)
  }
  const output = await run(['log', '--topo-order', `--max-count=${limit + 1}`, `--skip=${offset}`, '--format=%H%x00%aI%x00%s%x00%D%x00', '--no-show-signature', ...range, head, ...(after ? ['--not', after] : []), '--'])
  const fields = output.split('\0'), rows: HistoryCommit[] = []
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const sha = fields[i].trim()
    if (shaPattern.test(sha)) rows.push({ sha, at: fields[i + 1], subject: fields[i + 2], refs: fields[i + 3] })
  }
  return { head, commits: rows.slice(0, limit), next: rows.length > limit ? { head, offset: offset + limit, ...(since ? { since } : {}), ...(until ? { until } : {}), ...(after ? { after } : {}) } : null }
}

export async function projectCommit(root: string, sha: string, file?: string, start = 0, signal?:AbortSignal) {
  if (!shaPattern.test(sha)) throw new Error('请使用完整提交 SHA')
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('差异读取位置无效')
  const run = await repository(root, signal)
  if (file && (path.isAbsolute(file) || file.split(/[\\/]/).some(p => p === '..' || /^(?:\.git|\.env(?:\.|$))|credential|secret|password|cookie|token|密钥|密码|私钥|\.(?:pem|key|p12|pfx)$/i.test(p)))) throw new Error('文件超出可读项目范围')
  const args = ['show', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--format=fuller', ...(file ? ['--patch', '--unified=3'] : ['--stat']), sha, '--', ...(file ? [file] : [])]
  let output: string
  try { output = await run(args) } catch (error) {
    if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('单个提交差异超过 2 MB，请选取更具体的文件读取')
    throw error
  }
  const text = output.slice(start, start + 4500)
  return { sha, file: file || '', next: start + text.length < output.length ? start + text.length : null, text }
}
