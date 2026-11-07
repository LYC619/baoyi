export interface VideoTransferSettings { video_download_concurrency?: number; video_download_connections?: number }
const bounded=(value:unknown,fallback:number,max:number)=>typeof value==='number' && Number.isInteger(value) && value>=1 && value<=max ? value : fallback
export function videoTransferOptions(settings:VideoTransferSettings) {
  return {concurrency:bounded(settings.video_download_concurrency,2,4),connections:bounded(settings.video_download_connections,4,8)}
}
