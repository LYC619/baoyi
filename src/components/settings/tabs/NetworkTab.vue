<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { activeModule } from '@/composables/useModules'
import { Loader2 } from 'lucide-vue-next'
import OnlineSourceSettings from '@/components/settings/OnlineSourceSettings.vue'
import { useTaskCenter } from '@/composables/useTaskCenter'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { errorMessage } from '@/utils'
import { parseProxyInput, serializeProxyInput, type ProxyInput } from '../../../../electron/services/network/proxy-rules'

const settings = useSettingsStore()

const { success, error } = useToast()

const tasks = useTaskCenter()

/* ------------------------------ 出站代理 ------------------------------ */

type ProxyMode = ProxyInput['mode']

const proxyMode = ref<ProxyMode>('direct')

const proxyHost = ref('127.0.0.1')

const proxyPort = ref(10808)

const proxyRules = ref(settings.settings.proxy)

const proxyChecking = ref(false)

const proxyResult = ref<{ ok: boolean; message: string } | null>(null)

const hanimeNetwork = ref<Awaited<ReturnType<typeof window.baoyi.settings.proxyStatus>> | null>(null)

const hanimeVerifying = computed(() => tasks.runningTasks.value.some(task => task.kind === 'hanime-verify'))

const hanimeHosts = ref(settings.settings.hanime_builtin_hosts !== false)

/**
 * 内置 Hosts 开关分两层生效：取页时的换 IP 回退主进程当场切换；
 * Chromium 启动前注入的那条解析规则改不了，要重启。提示里把这两句都说清楚，
 * 免得用户关了开关、看到「解析规则」还在，以为没保存。
 */
async function toggleHanimeHosts(): Promise<void> {
  await settings.patch({ hanime_builtin_hosts: hanimeHosts.value })
  success(hanimeHosts.value ? '内置 Hosts 已开启；Chromium 的解析规则重启后生效' : '内置 Hosts 已关闭，改走系统 DNS；Chromium 的解析规则重启后生效')
  await checkProxy()
}

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
    proxyMode.value = 'custom' // 无法识别的规则交给自定义输入框编辑。
  }
}

/**
 * 保存代理。主进程在 `settings:patch` 里看见 `proxy` 这个键就当场铺下去，
 * 所以这里不需要另开一个「应用代理」的通道。
 *
 * 铺失败时它不抛、只在返回值里说 —— 但 patch 的返回是设置本身，拿不到那句话。
 * 所以保存后再问一次生效情况，把「规则铺上了吗」摆给用户看。
 */
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

/**
 * 问主进程「这个地址实际会走哪条代理」。
 *
 * 这一条不是锦上添花：代理填错时最常见的现象是「看着保存了但没生效」，而
 * `resolveProxy` 的回答能当场分清两件事 —— 规则没铺上（回 DIRECT），
 * 还是规则铺上了但目标本身不通（回 SOCKS5 ...，那问题在代理或目标那边）。
 */
async function checkProxy(): Promise<void> {
  proxyChecking.value = true
  try {
    const s = await window.baoyi.settings.proxyStatus()
    const rules = s.rules === '' ? '（直连）' : s.rules
    proxyResult.value = {
      ok: true,
      message: `当前规则：${rules}　·　hanime1.me 实际走：${s.resolved}`
    }
    hanimeNetwork.value = s
  } catch (err) {
    proxyResult.value = { ok: false, message: `问不到代理状态：${errorMessage(err)}` }
  } finally {
    proxyChecking.value = false
  }
}

async function verifyHanime(): Promise<void> {
  if (hanimeVerifying.value) return
  const taskId = tasks.start('hanime-verify', '内置 Cloudflare 验证', { message: '请在验证窗口完成验证；关闭窗口或超时会记为未完成' })
  try {
    const ok = await window.baoyi.settings.hanimeVerify('https://hanime1.me/')
    proxyResult.value = {
      ok,
      message: ok
        ? 'Hanime 页面已通过内置会话加载，可以重新刮削。'
        : '验证窗口未完成，请在窗口中完成 Cloudflare 验证后再试。'
    }
    tasks.finish(taskId, ok ? 'success' : 'cancelled', proxyResult.value.message)
  } catch (err) {
    proxyResult.value = { ok: false, message: '验证没能完成：' + errorMessage(err) }
    tasks.finish(taskId, 'failed', 'Cloudflare 验证失败', errorMessage(err))
  } finally {
    // 主任务在辅助查询前结束，查询慢或失败都不能继续锁住按钮。
    // 只刷新网络概况，不能用 checkProxy() 的「代理规则正常」覆盖验证失败。
    try {
      hanimeNetwork.value = await window.baoyi.settings.proxyStatus()
    } catch (err) {
      tasks.log(taskId, 'warn', '验证后的网络状态查询失败：' + errorMessage(err))
      // 辅助信息失败不改写主验证结果。
    }
  }
}

watch(() => settings.settings.hanime_builtin_hosts, (value) => { hanimeHosts.value = value !== false })
loadProxyForm(settings.settings.proxy)
watch(() => settings.settings.proxy, loadProxyForm)
onMounted(() => {
  if (activeModule.value === 'video') void checkProxy()
})
watch(activeModule, (kind) => {
  if (kind === 'video') void checkProxy()
})
</script>

<template>
<section class="panel"><h2>通用在线来源</h2><p class="sec-desc">找视频的来源浏览与连接配置。</p><OnlineSourceSettings /></section>
<section v-if="activeModule === 'video'" class="panel">
  <div class="sec-head">
    <h2>Hanime 专用代理</h2>
  </div>
  <p class="sec-desc">
    用于 Hanime 的页面、资料和视频下载专用会话。保存后新请求使用此配置；正在传输的连接继续完成。
  </p>

  <div class="form">
    <label class="field">
      <span class="field__label">代理模式</span>
      <select v-model="proxyMode" class="input">
        <option value="direct">直连</option>
        <option value="system">系统代理</option>
        <option value="http">HTTP 代理</option>
        <option value="socks5">SOCKS5 代理</option>
        <option value="custom">自定义规则</option>
      </select>
    </label>
    <div v-if="proxyMode === 'http' || proxyMode === 'socks5'" class="row">
      <label class="field field--grow">
        <span class="field__label">代理主机</span>
        <input v-model="proxyHost" class="input mono" placeholder="127.0.0.1" />
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
      />
    </label>
  </div>

  <div class="row">
    <button class="btn btn--primary" @click="saveProxy">保存配置</button>
    <button class="btn btn--ghost" :disabled="proxyChecking" @click="checkProxy">
      <Loader2 v-if="proxyChecking" :size="14" class="spin" />
      查看生效情况
    </button>
  </div>

  <p v-if="proxyResult" class="result" :class="{ 'result--bad': !proxyResult.ok }">
    {{ proxyResult.message }}
  </p>

  <div v-if="hanimeNetwork" class="proxy-status">
    <div class="proxy-status__title" :class="{ 'proxy-status__title--off': !hanimeHosts }">
      <span class="status-dot"></span>
      Hanime 内置 Hosts
      <label class="switch">
        <input v-model="hanimeHosts" type="checkbox" @change="toggleHanimeHosts" />
        <span>{{ hanimeHosts ? '已开启' : '已关闭（走系统 DNS）' }}</span>
      </label>
    </div>
    <p class="sec-desc">
      覆盖 Hanime 镜像及已知视频 CDN，不影响 TMDB、豆瓣或普通图片请求。
      镜像使用上次可用地址并支持失败重试；旧版 HLS 视频通过 CDN 官方别名解析，避免错误 DNS 导致一直停在 0 B。
      开关对重试即时生效，对启动规则要重启。
    </p>
    <p v-if="hanimeNetwork.resolverRules" class="sec-desc">
      当前解析规则：<span class="mono">{{ hanimeNetwork.resolverRules }}</span>
    </p>
    <p class="sec-desc">
      地址池：<span class="mono">{{ hanimeNetwork.ips.join(', ') }}</span>
      <template v-if="hanimeNetwork.activeIp">　·　当前改用：<span class="mono">{{ hanimeNetwork.activeIp }}</span></template>
    </p>
    <p class="sec-desc">
      覆盖域名：<span class="mono">{{ hanimeNetwork.hosts.join(', ') }}</span>
    </p>
    <div class="row">
      <button class="btn btn--ghost" :disabled="hanimeVerifying" @click="verifyHanime">
        <Loader2 v-if="hanimeVerifying" :size="14" class="spin" />
        打开内置 Cloudflare 验证
      </button>
    </div>
    <p class="sec-desc sec-desc--foot">
      内置 Hosts 负责线路和 DNS；如果站点返回 Cloudflare 挑战，会打开同一专用会话的验证窗口，完成后自动重试刮削。
    </p>
  </div>

  <!--
    这一段是必要的，不是免责声明：只有走 Chromium 网络栈的请求吃这份
    代理，而「配了没反应」是这里最容易出现的现象
  -->
  <p class="sec-desc sec-desc--foot">
    此配置作用于 Hanime 专用会话，不是全局代理。TMDB、豆瓣、AI 服务和其他来源不会随之切换。
    本机回环地址一律不走代理，所以海报那条自定义协议不受影响。
    SOCKS5 和自定义规则由 Chromium 负责最终解析。
  </p>
</section>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
.proxy-status {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--divider);
  border-radius: var(--radius-input);
  background: var(--active-surface);
}

.proxy-status__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--success);
  font-size: var(--fs-tag);
  font-weight: 600;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

/* 内置 Hosts 关掉后标题和圆点一起变灰，开关本身仍可点 */
.proxy-status__title--off {
  color: var(--text-faint);
}

.proxy-status__title .switch {
  margin-left: auto;
  font-weight: 400;
  color: var(--text-main);
}
</style>
