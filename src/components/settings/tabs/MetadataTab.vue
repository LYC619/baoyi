<script setup lang="ts">
import { tr } from '../../../i18n/index.ts'

import { computed, ref } from 'vue'
import { activeModule } from '@/composables/useModules'
import { Loader2 } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import type { TmdbConfig } from '@/types'

const settings = useSettingsStore()

const { success } = useToast()

/* ---------------------------- TMDB 刮削配置 ---------------------------- */


const tmdbKey = ref(settings.settings.tmdb.api_key)

const tmdbApiDomain = ref(settings.settings.tmdb.api_domain)

const tmdbImageDomain = ref(settings.settings.tmdb.image_domain)

const tmdbEnabled = ref(settings.settings.tmdb.enabled)

const tmdbTesting = ref(false)

const tmdbResult = ref<{ ok: boolean; message: string } | null>(null)

/** 够不够真的发出一次请求（不看 enabled）。和主进程 tmdbAvailable 同一条判据 */
const tmdbUsable = computed(() => tmdbKey.value.trim().length > 0)

function currentTmdbConfig(): TmdbConfig {
  return {
    api_key: tmdbKey.value.trim(),
    api_domain: tmdbApiDomain.value.trim(),
    image_domain: tmdbImageDomain.value.trim(),
    // 没 Key 不许是开着的，同搜索那边：开关开着而主进程判定不可用，
    // 用户只会以为刮削在工作
    enabled: tmdbEnabled.value && tmdbUsable.value
  }
}

/** 从「没 Key」跨到「有 Key」时顺手打开。理由和 saveSearch 一字不差 */
async function saveTmdb(): Promise<void> {
  const autoOn = !settings.settings.tmdb.api_key.trim() && tmdbUsable.value && !tmdbEnabled.value
  if (autoOn) tmdbEnabled.value = true
  await settings.patch({ tmdb: currentTmdbConfig() })
  success(autoOn ? tr("TMDB 配置已保存，并已自动启用") : tr("TMDB 配置已保存"))
}

async function toggleTmdb(): Promise<void> {
  if (!tmdbUsable.value) {
    tmdbEnabled.value = false
    return
  }
  await settings.patch({ tmdb: currentTmdbConfig() })
}

async function testTmdbConn(): Promise<void> {
  tmdbTesting.value = true
  tmdbResult.value = null
  try {
    tmdbResult.value = await window.baoyi.ai.testTmdb(currentTmdbConfig())
  } finally {
    tmdbTesting.value = false
  }
}
</script>

<template>
<!-- TMDB 用于影视资料补全；首轮本地入库不依赖它。 -->
<section v-if="activeModule === 'video'" class="panel">
  <div class="sec-head">
    <h2>{{ $t("TMDB 刮削（影视）") }}</h2>
    <label
      class="switch"
      :class="{ 'switch--off': !tmdbUsable }"
      :title="tmdbUsable ? '' : $t('请先填入 API Key')"
    >
      <input
        v-model="tmdbEnabled"
        type="checkbox"
        :disabled="!tmdbUsable"
        @change="toggleTmdb"
      />
      <span>{{ tmdbEnabled && tmdbUsable ? $t('已启用') : $t('已关闭') }}</span>
    </label>
  </div>
  <p class="sec-desc">{{ $t("用于补全影视条目的官方标题、简介、评分、海报和季集表。 个人 Key 是免费的，在 themoviedb.org 注册后于「设置 › API」页面申领。 本地扫描不需要填写 Key，已有的 NFO、下载器资料和图片会直接保留。") }}</p>
  <p v-if="!tmdbUsable" class="hint hint--block">{{ $t("请先填入 API Key。") }}</p>

  <div class="form">
    <label class="field">
      <span class="field__label">API Key</span>
      <input
        v-model="tmdbKey"
        class="input mono"
        type="password"
        :placeholder="$t('TMDB 的 API Key（v3 auth）')"
      />
    </label>
    <!--
      两个域名单独给，不合成一个：接口和图片走的是不同的主机，
      而国内的反代方案常常只代理其中一个
    -->
    <label class="field">
      <span class="field__label">{{ $t("接口域名（可留空用官方）") }}</span>
      <input v-model="tmdbApiDomain" class="input mono" placeholder="api.themoviedb.org" />
    </label>
    <label class="field">
      <span class="field__label">{{ $t("图片域名（可留空用官方）") }}</span>
      <input v-model="tmdbImageDomain" class="input mono" placeholder="image.tmdb.org" />
    </label>
  </div>

  <div class="row">
    <button class="btn btn--primary" @click="saveTmdb">{{ $t("保存配置") }}</button>
    <button class="btn btn--ghost" :disabled="tmdbTesting || !tmdbUsable" @click="testTmdbConn">
      <Loader2 v-if="tmdbTesting" :size="14" class="spin" />{{ $t("测试连接") }}</button>
  </div>

  <p v-if="tmdbResult" class="result" :class="{ 'result--bad': !tmdbResult.ok }">
    {{ $systemMessage(tmdbResult.message) }}
  </p>

  <p class="sec-desc sec-desc--foot">{{ $t("两个地址都只填域名，不带") }}<span class="mono">https://</span>{{ $t("和路径。 官方的") }}<span class="mono">api.themoviedb.org</span>{{ $t("在国内多数网络下连不上， 填自己的反代能解决；海报下载只允许走这里填的图片域名，别处的地址一概不收。") }}</p>
</section>
</template>

<style scoped src="../settings.css"></style>
