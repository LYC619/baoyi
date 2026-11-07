import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
test('来源卡只使用真实读取结果与选文上下文，忽略失败、伪造文本和无效位置',async()=>{
  assert.ok(existsSync('src/utils/workspace-sources.ts'),'需要可点击且有原始依据的来源卡')
  const {workspaceSources}=await import('../src/utils/workspace-sources.ts')
  const session:any={context:{selection:{documentId:'selected',quote:'重复原句',location:{page:2,offset:0}}},messages:[{id:'m',role:'assistant',text:'模型编造的第 999 页不是来源',events:[{label:'read_document_text 结果',detail:JSON.stringify({text:'实际正文',source:{documentId:'doc',name:'书',format:'pdf',page:3,start:0}})},{label:'read_document_text 结果',error:true,detail:JSON.stringify({source:{documentId:'failed',page:5}})},{label:'read_document_text 结果',detail:JSON.stringify({source:{documentId:'invalid',page:-1}})}]}]}
  const sources=workspaceSources(session,'m');assert.equal(sources.length,2);assert.equal(sources[0].documentId,'selected');assert.equal(sources[1].location.page,3);assert.equal(sources[1].quote,'实际正文')
  assert.deepEqual(workspaceSources(session,'unknown'),[])
})
