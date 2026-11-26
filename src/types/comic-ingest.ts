export type ComicProxy={mode:'system'|'builtin'}|{mode:'custom';url:string}
export interface ComicBrowseQuery {mode:'ranking'|'search';page:number;period?:'day'|'week'|'month'|'all';query?:string;scope?:'all'|'author'|'tag'}
export interface ComicBrowseWork {id:string;title:string;tags:string[]}
export interface ComicBrowseResult {items:ComicBrowseWork[];page:number;pages:number}
export interface ComicCatalog {
  provider:'jm';workId:string;name:string;authors:string[];description:string;tags:string[];
  publication:'ongoing'|'completed';adapterVersion:string;catalogFingerprint:string;
  chapters:Array<{id:string;title:string;order:number;pageIds:string[]}>;
  cover?:string;
}
export type ComicPhase='resolving'|'downloading'|'verifying'|'prepared'|'placed'|'indexing'|'done'
export interface ComicIngestJob {
  version:2;provider:'jm';id:string;workId:string;name:string;authors:string[];selectedChapters:string[];
  catalog:ComicCatalog;root:string;directory:string;groupId:string|null;operationId:string;requestId:string;
  status:'queued'|'running'|'paused'|'success'|'failed'|'cancelled'|'interrupted';phase:ComicPhase;
  processed:number;total:number;completedChapters:number;current:string;error:string;errorCode:string;
  resourceId:string;createdAt?:number;updatedAt:number;retryNotBefore:number;requiresRevalidation:boolean;
  adapterVersion:string;catalogFingerprint:string;manifestDigest:string;
}
export interface ComicIngestPreview {token:string;catalog:ComicCatalog;directory:string;existingId:string;existingChapters:string[]}
export type ComicJobView=Omit<ComicIngestJob,'catalog'>
export interface JobLogEntry {at:number;status:ComicIngestJob['status'];phase:string;processed:number;total:number;completedChapters:number;errorCode:string}
export interface ComicLogEntry extends JobLogEntry {phase:ComicPhase}
export interface ComicIngestApi {
  defaults():Promise<{proxy:ComicProxy}>;
  browse(query:ComicBrowseQuery,proxy:ComicProxy):Promise<ComicBrowseResult>;
  cover(workId:string,proxy:ComicProxy):Promise<string>;
  cancelBrowse():Promise<void>;
  preview(input:string,proxy:ComicProxy):Promise<ComicIngestPreview>;
  cancelPreview():Promise<void>;
  start(token:string,chapters:string[],directory:string,groupId:string|null,root?:string):Promise<string|null>;
  jobs():Promise<ComicJobView[]>;
  stop(id:string,cancel?:boolean):Promise<void>;
  retry(id:string,proxy?:ComicProxy):Promise<void>;
  revalidate(id:string,token:string,root?:string):Promise<boolean>;
  clean(id:string):Promise<void>;
  logs(id:string):Promise<ComicLogEntry[]>;
  dismiss(id:string):Promise<void>;
}
