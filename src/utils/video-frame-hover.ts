/** Starting the expensive operation belongs inside this timer, never before it. */
export function videoFrameHover(action:()=>void,timers:{set:(action:()=>void,ms:number)=>unknown;clear:(id:any)=>void}={set:(action,ms)=>setTimeout(action,ms),clear:id=>clearTimeout(id)}){
  let pending:unknown
  return {
    enter(){if(pending!==undefined)timers.clear(pending);pending=timers.set(()=>{pending=undefined;action()},250)},
    leave(){if(pending!==undefined)timers.clear(pending);pending=undefined},
  }
}
