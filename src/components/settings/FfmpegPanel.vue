<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { errorMessage } from '@/utils'
const settings = useSettingsStore(), busy = ref(false), message = ref('')
async function detect(pick = false) {
  busy.value = true; message.value = ''
  try {
    const file = await (pick ? window.baoyi.settings.pickFfmpeg() : window.baoyi.settings.detectFfmpeg())
    if (file) { await settings.patch({ ffmpeg_path: file }); message.value = tr("FFmpeg 可用，已保存路径") }
    else if (!pick) message.value = tr("未找到 FFmpeg，可手动选择已安装的 ffmpeg.exe。")
  } catch (error) { message.value = errorMessage(error) }
  finally { busy.value = false }
}
async function changeConcurrency(event: Event, key: 'video_download_concurrency' | 'video_download_connections') {
  const input=event.target as HTMLInputElement
  busy.value=true;message.value=''
  try { await settings.patch({[key]:Number(input.value)});message.value=tr("视频下载并发已保存，新连接将使用此设置") }
  catch(error){message.value=errorMessage(error)}
  finally { busy.value=false;input.value=String(settings.settings[key] ?? (key==='video_download_concurrency'?2:4)) }
}
async function resetDetection() {
  busy.value = true; message.value = ''
  try { await settings.patch({ ffmpeg_path: '' }); message.value = tr("已恢复自动检测，下次下载时重新查找 FFmpeg") }
  catch (error) { message.value = errorMessage(error) }
  finally { busy.value = false }
}
async function pickVideoPlayer() {
  busy.value = true; message.value = ''
  try {
    const picked = await window.baoyi.video?.preview?.pickPlayer()
    if (picked) { await settings.load(); message.value = tr("默认视频播放器已保存") }
  } catch (error) { message.value = errorMessage(error) }
  finally { busy.value = false }
}
async function resetVideoPlayer() {
  busy.value = true; message.value = ''
  try { await settings.patch({ video_player_path: '' }); message.value = tr("已恢复使用系统默认关联程序播放视频") }
  catch (error) { message.value = errorMessage(error) }
  finally { busy.value = false }
}
</script>
<template><section class="panel ffmpeg-panel"><h2>{{ $t("视频下载设置") }}</h2><div class="video-concurrency"><label>{{ $t("同时下载视频数") }}<input class="input" type="number" min="1" max="4" step="1" :value="settings.settings.video_download_concurrency ?? 2" :disabled="busy" @change="changeConcurrency($event,'video_download_concurrency')" /></label><label>{{ $t("每个视频连接数") }}<input class="input" type="number" min="1" max="8" step="1" :value="settings.settings.video_download_connections ?? 4" :disabled="busy" @change="changeConcurrency($event,'video_download_connections')" /></label></div><p>{{ $t("默认同时下载 2 个视频，每个视频使用 4 路连接。服务器不支持多连接时自动使用单连接；调低设置后已有连接会继续完成。") }}</p><h3>{{ $t("默认视频播放器") }}</h3><p>{{ $t("指定本地播放器（如 PotPlayer、mpv、VLC）后，在影视详情页点「播放」将直接用该程序打开视频；未指定时沿用系统默认关联程序。") }}</p><p class="ffmpeg-path">{{settings.settings.video_player_path || $t('未指定，沿用系统默认关联程序')}}</p><div><button class="btn btn--subtle" :disabled="busy" @click="pickVideoPlayer">{{ $t("选择播放器程序") }}</button><button v-if="settings.settings.video_player_path" class="btn btn--subtle" :disabled="busy" @click="resetVideoPlayer">{{ $t("恢复系统默认") }}</button></div><h3>{{ $t("HLS / DASH 下载工具") }}</h3><p>{{ $t("将分片保存为 MP4 需要 FFmpeg。PotPlayer 可直接播放 m3u8，下载合片仍需单独的 ffmpeg.exe。") }}</p><p class="ffmpeg-path">{{settings.settings.ffmpeg_path || $t('尚未指定，将自动检测系统与软件目录')}}</p><div><button class="btn btn--subtle" :disabled="busy" @click="detect()">{{busy?$t('正在检查…'):$t('重新检测')}}</button><button class="btn btn--subtle" :disabled="busy" @click="detect(true)">{{ $t("选择 ffmpeg.exe") }}</button><button v-if="settings.settings.ffmpeg_path" class="btn btn--subtle" :disabled="busy" @click="resetDetection">{{ $t("恢复自动检测") }}</button></div><p v-if="message" role="status">{{message}}</p></section></template>
<style scoped>.ffmpeg-panel{padding:22px;margin-top:20px}.ffmpeg-panel h2{font-size:16px}.ffmpeg-panel p{color:var(--text-sub);font-size:13px;line-height:1.7}.ffmpeg-path{overflow-wrap:anywhere;font-family:var(--font-mono);font-size:12px}.ffmpeg-panel>div{display:flex;gap:8px;flex-wrap:wrap}</style>
<style scoped>.video-concurrency{margin-top:16px;gap:24px!important}.video-concurrency label{display:flex;align-items:center;gap:10px;font-size:13px}.video-concurrency input{width:72px;min-height:32px}.ffmpeg-panel h3{font-size:14px;margin-top:20px}</style>
