/**
 * 系统 FFmpeg 定位与合片。抱一不打包 FFmpeg（见 docs/video-av-notes），只找用户机器上的。
 * 找不到给一句人话，不静默失败。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let cached = ''

export function validateFfmpeg(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    return /^ffmpeg version /m.test(execFileSync(file, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch { return false }
}

export function locateFfmpeg(configured = '', extraRoots: string[] = []): string | null {
  if (configured.trim()) {
    if (!validateFfmpeg(configured.trim())) throw new Error('配置的 FFmpeg 无效或无法运行，请在设置中重新选择 ffmpeg.exe')
    return configured.trim()
  }
  if (cached && validateFfmpeg(cached)) return cached
  const candidates: string[] = []
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) { const value = line.trim(); if (value) candidates.push(value) }
  } catch { /* 没装就继续找常见目录 */ }
  const dirs = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin') : '',
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'apps', 'ffmpeg', 'current', 'bin') : '',
    process.env.ProgramData ? path.join(process.env.ProgramData, 'chocolatey', 'bin') : '',
    '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'
  ].filter(Boolean)
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  for (const dir of dirs) for (const name of names) candidates.push(path.join(dir, name))
  // WinGet installs often keep the real executable below a versioned package directory.
  const roots = [...extraRoots, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : ''].filter(Boolean)
  let visited = 0
  function search(dir: string, depth: number): void {
    if (depth > 4 || visited++ > 1200) return
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && names.includes(entry.name.toLowerCase())) candidates.push(path.join(dir, entry.name))
        else if (entry.isDirectory() && !/^(?:node_modules|\.git|cache|data)$/i.test(entry.name)) search(path.join(dir, entry.name), depth + 1)
      }
    } catch { /* An inaccessible directory must not block detection. */ }
  }
  for (const candidate of candidates) if (validateFfmpeg(candidate)) { cached = candidate; return candidate }
  for (const root of roots) search(root, 0)
  for (const candidate of [...new Set(candidates)]) if (validateFfmpeg(candidate)) { cached = candidate; return candidate }
  return null
}

/** 把合并好的媒体流用 `-c copy` 封装成 MP4（不重编码）。取消时结束子进程。 */
export function remuxToMp4(ffmpeg: string, input: string, output: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-i', input,
      '-c', 'copy', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', output]
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
    const onAbort = () => { child.kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => { signal.removeEventListener('abort', onAbort); reject(error) })
    child.on('close', code => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('已取消'))
      if (code === 0) return resolve()
      reject(new Error('FFmpeg 合片失败：' + (stderr.trim() || '退出码 ' + code)))
    })
  })
}
