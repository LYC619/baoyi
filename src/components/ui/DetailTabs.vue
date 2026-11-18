<script setup lang="ts">
import type {Component} from 'vue'
const props = defineProps<{ modelValue: string; tabs: Array<{id:string;label:string;icon?:Component;count?:number;dot?:boolean}>; prefix:string; label:string }>()
const emit = defineEmits<{ 'update:modelValue': [value:string] }>()
function keydown(event: KeyboardEvent) {
  const index = props.tabs.findIndex(tab=>tab.id === props.modelValue)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.tabs.length-1 : event.key === 'ArrowRight' ? (index+1)%props.tabs.length : event.key === 'ArrowLeft' ? (index+props.tabs.length-1)%props.tabs.length : -1
  if (next < 0) return
  event.preventDefault(); emit('update:modelValue',props.tabs[next].id)
  document.getElementById(props.prefix+'-tab-'+props.tabs[next].id)?.focus()
}
</script>
<template><nav class="detail-tabs" role="tablist" :aria-label="label" @keydown="keydown"><button v-for="tab in tabs" :id="prefix+'-tab-'+tab.id" :key="tab.id" role="tab" :aria-label="tab.label" :aria-selected="modelValue===tab.id" :aria-controls="prefix+'-panel-'+tab.id" :tabindex="modelValue===tab.id?0:-1" @click="emit('update:modelValue',tab.id)"><component v-if="tab.icon" :is="tab.icon" :size="13"/>{{tab.label}}<small v-if="tab.count" class="tab-count">{{tab.count}}</small><i v-if="tab.dot" class="tab-dot"/></button></nav></template>
<style scoped>.detail-tabs{display:flex;gap:22px;border-bottom:1px solid var(--divider);overflow-x:auto}.detail-tabs button{white-space:nowrap;padding:13px 3px 12px;color:var(--text-sub);border-bottom:2px solid transparent;font-size:14px}.detail-tabs [aria-selected=true]{border-color:var(--accent);color:var(--accent)}.detail-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}</style>

<style scoped>.detail-tabs button{display:flex;align-items:center;gap:6px}.tab-count{font-size:10px;border-radius:10px;background:var(--hover-surface);color:var(--text-faint);padding:1px 5px}.tab-dot{width:5px;height:5px;border-radius:50%;background:var(--warning)}</style>
