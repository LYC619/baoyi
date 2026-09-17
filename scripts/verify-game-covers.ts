import assert from 'node:assert/strict'
import { acceptImageUrl, coverQueries, finalizeCandidates, pickSteamApps } from '../electron/kinds/game/covers.ts'
import { configUrlsFromLauncher, parseOfficialConfig } from '../electron/kinds/game/identity.ts'

const config = `const x={customKey:'原神',cover:'https://act-webstatic.mihoyo.com/a/cover.png',nested:{text:'Genshin Impact',img:'https://act-webstatic.mihoyo.com/a/alt.webp'}}`
const parsed = parseOfficialConfig(config, 'https://launcher.mihoyo.com/config.js')
assert.ok(parsed)
assert.equal(parsed.query, '原神')
assert.deepEqual(parsed.candidates, ['https://act-webstatic.mihoyo.com/a/cover.png', 'https://act-webstatic.mihoyo.com/a/alt.webp'])
assert.deepEqual(configUrlsFromLauncher(`<script src="/assets/app.js"></script><script src="https://act.mihoyo.com/config.js"></script>`), ['https://launcher.mihoyo.com/assets/app.js', 'https://act.mihoyo.com/config.js'])
assert.equal(acceptImageUrl('https://act-webstatic.mihoyo.com/a/cover.png'), true)
assert.equal(acceptImageUrl('https://evil.example/a/cover.png'), false)
assert.equal(pickSteamApps([{ id: 1, name: 'Portal 2', type: 'app' }, { id: 2, name: 'Portal', type: 'app' }, { id: 3, name: 'Portal OST', type: 'music' }], 'Portal')[0].id, 2)
assert.equal(finalizeCandidates([{ url: 'https://act-webstatic.mihoyo.com/a/cover.png', label: '官方', source: 'official', portrait: true, rank: 0 }, { url: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1/header.jpg', label: 'Steam', source: 'steam', portrait: false, rank: 0 }])[0].source, 'official')
assert.deepEqual(coverQueries({ identity_name: 'launcher.exe', name_en: 'game.exe', name_zh: '启动器.exe', source_dir: 'D:/Games/Portal', file_name: 'launcher.exe' }), [], 'Generic executable names must not become cover queries after cleaning')
assert.deepEqual(coverQueries({ identity_query: 'Portal 2', identity_name: 'Portal', name_en: 'Portal', source_dir: 'D:/Games' }), ['Portal 2'])
console.log('游戏封面纯逻辑：通过')
