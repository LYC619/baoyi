import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { errorMessage } from './utils'
import { useCategoriesStore } from './stores/categories'
import { useSettingsStore } from './stores/settings'
import { useVideoStore } from './stores/video'
import { useVideoWorkflow } from './composables/useVideoWorkflow'
import { useToast } from './composables/useToast'
import './styles/global.scss'

async function boot(): Promise<void> {
  try {
    const app = createApp(App)
    app.use(createPinia())

    // 先把设置和分类读出来，路由守卫要靠 onboarded 判断首启
    const settings = useSettingsStore()
    const categories = useCategoriesStore()
    await Promise.all([settings.load(), categories.load()])

    app.use(router)
    await router.isReady()
    app.mount('#app')
    window.baoyi.hanimeBrowser?.onDownload(url => {
      if (settings.settings.hide_hentai) return
      void (async () => {
        const workflow = useVideoWorkflow()
        workflow.url.value = url
        workflow.open.value = true
        useVideoStore().select({ kind:'type',value:'hentai' })
        await router.push({ name:'video-home' })
        await workflow.prepare()
      })().catch(cause => useToast().error('打开下载预览失败：' + errorMessage(cause)))
    })
  } catch (err) {
    showBootError(err)
  }
}

/**
 * 启动兜底。数据库损坏、IPC 抛错都会卡在 mount 之前 —— 不接住的话用户看到的
 * 就是无任何提示的空白窗口，连「坏了」都看不出来。这里直接往 #app 写 DOM，
 * 不依赖 Vue：正是要防「Vue 自己都起不来」的那种失败。样式走内联，同一个理由。
 */
function showBootError(err: unknown): void {
  const root = document.getElementById('app')
  if (!root) return
  const detail = errorMessage(err).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )
  root.innerHTML = `
    <div style="height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:12px;padding:32px;background:#1E1E2E;color:#CDD6F4;font-family:inherit;text-align:center;">
      <h1 style="font-size:22px;font-weight:500;margin:0;">抱一没能启动</h1>
      <p style="margin:0;color:#A6ADC8;">读取本地数据时出错：</p>
      <pre style="max-width:640px;margin:0;padding:12px 16px;border-radius:8px;background:#181825;color:#F38BA8;font-size:12px;white-space:pre-wrap;word-break:break-all;text-align:left;">${detail}</pre>
      <p style="margin:0;color:#A6ADC8;">数据文件在 %APPDATA%\\抱一\\baoyi.db，本次启动没有改动它。修好或恢复后重来。</p>
      <button onclick="location.reload()" style="margin-top:8px;height:36px;padding:0 20px;border:none;border-radius:8px;background:#7C6AF6;color:#fff;font-size:14px;cursor:pointer;">重试</button>
    </div>`
}

void boot()
