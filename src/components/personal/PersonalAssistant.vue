<script setup lang="ts">
import {Sparkles} from 'lucide-vue-next'
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
const assistant=useArchiveAssistant()
function open(text?:string){void assistant.show(text)}
defineExpose({open})
</script>
<template><button class="ws-button personal-assistant-trigger" :aria-expanded="assistant.open.value" @click="open()"><Sparkles :size="16"/>{{assistant.busy.value?'归档助理 · 处理中':'归档助理'}}</button></template>
<style scoped>.personal-assistant-trigger{position:absolute;right:32px;bottom:18px;z-index:5;box-shadow:0 3px 16px #0002}</style>
