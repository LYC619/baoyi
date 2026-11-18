<script setup lang="ts">
import { errorMessage } from '@/utils'
import {ref,onMounted} from 'vue'
import ModulePreferences from '@/components/workspace/ModulePreferences.vue'
import PersonalEditor from './PersonalEditor.vue'
import {workspace} from '@/utils/workspace-api'
import type {PersonalRecord} from '@/types/workspace'
import '@/styles/workspace.css'
const metrics=ref<PersonalRecord[]>([]),editing=ref(false),selected=ref<PersonalRecord>(),error=ref('')
async function refresh(){try{metrics.value=await workspace.personal.list('metric')}catch(e){error.value=errorMessage(e)}}
onMounted(refresh)
</script>
<template><div class="ws"><ModulePreferences module="personal"/><section class="ws-panel"><header class="ws-section-head"><h3>状态指标与单位</h3><button class="ws-button" @click="selected=undefined;editing=true">新增指标</button></header><p class="ws-muted">改名保留原记录；已有记录的指标不能直接更改单位，需要换单位时请新建指标。</p><p v-if="error" class="ws-error">{{error}}</p><p v-if="!metrics.length" class="ws-muted">尚未添加状态指标。</p><div v-for="metric in metrics" :key="metric.id" class="ws-toolbar"><strong>{{metric.name}}</strong><span>{{metric.data.unit||'无单位'}}</span><button class="ws-button" @click="selected=metric;editing=true">编辑指标</button></div></section><PersonalEditor v-if="editing" kind="metric" :record="selected" @close="editing=false" @saved="refresh"/></div></template>
