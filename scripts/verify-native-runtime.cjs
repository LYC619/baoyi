const { spawnSync } = require('node:child_process')
const path = require('node:path')
const runtime = process.argv[2] ? path.resolve(process.argv[2]) : require('electron')
const binding = process.argv[3] ? path.resolve(process.argv[3]) : require.resolve('better-sqlite3')
const source = `const Database=require(${JSON.stringify(binding)});const db=new Database(':memory:');db.exec('CREATE TABLE sample(value TEXT)');db.prepare('INSERT INTO sample VALUES(?)').run('原生模块验证');if(db.prepare('SELECT value FROM sample').get().value!=='原生模块验证')throw Error('SQLite roundtrip failed');db.close();console.log('PASS Electron '+process.versions.electron+' / SQLite N-API '+process.versions.napi)`
const result = spawnSync(runtime, ['-e', source], { cwd: path.resolve(__dirname, '..'), windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
if (result.error) console.error(result.error.message)
process.exitCode = result.status === 0 ? 0 : 1
