<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { posterUrl } from '@/utils'
const props = defineProps<{ poster?: string; thumbnail?: string }>()
const images = computed(() => [{ path: props.poster, label:'竖向海报', role:'portrait' }, { path:props.thumbnail, label:'横向预览图', role:'landscape' }]
  .filter((image,index,all) => image.path && all.findIndex(other=>other.path===image.path)===index))
const selected = ref<(typeof images.value)[number] | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
async function enlarge(image: (typeof images.value)[number]) { selected.value=image; await nextTick(); dialog.value?.showModal() }
</script>
<template>
  <div v-if="images.length" class="episode-artwork">
    <button v-for="image in images" :key="image.path" type="button" class="artwork-open" :class="'artwork-open--' + image.role" :aria-label="'放大' + image.label" @click="enlarge(image)"><img :src="posterUrl(image.path!)" :alt="image.label" /></button>
    <Teleport to="body"><dialog ref="dialog" class="artwork-lightbox" aria-label="查看图片" @click.self="dialog?.close()" @close="selected = null"><button class="lightbox-close" type="button" aria-label="关闭图片" autofocus @click="dialog?.close()"><X :size="22" /></button><img v-if="selected" :src="posterUrl(selected.path!)" :alt="selected.label" /></dialog></Teleport>
  </div>
</template>
<style scoped>
.episode-artwork { --artwork-height: clamp(110px, 13vw, 170px); display: flex; gap: 10px; align-items: flex-start; max-width: 100%; }
.artwork-open { border: 0; background: transparent; padding: 0; min-width: 0; flex: none; cursor: zoom-in; border-radius: 7px; }
.artwork-open--portrait { width: calc(var(--artwork-height) * 2 / 3); }
.artwork-open--landscape { width: calc(var(--artwork-height) * 16 / 9); }
.artwork-open img { display: block; width: 100%; height: var(--artwork-height); object-fit: contain; border-radius: 7px; }
.artwork-open:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.artwork-lightbox { border: 0; border-radius: 10px; padding: 24px; margin: auto; max-width: 96vw; max-height: 96vh; background: var(--bg-card); color: var(--text-main); overflow: visible; }
.artwork-lightbox::backdrop { background: #000b; }
.artwork-lightbox > img { display: block; max-width: calc(96vw - 48px); max-height: calc(96vh - 48px); object-fit: contain; }
.lightbox-close { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--bg-card); color: var(--text-main); cursor: pointer; }
</style>
