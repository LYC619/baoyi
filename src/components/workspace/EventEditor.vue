<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref } from 'vue'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { workspace,plain,localDate } from '@/utils/workspace-api'
import type { TimelineEvent,EventInput } from '@/types/workspace'
const props=defineProps<{projectId:string;event?:TimelineEvent}>(),emit=defineEmits<{close:[];saved:[]}>()
const at=new Date(props.event?.occurredAt||Date.now()),date=ref(localDate(at)),time=ref(`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`)
const form=ref<EventInput>({...(props.event?{id:props.event.id}:{}),title:props.event?.title||'',body:props.event?.body||'',occurredAt:at.getTime(),milestone:props.event?.milestone||false,version:props.event?.version||''}),busy=ref(false),error=ref('')
async function save(){busy.value=true;error.value='';try{form.value.occurredAt=new Date(date.value+'T'+time.value).getTime();await workspace.timeline.save(props.projectId,plain(form.value));emit('saved');emit('close')}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
</script>
<template><ProjectDialog :title="event?$t('编辑项目记录'):$t('记一笔')" wide :busy="busy" @close="emit('close')"><form id="event-form" class="ws ws-form" @submit.prevent="save"><p v-if="error" class="ws-error" role="alert">{{$systemMessage(error)}}</p><label>{{ $t("一句话记录") }}<input v-model="form.title" :placeholder="$t('今天推进了什么？')" required maxlength="300"/></label><label>{{ $t("经过与结果") }}<textarea v-model="form.body" rows="6" maxlength="50000" :placeholder="$t('为什么做、得到了什么、还有什么没解决。也可以先只留一句话。')"/></label><div class="ws-two"><label>{{ $t("发生日期") }}<input v-model="date" required type="date"/></label><label>{{ $t("时间") }}<input v-model="time" required type="time"/></label></div><div class="ws-two"><label>{{ $t("版本 / 阶段") }}<input v-model="form.version" maxlength="80" :placeholder="$t('可选，如 0.17 或初稿')"/></label><label class="check"><input v-model="form.milestone" type="checkbox"/>{{ $t("标记为重要节点") }}</label></div><p class="ws-muted">{{ $t("保存后可在记录下附上资料或摘录。修改草稿后，仍需确认发布。") }}</p></form><template #footer><div class="ws"><button class="ws-button primary" type="submit" form="event-form" :disabled="busy">{{ $t("保存记录") }}</button></div></template></ProjectDialog></template>
