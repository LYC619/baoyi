import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { SkillProfiles } from '../electron/workspace/skill-profiles.ts'
import { PersonalLibrary } from '../electron/workspace/personal.ts'
import { buildLibraryBackup, restoreLibraryBackup } from '../electron/services/storage/library-backup.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

test('技能草案必须确认，追加记录幂等且校验指标口径', t => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);t.after(()=>db.close())
  const skills = new SkillProfiles(db)
  const draft = skills.propose({name:'跑步',summary:'10 公里训练',metrics:[{key:'10k',label:'10 公里用时',unit:'分钟',type:'number'}]})
  assert.equal(skills.list().length,0)
  const card = skills.confirm(draft.id)
  assert.equal(skills.confirm(draft.id).id,card.id)
  const input={cardId:card.id,metricKey:'10k',version:1,value:51,date:'2026-10-22',requestId:'run-1',evidence:'用户报告'}
  assert.equal(skills.record(input).id,skills.record(input).id)
  assert.throws(()=>skills.record({...input,requestId:'run-2',version:2}),/口径/)
  assert.throws(()=>skills.record({...input,requestId:'run-2',value:'很快'}),/数值/)
  assert.equal(skills.list()[0].records.length,1)
  skills.undoRecord(skills.list()[0].records[0].id)
  assert.equal(skills.list()[0].records.length,0)
})

test('旧技能补建指标保留编号，过期草案不能覆盖人工修改', t=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);t.after(()=>db.close())
  const personal=new PersonalLibrary(db),skills=new SkillProfiles(db)
  const old=personal.save({kind:'skill',name:'编程',body:'人工说明',data:{practice:'旧作品'}})
  const draft=skills.propose({cardId:old.id,name:old.name,summary:old.body,metrics:[{key:'work',label:'作品',type:'text',unit:''}]})
  const card=skills.confirm(draft.id)
  assert.equal(card.id,old.id)
  assert.equal(personal.get(old.id)?.data.practice,'旧作品')
  skills.record({cardId:old.id,metricKey:'work',version:1,value:'旧作品',date:'2026-10-22',requestId:'old-work',evidence:'用户'})
  const revised=skills.propose({cardId:old.id,name:old.name,summary:old.body,metrics:[{key:'work',label:'作品数量',type:'number',unit:'个'}]})
  const updated=skills.confirm(revised.id)
  assert.equal(updated.metrics.length,2)
  assert.equal(updated.records[0].version,1)
  skills.record({cardId:old.id,metricKey:'work',version:2,value:2,date:'2026-10-22',requestId:'new-work',evidence:'用户'})
  assert.equal(skills.list().find(c=>c.id===old.id)?.records.length,2)
  const second=personal.save({kind:'skill',name:'绘画',body:'原文',data:{}})
  const stale=skills.propose({cardId:second.id,name:second.name,summary:second.body,metrics:[{key:'work',label:'作品',type:'text',unit:''}]})
  personal.save({id:second.id,kind:'skill',name:second.name,body:'后来人工修订',data:{}})
  assert.throws(()=>skills.confirm(stale.id),/过期/)
  assert.equal(personal.get(second.id)?.body,'后来人工修订')
})

test('技能及头像随备份恢复；状态首条记录失败不残留指标', t=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');initSchema(db,KINDS);db.exec(VIDEO_JOBS_SQL);t.after(()=>db.close())
  const skills=new SkillProfiles(db),personal=new PersonalLibrary(db)
  const draft=skills.propose({name:'英语',summary:'保留事实',metrics:[{key:'exam',label:'考试名称',unit:'',type:'text'}]})
  const card=skills.confirm(draft.id)
  skills.record({cardId:card.id,metricKey:'exam',version:1,value:'用户报告的考试',date:'2026-10-22',requestId:'exam-1',evidence:'用户'})
  assert.throws(()=>personal.captureState('体重','kg',NaN,'2026-10-22'))
  assert.equal(personal.list('metric').length,0)
  personal.captureState('体重','kg',70,'2026-10-22')
  assert.throws(()=>personal.captureState('体重','lb',150,'2026-10-22'),/单位/)
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='
  personal.save({kind:'profile',name:'我',body:'旧补充内容',data:{avatar:png}})
  const backup=buildLibraryBackup(db)
  const target=new DatabaseSync(':memory:');target.exec('PRAGMA foreign_keys=ON');initSchema(target,KINDS);target.exec(VIDEO_JOBS_SQL);t.after(()=>target.close())
  restoreLibraryBackup(target,backup)
  assert.equal(new SkillProfiles(target).list()[0].records[0].value,'用户报告的考试')
  assert.equal(new PersonalLibrary(target).get('self')?.data.avatar,png)
})

test('手动保存技能卡片无需 AI 草案即可建立与更新指标，并可直接登记实践记录', t => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); initSchema(db, KINDS); t.after(() => db.close())
  const skills = new SkillProfiles(db), personal = new PersonalLibrary(db)
  const card = skills.saveManual({ name: '指弹吉他', summary: '日常曲目练习', metrics: [{ key: 'songs', label: '完成曲目', unit: '首', type: 'number' }] })
  assert.equal(card.name, '指弹吉他')
  assert.equal(card.metrics.length, 1)
  skills.record({ cardId: card.id, metricKey: 'songs', version: 1, value: 3, date: '2026-11-22', requestId: 'manual-1', evidence: '手动练习记录' })
  const updated = skills.saveManual({ cardId: card.id, name: '指弹吉他', summary: '日常曲目与指法练习', metrics: [{ key: 'songs', label: '完成曲目', unit: '首', type: 'number' }, { key: 'hours', label: '练习时长', unit: '小时', type: 'number' }] })
  assert.equal(updated.metrics.length, 2)
  assert.equal(updated.records.length, 1)
  const measured = personal.captureState('睡眠时长', '小时', 7.5, '2026-11-22', undefined, '早睡测试备注')
  assert.equal(measured.body, '早睡测试备注')
})
