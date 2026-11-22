import assert from 'node:assert/strict'
import { runArchiveEval } from '../tests/evals/archive-eval.ts'

const summary = await runArchiveEval()
assert.equal(summary.failed, 0, 'All archive eval cases must pass')
assert.equal(summary.toolCoverage.missing.length, 0, 'All 22 archive tools must be covered')
assert.ok(summary.total >= 60, 'Eval suite must include at least 60 cases')
