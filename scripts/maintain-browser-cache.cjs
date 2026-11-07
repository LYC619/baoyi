const { app, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const profile = path.resolve(process.argv[2]), report = path.resolve(process.argv[3])
assert.ok(fs.existsSync(path.join(profile, 'baoyi.db')))
assert.ok(!fs.lstatSync(profile).isSymbolicLink())
assert.ok(!fs.existsSync(report))
app.setName('抱一'); app.setPath('userData', profile); app.setPath('sessionData', profile)
app.disableHardwareAcceleration()
if (!app.requestSingleInstanceLock()) throw new Error('Profile is already in use')
const digest = cookies => createHash('sha256').update(JSON.stringify(cookies.map(cookie => ({
  name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure,
  httpOnly: cookie.httpOnly, expirationDate: cookie.expirationDate, sameSite: cookie.sameSite
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')
app.whenReady().then(async () => {
  const profiles = [{ name: 'default', store: session.defaultSession }, ...['video-discovery', 'general-web-browser', 'hanime-network'].map(name => ({ name, store: session.fromPartition('persist:' + name) }))]
  const checks = []
  for (const { name, store } of profiles) {
    const before = await store.cookies.get({})
    await store.clearCache(); await store.clearCodeCaches({ urls: [] })
    const after = await store.cookies.get({})
    assert.equal(digest(after), digest(before), 'Cookies changed in ' + name)
    checks.push({ name, cookieCount: after.length, cookiesUnchanged: true })
    await store.cookies.flushStore(); store.flushStorageData()
  }
  fs.writeFileSync(report, JSON.stringify({ status: 'passed', checks, boundary: 'Only HTTP/code caches cleared; no clearStorageData or cookie removal.' }, null, 2) + '\n')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
