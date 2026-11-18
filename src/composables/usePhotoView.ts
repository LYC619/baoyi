import { errorMessage } from '@/utils'
import { useToast } from '@/composables/useToast'
import { computed, reactive, watch, type Ref } from 'vue'
import type { ImageType } from '@/types/image'
import type { LibraryGrouping } from '@/utils/library-grouping'
export interface PhotoView { display:'albums'|'single'; layout:'horizontal'|'vertical'|'adaptive'; grouping:LibraryGrouping; cardSize:number }
const views=reactive<Record<string,PhotoView>>({})
for(const type of ['photo','misc']) {
  let saved:Partial<PhotoView>={}
  try { saved=JSON.parse(localStorage.getItem('image-view-'+type)||'{}')||{} } catch { /* 偏好缺失或无法解析时使用当前默认视图。 */ }
  views[type]={display:saved.display==='single'||!saved.display&&type==='photo'?'single':'albums',layout:['horizontal','vertical','adaptive'].includes(saved.layout||'')?saved.layout!:'adaptive',grouping:['none','category','directory'].includes(saved.grouping||'')?saved.grouping!:'directory',cardSize:Math.min(320,Math.max(140,Number(saved.cardSize)||220))}
}
watch(views,()=>{for(const type of ['photo','misc'])try{localStorage.setItem('image-view-'+type,JSON.stringify(views[type]))}catch (cause) { useToast().error(errorMessage(cause)) }},{deep:true,flush:'sync'})
export function usePhotoView(type:Ref<ImageType|undefined>) { return computed(()=>views[type.value==='misc'?'misc':'photo']) }
