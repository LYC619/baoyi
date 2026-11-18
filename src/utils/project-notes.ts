import { latestOnly, STALE } from '../composables/latestOnly.ts'
import { errorMessage } from './index.ts'
import { emptyProjectContext, type ProjectContext } from '../types/workspace.ts'

export interface ProjectNotesApi { context(id:string):Promise<ProjectContext>; updateContext(id:string,input:ProjectContext):Promise<ProjectContext> }
const content=(v:ProjectContext)=>JSON.stringify([v.current,v.next,v.prompt,v.rules])
const copy=(v:ProjectContext):ProjectContext=>JSON.parse(JSON.stringify(v))

/** One session per editor. In-flight saves never replace text typed after sending. */
export class ProjectNotesSession {
  readonly id:string
  private api:ProjectNotesApi
  private changed:()=>void
  value=emptyProjectContext()
  saved=emptyProjectContext()
  latest:ProjectContext|null=null
  loaded=false
  loading=false
  saving=false
  composing=false
  error=''
  private timer:ReturnType<typeof setTimeout>|undefined
  private pending:Promise<boolean>|null=null
  private disposed=false
  private readContext=latestOnly(()=>this.api.context(this.id))
  constructor(id:string,api:ProjectNotesApi,changed:()=>void){this.id=id;this.api=api;this.changed=changed}
  get dirty(){return content(this.value)!==content(this.saved)}
  async load():Promise<void>{
    this.loading=true;this.changed()
    try{
      const value=await this.readContext()
      if(value===STALE||this.disposed)return
      if(!this.dirty&&!this.saving&&value.revision>=this.saved.revision){this.value=copy(value);this.saved=copy(value);this.error='';this.latest=null}
      this.loaded=true
    }catch(error){if(!this.disposed)this.error=errorMessage(error)}
    if(!this.disposed){this.loading=false;this.changed()}
  }
  edit(patch:Partial<Pick<ProjectContext,'current'|'next'|'prompt'|'rules'>>){
    this.value={...this.value,...patch};this.changed();this.schedule()
  }
  composition(active:boolean){this.composing=active;if(active)this.clearTimer();else this.schedule()}
  private clearTimer(){if(this.timer)clearTimeout(this.timer);this.timer=undefined}
  private schedule(){this.clearTimer();if(!this.composing&&!this.error&&!this.disposed)this.timer=setTimeout(()=>void this.flush(),500)}
  async flush():Promise<boolean>{
    this.clearTimer()
    if(this.pending){const ok=await this.pending;if(!ok)return false;return this.flush()}
    if(this.composing)return false
    if(!this.dirty)return true
    if(!this.loaded||this.disposed)return false
    const sent=copy(this.value);this.saving=true;this.error='';this.changed()
    this.pending=Promise.resolve().then(async()=>{
      try{
        const saved=await this.api.updateContext(this.id,sent)
        this.saved=copy(saved)
        // Only metadata advances. Keep keystrokes and IME text added during this request.
        this.value={...this.value,revision:saved.revision,updatedAt:saved.updatedAt,version:saved.version}
        this.latest=null
        return true
      }catch(error){this.error=errorMessage(error);return false}
      finally{this.saving=false;this.pending=null;this.changed()}
    })
    const ok=await this.pending
    if(ok&&this.dirty&&!this.composing&&!this.disposed)return this.flush()
    return ok
  }
  async compare(){
    try{this.latest=await this.api.context(this.id)}catch(error){this.error=errorMessage(error)}
    this.changed()
  }
  useLatest(){if(!this.latest)return;this.value=copy(this.latest);this.saved=copy(this.latest);this.latest=null;this.error='';this.changed()}
  async keepMine(){
    if(!this.latest)return false
    this.saved=copy(this.latest);this.value={...this.value,revision:this.latest.revision,updatedAt:this.latest.updatedAt};this.latest=null
    return this.flush()
  }
  dispose(){this.disposed=true;this.clearTimer()}
}
