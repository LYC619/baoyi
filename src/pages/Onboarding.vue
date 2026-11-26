<script setup lang="ts">
import { tr } from "../i18n/index.ts"

import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Check, FolderPlus, Loader2, SkipForward, Trash2 } from 'lucide-vue-next'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'
import LanguageSelect from '@/components/ui/LanguageSelect.vue'
import { useAI } from '@/composables/useAI'
import { useScan } from '@/composables/useScan'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { useSoftwareStore } from '@/stores/software'
import { errorMessage } from '@/utils'

const router = useRouter()
const settings = useSettingsStore()
const store = useSoftwareStore()
const scan = useScan()
const ai = useAI()
const toast = useToast()

/** 0 欢迎 · 1 选目录 · 2 扫描 · 3 配置 AI · 4 AI 补全 · 5 完成 */
const step = ref(0)
/**
 * 当前步骤的失败原因。路由守卫在 onboarded 之前把一切重定向回这一页，
 * 所以每一步都必须自带失败出口：看到原因、能重试、能绕过去。
 */
const stepError = ref('')
const dirs = ref<string[]>([...settings.settings.software_scan_dirs])

const apiUrl = ref(settings.settings.ai.api_url)
const apiKey = ref(settings.settings.ai.api_key)
const model = ref(settings.settings.ai.model)

const scanned = ref({ found: 0, added: 0, pending: 0, settled: 0, loose_files: [] as string[] })
const aiDone = ref({ processed: 0, registered: 0, skipped: 0, failed: 0, tokens: 0 })

const canScan = computed(() => dirs.value.length > 0)

async function addDir(): Promise<void> {
  const dir = await scan.pickDirectory()
  if (dir && !dirs.value.includes(dir)) dirs.value.push(dir)
}

function removeDir(dir: string): void {
  dirs.value = dirs.value.filter((d) => d !== dir)
}

async function startScan(): Promise<void> {
  stepError.value = ''
  try {
    await settings.patch({ software_scan_dirs: [...dirs.value] })
  } catch (err) {
    toast.error(tr('保存扫描目录失败：{p0}', {p0: errorMessage(err)}))
    return
  }
  step.value = 2
  try {
    scanned.value = await scan.run([...dirs.value])
    await store.reload()
  } catch (err) {
    stepError.value = errorMessage(err)
  }
}

async function startAi(): Promise<void> {
  stepError.value = ''
  try {
    await settings.patch({
      ai: {
        api_url: apiUrl.value.trim(),
        api_key: apiKey.value.trim(),
        model: model.value.trim(),
        enabled: true
      }
    })
  } catch (err) {
    toast.error(tr('保存 AI 配置失败：{p0}', {p0: errorMessage(err)}))
    return
  }
  step.value = 4
  try {
    aiDone.value = await ai.complete()
    await store.reload()
    step.value = 5
  } catch (err) {
    stepError.value = errorMessage(err)
  }
}

async function skipAi(): Promise<void> {
  try {
    await settings.patch({ ai: { ...settings.settings.ai, enabled: false } })
    step.value = 5
  } catch (err) {
    toast.error(tr('保存失败：{p0}', {p0: errorMessage(err)}))
  }
}

async function finish(): Promise<void> {
  try {
    await settings.patch({ onboarded: true })
    await store.reload()
  } catch (err) {
    toast.error(tr('保存失败：{p0}', {p0: errorMessage(err)}))
    return
  }
  // 识别结果停在暂存区等确认，这时候直接进卡片墙只会看到一片空白
  void router.push({ name: aiDone.value.registered > 0 ? 'confirm' : 'home' })
}
</script>

<template>
  <div class="onboarding">
    <div class="stage">
      <LanguageSelect class="onboarding-language" />
      <!-- ------------------------------ 0 欢迎 ------------------------------ -->
      <section v-if="step === 0" class="step step--center">
        <BaoyiLogo :size="72" />
        <h1 class="title">{{ $t("抱一") }}</h1>
        <p class="slogan">{{ $t("知止而后得。") }}</p>
        <p class="quote">{{ $t("是以圣人抱一为天下式。") }}<br />{{ $t("——《道德经》第二十二章") }}</p>
        <p class="lead">{{ $t("抱一不帮你囤积，它帮你掌握。") }}<br />{{ $t("每个品类只抱住最好的那一个，剩下的可以放下了。") }}</p>
        <button class="btn btn--primary btn--lg" @click="step = 1">{{ $t("开始") }}<ArrowRight :size="15" />
        </button>
      </section>

      <!-- ---------------------------- 1 选择目录 ---------------------------- -->
      <section v-else-if="step === 1" class="step">
        <p class="eyebrow">{{ $t("第一步") }}</p>
        <h2 class="head">{{ $t("选择要扫描的目录") }}</h2>
        <p class="desc">{{ $t("通常是你放绿色软件的盘符目录，或 Program Files。 抱一读取 EXE 的图标和版本信息，也能识别手机 APP 安装包；扫描不会移动或修改文件。") }}</p>

        <ul v-if="dirs.length" class="dirs">
          <li v-for="d in dirs" :key="d">
            <span class="mono truncate" :title="d">{{ d }}</span>
            <button class="btn btn--subtle" @click="removeDir(d)">
              <Trash2 :size="14" />
            </button>
          </li>
        </ul>

        <button class="btn btn--ghost" @click="addDir">
          <FolderPlus :size="15" />{{ $t("添加目录") }}</button>

        <div class="actions">
          <button class="btn btn--primary btn--lg" :disabled="!canScan" @click="startScan">{{ $t("开始扫描") }}<ArrowRight :size="15" />
          </button>
        </div>
      </section>

      <!-- ---------------------------- 2 扫描进度 ---------------------------- -->
      <section v-else-if="step === 2" class="step">
        <p class="eyebrow">{{ $t("第二步") }}</p>
        <!-- 失败也要有出口：原因摆出来，能重试，也能先去把 AI 配好 -->
        <template v-if="stepError">
          <h2 class="head">{{ $t("扫描没有完成") }}</h2>
          <p class="err">{{ stepError }}</p>
          <div class="actions">
            <button class="btn btn--primary btn--lg" @click="startScan">{{ $t("重试") }}<ArrowRight :size="15" />
            </button>
            <button class="btn btn--subtle" @click="step = 3">{{ $t("先去配置 AI") }}</button>
          </div>
        </template>
        <template v-else>
          <h2 class="head">
            <Loader2 v-if="scan.running.value" :size="18" class="spin" />
            {{ scan.running.value ? $t('正在扫描') : $t('扫描完成') }}
          </h2>
          <p class="desc mono truncate">{{ scan.progress.value?.current || '—' }}</p>

          <div class="bar"><i :style="{ width: `${scan.percent.value}%` }" /></div>
          <p class="stat">{{ scan.phaseLabel.value }}</p>

          <template v-if="!scan.running.value">
            <div class="summary">
              <div><b>{{ scanned.found }}</b><span>{{ $t("个程序") }}</span></div>
              <div><b>{{ scanned.pending }}</b><span>{{ $t("个目录待识别") }}</span></div>
              <div><b>{{ scanned.settled }}</b><span>{{ $t("个已识别过") }}</span></div>
            </div>
            <div class="actions">
              <button class="btn btn--primary btn--lg" @click="step = 3">{{ $t("下一步") }}<ArrowRight :size="15" />
              </button>
            </div>
          </template>
          <div v-else class="actions">
            <button class="btn btn--ghost" @click="scan.cancel()">{{ $t("中止扫描") }}</button>
          </div>
        </template>
      </section>

      <!-- ---------------------------- 3 配置 AI ---------------------------- -->
      <section v-else-if="step === 3" class="step">
        <p class="eyebrow">{{ $t("第三步") }}</p>
        <h2 class="head">{{ $t("让 AI 帮你认出它们") }}</h2>
        <p class="desc">{{ $t("抱一会把每个目录交给 AI 自己去看：列目录、读 exe 信息，判断哪个是主程序、 哪些只是加载器，再把 32 位和 64 位合并成一条。需要一个支持工具调用的模型， deepseek-chat 就够用。跳过也可以，之后随时能在设置里补。") }}</p>

        <div class="form">
          <label class="field">
            <span class="field__label">{{ $t("接口地址") }}</span>
            <input v-model="apiUrl" class="input mono" placeholder="https://api.deepseek.com/v1" />
          </label>
          <label class="field">
            <span class="field__label">API Key</span>
            <input v-model="apiKey" class="input mono" type="password" placeholder="sk-…" />
          </label>
          <label class="field">
            <span class="field__label">{{ $t("模型") }}</span>
            <input v-model="model" class="input mono" placeholder="deepseek-chat" />
          </label>
        </div>

        <div class="actions">
          <button class="btn btn--primary btn--lg" :disabled="!apiKey.trim()" @click="startAi">{{ $t("开始识别") }}<ArrowRight :size="15" />
          </button>
          <button class="btn btn--subtle" @click="skipAi">
            <SkipForward :size="14" />{{ $t("暂时跳过") }}</button>
        </div>
      </section>

      <!-- ---------------------------- 4 AI 识别 ---------------------------- -->
      <section v-else-if="step === 4" class="step">
        <p class="eyebrow">{{ $t("第四步") }}</p>
        <!-- 识别失败不能停在这个转圈上：给原因、给重试、也给跳过的出路 -->
        <template v-if="stepError">
          <h2 class="head">{{ $t("识别没有跑完") }}</h2>
          <p class="err">{{ stepError }}</p>
          <div class="actions">
            <button class="btn btn--primary btn--lg" @click="startAi">{{ $t("重试") }}<ArrowRight :size="15" />
            </button>
            <button class="btn btn--subtle" @click="skipAi">
              <SkipForward :size="14" />{{ $t("暂时跳过") }}</button>
          </div>
        </template>
        <template v-else>
          <h2 class="head">
            <Loader2 :size="18" class="spin" />{{ $t("AI 正在识别") }}</h2>
          <p class="desc mono truncate">{{ ai.progress.value?.current || '—' }}</p>

          <div class="bar"><i :style="{ width: `${ai.percent.value}%` }" /></div>
          <p class="stat">
            {{ $t("{p0} / {p1} 个目录 · 已认出 {p2} 个软件", {p0: (ai.progress.value?.processed ?? 0), p1: (ai.progress.value?.total ?? 0), p2: (ai.progress.value?.registered ?? 0)}) }}</p>
          <p class="stat truncate">{{ ai.activity.value || $t('正在启动…') }}</p>

          <div class="actions">
            <button class="btn btn--ghost" @click="ai.cancel()">{{ $t("中止") }}</button>
          </div>
        </template>
      </section>

      <!-- ------------------------------ 5 完成 ------------------------------ -->
      <section v-else class="step step--center">
        <div class="done-mark"><Check :size="30" /></div>
        <h2 class="head">{{ $t("好了") }}</h2>
        <p v-if="aiDone.registered > 0" class="lead">{{ $t("AI 认出了 {p0} 个软件，还差你点一次头。", {p0: (aiDone.registered)}) }}<br />{{ $t("它给的名字和分类不一定对，过一遍再收录 —— 错进了库，往后就没人会回头改了。") }}</p>
        <p v-else class="lead">{{ $t("已收录 {p0} 个软件。", {p0: (store.counts.all)}) }}<br />{{ $t("接下来做的事很简单：用它，或者放下它。") }}</p>
        <button class="btn btn--primary btn--lg" @click="finish">
          {{ aiDone.registered > 0 ? $t('去确认这 {p0} 个', {p0: aiDone.registered}) : $t('进入卡片墙') }}
          <ArrowRight :size="15" />
        </button>
      </section>
    </div>

    <ol class="steps">
      <li v-for="n in 5" :key="n" :class="{ on: step >= n - 1 }" />
    </ol>
  </div>
</template>

<style scoped>
.onboarding {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-main);
}

.stage {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow-y: auto;
}

.step {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: card-in 260ms var(--ease) both;
}

.step--center {
  align-items: center;
  text-align: center;
  gap: 10px;
}

.title {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 400;
  letter-spacing: 8px;
  margin-top: 18px;
  text-indent: 8px;
}

.slogan {
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 3px;
  color: var(--accent);
}

.quote {
  font-family: var(--font-display);
  font-size: 12px;
  line-height: 2;
  color: var(--text-faint);
  margin-top: 6px;
}

.lead {
  font-size: var(--fs-body);
  line-height: 2;
  color: var(--text-sub);
  margin: 14px 0 20px;
}

.eyebrow {
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--accent);
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 400;
  letter-spacing: 1px;
}

.step--center .head {
  justify-content: center;
}

.desc {
  font-size: var(--fs-body);
  line-height: 1.9;
  color: var(--text-sub);
}

.err {
  font-size: var(--fs-body);
  line-height: 1.8;
  color: var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius-input);
  background: var(--danger-bg);
  word-break: break-word;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 4px;
}

.dirs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dirs li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-input);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
}

.dirs li span {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}

.step--center .actions {
  justify-content: center;
}

.btn--lg {
  height: 40px;
  padding: 0 22px;
}

.bar {
  height: 5px;
  border-radius: 3px;
  background: var(--hover-surface);
  overflow: hidden;
  margin-top: 6px;
}

.bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 200ms ease;
}

.stat {
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.summary {
  display: flex;
  gap: 28px;
  margin-top: 10px;
}

.summary div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.summary b {
  font-size: 24px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.summary span {
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.done-mark {
  width: 62px;
  height: 62px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--success-bg);
  color: var(--success);
  margin-bottom: 6px;
}

.steps {
  flex: none;
  list-style: none;
  display: flex;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 0 0 26px;
}

.steps li {
  width: 22px;
  height: 3px;
  border-radius: 2px;
  background: var(--hover-surface);
  transition: background var(--t-fast) ease;
}

.steps li.on {
  background: var(--accent);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
