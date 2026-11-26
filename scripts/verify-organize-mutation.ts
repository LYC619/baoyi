import assert from 'node:assert/strict'
import { withOrganizeMutation } from '../electron/kinds/software/organize/mutation.ts'

let release!: () => void
const first = withOrganizeMutation(() => new Promise<void>(resolve => { release = resolve }))
await assert.rejects(withOrganizeMutation(async () => {}), /进行中/)
release(); await first
await assert.rejects(withOrganizeMutation(async () => { throw new Error('fixture') }), /fixture/)
assert.equal(await withOrganizeMutation(async () => 42), 42)
console.log('PASS concurrent writes rejected and lock released on failure')
