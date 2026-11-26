export type MusicSource='netease'|'tencent'|'kuwo'|'joox'|'bilibili'
export interface MusicTrack {key:string;id:string;source:MusicSource;title:string;artists:string[];album:string;picId:string;urlId:string;lyricId:string}
export interface MusicJob {id:string;track:MusicTrack;status:'running'|'completed'|'failed'|'cancelled'|'interrupted';received:number;total:number;message:string;resourceId?:string;file?:string;directory:string}
export interface MusicPreview {url:string;title:string;artist:string;album:string;key:string}
export interface MusicApi {
  search(source:MusicSource,query:string,page?:number):Promise<MusicTrack[]>
  preview(key:string):Promise<MusicPreview>
  directory():Promise<string>
  pickDirectory():Promise<string|null>
  download(key:string):Promise<MusicJob>
  jobs():Promise<MusicJob[]>
  cancel(id:string):Promise<void>
  retry(id:string):Promise<MusicJob>
  onChanged(cb:(jobs:MusicJob[])=>void):()=>void
}
