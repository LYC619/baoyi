/**
 * 模块记忆自检 —— 顶栏 Tab 切换背后那点状态，是 v0.6 Step 1 唯一会出错的地方。
 *
 *   node --experimental-strip-types --no-warnings scripts/check-module-memory.ts
 *
 * 断言失败会直接抛。要验的就三件事：Tab 亮在哪、切回来回到哪、
 * 设置页这种「不属于任何模块」的页面会不会把记忆冲掉。
 */

import assert from 'node:assert/strict'
import {
  activeModule,
  moduleOf,
  MODULE_TABS,
  moduleTarget,
  recallScroll,
  rememberScroll,
  trackRoute
} from '../src/composables/useModules.ts'

const route = (fullPath: string, module?: string) => ({ fullPath, meta: module ? { module } : {} })

// 1. 冷启动：默认停在软件库，游戏库没去过就落到它的首页
assert.equal(activeModule.value, 'software')
assert.deepEqual(moduleTarget('game'), { name: 'game-home' })
assert.deepEqual(moduleTarget('software'), { name: 'home' })

// 2. meta.module 认得出来，认不出来的老实返回 null
assert.equal(moduleOf({ module: 'game' }), 'game')
assert.equal(moduleOf({ module: 'image' }), 'image')
assert.deepEqual(moduleTarget('image'), { name: 'image-home' })
assert.equal(moduleOf({}), null)
assert.equal(moduleOf({ module: 'nope' }), null)

// 3. 在软件库深入到详情页
trackRoute(route('/detail/abc', 'software'))
assert.equal(activeModule.value, 'software')
assert.equal(moduleTarget('software'), '/detail/abc')

// 4. 切到游戏库
trackRoute(route('/game', 'game'))
assert.equal(activeModule.value, 'game')

// 5. 从游戏库进设置页 —— 设置不属于任何模块，Tab 必须还亮在「游戏」，
//    而且不许把任何一个模块的记忆冲掉
trackRoute(route('/settings'))
assert.equal(activeModule.value, 'game')
assert.equal(moduleTarget('game'), '/game')
assert.equal(moduleTarget('software'), '/detail/abc')

// 6. 切回软件库：回到刚才那个详情页，不是弹回首页
assert.equal(moduleTarget('software'), '/detail/abc')

// 7. 滚动位置各记各的
rememberScroll('software', 820)
assert.equal(recallScroll('software'), 820)
assert.equal(recallScroll('game'), 0)

// 8. 影视这一格和另两个同构 —— 新模块接进来最容易漏的就是这几处
assert.equal(moduleOf({ module: 'video' }), 'video')
assert.deepEqual(moduleTarget('video'), { name: 'video-home' })
trackRoute(route('/video/v1', 'video'))
assert.equal(activeModule.value, 'video')
assert.equal(moduleTarget('video'), '/video/v1')
// 进设置页不冲掉影视的记忆，另两个模块的也还在
trackRoute(route('/settings'))
assert.equal(activeModule.value, 'video')
assert.equal(moduleTarget('video'), '/video/v1')
assert.equal(moduleTarget('game'), '/game')
assert.equal(moduleTarget('software'), '/detail/abc')
// 滚动位置三份独立：海报墙那一屏和软件列表滚到哪儿没有关系
rememberScroll('video', 1240)
assert.equal(recallScroll('video'), 1240)
assert.equal(recallScroll('software'), 820)

// 9. 三个 Tab 的注册表本身要完整：key 不重、home 路由名不重。
//    重了的表现是「点这个 Tab 跳到了另一个模块」，而它不报错
const keys = MODULE_TABS.map((t) => t.key)
const homes = MODULE_TABS.map((t) => t.home)
assert.deepEqual(keys, ['software', 'game', 'video', 'image'], 'Tab 顺序就是顶栏从左到右的顺序')
assert.equal(new Set(keys).size, keys.length)
assert.equal(new Set(homes).size, homes.length)
for (const tab of MODULE_TABS) {
  assert.ok(tab.label.trim(), `模块 ${tab.key} 没有 Tab 文案`)
  // 每个 key 都得能被 moduleOf 认出来，否则 afterEach 那头永远记不上
  assert.equal(moduleOf({ module: tab.key }), tab.key)
}

console.log(`模块记忆自检通过：9 组 / ${MODULE_TABS.length} 个模块`)
