import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useCategoriesStore } from './stores/categories'
import { useSettingsStore } from './stores/settings'
import './styles/global.scss'

async function boot(): Promise<void> {
  const app = createApp(App)
  app.use(createPinia())

  // 先把设置和分类读出来，路由守卫要靠 onboarded 判断首启
  const settings = useSettingsStore()
  const categories = useCategoriesStore()
  await Promise.all([settings.load(), categories.load()])

  app.use(router)
  await router.isReady()
  app.mount('#app')
}

void boot()

