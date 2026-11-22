import type {SqlDb} from '../services/storage/schema.ts'
import type {AIConfig,AIProfile} from '../../src/types/index.ts'
import {DEFAULT_MODULE_PREFERENCES,type ModulePreferencesValue,type PreferenceModule} from '../../src/types/workspace.ts'
import * as v from './validation.ts'

export class ModulePreferences {
  private db:SqlDb;private settings:()=>{ai:AIConfig;ai_profiles:AIProfile[]}
  constructor(db:SqlDb,settings:()=>{ai:AIConfig;ai_profiles:AIProfile[]}){this.db=db;this.settings=settings}
  get(module:PreferenceModule):ModulePreferencesValue {
    if(!['document','personal','project'].includes(module))throw new Error('设置模块无效')
    const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get('_module_preferences_'+module) as {value:string}|undefined
    return {...structuredClone(DEFAULT_MODULE_PREFERENCES),...(row?JSON.parse(row.value):{})}
  }
  save(module:PreferenceModule,patch:Partial<ModulePreferencesValue>){
    v.keys(patch,Object.keys(DEFAULT_MODULE_PREFERENCES));const next={...this.get(module),...patch}
    next.profileId=v.text(next.profileId,'模型配置',200)
    if(next.profileId&&!this.settings().ai_profiles.some(p=>p.id===next.profileId))throw new Error('所选模型配置不存在，请重新选择')
    next.instructions=v.text(next.instructions,'助手偏好',2000)
    next.fontSize=v.number(next.fontSize,'字号',12,28);next.pdfZoom=v.number(next.pdfZoom,'PDF 缩放',.4,2.5)
    next.remindDays=v.number(next.remindDays,'提醒天数',0,365)
    for(const key of ['showCompleted','showCounts'] as const)if(typeof next[key]!=='boolean')throw new Error('显示偏好无效')
    next.defaultCategory=v.text(next.defaultCategory,'默认分类',128)
    if(next.defaultCategory&&!this.db.prepare('SELECT 1 FROM document_categories WHERE id=?').get(next.defaultCategory))throw new Error('默认分类不存在')
    for(const key of ['defaultTags','assetCategories','experienceCategories'] as const)next[key]=v.strings(next[key],100)
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('_module_preferences_'+module,JSON.stringify(next))
    return next
  }
  config(module:PreferenceModule):AIConfig {
    const id=this.get(module).profileId,settings=this.settings()
    if(!id)return settings.ai
    const profile=settings.ai_profiles.find(p=>p.id===id)
    if(!profile)throw new Error('模块使用的模型配置已删除，请在模块设置中重新选择')
    return {enabled:profile.enabled,api_url:profile.api_url,api_key:profile.api_key,model:profile.model}
  }
}
