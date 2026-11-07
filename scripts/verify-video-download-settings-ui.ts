import assert from 'node:assert/strict'
import path from 'node:path'
import { createWorkflowRendererFixture } from './verify-video-workflow-renderer.ts'
const extra=String.raw`
import FfmpegPanel from '@/components/settings/FfmpegPanel.vue'
const settingsHost=document.createElement('div');settingsHost.id='download-settings-test';document.body.append(settingsHost)
createApp(FfmpegPanel).use(pinia).mount(settingsHost)
const patchSettings=window.baoyi.settings.patch
window.baoyi.settings.patch=async value=>{
  for(const [key,max] of [['video_download_concurrency',4],['video_download_connections',8]])if(key in value && (!Number.isInteger(value[key]) || value[key]<1 || value[key]>max))throw new Error('并发必须是允许范围内的整数')
  return patchSettings(value)
}
`
const {page,url,errors,temporary,close}=await createWorkflowRendererFixture(extra)
page.on('console',(message:any)=>{if(message.type()==='error')console.error('Browser console: '+message.text())})
page.on('requestfailed',(request:any)=>console.error('Browser request: '+request.url()+' '+request.failure()?.errorText))
try{
  await page.goto(url,{waitUntil:'commit',timeout:60000})
  const panel=page.locator('#download-settings-test')
  await panel.getByLabel('同时下载视频数').waitFor({timeout:60000})
  const videos=panel.getByLabel('同时下载视频数'),connections=panel.getByLabel('每个视频连接数')
  assert.equal(await videos.inputValue(),'2');assert.equal(await connections.inputValue(),'4')
  await videos.fill('3');await videos.dispatchEvent('change')
  await page.waitForFunction(()=>((window as any).__fixture.settingsStore.settings.video_download_concurrency===3))
  await connections.fill('8');await connections.dispatchEvent('change')
  await page.waitForFunction(()=>((window as any).__fixture.settingsStore.settings.video_download_connections===8))
  await connections.fill('9');await connections.dispatchEvent('change')
  await panel.getByRole('status').filter({hasText:'并发必须'}).waitFor()
  assert.equal(await connections.inputValue(),'8')
  assert.deepEqual(errors,[])
  await panel.screenshot({path:path.join(temporary,'video-download-settings.png')})
  console.log('PASS video download settings: defaults, saved values, validation rollback; screenshot '+path.join(temporary,'video-download-settings.png'))
}catch(error){console.error('Settings UI diagnostics:',page.url(),errors,await page.locator('body').innerText().catch(()=>'(body unavailable)'));await page.screenshot({path:path.join(temporary,'settings-failure.png')}).catch(()=>{});throw error}
finally{await close()}
