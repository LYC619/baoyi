<script setup lang="ts">
import { activeModule } from '@/composables/useModules'
import IdentifyLog from '@/components/identify/IdentifyLog.vue'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()

/** 单个目录退回待识别。日志页那个「退回待识别」也走这里 */
const retryUnit = settings.retryScanUnit
</script>

<template>
<IdentifyLog :resource-kind="activeModule" @retry="retryUnit" />
</template>

<style scoped src="../settings.css"></style>
