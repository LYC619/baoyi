<script setup lang="ts">
import {Sparkles} from 'lucide-vue-next'
import {useArchiveAssistant} from '@/composables/useArchiveAssistant'
import type {WorkspaceAgentContext} from '@/types/workspace'
const props=defineProps<{context:WorkspaceAgentContext}>(),emit=defineEmits<{opened:[]}>(),assistant=useArchiveAssistant()
function open(){emit('opened');void assistant.show(undefined,props.context.documentIds||[])}
function close(_returnFocus=true){assistant.open.value=false}
defineExpose({close})
</script>
<template><button class="ws-button document-assistant-trigger" :aria-expanded="assistant.open.value" @click="open"><Sparkles :size="16"/>{{assistant.busy.value?$t('归档助理 · 处理中'):$t('归档助理')}}</button></template>
