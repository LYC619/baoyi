
import { showBootError } from "./boot-error"
import { applyLanguage, installI18n, tr } from './i18n'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { errorMessage } from './utils'
import { useCategoriesStore } from './stores/categories'
import { useSettingsStore } from './stores/settings'
import { useVideoStore } from './stores/video'
import { useVideoWorkflow } from './composables/useVideoWorkflow'
import { pendingDiscoveryDownload, pendingWebAddress } from './composables/useVideoDiscovery'
import { useToast } from './composables/useToast'
import './styles/global.scss'

const recentErrors = new Map<string, number>()
function reportError(err: unknown): void {
  console.error(err)
  const message = errorMessage(err)
  const now = Date.now()
  for (const [text, time] of recentErrors) {
    if (now - time >= 3000) recentErrors.delete(text)
  }
  if (recentErrors.has(message)) return
  recentErrors.set(message, now)
  useToast().error(message)
}

async function boot(): Promise<void> {
  applyLanguage('system')
  try {
    const app = createApp(App)
    installI18n(app)
    app.config.errorHandler = reportError
    window.addEventListener('unhandledrejection', event => reportError(event.reason))
    app.use(createPinia())

    // 先把设置和分类读出来，路由守卫要靠 onboarded 判断首启
    const settings = useSettingsStore()
    const categories = useCategoriesStore()
    await Promise.all([settings.load(), categories.load()])

    app.use(router)
    await router.isReady()
    app.mount('#app')
    window.baoyi.video.discovery?.onDownload(selection => {
      pendingDiscoveryDownload.value = selection
      void router.push({ name: 'video-discover' }).catch(cause => useToast().error(errorMessage(cause)))
    })
    window.baoyi.video.discovery?.web?.onEdit(url => {
      pendingWebAddress.value = url
      void router.push({ name: 'video-discover' }).catch(cause => useToast().error(errorMessage(cause)))
    })
    window.baoyi.hanimeBrowser?.onDownload(url => {
      if (settings.settings.hide_hentai) return
      void (async () => {
        const workflow = useVideoWorkflow()
        workflow.url.value = url
        workflow.open.value = true
        useVideoStore().select({ kind:'type',value:'hentai' })
        await router.push({ name:'video-home' })
        await workflow.prepare()
      })().catch(cause => useToast().error(tr("打开下载预览失败：") + errorMessage(cause)))
    })
  } catch (err) {
    showBootError(err)
  }
}

void boot()
