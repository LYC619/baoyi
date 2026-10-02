/**
 * 系统 FFmpeg 定位与合片。抱一不打包 FFmpeg（见 docs/video-av-notes），只找用户机器上的。
 * 找不到给一句人话，不静默失败。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let cached: string | null | undefined

export function locateFfmpeg(): string | null {
  if (cached !== undefined) return cached
  const candidates: string[] = []
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(finder, ['ffmpeg'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) { const value = line.trim(); if (value) candidates.push(value) }
  } catch { /* 没装就继续找常见目录 */ }
  const dirs = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin') : '',
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'
  ].filter(Boolean)
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  for (const dir of dirs) for (const name of names) candidates.push(path.join(dir, name))
  for (const candidate of candidates) { try { if (fs.statSync(candidate).isFile()) { cached = candidate; return candidate } } catch { /* 下一个 */ } }
  cached = null
  return null
}

/** 把合并好的媒体流用 `-c copy` 封装成 MP4（不重编码）。取消时结束子进程。 */
export function remuxToMp4(ffmpeg: string, input: string, output: string, signal: AbortSignal): Promise<void> {
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
