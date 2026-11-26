<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'
import type { LanguageSetting } from '@/i18n'

const settings = useSettingsStore()
const saving = ref(false)
async function change(event: Event): Promise<void> {
  const input = event.target as HTMLSelectElement
  saving.value = true
  try { await settings.patch({ language: input.value as LanguageSetting }) }
  catch (error) { input.value = settings.settings.language; useToast().error(errorMessage(error)) }
  finally { saving.value = false }
}
</script>

<template>
  <label class="language-select">
    <span>{{ $t('界面语言') }}</span>
    <select class="input" :value="settings.settings.language" :disabled="saving" @change="change" aria-label="Language / 界面语言">
      <option value="system">{{ $t('跟随系统') }}</option>
      <option value="zh-CN" lang="zh-CN">简体中文</option>
      <option value="en" lang="en">English</option>
    </select>
  </label>
</template>

<style scoped>
.language-select { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; font-size:var(--fs-body); }
.language-select select { width:auto; min-width:150px; }
</style>
