import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePersonal } from '../electron/workspace/personal.ts'
import { assetAnnualCosts, filterAssets } from '../src/utils/personal-assets.ts'
import type { PersonalRecord } from '../src/types/workspace.ts'

test('资产空费用保持缺省，中文币种归一化', () => {
  const result = validatePersonal({ kind: 'asset', name: '护照', body: '', data: { cost: '', currency: '人民币' } })
  assert.equal(result.data.cost, undefined)
  assert.equal(result.data.currency, 'CNY')
})
test('年度费用不混币种，不计一次性或未知费用；筛选不修改原数组', () => {
  const row = (id: string, data: PersonalRecord['data']): PersonalRecord => ({id, kind:'asset', name:id, body:'', data, createdAt:0, updatedAt:0})
  const records = [row('云服务',{category:'服务',cost:8,currency:'USD',cycle:'monthly'}),row('授权',{cost:100,currency:'CNY',cycle:'yearly'}),row('设备',{cost:500,currency:'CNY',cycle:'once'}),row('证件',{})]
  assert.deepEqual(assetAnnualCosts(records), {totals:{USD:96,CNY:100},omitted:1})
  assert.deepEqual(filterAssets(records,'云','服务','name').map(r=>r.id),['云服务'])
  assert.equal(records[0].id,'云服务')
})
test('头像只接收有限长度的 PNG 数据，不允许外部 URL 或 SVG', () => {
  assert.throws(() => validatePersonal({kind:'profile',name:'我',body:'',data:{avatar:'https://example.com/photo.png'}}))
  assert.throws(() => validatePersonal({kind:'profile',name:'我',body:'',data:{avatar:'data:image/svg+xml;base64,PHN2Zz4='}}))
  assert.equal(validatePersonal({kind:'profile',name:'我',body:'',data:{avatar:''}}).data.avatar,'')
})
test('免费与未填写费用不同，拒绝非数值费用', () => {
  assert.equal(validatePersonal({ kind: 'asset', name: '免费授权', body: '', data: { cost: 0, currency: 'usd' } }).data.cost, 0)
  assert.throws(() => validatePersonal({ kind: 'asset', name: '错误', body: '', data: { cost: 'abc' } }))
})
