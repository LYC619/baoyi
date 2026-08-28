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

console.log('模块记忆自检通过：7 组')
