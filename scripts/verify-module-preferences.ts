import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/storage/schema.ts'
import {KINDS} from '../electron/kinds/index.ts'

test('模块设置独立保存且只引用已有模型配置，不复制密钥',async t=>{
 const db=new DatabaseSync(':memory:');initSchema(db,KINDS);t.after(()=>db.close())
 assert.ok(existsSync('electron/workspace/preferences.ts'),'需要独立模块设置服务')
 const {ModulePreferences}=await import('../electron/workspace/preferences.ts')
 const settings={ai:{enabled:true,api_url:'https://default.test',api_key:'default-secret',model:'default'},ai_profiles:[{id:'other',name:'其他',enabled:true,api_url:'https://other.test',api_key:'profile-secret',model:'other'}]}
 const prefs=new ModulePreferences(db,()=>settings)
 assert.equal(prefs.config('document').model,'default')
 prefs.save('document',{profileId:'other',fontSize:21,defaultCategory:'certificate',defaultTags:['资料'],instructions:'回答简洁'})
 assert.equal(prefs.config('document').model,'other');assert.equal(prefs.config('personal').model,'default')
 assert.equal(new ModulePreferences(db,()=>settings).get('document').fontSize,21)
 const stored=String((db.prepare("SELECT value FROM settings WHERE key='_module_preferences_document'").get() as any).value)
 assert.ok(!stored.includes('secret'));assert.throws(()=>prefs.save('document',{profileId:'missing'}),/模型/)
 assert.throws(()=>prefs.save('document',{fontSize:999}),/字号/)
 settings.ai_profiles=[];assert.throws(()=>prefs.config('document'),/模型/)
})

test('密钥库不可用时回滚旧库迁移，写入新密钥也会明确失败', async t => {
  const {patchSettings}=await import('../electron/services/storage/settings-store.ts')
  const {bindKeyVault}=await import('../electron/services/storage/setting-keys.ts')
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());initSchema(db,KINDS)
  const write=db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)')
  for(const key of ['ai','search'])write.run(key,JSON.stringify({api_key:'fixture-'+key}))
  write.run('_schema','31')
  let count=0
  bindKeyVault(db,{isEncryptionAvailable:()=>++count===1,encryptString:()=>Buffer.from([1]),decryptString:()=>{throw Error('unexpected')}})
  assert.throws(()=>initSchema(db,KINDS),/加密服务不可用/)
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='_schema'").get()?.value,'31')
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value,JSON.stringify({api_key:'fixture-ai'}))
  assert.throws(()=>patchSettings(db,{ai:{api_key:'not-stored'} as any}),/加密服务不可用/)
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM settings').all()).includes('not-stored'))
})
