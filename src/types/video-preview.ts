export interface VideoPreviewAsset {key:string;name:string;episodeId:string;label:string;quality:string;duration:number;format:string}
export interface VideoPreviewSelection {resourceId:string;title:string;assets:VideoPreviewAsset[]}
export interface VideoPreviewSession {token:string;url:string;title:string;asset:VideoPreviewAsset}
export interface VideoFrameState {id:string;status:'queued'|'running'|'ready'|'failed';url:string;times:number[];duration:number;partial:boolean;message:string;completed:number;audioTracks:number|null;videoCodec:string}
export interface VideoPreviewApi {
  onClosed(callback:()=>void):()=>void
  choices(resourceId:string,episodeId?:string):Promise<VideoPreviewSelection>
  open(resourceId:string,assetKey:string):Promise<VideoPreviewSession>
  release(token:string):Promise<void>
  external(token:string,custom?:boolean):Promise<void>
  pickPlayer():Promise<string|null>
  copyPath(token:string):Promise<void>
  reveal(token:string):Promise<void>
  frames(token:string,retry?:boolean):Promise<VideoFrameState>
  releaseFrames(id:string):Promise<void>
  onFrames(callback:(state:VideoFrameState)=>void):()=>void
  frameCache():Promise<{bytes:number;items:number;limit:number}>
  clearFrames():Promise<void>
}
