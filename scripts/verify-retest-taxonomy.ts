import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { insertGame, updateGame } from '../electron/kinds/game/db.ts'
import { upsertCategory } from '../electron/services/taxonomy/taxonomy-store.ts'

test('游戏手动分类同步进入设置分类表', () => {
  const db = new DatabaseSync(':memory:'); initSchema(db, KINDS)
  try {
    const { id } = insertGame(db, { exe_path:'D:/test/game.exe',source_dir:'D:/test',file_size:1,name_zh:'测试',name_en:'',summary:'',description:'',category:'其他',tags:[],official_url:'',save_paths:[],linked_files:[] })
    updateGame(db,id,{category:'剧情互动'})
    const rows = db.prepare("SELECT * FROM categories WHERE kind='game' AND name='剧情互动'")
    const original = rows.all()
    assert.equal(original.length,1)
    updateGame(db,id,{category:' 剧情互动 '})
    updateGame(db,id,{category:'剧情互动'})
    assert.deepEqual(rows.all(),original)
    assert.equal(db.prepare("SELECT id FROM categories WHERE kind='software' AND name='剧情互动'").get(),undefined)
  } finally { db.close() }
})

test('设置拒绝同库重名且保留原归属，跨库允许同名', () => {
  const db = new DatabaseSync(':memory:'); initSchema(db,KINDS)
  try {
    const category = {id:'keep',name:'自定义一',description:'我的说明',icon:'folder',sort_order:40}
    upsertCategory(db,category,'game')
    upsertCategory(db,{...category,id:'fixture-game-second',name:'自定义二'},'game')
    upsertCategory(db,{...category,id:'software-keep'},'software')
    db.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at,category) VALUES('item','game','test','test',1,1,'自定义二')").run()
    const snapshot = () => db.prepare("SELECT * FROM categories WHERE kind='game' ORDER BY id").all()
    const before = snapshot()
    assert.throws(()=>upsertCategory(db,{...category,id:'',name:' 自定义一 '},'game'),/同名分类/)
    assert.throws(()=>upsertCategory(db,{...category,id:'fixture-game-second'},'game'),/同名分类/)
    assert.deepEqual(snapshot(),before)
    assert.equal(db.prepare("SELECT category FROM resource WHERE id='item'").get()?.category,'自定义二')
    upsertCategory(db,{...category,id:'fixture-game-second',name:'自定义三'},'game')
    assert.equal(db.prepare("SELECT category FROM resource WHERE id='item'").get()?.category,'自定义三')
    assert.equal(db.prepare("SELECT name FROM categories WHERE id='software-keep'").get()?.name,'自定义一')
  } finally { db.close() }
})

test('补齐历史分类不影响其他模块或重复分类', async () => {
  const db = new DatabaseSync(':memory:'); initSchema(db,KINDS)
  try {
    const taxonomy = await import('../electron/services/taxonomy/resource-taxonomy.ts').catch(()=>({reconcileResourceCategories:undefined}))
    assert.equal(typeof taxonomy.reconcileResourceCategories,'function')
    db.prepare("INSERT INTO resource(id,kind,path,file_name,created_at,updated_at,category) VALUES('legacy','game','D:/legacy','legacy',1,1,'历史分类')").run()
    taxonomy.reconcileResourceCategories!(db,'game'); taxonomy.reconcileResourceCategories!(db,'game')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM categories WHERE kind='game' AND name='历史分类'").get()?.n,1)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM categories WHERE kind='software' AND name='历史分类'").get()?.n,0)
  } finally { db.close() }
})
