import { createRouter, createWebHashHistory } from 'vue-router'
import { useSettingsStore } from '@/stores/settings'

const router = createRouter({
  // 生产环境走 file:// 加载，必须用 hash 路由
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/pages/software/Home.vue')
    },
    {
      path: '/detail/:id',
      name: 'detail',
      component: () => import('@/pages/software/Detail.vue'),
      props: true
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/Settings.vue')
    },
    {
      path: '/confirm',
      name: 'confirm',
      component: () => import('@/pages/software/Confirm.vue')
    },
    {
      path: '/organize',
      name: 'organize',
      component: () => import('@/pages/software/Organize.vue')
    },
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/pages/Onboarding.vue')
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

router.beforeEach((to) => {
  const settings = useSettingsStore()
  if (!settings.loaded) return true
  const onboarded = settings.settings.onboarded

  if (!onboarded && to.name !== 'onboarding') return { name: 'onboarding' }
  if (onboarded && to.name === 'onboarding') return { name: 'home' }
  return true
})

export default router
