export const PROJECT_CATEGORIES = ['软件项目', '调研写作', '资料处理', '个人事项', '其他'] as const
export const PROJECT_SOURCES = ['unknown', 'self', 'third-party', 'mixed'] as const
export const PROJECT_STATES = ['active', 'maintaining', 'paused', 'archived'] as const
export type ProjectSource = typeof PROJECT_SOURCES[number]
export type ProjectState = typeof PROJECT_STATES[number]
export interface ProjectEntry {
  id: string; label: string; type: 'path' | 'url' | 'command' | 'obsidian'; path: string
  role: string; args: string[]; cwd: string; resourceId: string
}
export interface ProjectCandidate {
  path: string; name: string; summary: string; category: string; source: ProjectSource
  version: string; entries: ProjectEntry[]; evidence: string; suggested: boolean; warnings: string[]
}
export interface ProjectItem extends Omit<ProjectCandidate, 'suggested' | 'warnings'> {
  id: string; state: ProjectState; group: string; tags: string[]; pinned: boolean; notes: string
  defaultEntryId: string; createdAt: number; updatedAt: number; lastOpenedAt: number; available: boolean
}
export type ProjectPatch = Partial<Pick<ProjectItem,'name'|'summary'|'category'|'source'|'state'|'group'|'tags'|'pinned'|'notes'|'entries'|'defaultEntryId'>>
export interface ProjectMovePlan {
  id: string; source: string; destination: string; keepLink: boolean; directory: boolean
  createdAt: number; sourceIdentity: string; affected: number; externalEntries: number; warnings: string[]
}
export interface ProjectMoveRecord {
  id: string; projectId: string; source: string; destination: string; stage: string; keepLink: boolean
  phase: 'prepared'|'copied'|'placed'|'committed'|'done'|'rolled-back'|'attention'; copied: boolean
  createdAt: number; updatedAt: number; error: string
  sourceIdentity: string; fingerprint: string; destinationIdentity?: string
}
export interface ProjectImportPreview { token: string; root: string; items: ProjectCandidate[] }
export interface ProjectApi {
  overview(id:string):Promise<ProjectOverview>
  preferences(value?:ProjectPreferences):Promise<ProjectPreferences>
  sessions(id:string):Promise<ProjectSessionSummary[]>
  createSession(id:string):Promise<ProjectSession>
  session(id:string):Promise<ProjectSession|null>
  sendMessage(id:string,text:string):Promise<ProjectSession>
  cancelMessage(id:string):Promise<void>
  applyProposal(sessionId:string,messageId:string):Promise<ProjectSession>
  onSession(callback:(session:ProjectSession)=>void):()=>void
  list(): Promise<ProjectItem[]>; get(id: string): Promise<ProjectItem|null>
  update(id: string, patch: ProjectPatch): Promise<ProjectItem>; remove(id: string): Promise<void>
  prepareImport(mode:'single'|'discover'|'file'): Promise<ProjectImportPreview|null>
  confirmImport(token:string, items:Array<{index:number;name:string;category:string;source:ProjectSource;mergeInto?:number;existingId?:string}>): Promise<{imported:number;errors:string[];warnings?:string[]}>
  rescan(id:string): Promise<ProjectCandidate>; pickPath(directory:boolean):Promise<string|null>
  addEntry(id:string,directory:boolean):Promise<ProjectItem|null>; resources():Promise<Array<{id:string;name:string;path:string;kind:string}>>
  open(id:string,entryId?:string):Promise<void>; reveal(id:string):Promise<void>
  relocate(id:string):Promise<ProjectItem|null>
  prepareMove(id:string):Promise<{destinationParent:string;name:string}|null>
  previewMove(id:string,destination:string,keepLink:boolean):Promise<{token:string;plan:ProjectMovePlan}>
  move(token:string):Promise<{item:ProjectItem;warnings:string[]}>
  moveRecords():Promise<ProjectMoveRecord[]>; recoverMove(recordId:string):Promise<string>
  onChanged(callback:()=>void):()=>void
}
export interface ProjectOverview { files:Array<{path:string;directory:boolean}>;scripts:Array<{name:string;command:string}>;git:{available:boolean;branch:string;changed:number;status:string;message:string} }
export interface ProjectPreferences { maxTurns:number; contextMessages:number; defaultSource:ProjectSource; defaultState:ProjectState }
export interface ProjectProposal { patch:ProjectPatch; before:ProjectPatch; stamp:string; applied:boolean }
export interface ProjectMessage { id:string;role:'user'|'assistant';text:string;createdAt:number;events:Array<{label:string;detail:string;error?:boolean}>;proposal?:ProjectProposal }
export interface ProjectSessionSummary { id:string;projectId:string;title:string;updatedAt:number;status:'idle'|'running'|'interrupted'|'failed' }
export interface ProjectSession extends ProjectSessionSummary { messages:ProjectMessage[];tokens:number;error:string }
