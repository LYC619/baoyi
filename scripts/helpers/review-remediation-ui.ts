import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

async function waitAsync(page: any, predicate: (arg: string) => Promise<boolean>, arg: string) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for asynchronous IPC condition')
}

type Capture = (name: string) => Promise<void>
const go = async (page: any, route: string) => {
  await page.evaluate((route: string) => { location.hash = route }, route)
  await page.waitForFunction(() => !document.querySelector('.page-leave-active,.page-enter-active'))
}

export async function imageOwnershipUI(app: any, page: any, capture: Capture) {
  const items = await page.evaluate(() => window.baoyi.image.list())
  const [a, b] = items.filter((item: any) => item.type === 'photo')
  await app.evaluate(({ ipcMain }: any, id: string) => {
    const original = ipcMain._invokeHandlers.get('image:get')
    const state: any = { original, released: false }; (globalThis as any).imageTest = state
    ipcMain.removeHandler('image:get')
    ipcMain.handle('image:get', async (event: any, requested: string) => {
      const value = await original(event, requested)
      if (requested === id && !state.released) await new Promise(resolve => { state.release = resolve })
      return value
    })
  }, a.id)
  try {
    await go(page, '/image/' + a.id)
    await page.getByRole('heading', { name: '正在读取资源…', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '资源不可用', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '重新扫描', exact: true }).isDisabled(), true)
    await capture('image-loading-final')
    await go(page, '/image/' + b.id)
    await page.waitForFunction((name: string) => document.querySelector<HTMLInputElement>('.detail-title')?.value === name, b.name)
    await app.evaluate(() => { const state = (globalThis as any).imageTest; state.released = true; state.release?.() })
    await page.waitForTimeout(350)
    assert.equal(await page.getByLabel('图片资源名称', { exact: true }).inputValue(), b.name)
    await page.getByLabel('图片资源名称', { exact: true }).fill('仅编辑当前相册 B')
    await page.getByRole('button', { name: '返回相册', exact: true }).focus()
    await waitAsync(page, async (id: string) => (await window.baoyi.image.get(id))?.name === '仅编辑当前相册 B', b.id)
    const saved = await page.evaluate(async (ids: string[]) => ({ A: await window.baoyi.image.get(ids[0]), B: await window.baoyi.image.get(ids[1]) }), [a.id, b.id])
    assert.equal(saved.A.name, a.name); assert.equal(saved.B.name, '仅编辑当前相册 B')
    await capture('image-owned-detail-final')
    return { routeId: b.id, unchangedA: saved.A.name, updatedB: saved.B.name }
  } finally {
    await app.evaluate(({ ipcMain }: any) => { const state = (globalThis as any).imageTest; state.released = true; state.release?.(); ipcMain.removeHandler('image:get'); ipcMain.handle('image:get', state.original) })
  }
}

export async function videoQueryUI(app: any, page: any, capture: Capture) {
  await go(page, '/video'); await page.locator('.card').nth(23).waitFor()
  await page.getByRole('button', { name: '批量管理', exact: true }).click()
  await page.locator('.card').nth(0).click(); await page.locator('.card').nth(1).click()
  await app.evaluate(({ ipcMain }: any) => {
    const original = ipcMain._invokeHandlers.get('video:list')
    const state: any = { original, mode: 'hold' }; (globalThis as any).queryTest = state
    ipcMain.removeHandler('video:list')
    ipcMain.handle('video:list', async (event: any, query: any) => {
      if (query?.keyword === '电影 02') {
        if (state.mode === 'hold') await new Promise(resolve => { state.release = resolve })
        if (state.mode === 'fail') throw new Error('synthetic-query-failure')
      }
      return original(event, query)
    })
  })
  try {
    await page.getByLabel('搜索作品、内容标题或文件名', { exact: true }).fill('电影 02')
    const all = page.getByRole('button', { name: '全选当前范围', exact: true })
    assert.equal(await all.isDisabled(), true, 'debounce window blocks selection')
    await page.waitForFunction(() => document.querySelector('.home__content')?.getAttribute('aria-busy') === 'true')
    assert.equal(await page.locator('.card').first().isDisabled(), true)
    await all.evaluate((button: HTMLButtonElement) => button.click())
    assert.match(await page.locator('.library-summary').innerText(), /已选 0/)
    await capture('video-pending-final')
    await app.evaluate(() => { const state = (globalThis as any).queryTest; state.mode = 'fail'; state.release?.() })
    await page.getByText('读取失败，刷新成功后可继续选择和操作。', { exact: false }).waitFor()
    assert.equal(await all.isDisabled(), true)
    assert.equal(await page.locator('.bulk-panel input').count(), 0)
    const before = await page.evaluate(async () => ({ A: await window.baoyi.video.get('layout-video-1'), B: await window.baoyi.video.get('layout-video-2') }))
    assert.equal(before.A.tags.includes('只应给B的标签'), false); assert.equal(before.B.tags.includes('只应给B的标签'), false)
    await capture('video-query-failed-final')
    await app.evaluate(() => { (globalThis as any).queryTest.mode = 'ready' })
    await page.getByRole('button', { name: '刷新结果', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.home__content .card').length === 1 && document.querySelector('.home__content')?.getAttribute('aria-busy') === 'false')
    await page.locator('.card').click()
    await page.getByLabel('作品标签', { exact: true }).fill('只应给B的标签')
    await page.getByRole('button', { name: '加标签', exact: true }).click()
    await page.getByText('已更新 1 部作品', { exact: true }).waitFor()
    const saved = await page.evaluate(async () => ({ A: (await window.baoyi.video.get('layout-video-1'))?.tags, B: (await window.baoyi.video.get('layout-video-2'))?.tags }))
    assert.equal(saved.A.includes('只应给B的标签'), false); assert.equal(saved.B.includes('只应给B的标签'), true)
    await capture('video-current-query-write-final')
    await page.getByRole('button', { name: '退出批量管理', exact: true }).click()
    await page.getByLabel('搜索作品、内容标题或文件名', { exact: true }).fill('')
    return saved
  } finally {
    await app.evaluate(({ ipcMain }: any) => { const state = (globalThis as any).queryTest; state.mode = 'ready'; state.release?.(); ipcMain.removeHandler('video:list'); ipcMain.handle('video:list', state.original) })
  }
}

export async function projectImportUI(app: any, page: any, root: string, capture: Capture) {
  const directory = path.join(root, '主动分析项目'); fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'README.md'), '# 主动分析项目\n仅用于本地登记和助手流程验证。')
  let calls = 0, mode = 'hold'
  const modelLog: any[] = []
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      calls++
      modelLog.push({mode, messages:JSON.parse(body).messages?.map((m:any)=>({role:m.role,content:m.content}))})
      if (mode === 'hold') return
      if (mode === 'fail') { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic-model-failure' } })); return }
      const messages = JSON.parse(body).messages || []
      const last = messages.at(-1)
      const message = last?.role === 'tool' ? { role: 'assistant', content: '建议已提出，请核对后应用。' } : { role: 'assistant', content: null, tool_calls: [{ id: 'local-proposal', type: 'function', function: { name: 'propose_project_update', arguments: JSON.stringify({ summary: '经过本地模拟分析的项目简介' }) } }] }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message, finish_reason: last?.role === 'tool' ? 'stop' : 'tool_calls' }], usage: { total_tokens: 10 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  await app.evaluate(({ dialog }: any, directory: string) => { (globalThis as any).originalPick = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, directory)
  try {
    await page.evaluate(async (port: number) => { const settings = await window.baoyi.settings.getAll(); await window.baoyi.settings.patch({ ai: { ...settings.ai, enabled: true, api_key: 'synthetic', api_url: 'http://127.0.0.1:' + port + '/v1', model: 'local-test' } }) }, port)
    await go(page, '/project')
    await page.getByRole('button', { name: '添加项目', exact: true }).first().click()
    const modal = page.getByRole('dialog', { name: '添加项目', exact: true })
    await modal.getByRole('button', { name: '导入一个项目', exact: false }).click()
    await modal.getByRole('button', { name: '导入所选项目', exact: true }).click()
    await modal.waitFor({ state: 'hidden' }); assert.equal(calls, 0, 'import never calls model')
    const item = await page.evaluate(async (directory: string) => (await window.baoyi.project.list()).find(item => item.path === directory), directory)
    assert.ok(item)
    const sessions = await page.evaluate((id: string) => window.baoyi.project.sessions(id), item.id)
    assert.equal(sessions.length, 1); assert.equal(sessions[0].title, '导入登记')
    // Duplicate import reuses the item and local registration, retaining manual state.
    await page.evaluate(async (id: string) => {
      await window.baoyi.project.update(id, { state: 'maintaining', source: 'self' })
      const preview = (await window.baoyi.project.prepareImport('single'))!
      await window.baoyi.project.confirmImport(preview.token, [{ index: 0, name: '重复扫描名称', category: preview.items[0].category, source: 'unknown' }])
    }, item.id)
    assert.equal(calls, 0)
    assert.equal((await page.evaluate((id: string) => window.baoyi.project.sessions(id), item.id)).length, 1)
    assert.equal((await page.evaluate((id: string) => window.baoyi.project.get(id), item.id)).state, 'maintaining')
    const associated=path.join(root,'关联资料');fs.mkdirSync(associated);fs.writeFileSync(path.join(associated,'README.md'),'# 关联资料')
    await app.evaluate(({dialog}:any,directory:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},associated)
    await page.evaluate(async(id:string)=>{const p=(await window.baoyi.project.prepareImport('single'))!;await window.baoyi.project.confirmImport(p.token,[{index:0,name:p.items[0].name,category:p.items[0].category,source:'unknown',existingId:id}])},item.id)
    assert.ok((await page.evaluate((id:string)=>window.baoyi.project.get(id),item.id)).entries.length>item.entries.length,'association adds entries without a duplicate project')
    const partialRoot=path.join(root,'部分登记');fs.mkdirSync(partialRoot)
    for(const name of ['成功登记','过期目标']) { const dir=path.join(partialRoot,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'README.md'),'# '+name) }
    await app.evaluate(({dialog}:any,directory:string)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},partialRoot)
    const partial=await page.evaluate(async()=>{const p=(await window.baoyi.project.prepareImport('discover'))!;return window.baoyi.project.confirmImport(p.token,p.items.slice(0,2).map((item,index)=>({index,name:item.name,category:item.category,source:'unknown',...(index===1?{existingId:'expired-target'}:{})})))})
    assert.equal(partial.imported,1);assert.equal(partial.errors.length,1);assert.match(partial.errors[0],/关联目标项目不存在/);assert.equal(calls,0)
    const added=await page.evaluate(async(root:string)=>(await window.baoyi.project.list()).filter(item=>item.path.startsWith(root)),partialRoot)
    for(const extra of added) await page.evaluate((id:string)=>window.baoyi.project.remove(id),extra.id)
    await go(page, '/project/' + item.id)
    await page.getByText('已登记，可分析', { exact: true }).waitFor(); await capture('project-local-registration-final')
    await page.getByRole('button', { name: '让助手了解项目', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    for (let i = 0; calls === 0 && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(calls > 0)
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await waitAsync(page, async (id: string) => (await window.baoyi.project.session(id))?.status === 'interrupted', sessions[0].id)
    await capture('project-analysis-stopped-final')
    mode = 'fail'
    await page.getByLabel('给项目助手发消息', { exact: true }).fill('失败后可以重试')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await waitAsync(page, async (id: string) => (async()=>{const s=await window.baoyi.project.session(id);return s?.status==='failed' && s.messages.filter(m=>m.role==='user').at(-1)?.text==='失败后可以重试'})(), sessions[0].id)
    await capture('project-analysis-failed-final')
    const failed = await page.evaluate((id:string)=>window.baoyi.project.session(id),sessions[0].id)
    assert.equal(failed.messages.at(-1).proposal,undefined,'failed response must not contain a proposal')
    mode = 'success'
    await page.getByLabel('给项目助手发消息', { exact: true }).fill('重试并提出资料建议')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '应用资料建议', exact: true }).waitFor()
    await waitAsync(page, async (id: string) => (async()=>{const s=await window.baoyi.project.session(id);return s?.status==='idle' && s.messages.filter(m=>m.role==='user').at(-1)?.text==='重试并提出资料建议'})(), sessions[0].id)
    assert.equal((await page.evaluate((id: string) => window.baoyi.project.get(id), item.id)).summary, item.summary)
    await page.getByRole('button', { name: '应用资料建议', exact: true }).click()
    await waitAsync(page, async (id: string) => (await window.baoyi.project.get(id))?.summary === '经过本地模拟分析的项目简介', item.id)
    assert.equal((await page.evaluate((id: string) => window.baoyi.project.sessions(id), item.id)).length, 1)
    await capture('project-analysis-applied-final')
    // Keep the original layout fixture count for the matrix below.
    await page.evaluate((id: string) => window.baoyi.project.remove(id), item.id)
    return { importModelCalls: 0, manualModelCalls: calls, sameSession: sessions[0].id, stopped: true, retried: true, applied: true }
  } finally {
    await page.evaluate(async () => { const settings = await window.baoyi.settings.getAll(); await window.baoyi.settings.patch({ ai: { ...settings.ai, enabled: false, api_key: '', api_url: '', model: '' } }) }).catch(() => {})
    await app.evaluate(({ dialog }: any) => { dialog.showOpenDialog = (globalThis as any).originalPick }).catch(() => {})
    fs.writeFileSync(path.join(root,'model-log.json'),JSON.stringify(modelLog,null,2))
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export async function refreshPendingUI(app: any, page: any, kind: 'image' | 'project', capture: Capture) {
  await go(page, '/' + kind)
  if (kind === 'image') await page.getByRole('button', { name: '照片', exact: true }).click()
  const entryName = kind === 'image' ? '批量整理' : '批量管理'
  await page.getByRole('button', { name: entryName, exact: true }).click()
  await page.locator(kind === 'image' ? '.shelf-select input' : '.pj-card input[type=checkbox]').first().click()
  const channel = kind + ':list'
  await app.evaluate(({ ipcMain }: any, channel: string) => {
    const original = ipcMain._invokeHandlers.get(channel), state: any = { original, fail: true }
    ;(globalThis as any).refreshTest = state
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event: any, ...args: any[]) => {
      await new Promise(resolve => { state.release = resolve })
      if (state.fail) throw new Error('synthetic-list-refresh-failure')
      return original(event, ...args)
    })
  }, channel)
  try {
    if (kind === 'project') await page.getByRole('button', { name: '刷新项目', exact: true }).click()
    else await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].webContents.send('image:changed'))
    const panel = kind === 'image' ? '.image-bulk-panel' : '.library-bulk'
    await page.waitForFunction((panel: string) => !!document.querySelector(panel + ' fieldset:disabled'), panel)
    const exit = page.getByRole('button', { name: kind === 'image' ? '批量整理' : '退出批量管理', exact: true })
    assert.equal(await exit.isEnabled(), true, 'refresh never traps selection mode')
    const clear = page.getByRole('button', { name: '清空选择', exact: true })
    assert.equal(await clear.isEnabled(), true); await clear.click(); await exit.click()
    await app.evaluate(() => (globalThis as any).refreshTest.release?.())
    await page.getByText(/synthetic-list-refresh-failure/).first().waitFor()
    await capture(kind + '-refresh-failed-final')
  } finally {
    await app.evaluate(({ ipcMain }: any, channel: string) => { const state = (globalThis as any).refreshTest; state.fail = false; state.release?.(); ipcMain.removeHandler(channel); ipcMain.handle(channel, state.original) }, channel)
  }
  const error = page.locator(kind === 'image' ? '.image-content > .im-error' : '.pj-content > .pj-error')
  await error.getByRole('button', { name: '重试', exact: true }).click()
  await error.waitFor({ state: 'hidden' })
}
