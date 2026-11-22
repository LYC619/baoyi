import { _electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/storage/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { SkillProfiles } from '../electron/workspace/skill-profiles.ts'
import { VIDEO_JOBS_SQL } from '../electron/kinds/video/download/jobs.ts'

const output = path.resolve('output/personal-revision')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-'))
const db = new DatabaseSync(path.join(profile, 'baoyi.db'))
initSchema(db, KINDS); db.exec(VIDEO_JOBS_SQL)
for (const [key,value] of Object.entries({onboarded:true,theme:'light',hanime_builtin_hosts:false})) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value))
new SkillProfiles(db).propose({name:'跑步',summary:'每周进行跑步训练',metrics:[{key:'10k',label:'10 公里用时',unit:'分钟',type:'number'}]})
db.close()
const env:Record<string,string> = Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const app = await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),'--user-data-dir='+profile,'--disable-gpu'],env})
const page = await app.firstWindow(), errors:string[] = []
page.on('pageerror', e=>errors.push(e.message)); page.setDefaultTimeout(15000)
try {
  await page.waitForFunction(()=>!!window.baoyi?.workspace)
  await page.evaluate(()=>{location.hash='/personal'})
  await page.getByRole('button',{name:'编辑个人信息'}).click()
  assert.equal(await page.getByText('补充记录',{exact:true}).count(),0)
  await page.getByLabel('称呼',{exact:true}).fill('实测用户')
  await page.getByRole('button',{name:'保存个人记录'}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByRole('button',{name:'背包',exact:true}).click()
  await page.getByRole('button',{name:'添加背包',exact:true}).click()
  await page.getByLabel('名称',{exact:true}).fill('护照')
  await page.getByLabel('币种',{exact:true}).fill('人民币')
  await page.getByRole('button',{name:'保存个人记录'}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  const asset = (await page.evaluate(()=>window.baoyi.workspace.personal.list('asset')))[0]
  assert.equal(asset.data.cost,undefined);assert.equal(asset.data.currency,'CNY')
  await page.getByRole('button',{name:'返回背包列表',exact:true}).click()
  await page.getByLabel('搜索背包',{exact:true}).fill('不存在')
  assert.equal(await page.locator('.asset-card').count(),0)
  await page.getByLabel('搜索背包',{exact:true}).fill('护照')
  assert.equal(await page.locator('.asset-card').count(),1)
  for (const width of [800,960,1280]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width)
    await page.screenshot({path:path.join(output,`asset-${width}.png`)})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  }
  await page.getByRole('button',{name:'技能',exact:true}).click()
  await page.getByRole('button',{name:'确认录入',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.skill-card').length===1)
  assert.equal((await page.evaluate(()=>window.baoyi.workspace.skills.list()))[0].name,'跑步')
  await page.getByRole('button',{name:'状态',exact:true}).click()
  await page.getByRole('textbox',{name:'快捷状态名称'}).fill('体重')
  await page.getByRole('textbox',{name:'快捷状态单位'}).fill('kg')
  await page.getByRole('spinbutton',{name:'快捷状态数值'}).fill('70')
  await page.locator('.state-capture').getByRole('button',{name:'记录状态',exact:true}).click()
  await page.waitForFunction(()=>!!document.querySelector('.metric-trend'))
  assert.equal((await page.evaluate(()=>window.baoyi.workspace.personal.list('measurement')))[0].data.value,70)
  await page.screenshot({path:path.join(output,'state.png')})
  await page.getByRole('button',{name:'总览',exact:true}).click()
  await page.getByRole('button',{name:'编辑个人信息'}).click()
  const avatarSource=path.join(profile,'avatar-source.png');fs.copyFileSync(path.join(output,'asset-800.png'),avatarSource)
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},avatarSource)
  await page.getByRole('button',{name:'选择头像',exact:true}).click()
  await page.getByAltText('头像预览').waitFor()
  await page.getByRole('button',{name:'保存个人记录'}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  fs.unlinkSync(avatarSource)
  await page.reload();await page.getByAltText('个人头像').waitFor()
  assert.equal(await page.getByAltText('个人头像').evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth===256),true)
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark'})
  await page.screenshot({path:path.join(output,'overview-dark.png')})
  assert.deepEqual(errors,[])
  console.log('PASS asset capture/search, skill confirmation, state capture, avatar persistence, 800/960/1280 and dark theme')
} finally { await app.close() }
