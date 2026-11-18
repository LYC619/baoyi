<script setup lang="ts">
import {isWindowsGameEntry} from '@/utils/game-entry'
import {computed,ref} from 'vue'
import {BookOpen,Clock,Unlink,Wrench,Play} from 'lucide-vue-next'
import type {GameItem} from '@/types'
import {formatPlaytime,formatRelative,gameTitle,errorMessage} from '@/utils'
import {PLAY_STATUS_LABEL,useGameStore} from '@/stores/game'
import {useToast} from '@/composables/useToast'
import GameCover from './GameCover.vue'
const props=defineProps<{item:GameItem;selectable?:boolean;selected?:boolean;locked?:boolean;coverShape?:'portrait'|'landscape'}>()
const emit=defineEmits<{open:[id:string,tab?:string];select:[id:string]}>()
const store=useGameStore(),{error,toast}=useToast(),launching=ref(false)
const title=computed(()=>gameTitle(props.item)),stale=computed(()=>store.staleSaves.get(props.item.id)||[])
const tools=computed(()=>props.item.linked_files.filter(f=>f.type==='trainer'&&f.role!=='usage').length)
const guides=computed(()=>props.item.linked_files.filter(f=>f.type==='guide').length)
const unavailable=computed(()=>props.item.path_state&&props.item.path_state!=='present')
async function launch(){if(launching.value)return;launching.value=true;try{const r=await window.baoyi.game.launch(props.item.id);if(r.ok)toast(r.message);else error(r.message)}catch(e){error(errorMessage(e))}finally{launching.value=false}}
</script>
<template>
  <article class="gameCard" :class="{'gameCard--selected':selected}">
    <div class="card__cover">
      <button class="card__open" :disabled="locked" :title="item.summary||title" :aria-label="`查看游戏 ${title}`" :aria-pressed="selectable?!!selected:undefined" @click="selectable?emit('select',item.id):emit('open',item.id)"><GameCover :item="item" :shape="coverShape==='landscape'?'wide':'vert'"/></button>
      <input v-if="selectable" class="gameCard__select" type="checkbox" :checked="selected" :disabled="locked" :aria-label="`选择 ${title}`" @change="emit('select',item.id)"/>
      <span v-else-if="item.play_status!=='unplayed'" class="card__status"><i :class="'dot--'+item.play_status"/>{{PLAY_STATUS_LABEL[item.play_status]}}</span>
      <span v-if="unavailable||stale.length" class="card__stale" :title="unavailable?'程序路径不可用':`存档路径找不到了：${stale.join('、')}`"><Unlink :size="12"/></span>
      <button v-if="!selectable&&!unavailable&&isWindowsGameEntry(item.path)" class="card__launch" :disabled="locked||launching" :aria-label="`启动 ${title}`" @click="launch"><Play :size="18"/></button>
    </div>
    <button class="card__name" :title="title" :disabled="locked" @click="selectable?emit('select',item.id):emit('open',item.id)">{{title}}</button>
    <div v-if="unavailable" class="card__missing"><Unlink :size="12"/>路径失效 · <button :disabled="locked" @click="emit('open',item.id,'files')">修复</button></div>
    <div v-else class="card__meta"><span><Clock :size="11"/>{{item.total_playtime_sec?formatPlaytime(item.total_playtime_sec):formatRelative(item.last_played_at)==='从未使用'?'未玩过':formatRelative(item.last_played_at)}}</span><span class="card__resources"><span v-if="tools" :title="`${tools} 个修改器`"><Wrench :size="11"/>{{tools}}</span><span v-if="guides" :title="`${guides} 份攻略`"><BookOpen :size="11"/>{{guides}}</span></span></div>
  </article>
</template>
<style scoped>
.gameCard{min-width:0;container-type:inline-size}.card__cover{position:relative;border-radius:10px;transition:transform var(--t-fast),box-shadow var(--t-fast)}.card__cover:hover,.card__cover:focus-within{transform:translateY(-3px);box-shadow:var(--shadow-card-hover)}.card__open{display:block;width:100%;border-radius:10px;overflow:hidden}.gameCard--selected .card__cover{outline:2px solid var(--accent);outline-offset:2px}.gameCard__select{position:absolute;z-index:3;top:9px;left:9px;width:18px;height:18px;accent-color:var(--accent)}.card__status{position:absolute;z-index:2;top:8px;left:8px;display:flex;align-items:center;gap:5px;background:#111c;color:#fff;padding:3px 8px;border-radius:999px;font-size:11px;backdrop-filter:blur(8px);pointer-events:none}.card__status i{width:5px;height:5px;border-radius:50%;background:var(--accent)}.card__status .dot--completed{background:#70c58e}.card__status .dot--shelved{background:var(--warning)}.card__stale{position:absolute;right:7px;bottom:7px;z-index:3;background:#111c;color:var(--warning);padding:5px;border-radius:6px;display:flex;pointer-events:none}.card__launch{position:absolute;z-index:3;right:12px;bottom:12px;width:36px;height:36px;border-radius:50%;background:var(--accent);color:white;display:grid;place-items:center;opacity:0;transform:translateY(5px);transition:opacity var(--t-fast),transform var(--t-fast);box-shadow:0 6px 20px #0006}.card__cover:hover .card__launch,.card__cover:focus-within .card__launch{opacity:1;transform:none}.card__name{display:block;width:100%;text-align:left;margin:10px 0 6px;font-size:13px;font-weight:500}.card__meta,.card__meta span{display:flex;align-items:center;gap:5px;min-width:0}.card__meta{justify-content:space-between;font-size:11px;color:var(--text-faint)}.card__meta>span:first-child{overflow:hidden;white-space:nowrap}.card__resources{gap:9px!important}.card__missing{display:flex;align-items:center;gap:4px;color:var(--warning);font-size:11px}.card__missing button{text-decoration:underline}@container(max-width:139px){.card__resources{display:none!important}}
</style>

<style scoped>
.card__name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;line-height:1.55;min-height:3.1em;overflow-wrap:anywhere}
</style>
