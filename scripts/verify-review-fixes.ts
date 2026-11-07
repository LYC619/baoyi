import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { WorkspaceChanges } from '../electron/workspace/agent-changes.ts'

function fixture(t: { after: (fn:()=>void)=>void }) {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS)
  db.prepare('INSERT INTO workspace_sessions(id,module,title,created_at,updated_at,payload) VALUES(?,?,?,?,?,?)').run('session','personal','review fixes',1,1,'{}')
  t.after(()=>db.close());return {db,personal:new PersonalLibrary(db),changes:new WorkspaceChanges(db)}
}

test('assistant-created unitless metric accepts capture, preserves identity and idempotent retries', t=>{
  const {personal,changes}=fixture(t),input={kind:'metric' as const,name:'心情分数',body:'',data:{}}
  const created=changes.savePersonal('session',input),metric=personal.get(created.targetId)!
  const recorded=personal.captureState(metric.name,'',7,'2026-11-04',metric.id)
  assert.equal(recorded.data.metricId,metric.id);assert.equal(recorded.data.value,7)
  assert.equal(changes.savePersonal('session',input).id,created.id)
  assert.equal(personal.list('metric').length,1)
  assert.deepEqual(personal.get(metric.id)!.data,metric.data,'capture leaves audited metric data unchanged')
  personal.remove(recorded.id)
  assert.equal(changes.undo(created.id).undone,true,'existing audit remains undoable')
})

test('legacy missing unit with history accepts new values and rejects attaching a nonempty unit', t=>{
  const {db,personal}=fixture(t),metric=personal.save({kind:'metric',name:'专注程度',body:'',data:{}})
  const previous=personal.save({kind:'measurement',name:'原记录',body:'保留',data:{metricId:metric.id,value:3,date:'2026-11-03'}})
  const reopened=new PersonalLibrary(db),next=reopened.captureState(metric.name,'',4,'2026-11-04',metric.id)
  assert.equal(next.data.metricId,metric.id);assert.equal(reopened.list('measurement').length,2)
  assert.throws(()=>reopened.captureState(metric.name,'分',5,'2026-11-04',metric.id),/单位/)
  const edit={id:metric.id,kind:metric.kind,name:metric.name,body:metric.body}
  assert.throws(()=>reopened.save({...edit,data:{unit:'分'}}),/已有历史/)
  assert.deepEqual(reopened.get(previous.id),previous)
  const normalized=reopened.save({...edit,data:{unit:''}})
  assert.equal(normalized.id,metric.id)
  assert.equal(reopened.captureState(metric.name,'',5,'2026-11-04').data.metricId,metric.id)
})

test('explicit empty unit and nonempty units keep strict selection and history boundaries', t=>{
  const {personal}=fixture(t),metric=personal.save({kind:'metric',name:'评分',body:'',data:{unit:''}})
  assert.equal(personal.captureState('评分','',8,'2026-11-04',metric.id).data.metricId,metric.id)
  const kg=personal.save({kind:'metric',name:'体重',body:'',data:{unit:'kg'}})
  const lb=personal.save({kind:'metric',name:'体重',body:'',data:{unit:'lb'}})
  assert.equal(personal.captureState('体重','kg',70,'2026-11-04',kg.id).data.metricId,kg.id)
  assert.throws(()=>personal.captureState('体重','',70,'2026-11-04',kg.id),/单位/)
  assert.throws(()=>personal.captureState('体重','lb',154,'2026-11-04',kg.id),/单位/)
  assert.equal(personal.captureState('体重','lb',154,'2026-11-04',lb.id).data.metricId,lb.id)
  assert.throws(()=>personal.save({id:kg.id,kind:kg.kind,name:kg.name,body:kg.body,data:{}}),/已有历史/)
  assert.throws(()=>personal.captureState('体重','kg',70,'2026-11-04'),/同名/)
})
