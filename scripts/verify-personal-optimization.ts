import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { filterAssets } from '../src/utils/personal-assets.ts'
import { matchesExpiry } from '../src/utils/personal-assets.ts'
import { daysUntil, filterTodos } from '../src/utils/personal-view.ts'
import type { PersonalRecord } from '../src/types/workspace.ts'

const row = (name: string, data: PersonalRecord['data']): PersonalRecord => ({ id:name, kind:'asset', name, body:'', data, createdAt:0, updatedAt:0 })
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
