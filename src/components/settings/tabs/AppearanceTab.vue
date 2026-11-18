<script setup lang="ts">
import { computed, ref } from 'vue'
import { Moon, Sun } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import type { TitleLang } from '@/types'

const settings = useSettingsStore()

const store = useSoftwareStore()

const unusedDays = ref(settings.settings.unused_days)

/* -------------------------------- 外观 -------------------------------- */

const TITLE_LANGS: Array<{ value: TitleLang; label: string; hint: string }> = [
  { value: 'zh', label: '中文名为主', hint: '标题显示中文名，英文原名作副标题' },
  { value: 'en', label: '英文原名为主', hint: '标题显示 Process Monitor 这类官方原名，中文名作副标题' }
]

const titleLangHint = computed(
  () => TITLE_LANGS.find((t) => t.value === settings.settings.title_lang)?.hint ?? ''
)

async function setTitleLang(e: Event): Promise<void> {
  await settings.patch({ title_lang: (e.target as HTMLSelectElement).value as TitleLang })
}

async function setUnusedDays(): Promise<void> {
  const value = Math.max(7, Math.min(365, Math.round(unusedDays.value) || 60))
  unusedDays.value = value
  await settings.patch({ unused_days: value })
  await store.refreshCounts()
}
</script>

<template>
<section class="panel">
  <h2 class="sec-head">主题</h2>
  <div class="row">
    <div class="segmented">
      <button
        :class="{ on: settings.settings.theme === 'dark' }"
        @click="settings.patch({ theme: 'dark' })"
      >
        <Moon :size="14" />
        深色
      </button>
      <button
        :class="{ on: settings.settings.theme === 'light' }"
        @click="settings.patch({ theme: 'light' })"
      >
        <Sun :size="14" />
        浅色
      </button>
    </div>
  </div>
</section>

<section class="panel">
  <h2 class="sec-head">卡片标题</h2>
  <p class="sec-desc">
    Process Monitor、PowerRun 这类软件本来就没有通行中文名，AI 硬译出来的
    「进程监视器」反而比原名难认。选哪个名字打头由你定，另一个降为副标题。
  </p>
  <div class="form">
    <label class="field">
      <span class="field__label">标题优先</span>
      <select :value="settings.settings.title_lang" class="input" @change="setTitleLang">
        <option v-for="t in TITLE_LANGS" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
    </label>
    <p class="provider-hint">{{ titleLangHint }}</p>
  </div>
</section>

<section class="panel">
  <h2 class="sec-head">精简提醒</h2>
  <p class="sec-desc">
    超过设定天数没有动静的软件会被归入「长期未用」，辅助你审视是否还需要它。
    判定不只看你通过抱一启动的记录 —— 抱一还会读软件目录里配置文件的最后修改时间，
    所以刚导入的库不会整片显示成「从未使用」。卡片上实心点是抱一记到的启动，
    空心点是这种从磁盘推出来的近似时间。
  </p>
  <div class="row">
    <input
      v-model.number="unusedDays"
      class="input input--num"
      type="number"
      min="7"
      max="365"
      @blur="setUnusedDays"
    />
    <span class="hint">天</span>
    <span class="hint">当前有 {{ store.counts.unused }} 个软件超期</span>
  </div>
</section>
</template>

<style scoped src="../settings.css"></style>
