export const DOCUMENT_TYPES = ['book', 'novel', 'paper', 'certificate', 'id_resume', 'archive_other', 'reading_other', 'reference', 'contract', 'other'] as const
export type DocumentType = string
export type DocumentSubmodule = 'archive' | 'reading'
export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  book: '书籍',
  novel: '小说',
  paper: '论文',
  certificate: '证书',
  id_resume: '简历与证件',
  archive_other: '其他',
  reading_other: '其他',
  reference: '教程与参考',
  contract: '合同',
  other: '其他'
}
export interface DocumentCategory {
  id: string
  submodule: DocumentSubmodule
  name: string
  description: string
  behavior: 'reading' | 'contract' | 'certificate' | 'other'
  order: number
}
export interface DocumentCustomGroup {
  id: string
  submodule: DocumentSubmodule
  categoryId?: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}
export const DEFAULT_DOCUMENT_CATEGORIES: DocumentCategory[] = [
  // 资料（档案类）
  { id: 'certificate', submodule: 'archive', name: '证书', description: '资格、获奖和经历凭证', behavior: 'certificate', order: 0 },
  { id: 'id_resume', submodule: 'archive', name: '简历与证件', description: '个人简历、身份证明与证件档案', behavior: 'other', order: 1 },
  { id: 'archive_other', submodule: 'archive', name: '其他', description: '尚未分类的其他档案资料', behavior: 'other', order: 2 },
  // 阅读（书架类）
  { id: 'novel', submodule: 'reading', name: '小说', description: '长篇、短篇小说等文学作品', behavior: 'reading', order: 0 },
  { id: 'book', submodule: 'reading', name: '书籍', description: '阅读型书籍、专著与技术书', behavior: 'reading', order: 1 },
  { id: 'paper', submodule: 'reading', name: '论文', description: '学术论文、研究报告', behavior: 'reading', order: 2 },
  { id: 'reading_other', submodule: 'reading', name: '其他', description: '尚未分类的阅读材料', behavior: 'reading', order: 3 }
]
export interface TextAnchor {version:1;kind:'text'|'pdf';start:number;end:number;exact:string;prefix:string;suffix:string;fingerprint:string;regions?:Array<{x:number;y:number;width:number;height:number}>;pages?:Array<{page:number;anchor:Omit<TextAnchor,'pages'>}>}
export interface ReadingLocation { page: number; offset: number;anchor?:TextAnchor }
export interface DocumentItem {
  insight?:{coreValue:string;conclusions:Array<string|null>;userEdited:boolean;revision:number}
  id: string; name: string; path: string; format: string; type: DocumentType; author: string; counterpart: string
  typeName: string; typeLocked: boolean; behavior: DocumentCategory['behavior']; editedFields: string[]
  submodule: DocumentSubmodule | null
  suggestedSubmodule?: DocumentSubmodule
  suggestedReason?: string
  customGroupId?: string
  favorite?: boolean
  sourceDir?: string
  issuedOn: string; expiresOn: string; notes: string; tags: string[]; size: number; available: boolean; readable: boolean
  readState: 'unread' | 'reading' | 'read'; position: ReadingLocation; pageCount: number; updatedAt: number; lastReadAt: number
}
export type DocumentPatch = Partial<Pick<DocumentItem, 'name' | 'type' | 'author' | 'counterpart' | 'issuedOn' | 'expiresOn' | 'notes' | 'tags' | 'readState' | 'submodule' | 'customGroupId' | 'favorite'>>
export interface DocumentImportChoice { path: string; categoryId: string | null; name?:string;author?:string;tags?:string[] }
export interface DocumentImportSuggestion { path:string;categoryId:string;name:string;author:string;tags:string[];reason:string }
export interface NovelChapter {
  index: number
  title: string
  byteOffset: number
  byteLength: number
  characterCount?: number
}

export interface NovelIndexResult {
  version: string
  encoding: string
  fileSize: number
  chapters: NovelChapter[]
  isChunked: boolean
}

export interface DocumentAnnotation { id: string; documentId: string; kind: 'bookmark' | 'excerpt'; quote: string; note: string; location: ReadingLocation; createdAt: number; updatedAt: number }
export type AnnotationInput = Omit<DocumentAnnotation, 'id' | 'documentId' | 'createdAt' | 'updatedAt'> & { id?: string }
export interface DocumentCandidate {
  path: string
  name: string
  format: string
  size: number
  existing: boolean
  suggestedSubmodule?: DocumentSubmodule
  suggestedCategoryId?: string
  suggestedReason?: string
}
export interface DocumentScan { items: DocumentCandidate[]; warnings: string[] }
export interface DocumentBatchRemoval { token:string;items:Array<{id:string;name:string;expiresAt:number;files:Array<{source:string;stored:string}>}> }
export type LinkOwner = 'project' | 'event' | 'skill' | 'experience' | 'asset'
export interface ResourceLink { id: string; ownerType: LinkOwner; ownerId: string; resourceId: string | null; annotationId: string | null; kind: string; name: string; path: string; quote: string; location: ReadingLocation | null; missing: boolean }
export interface ResourceOption { id: string; name: string; kind: string; path: string }
export interface DocumentProjectReference {
  documentId: string; annotationId: string | null; linkId: string
  projectId: string; projectName: string; ownerType: 'project' | 'event'; ownerId: string
}
export type CoverResult =
  | { state: 'ready'; key: string; png: Uint8Array }
  | { state: 'render'; key: string; token: string; format: string }
  | { state: 'unavailable'; reason: string; key?: string }
export interface DocumentCoversApi {
  get(documentId: string): Promise<CoverResult>
  source(documentId: string, token: string): Promise<{ format: string; data?: Uint8Array; size: number }>
  range(documentId: string, token: string, offset: number, length: number): Promise<Uint8Array>
  put(documentId: string, token: string, png: Uint8Array): Promise<{ stored: boolean }>
}
export interface ProjectRule { type:'path'|'entry'; value:string; label:string }
export interface ProjectContext {
  current:string; next:string; prompt:string; rules:ProjectRule[]
  version:1; revision:number; updatedAt:number
}
export const emptyProjectContext = ():ProjectContext => ({current:'',next:'',prompt:'',rules:[],version:1,revision:0,updatedAt:0})
export interface TimelineEvent {
  id: string; projectId: string; title: string; body: string; occurredAt: number; milestone: boolean; version: string
  source: 'manual' | 'git' | 'directory'; sourceKey: string; evidence: string[]; status: 'draft' | 'published' | 'dismissed'
  revised: boolean; createdAt: number; updatedAt: number
  generated?: { sessionId: string; undone: boolean; createdAt: number }
}
export type EventInput = Pick<TimelineEvent, 'title' | 'body' | 'occurredAt' | 'milestone' | 'version'> & { id?: string }
export type SummaryKind='day'|'week'|'version'
export interface ProjectSummary {id:string;projectId:string;kind:SummaryKind;key:string;title:string;body:string;sources:TimelineEvent[];stamp:string;sessionId:string;revised:boolean;stale:boolean;createdAt:number;updatedAt:number}
export type EventSuggestion = Pick<TimelineEvent, 'title' | 'body' | 'source' | 'sourceKey' | 'evidence'> & { occurredAt?: number; version?: string }
export const PERSONAL_KINDS = ['profile', 'asset', 'skill', 'experience', 'metric', 'measurement', 'todo'] as const
export type PersonalKind = typeof PERSONAL_KINDS[number]
export interface AssetRenewal { on: string; from: string; to: string; cost?: number; currency?: string }
export interface AssetRenewalInput { to?: string; cost?: number; currency?: string }
export type PersonalData = Record<string, string | number | boolean | string[] | AssetRenewal[]> & { renewals?: AssetRenewal[] }
export interface PersonalRecord { id: string; kind: PersonalKind; name: string; body: string; data: PersonalData; createdAt: number; updatedAt: number }
export type PersonalInput = Pick<PersonalRecord, 'kind' | 'name' | 'body' | 'data'> & { id?: string }
export interface WorkspaceAgentContext {documentIds?:string[];selection?:{documentId:string;quote:string;location:ReadingLocation}}
export interface EvidenceReport { source: 'git' | 'directory'; key: string; title: string; text: string; evidence: string[]; message: string; occurredAt: number; version: string; snapshot?: string }
export interface DocumentOrganizePreviewItem {
  id: string
  name: string
  submodule: DocumentSubmodule | null
  categoryName: string
  groupName: string
  source: string
  destination: string
  size: number
  status: 'ready' | 'skip' | 'conflict' | 'missing'
  reason: string
}

export interface DocumentOrganizePreview {
  total: number
  ready: number
  skip: number
  conflict: number
  missing: number
  items: DocumentOrganizePreviewItem[]
}

export interface DocumentOrganizeResult {
  total: number
  succeeded: number
  skipped: number
  failed: number
  items: Array<{
    id: string
    name: string
    source: string
    destination: string
    status: 'success' | 'failed' | 'skipped'
    error?: string
    operationId?: string
  }>
}

export interface WorkspaceApi {
  skills: import('./skill-profile').SkillApi
  preferences:{get(module:PreferenceModule):Promise<ModulePreferencesValue>;save(module:PreferenceModule,value:Partial<ModulePreferencesValue>):Promise<ModulePreferencesValue>;dataDirectory():Promise<string>;chooseDataDirectory():Promise<string|null>}
  recycle:{previewBatch(ids:string[],withFiles:boolean):Promise<DocumentBatchRemoval>;confirmBatch(token:string):Promise<{removed:string[];errors:string[]}>;locations(id:string):Promise<Array<{path:string;primary:boolean;available:boolean}>>;preview(id:string,paths:string[]):Promise<{token:string;name:string;references:number;expiresAt:number;files:Array<{source:string;stored:string}>}>;confirm(token:string):Promise<void>;list():Promise<RecycleItem[]>;restore(id:string,alternate?:boolean):Promise<void>;resume(id:string):Promise<void>;cleanup():Promise<void>}
  files:{
    choose(projectId:string):Promise<{token:string;source:string}|null>
    preview(token:string,mode:'link'|'copy'|'move',target:'project'|'library',name?:string):Promise<{token:string;source:string;destination:string;mode:'link'|'copy'|'move';size:number}>
    confirm(token:string):Promise<{documentId:string;state:string}>
    operations(projectId:string):Promise<Array<{id:string;source:string;destination:string;mode:string;state:string;error:string}>>
    recover(id:string):Promise<{state:string}>
  }
  documents: {
    covers: DocumentCoversApi
    categories(submodule?: DocumentSubmodule): Promise<DocumentCategory[]>
    saveCategory(input: Omit<DocumentCategory, 'id' | 'submodule'> & { id?: string; submodule?: DocumentSubmodule }): Promise<DocumentCategory>
    removeCategory(id: string, target?: string): Promise<void>
    customGroups(submodule?: DocumentSubmodule, categoryId?: string): Promise<DocumentCustomGroup[]>
    saveCustomGroup(input: { id?: string; submodule: DocumentSubmodule; categoryId?: string; name: string; sortOrder?: number }): Promise<DocumentCustomGroup>
    removeCustomGroup(id: string): Promise<void>
    moveToSubmodule(id: string, targetSubmodule: DocumentSubmodule, targetCategoryId?: string): Promise<DocumentItem>
    list(options?: { submodule?: DocumentSubmodule; uncategorized?: boolean; customGroupId?: string }): Promise<DocumentItem[]>
    get(id: string): Promise<DocumentItem | null>
    update(id: string, patch: DocumentPatch): Promise<DocumentItem>
    prepareImport(directory: boolean, categoryId?: string): Promise<(DocumentScan & { token: string; categoryId: string }) | null>
    analyzeImport(token:string,path:string):Promise<DocumentImportSuggestion>
    confirmImport(token: string, paths: string[], categoryId?: string, submodule?: DocumentSubmodule | null, customGroupId?: string, choices?: DocumentImportChoice[]): Promise<{ imported: number; errors: string[];insightStatus?:string }>
    remove(id: string): Promise<void>; relocate(id: string): Promise<DocumentItem | null>; open(id: string): Promise<void>; reveal(id: string): Promise<void>
    content(id: string): Promise<{ format: string; text: string; data?: Uint8Array; isLarge?: boolean; size?: number }>
    textIndex(id: string, encoding?: string): Promise<NovelIndexResult>
    searchText(id:string,query:string,page?:number,start?:number,encoding?:string):Promise<{page:number;start:number;occurrence:number}|null>
    textSlice(id: string, byteOffset: number, byteLength: number, encoding?: string): Promise<{ text: string; byteOffset: number; byteLength: number }>
    pdfRange(id: string, offset: number, length: number): Promise<Uint8Array>
    position(id: string, location: ReadingLocation, pageCount: number): Promise<void>
    annotations(id: string): Promise<DocumentAnnotation[]>; annotate(id: string, input: AnnotationInput): Promise<DocumentAnnotation>
    removeAnnotation(id: string, annotationId: string): Promise<void>; export(id: string, ids: string[], obsidian?: boolean): Promise<string | null>; markdown(id: string, ids: string[]): Promise<string>
    pickDirectory(): Promise<string | null>
    previewOrganize(options: { rootDir: string; mode: 'copy' | 'move'; submodule?: DocumentSubmodule; useCustomGroups?: boolean }): Promise<DocumentOrganizePreview>
    executeOrganize(options: { rootDir: string; mode: 'copy' | 'move'; submodule?: DocumentSubmodule; useCustomGroups?: boolean; selectedIds?: string[] }): Promise<DocumentOrganizeResult>
    organizeHistory(): Promise<any[]>
    undoOrganize(operationId: string): Promise<{ undone: boolean; reason?: string }>
  }
  links: {
    projectReferences(documentIds: string[]): Promise<DocumentProjectReference[]>
    list(owner: LinkOwner, id: string): Promise<ResourceLink[]>; add(owner: LinkOwner, id: string, resourceId: string, annotationId?: string): Promise<ResourceLink>
    remove(owner: LinkOwner, id: string, linkId: string): Promise<void>; resources(): Promise<ResourceOption[]>
    backlinks(resourceId: string): Promise<Array<{ ownerType: LinkOwner; ownerId: string; name: string; projectId?: string }>>
  }
  timeline: {
    context(id: string): Promise<ProjectContext>; updateContext(id: string, patch: ProjectContext): Promise<ProjectContext>
    events(id: string): Promise<TimelineEvent[]>; save(id: string, input: EventInput): Promise<TimelineEvent>
    publish(id: string, eventId: string): Promise<void>; dismiss(id: string, eventId: string): Promise<void>; remove(id: string, eventId: string): Promise<void>
    check(id: string): Promise<EvidenceReport>; generate(id: string, ai: boolean): Promise<TimelineEvent | import('./project').ProjectSession | null>; cancel(id: string): Promise<void>
    export(id: string): Promise<string | null>
  }
  personal: {
    chooseAvatar(): Promise<string | null>
    captureState(name:string,unit:string,value:number,date:string,metricId?:string):Promise<PersonalRecord>
    list(kind?: PersonalKind): Promise<PersonalRecord[]>; save(input: PersonalInput): Promise<PersonalRecord>; remove(id: string): Promise<void>
    renew(id: string, input: AssetRenewalInput): Promise<PersonalRecord>
    snooze(id: string, until: string | null): Promise<PersonalRecord>
    overview(): Promise<{ counts: Record<string, number> }>
  }
  onChanged(callback: () => void): () => void
}
export type PreferenceModule='document'|'personal'|'project'
export interface ModulePreferencesValue {profileId:string;instructions:string;fontSize:number;pdfZoom:number;defaultCategory:string;defaultTags:string[];remindDays:number;showCompleted:boolean;showCounts:boolean;assetCategories:string[];experienceCategories:string[]}
export const DEFAULT_MODULE_PREFERENCES:ModulePreferencesValue={profileId:'',instructions:'',fontSize:17,pdfZoom:1,defaultCategory:'',defaultTags:[],remindDays:30,showCompleted:true,showCounts:true,assetCategories:['服务','AI 服务','VPS','域名','软件授权','会员','设备保修','证件','其他'],experienceCategories:['经历','奖项','证书','成果']}
export interface RecycleItem {id:string;documentId:string;name:string;createdAt:number;expiresAt:number;state:string;error:string;restoring?:boolean;files:Array<{source:string;stored:string;state:string}>}
