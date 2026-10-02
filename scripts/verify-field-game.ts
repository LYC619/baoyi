import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertGame, getGame, listGames } from '../electron/kinds/game/db.ts'
import { inspectDir } from '../electron/kinds/game/scanner.ts'
const grouping: any = await import('../src/utils/library-grouping.ts').catch(() => ({}))
assert.equal(typeof grouping.libraryDirectoryGroup, 'function', 'directory grouping must be implemented')
assert.equal(grouping.libraryDirectoryGroup('E:\\Games\\1.SLG\\常识改变模拟器', ['E:\\Games']).name, '1.SLG')
assert.equal(grouping.libraryDirectoryGroup('E:\\Games\\DirectGame', ['E:\\Games']).name, 'Games · 直属')
assert.notEqual(grouping.libraryDirectoryGroup('E:\\GamesOther\\X', ['E:\\Games']).name, 'Games · 直属')
const files: any = await import('../electron/kinds/game/files.ts').catch(() => ({}))
assert.equal(typeof files.relocateGame, 'function', 'relocation must be implemented')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baoyi-game-field-')), db = new DatabaseSync(':memory:')
try {
 initSchema(db, KINDS)
 const old = path.join(root,'old'), next = path.join(root,'renamed')
 fs.mkdirSync(path.join(old, 'Bin'), {recursive:true}); fs.writeFileSync(path.join(old, 'Bin', 'Game.exe'), 'fixture')
 const {id} = insertGame(db,{exe_path:path.join(old,'Bin','Game.exe'),source_dir:old,file_size:7,name_zh:'示例',name_en:'',summary:'',description:'',category:'',tags:[],official_url:'',save_paths:[{path:path.join(old,'Save'),verified_at:1}],linked_files:[]})
 db.prepare('UPDATE game_meta SET total_playtime_sec = 123 WHERE resource_id = ?').run(id)
 assert.equal(listGames(db,{uncategorized:true} as any).length,1)
 fs.renameSync(old,next)
 assert.equal(files.gamePathState(getGame(db,id)).path_state,'missing')
 files.relocateGame(db,id,path.join(next,'Bin','Game.exe'),next)
 const game=getGame(db,id)!
 assert.equal(game.id,id); assert.equal(game.source_dir,next); assert.equal(game.total_playtime_sec,123)
 assert.equal(game.save_paths[0].path,path.join(next,'Save'))
 assert.throws(()=>files.relocateGame(db,id,path.join(root,'missing.exe')))
 assert.equal(getGame(db,id)!.path,game.path)
 const wrapper=path.join(root,'Wandering Sword'), shipping=path.join(wrapper,'Wandering_Sword','Binaries','Win64','JH-Win64-Shipping.exe')
 fs.mkdirSync(path.dirname(shipping),{recursive:true});fs.writeFileSync(shipping,'shipping');fs.writeFileSync(path.join(wrapper,'JH.exe'),'launcher')
 fs.writeFileSync(path.join(root,'说明.txt'),'fixture')
 const candidate=inspectDir(root,root)!
 assert.ok(candidate.exes.some(exe=>exe.path===shipping),'nested Unreal binaries must appear in the initial evidence')
 assert.equal(candidate.likely_main,path.join(wrapper,'JH.exe'))
 console.log('PASS game grouping, uncategorized query and relocation preserving identity/history')
} finally {db.close();fs.rmSync(root,{recursive:true,force:true})}
