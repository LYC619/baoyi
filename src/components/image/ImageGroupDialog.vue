<script setup lang="ts">
import { ref } from 'vue'
import { X, ArrowUp, ArrowDown, Trash2 } from 'lucide-vue-next'
import { useImageStore } from '@/stores/image'
import type { ImageGroup } from '@/types/image'
const emit=defineEmits<{close:[]}>(), store=useImageStore(), name=ref(''), error=ref(''), busy=ref(false)
async function save(group:Partial<ImageGroup>&{name:string}) { busy.value=true; error.value=''; try { await window.baoyi.image.saveGroup({...group}); name.value=''; await store.refresh() } catch(cause){error.value=(cause as Error).message}finally{busy.value=false} }
async function move(group:ImageGroup,delta:number) { const list=store.groups.slice(), index=list.findIndex(g=>g.id===group.id), other=list[index+delta]; if(!other)return; await save({...group,sortOrder:other.sortOrder}); await save({...other,sortOrder:group.sortOrder}) }
async function remove(group:ImageGroup) { if(!confirm(`移除“${group.name}”分类？作品会保留，分类变为未分类。`))return; try{await window.baoyi.image.removeGroup(group.id); await store.refresh()}catch(cause){error.value=(cause as Error).message} }
</script>
<template><Teleport to="body"><div class="im-overlay" @click.self="emit('close')"><section class="im-dialog" role="dialog" aria-modal="true" aria-label="漫画分类管理"><header><div><h2>漫画分类</h2><p>隐藏后，作品不会出现在书架、搜索和继续阅读中。</p></div><button class="im-icon" aria-label="关闭分类管理" @click="emit('close')"><X :size="20"/></button></header>
  <div class="im-groups"><div v-for="(group,index) in store.groups" :key="group.id"><input :value="group.name" aria-label="分类名称" @change="save({...group,name:($event.target as HTMLInputElement).value})"/><label><input type="checkbox" :checked="group.hidden" :disabled="busy" @change="save({...group,hidden:($event.target as HTMLInputElement).checked})"/>隐藏</label><button class="im-icon" aria-label="上移分类" :disabled="busy||index===0" @click="move(group,-1)"><ArrowUp :size="16"/></button><button class="im-icon" aria-label="下移分类" :disabled="busy||index===store.groups.length-1" @click="move(group,1)"><ArrowDown :size="16"/></button><button class="im-icon" aria-label="删除分类" @click="remove(group)"><Trash2 :size="16"/></button></div></div>
  <form class="im-group-add" @submit.prevent="save({name})"><input v-model="name" placeholder="新分类名称" aria-label="新分类名称" maxlength="80"/><button class="im-button im-primary" :disabled="busy||!name.trim()">新增分类</button></form><p v-if="error" class="im-error" role="alert">{{error}}</p>
</section></div></Teleport></template>
