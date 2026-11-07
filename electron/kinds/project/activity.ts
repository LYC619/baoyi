import { workspaceBusy } from '../../workspace/activity.ts'
let busy=false
let runsBusy:(id?:string)=>boolean=()=>false
export function observeProjectRuns(read:(id?:string)=>boolean){runsBusy=read}
export function assertProjectRunsStopped(id?:string){if(runsBusy(id))throw new Error('请先停止正在运行的项目命令，再移动、移除项目或恢复资料库')}
export const projectLibraryBusy=()=>busy
export function assertProjectIdle():void{if(busy||workspaceBusy())throw new Error('项目操作正在进行，请完成后重试')}
export async function projectOperation<T>(fn:()=>Promise<T>):Promise<T>{assertProjectIdle();busy=true;try{return await fn()}finally{busy=false}}
