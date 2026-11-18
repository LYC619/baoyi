import { errorMessage } from '@/utils'
import { useToast } from '@/composables/useToast'
import {computed,onScopeDispose,ref,shallowRef} from 'vue'
import {defineStore} from 'pinia'
import type {AudioMetadata, AudioTrack} from '@/utils/audio'
import type {MusicPreview} from '@/types/music'

export type {AudioTrack} from '@/utils/audio'
export const useAudioStore=defineStore('audio',()=>{
  const queue=shallowRef<AudioTrack[]>([]),current=shallowRef<AudioTrack|null>(null),player=shallowRef<HTMLAudioElement|null>(null)
  const online=shallowRef<MusicPreview|null>(null)
  const playing=ref(false),position=ref(0),duration=ref(0),failure=ref(''),music=shallowRef<AudioMetadata|null>(null)
  const source=computed(()=>online.value?.url||(current.value?`baoyi://audio/${current.value.resource.id}/${current.value.episode}`:''))
  const index=computed(()=>queue.value.findIndex(track=>track.id===current.value?.id))
  const hasPrevious=computed(()=>index.value>0),hasNext=computed(()=>index.value>=0&&index.value<queue.value.length-1)
  let generation=0
  async function resume(){const own=generation;try{await player.value?.play()}catch{if(own===generation&&(current.value||online.value))failure.value=online.value?'试听无法播放，请重新搜索或换来源重试。':'无法内置播放，请重试或在详情中使用系统播放器。'}}
  async function play(track:AudioTrack,tracks?:AudioTrack[]){
    if(track.available===false){failure.value='曲目文件缺失或磁盘未连接';return}
    online.value=null
    if(tracks)queue.value=tracks.filter(track=>track.available!==false)
    if(current.value?.id===track.id){await toggle();return}
    const own=++generation
    player.value?.pause();playing.value=false;failure.value='';music.value=null;position.value=0;duration.value=track.duration;current.value=track
    try{const info=await window.baoyi.video.audioInfo(track.resource.id,track.episode);if(own===generation)music.value=info?.music||null}catch (cause) { if (own === generation) useToast().error(errorMessage(cause)) }
  }
  function playOnline(track:MusicPreview){generation++;player.value?.pause();current.value=null;queue.value=[];online.value=track;music.value={title:track.title,artist:track.artist,album:track.album,track:0,sampleRate:0,bitDepth:0,bitRate:0};playing.value=false;failure.value='';position.value=0;duration.value=0}
  async function toggle(){if(!current.value&&!online.value)return;if(player.value?.paused)await resume();else player.value?.pause()}
  function next(delta=1){const track=queue.value[index.value+delta];if(track)void play(track);else playing.value=false}
  function close(){generation++;player.value?.pause();current.value=null;online.value=null;queue.value=[];music.value=null;playing.value=false;position.value=0;duration.value=0;failure.value=''}
  function seek(seconds:number){if(player.value&&Number.isFinite(seconds))try{player.value.currentTime=Math.max(0,Math.min(duration.value,seconds));position.value=player.value.currentTime}catch (cause) { useToast().error(errorMessage(cause)) }}
  async function loaded(){if((!current.value&&!online.value)||player.value?.getAttribute('src')!==source.value)return;if(player.value&&Number.isFinite(player.value.duration))duration.value=player.value.duration;await resume()}
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
    }catch (cause) { if (own === generation) { close(); useToast().error(errorMessage(cause)) } }
  })
  onScopeDispose(()=>{unsubscribeClosed();unsubscribeLibrary();close()})
  return {queue,current,online,playing,position,duration,failure,music,source,hasPrevious,hasNext,play,playOnline,toggle,next,close,seek,loaded,attach}
})
