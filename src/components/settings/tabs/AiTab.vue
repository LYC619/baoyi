<script setup lang="ts">
import { confirmDialog } from '@/composables/useDialog'
import { computed, ref } from 'vue'
import { Eye, EyeOff, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import type { AIConfig, AIProfile } from '@/types'

const settings = useSettingsStore()

const { success, error, toast } = useToast()

/* ------------------------------- AI 配置 ------------------------------- */

const apiUrl = ref(settings.settings.ai.api_url)

const apiKey = ref(settings.settings.ai.api_key)

const model = ref(settings.settings.ai.model)

const enabled = ref(settings.settings.ai.enabled)

const testing = ref(false)

const testResult = ref<{ ok: boolean; message: string } | null>(null)

/**
 * 让 Key 明文可见。
 *
 * 不只是「方便核对」：Chromium 的 type=password 在 Windows 中文输入法下会吞掉
 * 候选框，粘贴之外的输入看着像卡死（用户报过一次「删掉 Key 之后就打不进字了」）。
 * 留一个出口，遇上就点开它。
 */
const keyVisible = ref(false)

/** 当前表单凑成的一份配置，测试、拉模型、存 profile 都用它 */
function currentAiConfig(): AIConfig {
  return {
    api_url: apiUrl.value.trim(),
    api_key: apiKey.value.trim(),
    model: model.value.trim(),
    enabled: enabled.value
  }
}

async function saveAi(): Promise<void> {
  const ai = currentAiConfig()
  // 选中某套配置时，保存同时更新那一套 —— 否则改完再切走一趟就白改了
  const profiles = settings.settings.ai_profiles.map((p) =>
    p.id === settings.settings.ai_profile_id ? { ...p, ...ai } : p
  )
  await settings.patch({ ai, ai_profiles: profiles })
  success(activeProfile.value ? `已保存到「${activeProfile.value.name}」` : 'AI 配置已保存')
}

async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.baoyi.ai.test({ ...currentAiConfig(), enabled: true })
  } finally {
    testing.value = false
  }
}

/* --------------------------- 接口配置的存与切 --------------------------- */

const profiles = computed(() => settings.settings.ai_profiles)

const activeProfile = computed(
  () => profiles.value.find((p) => p.id === settings.settings.ai_profile_id) ?? null
)

/** 表单和选中的那套是否已经不一致 —— 用来提示「记得保存」 */
const aiDirty = computed(() => {
  const p = activeProfile.value
  if (!p) return false
  const c = currentAiConfig()
  return p.api_url !== c.api_url || p.api_key !== c.api_key || p.model !== c.model
})

function fillForm(cfg: AIConfig): void {
  apiUrl.value = cfg.api_url
  apiKey.value = cfg.api_key
  model.value = cfg.model
  enabled.value = cfg.enabled
}

/** 换一套配置：铺回表单，同时落到 settings.ai —— 主进程读的就是那里 */
async function switchProfile(id: string): Promise<void> {
  const p = profiles.value.find((x) => x.id === id)
  if (!p) return
  const { id: _id, name, ...cfg } = p
  fillForm(cfg)
  profileName.value = name
  await settings.patch({ ai: cfg, ai_profile_id: id })
  testResult.value = null
  modelList.value = []
  success(`已切换到「${p.name}」`)
}

/**
 * 配置名单独一个输入框，不走 window.prompt —— Electron 里 prompt 是空实现，
 * 点了什么都不会发生，看起来就跟按钮坏了一样。
 */
const profileName = ref(activeProfile.value?.name ?? '')

/** 名字空着时拿域名兜一个，省得每次都要自己想 */
const namePlaceholder = computed(() => {
  try {
    return new URL(apiUrl.value.trim()).hostname.replace(/^api\./, '') || '配置名'
  } catch {
    return '配置名' // 地址未填完整时使用默认名称。
  }
})

const canRename = computed(
  () => !!activeProfile.value && !!profileName.value.trim() && profileName.value.trim() !== activeProfile.value.name
)

async function addProfile(): Promise<void> {
  const name = profileName.value.trim() || namePlaceholder.value
  if (name === '配置名') {
    error('先给这套配置起个名字')
    return
  }
  // ponytail: 时间戳做 id 就够 —— 存一套要点一次按钮，人手点不出同毫秒的两条。
  // 不用 crypto.randomUUID()：打包后渲染进程跑在 file:// 下，它算不算安全上下文
  // 随 Chromium 版本变，缺了就是静默炸在生产环境，而这里根本不需要那种强度。
  const profile: AIProfile = { id: `p${Date.now().toString(36)}`, name, ...currentAiConfig() }
  profileName.value = name
  await settings.patch({
    ai: currentAiConfig(),
    ai_profiles: [...profiles.value, profile],
    ai_profile_id: profile.id
  })
  success(`已存为「${name}」`)
}

async function renameProfile(): Promise<void> {
  const p = activeProfile.value
  if (!p || !canRename.value) return
  const name = profileName.value.trim()
  await settings.patch({
    ai_profiles: profiles.value.map((x) => (x.id === p.id ? { ...x, name } : x))
  })
  success(`已改名为「${name}」`)
}

/**
 * 删掉当前这套。只从列表里摘掉，**不动** settings.ai ——
 * 删配置不该顺手把正在用的接口也拔了，识别会立刻开始报 401。
 */
async function removeProfile(): Promise<void> {
  const p = activeProfile.value
  if (!p) return
  // confirm 在 Electron 里是能用的（prompt 才是空实现），删除这种不可逆操作值得拦一道
  if (!(await confirmDialog({ title: `删除模型预设「${p.name}」？`, message: '当前表单里已填写的连接信息不会被清空。', confirmText: '删除预设', tone: 'danger' }))) return
  await settings.patch({
    ai_profiles: profiles.value.filter((x) => x.id !== p.id),
    ai_profile_id: ''
  })
  // 名字框留着已删掉的名字会让人以为没删干净
  profileName.value = ''
  success(`已删除「${p.name}」`)
}

/* ------------------------------ 模型列表 ------------------------------ */

const modelList = ref<string[]>([])

const modelsLoading = ref(false)

async function loadModels(): Promise<void> {
  modelsLoading.value = true
  try {
    const r = await window.baoyi.ai.models(currentAiConfig())
    modelList.value = r.models
    // 失败原因得说出来：中转站不实现 /models 是常事，静默清空只会让人以为 Key 废了
    if (!r.ok) error(r.message)
    else if (!r.models.includes(model.value.trim())) toast(`${r.message}，点开模型框挑一个`)
  } finally {
    modelsLoading.value = false
  }
}
</script>

<template>
<section class="panel">
  <div class="sec-head">
    <h2>AI 模型配置</h2>
    <label class="switch">
      <input v-model="enabled" type="checkbox" @change="saveAi" />
      <span>{{ enabled ? '已启用' : '已关闭' }}</span>
    </label>
  </div>

  <div class="profiles">
    <select
      class="input profiles__pick"
      :value="settings.settings.ai_profile_id"
      @change="switchProfile(($event.target as HTMLSelectElement).value)"
    >
      <option value="" disabled>
        {{ profiles.length ? '选择已存的配置…' : '还没有存过配置' }}
      </option>
      <option v-for="p in profiles" :key="p.id" :value="p.id">
        {{ p.name }} · {{ p.model }}
      </option>
    </select>
    <input
      v-model="profileName"
      class="input profiles__name"
      spellcheck="false"
      :placeholder="namePlaceholder"
      @keydown.enter="renameProfile"
    />
    <button class="btn btn--subtle" title="把当前填的存成一套" @click="addProfile">
      <Plus :size="14" />
      存为新配置
    </button>
    <button
      class="btn btn--subtle"
      :disabled="!canRename"
      title="用左边的名字重命名当前配置"
      @click="renameProfile"
    >
      <Pencil :size="14" />
    </button>
    <button
      class="btn btn--subtle"
      :disabled="!activeProfile"
      title="删除当前配置"
      @click="removeProfile"
    >
      <Trash2 :size="14" />
    </button>
  </div>

  <div class="form">
    <label class="field">
      <span class="field__label">接口地址</span>
      <input
        v-model="apiUrl"
        class="input mono"
        spellcheck="false"
        placeholder="https://api.deepseek.com/v1"
      />
    </label>
    <label class="field">
      <span class="field__label">API Key</span>
      <span class="field__wrap">
        <input
          v-model="apiKey"
          class="input mono"
          :type="keyVisible ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-…"
        />
        <button
          class="field__eye"
          type="button"
          :title="keyVisible ? '隐藏' : '显示'"
          @click="keyVisible = !keyVisible"
        >
          <EyeOff v-if="keyVisible" :size="14" />
          <Eye v-else :size="14" />
        </button>
      </span>
    </label>
    <label class="field">
      <span class="field__label">模型</span>
      <span class="field__wrap">
        <input
          v-model="model"
          class="input mono"
          list="ai-models"
          autocomplete="off"
          spellcheck="false"
          placeholder="deepseek-chat"
        />
        <datalist id="ai-models">
          <option v-for="m in modelList" :key="m" :value="m" />
        </datalist>
        <button
          class="field__eye"
          type="button"
          :disabled="modelsLoading"
          title="拉取模型列表"
          @click="loadModels"
        >
          <Loader2 v-if="modelsLoading" :size="14" class="spin" />
          <RefreshCw v-else :size="14" />
        </button>
      </span>
    </label>
  </div>

  <div class="row">
    <button class="btn btn--primary" @click="saveAi">保存配置</button>
    <button class="btn btn--ghost" :disabled="testing" @click="testConnection">
      <Loader2 v-if="testing" :size="14" class="spin" />
      测试连接
    </button>
    <span v-if="aiDirty" class="dirty">「{{ activeProfile?.name }}」有未保存的改动</span>
  </div>

  <p v-if="testResult" class="result" :class="{ 'result--bad': !testResult.ok }">
    {{ testResult.message }}
  </p>

  <p class="sec-desc sec-desc--foot">
    需要<b>支持工具调用</b>的模型，兼容 OpenAI 接口格式的服务商均可使用。
    deepseek-chat、qwen-plus、gpt-4o-mini 都够用。
    「测试连接」会真的发一次工具调用来验证，而不只是看能不能连通 ——
    模型列表里哪些支持工具调用，接口不会告诉你，挑完还是得测一次。
    多套配置存在本地库里，Key 明文存放，和其他设置一样。
  </p>
</section>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
/* ------------------------- 接口配置的存与切 ------------------------- */
.profiles {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.profiles__pick,
.profiles__name {
  flex: 1;
  min-width: 140px;
}

/* 输入框右侧塞一个小按钮（显示密码 / 拉模型列表） */
.field__wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.field__wrap .input {
  padding-right: 36px;
}

.field__eye {
  position: absolute;
  right: 1px;
  display: grid;
  place-items: center;
  width: 32px;
  height: calc(100% - 2px);
  border-radius: 0 var(--radius-input) var(--radius-input) 0;
  color: var(--text-faint);
}

.field__eye:hover {
  color: var(--text-main);
}

.field__eye:disabled {
  cursor: default;
}

.dirty {
  font-size: var(--fs-tag);
  color: var(--warning);
}
</style>
