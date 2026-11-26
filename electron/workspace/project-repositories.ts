import fs from 'node:fs/promises'
import path from 'node:path'

function checkCancelled(signal?: AbortSignal) { if (signal?.aborted) throw new Error('已停止仓库读取') }
export async function projectRepoPath(projectRoot: string, relative?: unknown, signal?: AbortSignal): Promise<string> {
  checkCancelled(signal)
  const root = path.resolve(projectRoot)
  const rootStat = await fs.lstat(root)
  checkCancelled(signal)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('请选择项目的实际目录，不能经过符号链接')
  if (relative === undefined || relative === '') return root
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error('repoPath 必须是项目目录内的相对路径')
  }
  let current = root
  for (const part of relative.split(/[\\/]/)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    checkCancelled(signal)
    if (stat.isSymbolicLink()) throw new Error('repoPath 不能经过符号链接')
    if (!stat.isDirectory()) throw new Error('repoPath 必须指向项目内的目录')
  }
  return current
}

export async function nestedGitRoots(root: string, signal?: AbortSignal) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'release', 'output', 'cache', '.cache', 'venv', '.venv', '__pycache__'])
  const found: string[] = [], queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
  const reasons = new Set<string>()
  let visited = 0
  while (queue.length && visited < 1000 && found.length < 10) {
    checkCancelled(signal)
    const current = queue.shift()!
    visited++
    const marker = await fs.lstat(path.join(current.directory, '.git')).catch(error => {
      if (error.code !== 'ENOENT') reasons.add('unreadable')
      return null
    })
    checkCancelled(signal)
    if (current.depth > 0 && marker && (marker.isDirectory() || marker.isFile())) {
      found.push(current.directory)
      continue
    }
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => { reasons.add('unreadable'); return [] })
    checkCancelled(signal)
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue
      if (current.depth >= 5) { reasons.add('depth_limit'); continue }
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 })
    }
  }
  if (queue.length) reasons.add(visited >= 1000 ? 'directory_limit' : 'candidate_limit')
  return { roots: found, complete: reasons.size === 0, visited, reasons: [...reasons] }
}

