<script setup lang="ts">
import { ref } from 'vue'
import { activeModule } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useVideoStore } from '@/stores/video'

const settings = useSettingsStore()

// 「隐藏里番」的开关要在设置页里当场让影视那边重查，所以这儿得拿到它的 store
const video = useVideoStore()

const { success } = useToast()

/* ------------------------------ 隐藏里番 ------------------------------ */

const hideHentai = ref(settings.settings.hide_hentai)

/**
 * 即时落盘 + 立刻让影视那边重查。
 *
 * `video.reload()` 这一下是必需的：判据在主进程的查询层，而渲染进程手上是
 * 上一次查回来的 `items` 和 `counts`。不重查的话开关扳完**界面一点变化都没有**，
 * 要等下次进影视页才生效 —— 那看起来就是开关坏了。
 *
 * 之后再看选中项还在不在：用户可能正停在里番那一格上，而那一格马上就没了，
 * 留在原地会得到一面空墙配一个「里番」的标题。
 *
 * 判据是「刷新后的 counts 里还有没有这个分类」，而不是拿分类名去比 ——
 * 渲染进程**不 import `electron/`** 下的任何东西（那条边界全项目都守着），
 * 所以这里没有 `HENTAI_CATEGORY` 这个常量可用。照计数判反而更通用：
 * 任何一个分类因为任何原因消失了，都会被拨回「全部」。
 */
async function toggleHideHentai(): Promise<void> {
  await settings.patch({ hide_hentai: hideHentai.value })
  await video.reload()
  const sel = video.selection
  if (sel.kind === 'category' && !video.counts.categories.some((c) => c.name === sel.value)) {
    video.select({ kind: 'group', value: 'all' })
  }
  success(hideHentai.value ? '里番已隐藏' : '里番已恢复显示')
}
</script>

<template>
<section v-if="activeModule === 'video'" class="panel">
  <div class="sec-head">
    <h2>隐藏里番</h2>
    <label class="switch">
      <input v-model="hideHentai" type="checkbox" @change="toggleHideHentai" />
      <span>{{ hideHentai ? '已隐藏' : '正常显示' }}</span>
    </label>
  </div>
  <p class="sec-desc">
    打开后影视侧边栏不再出现「里番」这一格，海报墙也不铺这些条目，
    侧栏的类型、标签、归档几处计数都不把它们算进去。
  </p>

  <!--
    边界要写明白，否则它很容易被当成锁用。藏起来的是「浏览时看不见」，
    不是「访问不到」—— 说清楚比让用户自己发现要好
  -->
  <p class="sec-desc sec-desc--foot">
    它只管显示：条目、文件和海报都原样留着，关掉开关立刻回来，
    不改任何数据。设置页这边「影视条目」的总数仍是全库的数字，
    已经打开过的详情页地址也照样能打开。
  </p>
</section>
</template>

<style scoped src="../settings.css"></style>
