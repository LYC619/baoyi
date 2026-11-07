import assert from 'node:assert/strict'
import { settingsModule, MODULE_TABS } from '../src/composables/useModules.ts'
for (const { key } of MODULE_TABS) {
  assert.equal(settingsModule(key, 'appearance', 'software'), key)
  assert.equal(settingsModule(undefined, 'appearance', key), key)
  assert.equal(settingsModule(key, 'downloads', 'software'), key)
  assert.equal(settingsModule(key, 'organize', 'software'), key)
}
assert.equal(settingsModule('wrong', 'search', 'game'), 'game')
assert.equal(settingsModule(undefined, 'project', 'software'), 'project')
assert.equal(settingsModule('video', 'organize', 'video'), 'video')
assert.equal(settingsModule(undefined, 'organize', 'video'), 'software')
assert.equal(settingsModule(undefined, 'downloads', 'game'), 'video')
assert.equal(settingsModule(undefined, 'saves', 'software'), 'game')
assert.equal(settingsModule(undefined, 'document', 'software'), 'document')
console.log('PASS settings module restoration, shared pages and video-specific deep links')
