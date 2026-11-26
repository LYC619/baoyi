/** One model run at a time. Interactive requests go before the next background chunk. */
export class ArchiveRunSlot {
  private active=false
  private queue:Array<{priority:'interactive'|'background';start:()=>void;signal?:AbortSignal;abort:()=>void}>=[]
  run<T>(action:()=>Promise<T>,options:{priority?:'interactive'|'background';signal?:AbortSignal}={}):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      if(options.signal?.aborted){reject(options.signal.reason);return}
      const job={priority:options.priority||'interactive' as 'interactive'|'background',signal:options.signal,abort:()=>{this.queue=this.queue.filter(value=>value!==job);reject(options.signal!.reason)},start:()=>{
        options.signal?.removeEventListener('abort',job.abort);this.active=true
        Promise.resolve().then(()=>{options.signal?.throwIfAborted();return action()}).then(resolve,reject).finally(()=>{this.active=false;this.next()})
      }}
      options.signal?.addEventListener('abort',job.abort,{once:true});this.queue.push(job);this.next()
    })
  }
  private next(){if(this.active)return;const index=this.queue.findIndex(job=>job.priority==='interactive'),job=this.queue.splice(index<0?0:index,1)[0];job?.start()}
}
export const archiveRunSlot=new ArchiveRunSlot()
