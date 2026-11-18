export const AUDIO_EXTENSIONS = new Set(['.mp3','.flac','.wav','.m4a','.aac','.ogg','.opus','.wma','.aiff','.aif','.ape','.alac'])
export function isAudioFile(file: string): boolean { return AUDIO_EXTENSIONS.has(file.slice(file.lastIndexOf('.')).toLowerCase()) }
export interface AudioMetadata { title:string; artist:string; album:string; track:number; sampleRate:number; bitDepth:number; bitRate:number }

import type { VideoItem } from '../types'
import type { VideoWorkLibrary } from '../types/video-workflow'
export interface AudioTrack { id:string; resource:VideoItem; title:string; duration:number; episode:string; available?:boolean }
export function audioTracks(item:VideoItem,library:VideoWorkLibrary):AudioTrack[] {
  if(library.contents.length)return library.contents.map(ep=>({id:ep.id,resource:item,title:ep.title||item.name_zh||item.file_name,episode:ep.id,duration:ep.duration_sec,
    available:!!ep.path&&!ep.assets.some(a=>a.path.toLowerCase()===ep.path.toLowerCase()&&a.state!=='present')}))
  return [{id:item.id,resource:item,title:item.name_zh||item.file_name,episode:'',duration:item.duration_sec,
    available:isAudioFile(item.parts[0]?.path||item.path)&&!library.assets.some(a=>a.path===(item.parts[0]?.path||item.path)&&a.state!=='present')}]
}
