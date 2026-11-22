import { ARCHIVE_TOOLS } from '../../electron/archive/tools.ts'
import { createEvalFixture, type EvalSummary } from './mock-runner.ts'
import { ARCHIVE_EVAL_CASES } from './cases.ts'

export async function runArchiveEval(options: { quiet?: boolean; filter?: string } = {}): Promise<EvalSummary> {
  const cases = options.filter
    ? ARCHIVE_EVAL_CASES.filter(c => c.id.includes(options.filter!) || c.group.includes(options.filter!) || c.title.includes(options.filter!))
    : ARCHIVE_EVAL_CASES

  const covered = new Set<string>()
  const failures: EvalSummary['failures'] = []
  let passed = 0

  for (const item of cases) {
    for (const tool of item.tools) covered.add(tool)
    const needsFixture = item.group !== 'turn-policy' && item.group !== 'schema-quality'
    const ctx = needsFixture ? await createEvalFixture() : (null as any)
    try {
      await item.run(ctx)
      passed++
      if (!options.quiet) console.log(`PASS [${item.id}] (${item.group}) ${item.title}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ id: item.id, group: item.group, title: item.title, error: message })
      if (!options.quiet) console.error(`FAIL [${item.id}] (${item.group}) ${item.title}\n     -> ${message}`)
    } finally {
      if (ctx) await ctx.close()
    }
  }

  const allTools = ARCHIVE_TOOLS.map(t => t.name)
  const missing = allTools.filter(name => !covered.has(name))
  const summary: EvalSummary = {
    total: cases.length,
    passed,
    failed: failures.length,
    toolCoverage: { covered: [...covered].sort(), missing, total: allTools.length },
    failures,
  }
  if (!options.quiet) {
    console.log(`\nArchive Eval Summary: ${summary.passed}/${summary.total} passed (${Math.round((summary.passed / Math.max(1, summary.total)) * 100)}%) | Tools covered: ${summary.toolCoverage.covered.length}/${summary.toolCoverage.total}${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`)
  }
  return summary
}

if (import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const filter = process.argv.find(a => a.startsWith('--filter='))?.slice(9)
  const summary = await runArchiveEval({ filter })
  if (summary.failed > 0 || (!filter && summary.toolCoverage.missing.length > 0)) {
    process.exitCode = 1
  }
}
