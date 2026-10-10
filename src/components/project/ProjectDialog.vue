<script setup lang="ts">
import { onMounted,ref } from 'vue'
import '@/styles/project.css'
import { X } from 'lucide-vue-next'
defineProps<{title:string;busy?:boolean;wide?:boolean}>()
const emit=defineEmits<{close:[]}>(),dialog=ref<HTMLDialogElement>()
onMounted(()=>dialog.value?.showModal())
</script>
<template><Teleport to="body"><dialog ref="dialog" class="pj-modal" :class="{'pj-modal-wide':wide}" :aria-label="title" @cancel.prevent="!busy&&emit('close')"><header><h2>{{title}}</h2><button class="pj-icon" :disabled="busy" aria-label="关闭对话框" @click="emit('close')"><X :size="20"/></button></header><div class="pj-modal-body"><slot/></div><footer v-if="$slots.footer"><slot name="footer"/></footer></dialog></Teleport></template>
