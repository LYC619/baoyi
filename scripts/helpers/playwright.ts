import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
/** The Electron launcher needs the npm package, not a downloaded browser. */
export function loadPlaywright(): typeof import('playwright') {
  return require(process.env.BAOYI_PLAYWRIGHT || 'playwright')
}
export function findChromiumExecutable(playwright = loadPlaywright()): string | undefined {
  try {
    const expected = playwright.chromium.executablePath()
    if (expected && fs.existsSync(expected)) return expected
  } catch { /* fallback to browsers cache */ }
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!cacheDir || !fs.existsSync(cacheDir)) return undefined
  for (const entry of fs.readdirSync(cacheDir).sort().reverse()) {
    if (!/^chromium(?:_headless_shell)?-/.test(entry)) continue
    for (const rel of [
      'chrome-headless-shell-win64/chrome-headless-shell.exe',
      'chrome-headless-shell-linux64/chrome-headless-shell',
      'chrome-win/chrome.exe',
      'chrome-linux/chrome'
    ]) {
      const candidate = path.join(cacheDir, entry, rel)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return undefined
}
export function electronTestEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
  return env
}
