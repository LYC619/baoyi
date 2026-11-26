import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { PersonalLibrary, validatePersonal } from '../electron/workspace/personal.ts'
import { filterAssets } from '../src/utils/personal-assets.ts'
import { matchesExpiry, isReminding, renewalDate, formatAssetPrice } from '../src/utils/personal-assets.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'
import { daysUntil, filterTodos } from '../src/utils/personal-view.ts'
import type { PersonalRecord } from '../src/types/workspace.ts'

const row = (name: string, data: PersonalRecord['data']): PersonalRecord => ({ id:name, kind:'asset', name, body:'', data, createdAt:0, updatedAt:0 })

test('续费按到期日推进一个周期，月底夹紧、闰年及跨年正确', () => {
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const lib=new PersonalLibrary(db)
    for(const [from,cycle,to] of [['2027-01-31','monthly','2027-02-28'],['2028-01-31','monthly','2028-02-29'],['2028-02-29','yearly','2029-02-28'],['2026-12-31','monthly','2027-01-31']]){
      const item=lib.save({kind:'asset',name:'周期测试',body:'原备注',data:{expiresOn:from,cycle,cost:12,currency:'CNY',snoozedUntil:'2099-01-01'}})
      assert.equal(renewalDate(item),to)
      const renewed=lib.renew(item.id,{cost:20,currency:'usd'})
      assert.equal(renewed.data.expiresOn,to);assert.equal(renewed.data.snoozedUntil,undefined);assert.equal(renewed.body,'原备注')
      assert.equal(renewed.data.cost,20);assert.equal(renewed.data.currency,'USD')
      assert.deepEqual(renewed.data.renewals,[{on:new Date().toLocaleDateString('sv-SE'),from,to,cost:20,currency:'USD'}])
    }
    for(const data of [{cycle:'once',expiresOn:'2026-01-01'},{cycle:'other',expiresOn:'2026-01-01'},{cycle:'monthly'}] as PersonalRecord['data'][]){
      const item=lib.save({kind:'asset',name:'手填到期日',body:'',data})
      assert.equal(renewalDate(item),'');assert.throws(()=>lib.renew(item.id,{}),/请填写新的到期日/)
      const renewed=lib.renew(item.id,{to:'2030-03-04'})
      assert.equal(renewed.data.expiresOn,'2030-03-04');assert.equal(renewed.data.renewals![0].from,data.expiresOn||'')
    }
  } finally {db.close()}
})

test('暂缓从所有提醒数量和到期筛选中排除，到期日当天恢复；取消可立即恢复', () => {
  const item=row('快到期',{expiresOn:'2026-11-13',snoozedUntil:'2026-11-17'})
  assert.equal(isReminding(item,7,'2026-11-10'),false)
  assert.equal(matchesExpiry(item,'soon','2026-11-10',7),false)
  assert.equal(matchesExpiry(item,'overdue','2026-11-16',7),false)
  assert.equal(matchesExpiry(item,'all','2026-11-16',7),true)
  assert.equal(isReminding(item,7,'2026-11-17'),true)
  assert.equal(matchesExpiry(item,'overdue','2026-11-17',7),true)
  assert.equal(isReminding(row('无日期',{snoozedUntil:'2026-11-20'}),7,'2026-11-21'),false)
  assert.equal(matchesExpiry(row('无日期',{}),'undated','2026-11-10',7),true)
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const lib=new PersonalLibrary(db),today=new Date().toLocaleDateString('sv-SE'),asset=lib.save({kind:'asset',name:'暂缓',body:'',data:{expiresOn:today}})
    assert.throws(()=>lib.snooze(asset.id,today),/晚于今天/);assert.throws(()=>lib.snooze(asset.id,'2026-02-30'),/日期无效/)
    assert.equal(isReminding(lib.snooze(asset.id,'2099-01-01'),7,today),false)
    assert.equal(isReminding(lib.snooze(asset.id,null),7,today),true)
    const todo=lib.save({kind:'todo',name:'待办',body:'',data:{done:false}})
    assert.throws(()=>lib.snooze(todo.id,'2099-01-01'),/背包/);assert.throws(()=>lib.renew(todo.id,{to:'2099-01-01'}),/背包/)
  } finally {db.close()}
})

test('续费记录最多保留最近五十条，新字段经过真实 JSON 备份恢复保持一致', () => {
  const db=new DatabaseSync(':memory:'),target=new DatabaseSync(':memory:');initSchema(db,KINDS);initSchema(target,KINDS);db.exec(VIDEO_JOBS_SQL);target.exec(VIDEO_JOBS_SQL)
  try {
    const lib=new PersonalLibrary(db),renewals=Array.from({length:51},(_,i)=>({on:'2026-11-10',from:'2026-01-01',to:'2026-02-01',cost:i,currency:'CNY'}))
    const item=lib.save({kind:'asset',name:'续费历史',body:'',data:{cycle:'monthly',expiresOn:'2026-02-01',renewals,snoozedUntil:'2099-01-01'}})
    assert.equal(item.data.renewals!.length,50);assert.equal(item.data.renewals![0].cost,1)
    const renewed=lib.renew(item.id,{cost:0,currency:'人民币'})
    assert.equal(renewed.data.renewals!.length,50);assert.equal(renewed.data.renewals![0].cost,2);assert.equal(renewed.data.renewals!.at(-1)!.cost,0)
    lib.snooze(item.id,'2099-02-01')
    restoreLibraryBackup(target,JSON.parse(JSON.stringify(buildLibraryBackup(db))))
    assert.deepEqual(new PersonalLibrary(target).get(item.id),lib.get(item.id))
  } finally {db.close();target.close()}
})

test('记录写入校验续费结构、日期、费用和币种，拒绝错误后保持原记录', () => {
  const valid={on:'2026-11-10',from:'',to:'2027-01-01',cost:0,currency:'CNY'}
  for(const data of [{renewals:[{...valid,to:''}]},{renewals:[{...valid,on:'2026-02-30'}]},{renewals:[{...valid,cost:-1}]},{renewals:[{...valid,currency:'BADCODE'}]},{snoozedUntil:''},{renewals:['bad']},{renewals:{}}]){
    assert.throws(()=>validatePersonal({kind:'asset',name:'无效输入',body:'',data} as any))
  }
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const lib=new PersonalLibrary(db),item=lib.save({kind:'asset',name:'保留',body:'',data:{cycle:'monthly',expiresOn:'2026-01-31',cost:10}})
    assert.throws(()=>lib.renew(item.id,{cost:-1}));assert.throws(()=>lib.renew(item.id,{to:'2026-02-30'}));assert.deepEqual(lib.get(item.id),item)
  } finally {db.close()}
})
test('uncategorized assets remain reachable using the displayed Other category', () => {
  assert.deepEqual(filterAssets([row('证件',{})], '', '其他', 'expiry').map(r=>r.name), ['证件'])
})

test('expiry filters follow the configured reminder days and exclude invalid dates', () => {
  assert.equal(matchesExpiry(row('十天',{expiresOn:'2026-11-14'}),'soon','2026-11-04',7),false)
  assert.equal(matchesExpiry(row('七天',{expiresOn:'2026-11-11'}),'soon','2026-11-04',7),true)
  assert.equal(matchesExpiry(row('今天',{expiresOn:'2026-11-04'}),'overdue','2026-11-04',7),false)
  assert.equal(daysUntil('2026-02-30','2026-11-04'),null)
  assert.equal(daysUntil('2027-01-01','2026-12-31'),1)
})
test('todo date views compose with search and do not hide overdue tasks in the active list', () => {
  const todo=(name:string,dueOn:string,done=false)=>({...row(name,{dueOn,done}),kind:'todo' as const})
  const records=[todo('遥远','2027-01-01'),todo('今天','2026-11-04'),todo('逾期','2026-11-03'),todo('下周','2026-11-11'),todo('完成','2026-11-03',true),todo('无日期','')]
  assert.deepEqual(filterTodos(records,'active','','2026-11-04').map(r=>r.name),['逾期','今天','下周','遥远','无日期'])
  assert.deepEqual(filterTodos(records,'upcoming','','2026-11-04').map(r=>r.name),['下周'])
  assert.deepEqual(filterTodos(records,'today','今','2026-11-04').map(r=>r.name),['今天'])
  assert.deepEqual(filterTodos(records,'completed','','2026-11-04').map(r=>r.name),['完成'])
  assert.deepEqual(filterTodos(records,'overdue','今','2026-11-04'),[])
})
test('recurring cost sorting uses a comparable annual amount within currency and separates one-time costs', () => {
  const records=[row('年付',{cost:100,currency:'CNY',cycle:'yearly'}),row('月付',{cost:20,currency:'CNY',cycle:'monthly'}),row('买断',{cost:999,currency:'CNY',cycle:'once'})]
  assert.deepEqual(filterAssets(records,'','','cost').map(r=>r.name),['月付','年付','买断'])
})
test('changing a recorded metric unit cannot relabel historical measurements; renaming remains possible', () => {
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const lib=new PersonalLibrary(db),metric=lib.save({kind:'metric',name:'体重',body:'',data:{unit:'kg'}})
    const value=lib.captureState('体重','kg',70,'2026-11-04')
    assert.throws(()=>lib.save({id:metric.id,kind:'metric',name:'体重',body:'',data:{unit:'lb'}}),/单位|新建/)
    assert.equal(lib.get(metric.id)!.data.unit,'kg');assert.equal(lib.get(value.id)!.data.value,70)
    assert.equal(lib.save({id:metric.id,kind:'metric',name:'晨起体重',body:'',data:{unit:'kg'}}).id,metric.id)
  } finally {db.close()}
})

test('choosing a specific metric distinguishes equal names with different units', () => {
  const db=new DatabaseSync(':memory:');initSchema(db,KINDS)
  try {
    const lib=new PersonalLibrary(db),kg=lib.save({kind:'metric',name:'体重',body:'',data:{unit:'kg'}}),lb=lib.save({kind:'metric',name:'体重',body:'',data:{unit:'lb'}})
    assert.throws(()=>lib.captureState('体重','kg',70,'2026-11-04'),/同名/)
    assert.equal(lib.captureState('体重','kg',70,'2026-11-04',kg.id).data.metricId,kg.id)
    assert.equal(lib.captureState('体重','lb',154,'2026-11-04',lb.id).data.metricId,lb.id)
    assert.throws(()=>lib.captureState('体重','lb',154,'2026-11-04',kg.id),/单位/)
  } finally {db.close()}
})

test('reminding and snoozed expiry views keep snoozed subscriptions reachable and format prices cleanly', () => {
  const snoozed = row('暂缓订阅', { expiresOn: '2026-11-12', snoozedUntil: '2026-11-20', cost: 20, currency: 'CNY' })
  const due = row('待续费订阅', { expiresOn: '2026-11-12', cost: 9.9, currency: 'USD' })
  assert.equal(matchesExpiry(snoozed, 'reminding', '2026-11-10', 7), false)
  assert.equal(matchesExpiry(snoozed, 'snoozed', '2026-11-10', 7), true)
  assert.equal(matchesExpiry(due, 'reminding', '2026-11-10', 7), true)
  assert.equal(formatAssetPrice(20, 'CNY'), '¥20 CNY')
  assert.equal(formatAssetPrice(9.9, 'USD'), '$9.9 USD')
})
