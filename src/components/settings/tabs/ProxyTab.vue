<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import OnlineSourceSettings from '@/components/settings/OnlineSourceSettings.vue'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { errorMessage } from '@/utils'
import { parseProxyInput, serializeProxyInput, type ProxyInput } from '../../../../electron/services/network/proxy-rules'

const settings = useSettingsStore()
const { success, error } = useToast()

type ProxyMode = ProxyInput['mode']

const proxyMode = ref<ProxyMode>('direct')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref(10808)
const proxyRules = ref(settings.settings.proxy)
const proxyChecking = ref(false)
const proxyResult = ref<{ ok: boolean; message: string } | null>(null)

function loadProxyForm(raw: string): void {
  proxyRules.value = raw
  try {
    const parsed = parseProxyInput(raw)
    proxyMode.value = parsed.mode
    if (parsed.mode === 'http' || parsed.mode === 'socks5') {
      proxyHost.value = parsed.host
      proxyPort.value = parsed.port
    }
  } catch {
    proxyMode.value = 'custom'
  }
}

async function saveProxy(): Promise<void> {
  let input: ProxyInput
  if (proxyMode.value === 'direct') input = { mode: 'direct' }
  else if (proxyMode.value === 'system') input = { mode: 'system' }
  else if (proxyMode.value === 'custom') {
    const raw = proxyRules.value.trim()
    if (!raw) {
      error('自定义代理规则不能为空')
      return
    }
    try {
      input = parseProxyInput(raw)
    } catch (err) {
      error(errorMessage(err))
      return
    }
  } else {
    const host = proxyHost.value.trim()
    const port = Number(proxyPort.value)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      error('请输入有效的代理主机和端口（1-65535）')
      return
    }
    input = { mode: proxyMode.value, host, port }
  }

  const serialized = serializeProxyInput(input)
  await settings.patch({ proxy: serialized })
  proxyRules.value = serialized
  success(input.mode === 'direct' ? '已切回直连' : '代理配置已保存')
  await checkProxy()
}

async function checkProxy(): Promise<void> {
  proxyChecking.value = true
  try {
    const s = await window.baoyi.settings.proxyStatus()
    const rules = s.rules === '' ? '（直连）' : s.rules
    proxyResult.value = {
      ok: true,
      message: `当前规则：${rules}　·　实际出口：${s.resolved}`
    }
  } catch (err) {
    proxyResult.value = { ok: false, message: `查询代理状态失败：${errorMessage(err)}` }
  } finally {
    proxyChecking.value = false
  }
}

loadProxyForm(settings.settings.proxy)
watch(() => settings.settings.proxy, loadProxyForm)
onMounted(() => {
  void checkProxy()
})
</script>

<template>
  <section class="panel">
    <div class="sec-head">
      <h2>应用出站代理</h2>
    </div>
    <p class="sec-desc">
      供在线漫画（哔咔 / JM 选择「沿用抱一代理」时）与 Hanime 专用会话共用。保存后新发起的连接立即生效，本机回环地址不经过代理。
    </p>

    <div class="form">
      <label class="field">
        <span class="field__label">代理模式</span>
        <select v-model="proxyMode" class="input">
          <option value="direct">直连</option>
          <option value="system">跟随系统代理</option>
          <option value="http">HTTP 代理</option>
          <option value="socks5">SOCKS5 代理</option>
          <option value="custom">自定义规则</option>
        </select>
      </label>
      <div v-if="proxyMode === 'http' || proxyMode === 'socks5'" class="row">
        <label class="field field--grow">
          <span class="field__label">代理主机</span>
          <input
            v-model="proxyHost"
            class="input mono"
            placeholder="127.0.0.1"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
          />
        </label>
        <label class="field">
          <span class="field__label">端口</span>
          <input v-model.number="proxyPort" class="input input--num mono" type="number" min="1" max="65535" />
        </label>
      </div>
      <label v-if="proxyMode === 'custom'" class="field">
        <span class="field__label">Chromium 代理规则</span>
        <input
          v-model="proxyRules"
          class="input mono"
          placeholder="https=socks5://127.0.0.1:10808;http=direct://"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
        />
      </label>
    </div>

    <div class="row">
      <button type="button" class="btn btn--primary" @click="saveProxy">保存代理配置</button>
      <button type="button" class="btn btn--ghost" :disabled="proxyChecking" @click="checkProxy">
        <Loader2 v-if="proxyChecking" :size="14" class="spin" />
        查看生效情况
      </button>
    </div>

    <p v-if="proxyResult" class="result" :class="{ 'result--bad': !proxyResult.ok }">
      {{ proxyResult.message }}
    </p>
  </section>

  <section class="panel">
    <h2>在线来源与网页代理</h2>
    <p class="sec-desc">用于「找视频」等通用在线来源浏览、封面加载与网页验证窗口。</p>
    <OnlineSourceSettings />
  </section>
</template>

<style scoped src="../settings.css"></style>
