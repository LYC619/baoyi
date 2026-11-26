<script setup lang="ts">
import { ref, watch } from 'vue'
import { BookOpen, Images } from 'lucide-vue-next'
const props = defineProps<{ pageId?: string; name: string; photo?: boolean; shape?:string; revision?:number }>()
const failed = ref(false)
watch(() => [props.pageId,props.revision], () => { failed.value = false })
</script>
<template>
  <div class="image-cover" :class="[{ 'image-cover--photo': photo },shape?'image-cover--'+shape:'']">
    <img v-if="pageId && !failed" :src="`baoyi://image/${pageId}?thumb=1&v=${revision||0}`" :alt="name" loading="lazy" draggable="false" @error="failed=true" />
    <div v-else class="image-cover__empty"><Images v-if="photo" :size="30" /><BookOpen v-else :size="30" /><span>{{ failed ? $t('图片不可用') : name.slice(0,10) }}</span></div>
  </div>
</template>
<style scoped>
.image-cover{aspect-ratio:2/3;background:var(--bg-side);overflow:hidden;position:relative;flex:none}.image-cover--photo{aspect-ratio:4/3}.image-cover img{width:100%;height:100%;object-fit:cover;display:block}.image-cover__empty{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;color:var(--text-sub);padding:14px;text-align:center;background:linear-gradient(145deg,var(--bg-side),var(--bg-card))}
</style>
<style scoped>
.image-cover--horizontal{aspect-ratio:4/3}.image-cover--vertical{aspect-ratio:2/3}.image-cover--adaptive{aspect-ratio:auto;min-height:100px}.image-cover--adaptive img{height:auto;object-fit:contain}.image-cover--adaptive .image-cover__empty{min-height:160px}
</style>
