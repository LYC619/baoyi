import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
/** The Electron launcher needs the npm package, not a downloaded browser. */
export function loadPlaywright(): typeof import('playwright') {
  return require(process.env.BAOYI_PLAYWRIGHT || 'playwright')
}
export function electronTestEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
  return env
}
