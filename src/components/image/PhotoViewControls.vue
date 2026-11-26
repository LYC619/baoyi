<script setup lang="ts">
import type { PhotoView } from '@/composables/usePhotoView'
defineProps<{ view:PhotoView; singleOnly?:boolean; hideGrouping?:boolean }>()
</script>
<template>
  <div class="photo-view-controls">
    <span v-if="singleOnly">{{ $t("单张图片") }}</span><label v-else>{{ $t("展示") }}<select v-model="view.display" :aria-label="$t('图片展示方式')"><option value="albums">{{ $t("按组合") }}</option><option value="single">{{ $t("单张图片") }}</option></select></label>
    <label>{{ $t("视图") }}<select v-model="view.layout" :aria-label="$t('照片视图')"><option value="horizontal">{{ $t("横向") }}</option><option value="vertical">{{ $t("竖向") }}</option><option value="adaptive">{{ $t("自适配 · 瀑布流") }}</option></select></label>
    <label v-if="!hideGrouping">{{ $t("分组") }}<select v-model="view.grouping" :aria-label="$t('照片分组')"><option value="directory">{{ $t("按文件夹") }}</option><option value="category">{{ $t("按分类") }}</option><option value="none">{{ $t("不分组") }}</option></select></label>
    <label>{{ $t("大小") }}<input v-model.number="view.cardSize" type="range" min="140" max="320" step="20" :aria-label="$t('照片卡片大小')" /></label>
  </div>
</template>
<style scoped>
.photo-view-controls{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.photo-view-controls label{display:flex;gap:7px;align-items:center;font-size:12px;color:var(--text-sub)}.photo-view-controls select{max-width:170px}.photo-view-controls input{width:85px;padding:0;accent-color:var(--accent)}
</style>
