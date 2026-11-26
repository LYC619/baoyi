<script setup lang="ts">
import FfmpegPanel from '@/components/settings/FfmpegPanel.vue'
import DownloadCachePanel from '@/components/settings/DownloadCachePanel.vue'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()
</script>

<template>
<p class="hint">{{ $t("此处为影视共用下载配置，适用于里番和「找视频」的下载任务。") }}</p>
<section class="panel"><h2>{{ $t("视频更新检查") }}</h2><label><input type="checkbox" :checked="settings.settings.video_updates_weekly===true" @change="settings.patch({video_updates_weekly:($event.target as HTMLInputElement).checked})" />{{ $t("每周在启动时自动检查一次") }}</label><p class="sec-desc">{{ $t("距上次成功检查满 7 天后，下次启动检查可见视频的本地文件与支持的系列来源，只报告结果，不自动下载。隐藏内容会跳过；网络检查失败可手动重试。") }}</p><p v-if="settings.settings.video_updates_last_checked" class="hint">{{ $t("上次成功检查：{p0}", {p0: (new Date(settings.settings.video_updates_last_checked).toLocaleString($locale))}) }}</p></section>
<FfmpegPanel />
<DownloadCachePanel />
</template>

<style scoped src="../settings.css"></style>
