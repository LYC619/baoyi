const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseOptions, selectSuites, suiteEnvironment, resultExitCode } = require('./run-tests.cjs')

const suites = [
  { file: 'good.ts', module: 'infra', kind: 'unit', status: 'pass' },
  { file: 'broken.ts', module: 'infra', kind: 'unit', status: 'failing', reason: 'regression' },
  { file: 'ui.ts', module: 'video', kind: 'ui-dev', status: 'failing', reason: 'old locator', packaged: true },
  { file: 'live.ts', module: 'infra', kind: 'real-env', status: 'failing', reason: 'requires credentials' },
  { file: 'packaged.ts', module: 'infra', kind: 'e2e-packaged', status: 'pass' }
]
const options = (args = [], env = {}) => parseOptions(args, env)
assert.equal(options().all, false)
assert.equal(options(['--all']).all, true)
assert.equal(options(['--strict']).all, true)
assert.equal(options(['--strict']).strict, true)
assert.equal(options([], { CI: 'true' }).strict, true)
assert.equal(options([], { CI: '1' }).all, true)
assert.equal(options([], { CI: 'false' }).strict, false)
assert.equal(options([], { CI: '0' }).all, false)
assert.equal(options(['infra', '--all']).mode, 'infra')
assert.equal(options(['--strict', 'e2e', 'test.exe']).executable, 'test.exe')
assert.throws(() => options(['--al']), /未知/)
assert.throws(() => options(['infra', 'extra.exe']), /参数/)
assert.throws(() => selectSuites(suites, options(['missing'])), /未知测试模块/)

let selected = selectSuites(suites, options())
assert.deepEqual(selected.suites.map(s => s.file), ['good.ts'])
assert.deepEqual(selected.excluded.map(s => s.file), ['broken.ts', 'ui.ts'])
assert.deepEqual(selected.outOfScope.map(s => s.file), ['live.ts', 'packaged.ts'])
selected = selectSuites(suites, options(['--all']))
assert.deepEqual(selected.suites.map(s => s.file), ['good.ts', 'broken.ts', 'ui.ts'])
assert.deepEqual(selected.excluded, [])
assert.deepEqual(selectSuites(suites, options([], { CI: 'true' })).suites, selected.suites)
assert.deepEqual(selectSuites(suites, options(['infra', '--strict'])).suites.map(s => s.file), ['good.ts', 'broken.ts'])
assert.deepEqual(selectSuites(suites, options(['--unit', '--strict'])).suites.map(s => s.file), ['good.ts', 'broken.ts'])
assert.deepEqual(selectSuites(suites, options(['e2e', 'test.exe', '--all'])).suites.map(s => s.file), ['ui.ts', 'packaged.ts'])
assert.equal(resultExitCode([{ passed: true }], [], [], false), 0)
assert.equal(resultExitCode([{ passed: false }], [], [], false), 1)
assert.equal(resultExitCode([{ passed: true }], [suites[1]], [], false), 0)
assert.equal(resultExitCode([{ passed: true }], [suites[1]], [], true), 1)
assert.equal(resultExitCode([{ passed: true }], [], [suites[1]], true), 1)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-test-runner-'))
try {
  const inherited = { APPDATA: 'daily-data', LOCALAPPDATA: 'daily-cache', TEMP: 'shared-temp', ELECTRON_RUN_AS_NODE: '1', VITE_DEV_SERVER_URL: 'http://example.invalid', PATH: process.env.PATH }
  const first = suiteEnvironment(suites[0], root, inherited)
  const second = suiteEnvironment(suites[1], root, inherited)
  for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'BAOYI_TEST_DATA_DIR']) {
    assert.ok(path.relative(root, first[key]) && !path.relative(root, first[key]).startsWith('..'), key)
    assert.ok(fs.statSync(first[key]).isDirectory(), key)
    assert.notEqual(first[key], second[key], key)
  }
  assert.equal(first.APPDATA, path.join(first.USERPROFILE, 'AppData', 'Roaming'))
  assert.equal(first.LOCALAPPDATA, path.join(first.USERPROFILE, 'AppData', 'Local'))
  assert.equal(first.PLAYWRIGHT_BROWSERS_PATH, path.join(process.platform === 'win32' ? inherited.LOCALAPPDATA : path.join(inherited.HOME || '', '.cache'), 'ms-playwright'))
  assert.equal(first.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(first.VITE_DEV_SERVER_URL, undefined)
  assert.equal(first.PATH, inherited.PATH)
  assert.equal(inherited.APPDATA, 'daily-data', 'parent environment must stay unchanged')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
console.log('PASS test selection, CI strict mode, failure exits and per-suite data isolation')
