/** One FIFO for local agent modules. Cancelling queued work never starts a model call. */
export class AgentQueue {
  private pending: Array<()=>Promise<void>> = []
  private running = false
  private count = 0
  busy() { return this.count > 0 }
  run<T>(action:()=>Promise<T>, signal?:AbortSignal):Promise<T> {
    return new Promise<T>((resolve,reject)=>{
      let started=false
      const abort=()=>{
        if(started)return
        const index=this.pending.indexOf(job)
        if(index>=0){this.pending.splice(index,1);this.count--}
        signal?.removeEventListener('abort',abort)
        reject(new Error('排队任务已停止'))
      }
      const job=async()=>{
        started=true;signal?.removeEventListener('abort',abort)
        if(signal?.aborted){this.count--;reject(new Error('排队任务已停止'));return}
        try {const value=await action();this.count--;resolve(value)} catch(error){this.count--;reject(error)}
      }
      if(signal?.aborted){abort();return}
      signal?.addEventListener('abort',abort,{once:true})
      this.count++;this.pending.push(job);void this.drain()
    })
  }
  private async drain() {
    if(this.running)return
    this.running=true
    try {while(this.pending.length)await this.pending.shift()!()} finally {this.running=false}
  }
}
export const agentQueue = new AgentQueue()
