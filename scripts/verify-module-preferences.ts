import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {initSchema} from '../electron/services/schema.ts'
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
