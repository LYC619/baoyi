<script setup lang="ts">
import { computed } from 'vue'
import { useRoute,useRouter } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import { returnPath } from '@/utils/workspace-api'
const route=useRoute(),router=useRouter(),from=computed(()=>returnPath(route.query.from,''))
</script>
<template><div v-if="from&&route.name!=='document-reader'" class="source-return"><button @click="router.push(from)"><ArrowLeft :size="14"/>返回引用来源</button></div></template>
<style scoped>.source-return{flex:none;background:var(--bg-main);padding:8px 22px;border-bottom:1px solid var(--divider);font-size:12px;color:var(--text-sub)}.source-return button{display:flex;align-items:center;gap:7px}.source-return button:hover{color:var(--accent)}</style>
