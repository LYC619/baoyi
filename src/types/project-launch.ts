export interface ProjectLaunchProfile {
  id:string;projectId:string;name:string;kind:'script'|'application'|'preview'
  command:string;args:string[];cwd:string;source:'discovered'|'entry'|'manual';sourceRef:string
  port:number|null;url:string;trusted:boolean;trustStamp:string;revision:number;enabled:boolean
  createdAt:number;updatedAt:number
}
export type ProjectLaunchInput=Pick<ProjectLaunchProfile,'name'|'kind'|'command'|'args'|'cwd'|'source'|'sourceRef'|'port'|'url'|'enabled'> & {id?:string;revision?:number}
export interface ProjectLaunchPreview {
  profile:ProjectLaunchProfile;stamp:string;trusted:boolean;root:string;cwd:string;command:string;args:string[];sourceText:string
}
export interface ProjectRun {
  id:string;projectId:string;profileId:string;profileName:string;profileRevision:number;status:'starting'|'running'|'stopping'|'exited'|'failed'|'interrupted'
  startedAt:number;endedAt:number;pid:number|null;exitCode:number|null;previewUrl:string;lines:string[];error:string
}
export interface ProjectLaunchApi {
  profiles(projectId:string):Promise<ProjectLaunchProfile[]>
  save(projectId:string,input:ProjectLaunchInput):Promise<ProjectLaunchProfile>
  remove(projectId:string,id:string,revision:number):Promise<void>
  revoke(projectId:string,id:string):Promise<ProjectLaunchProfile>
  preview(projectId:string,id:string):Promise<ProjectLaunchPreview>
  start(projectId:string,id:string,approval?:{stamp:string;remember:boolean}):Promise<ProjectRun>
  runs(projectId?:string):Promise<ProjectRun[]>
  stop(id:string):Promise<void>
  openPreview(projectId:string,profileId:string,runId?:string):Promise<void>
  onRun(callback:(run:ProjectRun)=>void):()=>void
}
