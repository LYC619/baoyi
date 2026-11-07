const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const suites = [
  'verify-download-improvements.cjs', 'verify-stream-recovery.ts', 'verify-download-cache.ts', 'verify-hanime-cdn-routing.ts', 'verify-settings-routing.ts',
  'verify-review-boundaries.ts', 'verify-library-query.ts', 'verify-library-selection.ts',
  'verify-project.ts', 'verify-project-agent.ts', 'verify-image-integrity.ts', 'verify-image-download-control.ts',
  'verify-library-upgrade.ts', 'verify-organize-sync.ts', 'verify-organize-service.ts',
  'verify-field-game.ts', 'verify-game-identify-budget.ts', 'verify-release-config.cjs',
  'agent-selfcheck.ts', 'check-module-memory.ts',
  'verify-workspace.ts', 'verify-workspace-ipc.ts', 'verify-workspace-assistant.ts', 'verify-workspace-reader.ts'
]
const version = require('../package.json').version
const output = path.resolve(`output/release-${version}/core`)
fs.mkdirSync(output, { recursive: true })
const results = []
for (const name of suites) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/' + name], {
    encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024
  })
  const passed = run.status === 0
  fs.writeFileSync(path.join(output, name + '.log'), (run.stdout || '') + (run.stderr || '') + (run.error?.message || ''))
  results.push({ name, passed, exitCode: run.status })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : '\n' + run.stdout + run.stderr + (run.error?.message || '')}`)
}
const failed = results.filter(r => !r.passed).length
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: failed ? 'failed' : 'passed', version, results }, null, 2))
console.log(`Core verification: ${results.length - failed}/${results.length} groups passed`)
process.exitCode = failed ? 1 : 0
