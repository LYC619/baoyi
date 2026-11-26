<script setup lang="ts">
import { tr } from "../../../i18n/index.ts"

import { computed, ref } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import type { SearchProvider } from '@/types'

const settings = useSettingsStore()

const { success } = useToast()

/* ---------------------------- 网络搜索配置 ---------------------------- */

const PROVIDERS: Array<{ value: SearchProvider; label: string; hint: string }> = [
  {
    value: 'model_builtin',
    get label() { return tr("不额外联网（默认）") },
    get hint() { return tr("仅依据本地文件信息与模型自身知识判断，不消耗任何搜索额度。") }
  },
  {
    value: 'tavily',
    label: 'Tavily',
    get hint() { return tr("适合自动识别检索，返回结构化摘要。免费额度每月 1000 次。") }
  },
  {
    value: 'exa',
    label: 'Exa',
    get hint() { return tr("语义搜索，适合「这个 exe 是什么软件」这类模糊查询。") }
  },
  {
    value: 'firecrawl',
    label: 'Firecrawl',
    get hint() { return tr("搜索 + 网页抓取，能读进官网正文。免费额度每月 500 次。") }
  },
  {
    value: 'bing',
    label: 'Bing Web Search',
    get hint() { return tr("微软官方接口。注意该服务已进入退役流程，新账号可能申请不到 Key。") }
  },
  {
    value: 'searxng',
    get label() { return tr("SearXNG（自建）") },
    get hint() { return tr("自建搜索聚合，完全免费。需要填写你的实例地址。") }
  }
]

const searchProvider = ref<SearchProvider>(settings.settings.search.provider)

const searchKey = ref(settings.settings.search.api_key)

const searchEndpoint = ref(settings.settings.search.endpoint)

const searchEnabled = ref(settings.settings.search.enabled)

const searchTesting = ref(false)

const searchResult = ref<{ ok: boolean; message: string } | null>(null)

const providerHint = computed(
  () => PROVIDERS.find((p) => p.value === searchProvider.value)?.hint ?? ''
)

const needsKey = computed(
  () => searchProvider.value !== 'model_builtin' && searchProvider.value !== 'searxng'
)

const needsEndpoint = computed(
  () => searchProvider.value === 'searxng' || searchProvider.value === 'bing'
)

/** 一份搜索配置够不够真的发出一次搜索（不看 enabled）。和主进程 searchAvailable 同一条判据 */
function usable(cfg: { provider: SearchProvider; api_key: string; endpoint: string }): boolean {
  if (cfg.provider === 'model_builtin') return false
  if (cfg.provider === 'searxng') return cfg.endpoint.trim().length > 0
  return cfg.api_key.trim().length > 0
}

const searchUsable = computed(() =>
  usable({
    provider: searchProvider.value,
    api_key: searchKey.value,
    endpoint: searchEndpoint.value
  })
)

const switchHint = computed(() => {
  if (searchProvider.value === 'model_builtin') return tr('当前服务商本来就不联网，无需开关')
  if (searchUsable.value) return ''
  return searchProvider.value === 'searxng' ? tr('请先填入实例地址') : tr('请先填入 API Key')
})

function currentSearchConfig() {
  return {
    provider: searchProvider.value,
    api_key: searchKey.value.trim(),
    endpoint: searchEndpoint.value.trim(),
    // 配置不完整时不许它是开着的：开着但没 Key，agent 那边照样拿不到工具，
    // 而用户看着开关是开的，只会以为搜索在工作
    enabled: searchEnabled.value && searchUsable.value
  }
}

/**
 * 保存搜索配置。
 *
 * 从「配置不全」变成「配置齐了」时顺手把开关打开 —— 0.4 之前这两件事是分开的，
 * 于是出现过「Key 填了、开关没开」这种状态：主进程照 enabled 判断，不注册
 * web_search 工具，而提示词还在教模型去搜，白烧轮数，冷门软件（cc-gui、Kelivo）
 * 直接认不出来。用户填 Key 的意图就是要用搜索，没有第二种解释。
 *
 * 只在这个**跨越**上自动开，不是「只要 Key 有效就开」—— 后者会把用户刚刚
 * 主动关掉的开关又扳回去（开关本身是即时落盘的，见 toggleSearch）。
 */
async function saveSearch(): Promise<void> {
  const autoOn = !usable(settings.settings.search) && searchUsable.value && !searchEnabled.value
  if (autoOn) searchEnabled.value = true
  await settings.patch({ search: currentSearchConfig() })
  success(autoOn ? tr("搜索配置已保存，并已自动启用") : tr("搜索配置已保存"))
}

/** 开关自己改动时也要落盘，否则关掉之后不重启就还是开着的 */
async function toggleSearch(): Promise<void> {
  if (!searchUsable.value) {
    searchEnabled.value = false
    return
  }
  await settings.patch({ search: currentSearchConfig() })
}

async function testSearchConn(): Promise<void> {
  searchTesting.value = true
  searchResult.value = null
  try {
    searchResult.value = await window.baoyi.ai.testSearch(currentSearchConfig())
  } finally {
    searchTesting.value = false
  }
}
</script>

<template>
<section class="panel">
  <div class="sec-head">
    <h2>{{ $t("联网搜索") }}</h2>
    <label class="switch" :class="{ 'switch--off': !searchUsable }" :title="switchHint">
      <input
        v-model="searchEnabled"
        type="checkbox"
        :disabled="!searchUsable"
        @change="toggleSearch"
      />
      <span>{{ searchEnabled && searchUsable ? $t('已启用') : $t('已关闭') }}</span>
    </label>
  </div>
  <p class="sec-desc">{{ $t("AI 识别软件、游戏或影视时，可使用联网搜索查证本地资料中没有的信息。 这些配置在支持联网搜索的模块间共用；影视的 TMDB 资料源在“影视刮削”中单独设置。") }}</p>
  <p v-if="switchHint" class="hint hint--block">{{ switchHint }}。</p>

  <div class="form">
    <label class="field">
      <span class="field__label">{{ $t("服务商") }}</span>
      <select v-model="searchProvider" class="input">
        <option v-for="p in PROVIDERS" :key="p.value" :value="p.value">{{ p.label }}</option>
      </select>
    </label>
    <p class="provider-hint">{{ providerHint }}</p>

    <label v-if="needsKey" class="field">
      <span class="field__label">API Key</span>
      <input v-model="searchKey" class="input mono" type="password" :placeholder="$t('填入对应服务的 Key')" />
    </label>
    <label v-if="needsEndpoint" class="field">
      <span class="field__label">
        {{ searchProvider === 'searxng' ? $t('实例地址') : $t('接口地址（可留空用官方）') }}
      </span>
      <input
        v-model="searchEndpoint"
        class="input mono"
        :placeholder="searchProvider === 'searxng' ? 'http://127.0.0.1:8080' : 'https://api.bing.microsoft.com/v7.0/search'"
      />
    </label>
  </div>

  <div class="row">
    <button class="btn btn--primary" @click="saveSearch">{{ $t("保存配置") }}</button>
    <button
      class="btn btn--ghost"
      :disabled="searchTesting || searchProvider === 'model_builtin'"
      @click="testSearchConn"
    >
      <Loader2 v-if="searchTesting" :size="14" class="spin" />{{ $t("测试搜索") }}</button>
  </div>

  <p v-if="searchResult" class="result" :class="{ 'result--bad': !searchResult.ok }">
    {{ $systemMessage(searchResult.message) }}
  </p>

  <p class="sec-desc sec-desc--foot">{{ $t("优先使用本地信息，必要时才搜索。关闭后，识别过程中不会调用联网搜索服务。 调用详情可在顶部“日志”的“识别与调用”中查看。") }}</p>
</section>
</template>

<style scoped src="../settings.css"></style>
