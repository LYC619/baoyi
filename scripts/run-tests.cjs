const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const manifest = require('./test-manifest.json')
const uiPauseFile = path.join(root, 'output', 'test-ui-paused.txt')
const readableRuntimes = new Set()

// Agent-managed runs renew this lease while the turn is active. An interrupted
// turn stops renewing it, even if its terminal process survives cancellation.
function leaseActive() {
  if (!process.env.BAOYI_TEST_LEASE) return true
  return Date.now() - fs.statSync(process.env.BAOYI_TEST_LEASE).mtimeMs < 60000
}

function windowsArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}

function failureReason(log, code, timedOut) {
  if (timedOut) return '超过 5 分钟'
  const lines = log.split(/\r?\n/).map(line => line.trim())
  return lines.find(line => /^(?:[\w.]*Error(?: \[.*?\])?:|error:|FAIL |not ok |用法[:：]|(?:locator|page|electron)\.[\w.]+:)/.test(line)) || `退出码 ${code}`
}

function assertWindowTestAvailable(suite, executable) {
  if (process.platform !== 'win32' || (suite.kind === 'unit' && !executable)) return
  if (fs.existsSync(uiPauseFile)) {
    throw new Error('窗口测试已暂停，未启动测试进程。修复启动故障后再移除暂停记录：' + uiPauseFile + '\n' + fs.readFileSync(uiPauseFile, 'utf8').trim())
  }
  const runtimeFile = path.join(executable ? path.dirname(path.resolve(executable)) : path.join(root, 'node_modules', 'electron', 'dist'), 'icudtl.dat')
  if (readableRuntimes.has(runtimeFile)) return
  const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers', 'electron-access.ps1'), '-Paths', runtimeFile], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000 })
  if (check.error) throw check.error
  if (check.status !== 0 || !check.stdout.trim().endsWith('|restrictedLow=True')) {
    throw new Error('当前执行环境不能让 Electron 的受限进程读取运行文件；未启动窗口测试。请在已通过权限检查的授权环境中运行。\n' + (check.stderr || check.stdout).trim())
  }
  readableRuntimes.add(runtimeFile)
}

async function runSuite(suite, executable, output) {
  if (!leaseActive()) throw new Error('测试已暂停：运行许可超过 60 秒未续期')
  assertWindowTestAvailable(suite, executable)
  fs.mkdirSync(output, { recursive: true })
  const python = suite.file.endsWith('.py')
  const runtime = python ? path.join(root, 'output', 'hermes-runtime', 'python', 'python.exe') : process.execPath
  const args = [...(python ? ['-I', '-S', '-X', 'utf8', '-u'] : suite.file.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : []), path.join(__dirname, suite.file)]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VITE_DEV_SERVER_URL
  if (executable) {
    args.push(path.resolve(executable))
    env.BAOYI_TEST_EXE = path.resolve(executable)
  }
  const logFile = path.join(output, path.basename(suite.file) + '.log')
  const log = fs.openSync(logFile, 'w')
  const start = Date.now()
  let timedOut = false
  const hiddenDesktop = process.platform === 'win32'
  const command = hiddenDesktop ? 'powershell.exe' : runtime
  const childArgs = hiddenDesktop ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers', 'hidden-desktop.ps1'),
    '-Executable', runtime, '-ChildCommandLine', [runtime, ...args].map(windowsArgument).join(' '),
    '-WorkingDirectory', root, '-LogFile', logFile, '-OwnerPid', String(process.pid)] : args
  // The desktop helper owns the test process tree and its log. The runner owns
  // the helper, so cancellation or runner exit also closes the Windows job.
  if (hiddenDesktop) fs.closeSync(log)
  const child = spawn(command, childArgs, { cwd: root, env, windowsHide: true, stdio: hiddenDesktop ? ['ignore', 'pipe', 'pipe'] : ['ignore', log, log] })
  let launcherOutput = ''
  child.stdout?.on('data', chunk => { launcherOutput += chunk })
  child.stderr?.on('data', chunk => { launcherOutput += chunk })
  const stop = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGKILL')
  }
  const interrupted = () => { stop(); process.exit(130) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  let cancelled = false
  const leaseTimer = process.env.BAOYI_TEST_LEASE ? setInterval(() => {
    if (!leaseActive()) { cancelled = true; stop() }
  }, 1000) : undefined
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, hiddenDesktop ? 310000 : 300000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    if (cancelled) throw new Error('测试已暂停：运行许可超过 60 秒未续期')
    timedOut ||= code === 124
    if (hiddenDesktop) fs.appendFileSync(logFile, '\n' + launcherOutput)
    const logText = fs.readFileSync(logFile, 'utf8')
    if (/FATAL:electron[\\/]+shell[\\/]+browser[\\/]+win[\\/]+install_dir_access\.cc/.test(logText)) {
      fs.writeFileSync(uiPauseFile, 'Electron 启动目录权限检查失败。为避免系统错误弹窗，窗口测试保持暂停。日志：' + logFile + '\n')
      throw new Error('Electron 启动目录权限检查失败；已停止测试队列，避免重复触发系统错误弹窗。日志：' + logFile)
    }
    const passed = code === 0 && !timedOut
    return { file: suite.file, passed, exitCode: code, durationMs: Date.now() - start, ...(passed ? {} : { reason: failureReason(logText, code, timedOut) }) }
  } finally {
    clearTimeout(timer)
    clearInterval(leaseTimer)
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    if (!hiddenDesktop) fs.closeSync(log)
  }
}

async function main() {
  const [mode, executable] = process.argv.slice(2)
  const modules = [...new Set(manifest.map(suite => suite.module))]
  if (mode && mode !== 'e2e' && !modules.includes(mode)) throw new Error('未知测试模块：' + mode)
  if (mode === 'e2e' && (!executable || !fs.existsSync(executable))) throw new Error('用法：npm run test:e2e -- <抱一.exe 路径>')
  const inScope = suite => mode === 'e2e' ? suite.kind === 'e2e-packaged' || suite.packaged : ['unit', 'ui-dev'].includes(suite.kind) && (!mode || suite.module === mode)
  const suites = manifest.filter(suite => inScope(suite) && suite.status === 'pass')
  const excluded = manifest.filter(suite => inScope(suite) && suite.status !== 'pass')
  if (!suites.length) throw new Error('没有已通过的测试可运行')
  for (const suite of suites) assertWindowTestAvailable(suite, mode === 'e2e' ? executable : undefined)
  const date = new Date().toLocaleDateString('sv-SE')
  const output = path.join(root, 'output', `test-${date}`, `${Date.now()}-${mode || 'all'}`)
  const results = []
  for (const suite of suites) {
    const result = await runSuite(suite, mode === 'e2e' ? executable : undefined, output)
    results.push(result)
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${suite.file}${result.reason ? ': ' + result.reason : ''}`)
  }
  const failed = results.filter(result => !result.passed).length
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ version: require('../package.json').version, results, excluded }, null, 2))
  console.log(`${results.length - failed}/${results.length} 通过；清单中 ${excluded.length} 项已知失败未运行。日志：${path.relative(root, output)}`)
  process.exitCode = failed ? 1 : 0
}

module.exports = { runSuite, assertWindowTestAvailable }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
