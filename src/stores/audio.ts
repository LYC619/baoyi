import {computed,onScopeDispose,ref,shallowRef} from 'vue'
import {defineStore} from 'pinia'
import type {VideoItem} from '@/types'
import type {AudioMetadata} from '@/utils/audio'

export interface AudioTrack {id:string;resource:VideoItem;title:string;duration:number;episode:string}
export const useAudioStore=defineStore('audio',()=>{
  const queue=shallowRef<AudioTrack[]>([]),current=shallowRef<AudioTrack|null>(null),player=shallowRef<HTMLAudioElement|null>(null)
  const playing=ref(false),position=ref(0),duration=ref(0),failure=ref(''),music=shallowRef<AudioMetadata|null>(null)
  const source=computed(()=>current.value?`baoyi://audio/${current.value.resource.id}/${current.value.episode}`:'')
  const index=computed(()=>queue.value.findIndex(track=>track.id===current.value?.id))
  const hasPrevious=computed(()=>index.value>0),hasNext=computed(()=>index.value>=0&&index.value<queue.value.length-1)
  let generation=0
  async function resume(){const own=generation;try{await player.value?.play()}catch{if(own===generation&&current.value)failure.value='无法内置播放，请重试或在详情中使用系统播放器。'}}
  async function play(track:AudioTrack,tracks?:AudioTrack[]){
    if(tracks)queue.value=[...tracks]
    if(current.value?.id===track.id){await toggle();return}
    const own=++generation
    player.value?.pause();playing.value=false;failure.value='';music.value=null;position.value=0;duration.value=track.duration;current.value=track
    try{const res=await fetch(`baoyi://audio/${track.resource.id}/${track.episode}?info=1`);const info=res.ok?await res.json():null;if(own===generation)music.value=info?.music||null}catch{}
  }
  async function toggle(){if(!current.value)return;if(player.value?.paused)await resume();else player.value?.pause()}
  function next(delta=1){const track=queue.value[index.value+delta];if(track)void play(track);else playing.value=false}
  function close(){generation++;player.value?.pause();current.value=null;queue.value=[];music.value=null;playing.value=false;position.value=0;duration.value=0;failure.value=''}
  function seek(seconds:number){if(player.value&&Number.isFinite(seconds))player.value.currentTime=Math.max(0,Math.min(duration.value,seconds))}
  async function loaded(){if(!current.value||player.value?.getAttribute('src')!==source.value)return;if(player.value&&Number.isFinite(player.value.duration))duration.value=player.value.duration;await resume()}
  function attach(value:HTMLAudioElement|null){player.value=value}
  // Privacy changes and library restore revoke media in the main process.
  const unsubscribeClosed=window.baoyi.video.preview.onClosed(close)
  const unsubscribeLibrary=window.baoyi.video.onLibraryChanged(async()=>{
    const track=current.value,own=generation
    if(!track)return
    try{
      const [item,library]=await Promise.all([window.baoyi.video.get(track.resource.id),window.baoyi.video.library(track.resource.id)])
      if(own!==generation)return
      const content=library.contents.find(value=>value.id===track.episode)
      if(!item||(track.episode&&!content)){close();return}
      queue.value=queue.value.filter(value=>value.resource.id!==item.id||!value.episode||library.contents.some(content=>content.id===value.episode))
    }catch{if(own===generation)close()}
  })
  onScopeDispose(()=>{unsubscribeClosed();unsubscribeLibrary();close()})
  return {queue,current,playing,position,duration,failure,music,source,hasPrevious,hasNext,play,toggle,next,close,seek,loaded,attach}
})
