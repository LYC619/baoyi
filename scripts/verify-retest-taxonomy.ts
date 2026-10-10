import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertGame, updateGame } from '../electron/kinds/game/db.ts'

test('游戏手动分类同步进入设置分类表', () => {
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  try {
    const { id } = insertGame(db, { exe_path:'D:/test/game.exe',source_dir:'D:/test',file_size:1,name_zh:'测试',name_en:'',summary:'',description:'',category:'其他',tags:[],official_url:'',save_paths:[],linked_files:[] })
    updateGame(db,id,{category:'剧情互动'})
    assert.ok(db.prepare("SELECT id FROM categories WHERE kind='game' AND name='剧情互动'").get())
    assert.equal(db.prepare("SELECT id FROM categories WHERE kind='software' AND name='剧情互动'").get(),undefined)
  } finally { db.close() }
})

test('补齐历史分类不影响其他模块或重复分类', async () => {
  const db = new DatabaseSync(':memory:'); initSchema(db,KINDS)
  try {
    const taxonomy = await import('../electron/services/resource-taxonomy.ts').catch(()=>({reconcileResourceCategories:undefined}))
    assert.equal(typeof taxonomy.reconcileResourceCategories,'function')
    db.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at,category) VALUES('legacy','game','D:/legacy','legacy',1,1,'历史分类')").run()
    taxonomy.reconcileResourceCategories!(db,'game'); taxonomy.reconcileResourceCategories!(db,'game')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM categories WHERE kind='game' AND name='历史分类'").get()?.n,1)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM categories WHERE kind='software' AND name='历史分类'").get()?.n,0)
  } finally { db.close() }
})
