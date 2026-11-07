export const PROJECT_CATEGORIES = ['软件项目', '调研写作', '资料处理', '个人事项', '其他'] as const
export const PROJECT_SOURCES = ['unknown', 'self', 'third-party', 'mixed'] as const
export const PROJECT_STATES = ['active', 'maintaining', 'paused', 'archived'] as const
export const PROJECT_TABS = ['timeline', 'overview', 'chat', 'entries', 'info'] as const
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
  contextPreview?:{current:string;next:string}
  git?:ProjectGitStatus
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
export interface ProjectRuleStatus {key:string;available:boolean;message:string}
export interface ProjectApplication {id:'vscode'|'cursor';name:string;path:string;available:boolean}
export interface ProjectApi {
  applications():Promise<ProjectApplication[]>
  selectApplication(id:ProjectApplication['id']):Promise<boolean>
  openApplication(projectId:string,id:ProjectApplication['id']):Promise<void>
  rules(id:string):Promise<ProjectRuleStatus[]>
  launch:import('./project-launch').ProjectLaunchApi
  overview(id:string,options?:{refresh?:boolean;repoPath?:string}):Promise<ProjectOverview>
  git(id:string,options?:{refresh?:boolean;repoPath?:string}):Promise<ProjectGitStatus>
  files(id:string,relative?:string,options?:{query?:string;cursor?:ProjectDirectoryCursor}):Promise<ProjectDirectoryPage>
  readFile(id:string,relative:string,cursor?:ProjectTextCursor):Promise<ProjectTextPage>
  openFile(id:string,relative:string):Promise<void>
  scripts(id:string,relative?:string):Promise<{scripts:ProjectScript[];warnings:string[]}>
  openTerminal(id:string,relative?:string):Promise<void>
  saveEntry(id:string,entry:ProjectEntry,expected?:ProjectEntry):Promise<ProjectItem>
  removeEntry(id:string,entryId:string,expected:ProjectEntry):Promise<ProjectItem>
  preferences(value?:ProjectPreferences):Promise<ProjectPreferences>
  sessions(id:string):Promise<ProjectSessionSummary[]>
  createSession(id:string):Promise<ProjectSession>
  organize(id:string):Promise<ProjectSession>
  summarize(id:string,kind:import('./workspace').SummaryKind,key:string):Promise<ProjectSession>
  summaries(id:string):Promise<import('./workspace').ProjectSummary[]>
  editSummary(id:string,summaryId:string,patch:{title:string;body:string}):Promise<import('./workspace').ProjectSummary>
  undoSummary(id:string,summaryId:string):Promise<{undone:boolean;reason:string}>
  resumeOrganize(sessionId:string):Promise<ProjectSession>
  selectRepository(sessionId:string,repoPath:string):Promise<ProjectSession>
  undoEvent(projectId:string,eventId:string):Promise<{undone:boolean;reason:string}>
  undoBatch(projectId:string,sessionId:string,apply?:boolean):Promise<{eligible:Array<{id:string;title:string}>;retained:Array<{id:string;title:string;reason:string}>;undone:number}>
  automation(projectId:string,enabled?:boolean):Promise<{enabled:boolean;lastHead:string;sessionId:string;error:string}>
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
export interface ProjectDirectoryCursor {offset:number;version:string}
export interface ProjectDirectoryPage {files:Array<{path:string;directory:boolean}>;total:number;next:ProjectDirectoryCursor|null}
export interface ProjectTextCursor {offset:number;line:number;version:string}
export interface ProjectTextPage {startLine:number;next:ProjectTextCursor|null;size:number;reachedStart:boolean;text:string}
export interface ProjectScript {name:string;command:string;runCommand:string|null;source:string;cwd:string}
export interface ProjectGitStatus {available:boolean;branch:string;changed:number;status:string;message:string;readAt:number;head:string;repoPath:string;candidates:string[];truncated:boolean}
export interface ProjectOverview { files:Array<{path:string;directory:boolean}>;totalFiles:number;directory:boolean;scripts:ProjectScript[];warnings:string[];git:ProjectGitStatus }
export interface ProjectPreferences { maxTurns:number; contextMessages:number; defaultSource:ProjectSource; defaultState:ProjectState; defaultTab?:typeof PROJECT_TABS[number] }
export interface ProjectProposal { patch:ProjectPatch; before:ProjectPatch; stamp:string; applied:boolean }
export interface ProjectMessage { id:string;role:'user'|'assistant';text:string;createdAt:number;events:Array<{label:string;detail:string;error?:boolean}>;proposal?:ProjectProposal }
export interface ConversationCheckpoint {version:1;through:number;lastMessageId:string;digest:string;summary:string}
export interface ProjectRepositoryScan { complete:boolean;visited:number;reasons:string[] }
export interface ProjectRepositoryState { status:'ready'|'unavailable'|'needs_selection';repoPath?:string;candidates:string[];message:string;scan?:ProjectRepositoryScan }
export interface ProjectSessionSummary { id:string;projectId:string;title:string;updatedAt:number;status:'idle'|'running'|'interrupted'|'failed';workflow?:ProjectWorkflow;repository?:ProjectRepositoryState;summary?:{kind:import('./workspace').SummaryKind;key:string} }
export interface ProjectWorkflow {
  kind:'timeline'; state:'running'|'paused'|'complete'; head:string; readComplete:boolean
  next:{head:string;offset:number;since?:string;until?:string;after?:string}|null;after?:string;repoPath?:string
}
export interface ProjectSession extends ProjectSessionSummary { messages:ProjectMessage[];tokens:number;error:string;workflow?:ProjectWorkflow;contextCheckpoint?:ConversationCheckpoint }
