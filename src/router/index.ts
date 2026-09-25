import { createRouter, createWebHashHistory } from 'vue-router'
import { useSettingsStore } from '@/stores/settings'
import { trackRoute } from '@/composables/useModules'

const router = createRouter({
  // 生产环境走 file:// 加载，必须用 hash 路由
  history: createWebHashHistory(),
  routes: [
    // meta.module 决定顶栏哪个 Tab 亮着，也是「切回来回到原位」的记账依据。
    // 设置页和引导页刻意不标：它们不属于任何模块，进去时 Tab 应该保持原样。
    {
      path: '/',
      name: 'home',
      component: () => import('@/pages/software/Home.vue'),
      meta: { module: 'software' }
    },
    {
      path: '/detail/:id',
      name: 'detail',
      component: () => import('@/pages/software/Detail.vue'),
      props: true,
      meta: { module: 'software' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/Settings.vue')
    },
    {
      path: '/confirm',
      name: 'confirm',
      component: () => import('@/pages/software/Confirm.vue'),
      meta: { module: 'software' }
    },
    {
      path: '/organize',
      name: 'organize',
      component: () => import('@/pages/software/Organize.vue'),
      meta: { module: 'software' }
    },
    {
      path: '/game',
      name: 'game-home',
      component: () => import('@/pages/game/Home.vue'),
      meta: { module: 'game' }
    },
    {
      path: '/game/:id',
      name: 'game-detail',
      component: () => import('@/pages/game/Detail.vue'),
      props: true,
      meta: { module: 'game' }
    },
    {
      path: '/video',
      name: 'video-home',
      component: () => import('@/pages/video/Home.vue'),
      meta: { module: 'video' }
    },
    {
      path: '/video/:id',
      name: 'video-detail',
      component: () => import('@/pages/video/Detail.vue'),
      props: true,
      meta: { module: 'video' }
    },
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/pages/Onboarding.vue')
    },
    { path: '/image', name: 'image-home', component: () => import('@/pages/image/Home.vue'), meta: { module: 'image' } },
    { path: '/image/:id', name: 'image-detail', component: () => import('@/pages/image/Detail.vue'), props: true, meta: { module: 'image' } },
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

// 记在 afterEach 而不是 beforeEach：被 onboarding 拦下来的那次跳转不算「去过」
router.afterEach((to) => trackRoute(to))

export default router
