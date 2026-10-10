let busy=false
export const projectLibraryBusy=()=>busy
export function assertProjectIdle():void{if(busy)throw new Error('项目操作正在进行，请完成后重试')}
export async function projectOperation<T>(fn:()=>Promise<T>):Promise<T>{assertProjectIdle();busy=true;try{return await fn()}finally{busy=false}}
