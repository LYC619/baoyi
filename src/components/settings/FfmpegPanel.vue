<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { errorMessage } from '@/utils'
const settings = useSettingsStore(), busy = ref(false), message = ref('')
async function detect(pick = false) {
  busy.value = true; message.value = ''
  try {
    const file = await (pick ? window.baoyi.settings.pickFfmpeg() : window.baoyi.settings.detectFfmpeg())
    if (file) { await settings.patch({ ffmpeg_path: file }); message.value = 'FFmpeg 可用，已保存路径' }
    else if (!pick) message.value = '未找到 FFmpeg，可手动选择已安装的 ffmpeg.exe。'
  } catch (error) { message.value = errorMessage(error) }
  finally { busy.value = false }
}
</script>
<template><section class="panel ffmpeg-panel"><h2>HLS 下载工具</h2><p>将 m3u8 分片保存为 MP4 需要 FFmpeg。PotPlayer 可直接播放 m3u8，下载合片仍需单独的 ffmpeg.exe。</p><p class="ffmpeg-path">{{settings.settings.ffmpeg_path || '尚未指定，将自动检测系统与软件目录'}}</p><div><button class="btn btn--subtle" :disabled="busy" @click="detect()">{{busy?'正在检查…':'重新检测'}}</button><button class="btn btn--subtle" :disabled="busy" @click="detect(true)">选择 ffmpeg.exe</button><button v-if="settings.settings.ffmpeg_path" class="btn btn--subtle" :disabled="busy" @click="settings.patch({ffmpeg_path:''}); message=''">恢复自动检测</button></div><p v-if="message" role="status">{{message}}</p></section></template>
<style scoped>.ffmpeg-panel{padding:22px;margin-top:20px}.ffmpeg-panel h2{font-size:16px}.ffmpeg-panel p{color:var(--text-sub);font-size:13px;line-height:1.7}.ffmpeg-path{overflow-wrap:anywhere}.ffmpeg-panel>div{display:flex;gap:8px;flex-wrap:wrap}</style>
