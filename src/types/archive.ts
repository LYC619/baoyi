export interface ArchiveSource {
  id:string;kind:string;name:string;path:string;summary:string;tags:string[];updatedAt:number
  subtype?:string;page?:number;line?:number
}
export interface ArchiveAction {
  id:string;sessionId:string;targetId:string;name:string;kind:string;reason:string
  before:Record<string,unknown>|null;after:Record<string,unknown>;state:'applied'|'undone';createdAt:number
}
export interface ArchiveSession {id:string;title:string;started_at:number;last_active:number;message_count:number;model:string;parent_session_id?:string}
export interface ArchiveMessage {id:number;role:string;content:string|null;tool_calls?:any[];tool_call_id?:string;tool_name?:string;timestamp:number}
export interface ArchiveEvent {sessionId:string;event:string;[key:string]:any}
export interface ArchiveRun {sessionId:string;status:'starting'|'running'|'completed'|'interrupted'|'failed';text:string;error:string;startedAt:number;updatedAt:number}
export interface ArchiveMemory {memory:string[];user:string[];limits:{memory:number;user:number}}
export interface ArchiveApi {
  insights:import('./document-insight').DocumentInsightApi
  projectHandoffPreview(id:string,includeRules?:boolean):Promise<import('./project-handoff').ProjectHandoffPreview>
  projectHandoffGenerate(input:{token:string;stamp:string;remember:boolean}):Promise<import('./project-handoff').ProjectHandoffResult>
  projectHandoffCancel(id:string):Promise<void>
  projectHandoffAdopt(id:string,revision:number,prompt:string):Promise<import('./workspace').ProjectContext>
  status():Promise<{engine:string;configured:boolean;model:string;active:ArchiveRun|null;profiles:Array<{id:string;name:string;model:string}>}>
  sessions(query?:string):Promise<ArchiveSession[]>
  session(id:string):Promise<{session:ArchiveSession;messages:ArchiveMessage[];lastRun:ArchiveRun|null} | null>
  send(input:{sessionId?:string;text:string;contextIds?:string[];profileId?:string}):Promise<ArchiveRun>
  cancel():Promise<void>
  steer(text:string):Promise<boolean>
  rename(id:string,title:string):Promise<void>
  archive(id:string):Promise<void>
  memory():Promise<ArchiveMemory>
  editMemory(input:{target:'memory'|'user';action:'add'|'replace'|'remove';content?:string;oldText?:string}):Promise<ArchiveMemory>
  skills():Promise<any>
  actions(sessionId?:string):Promise<ArchiveAction[]>
  undo(id:string):Promise<{undone:boolean;reason:string}>
  source(id:string):Promise<ArchiveSource>
  onEvent(callback:(event:ArchiveEvent)=>void):()=>void
}
