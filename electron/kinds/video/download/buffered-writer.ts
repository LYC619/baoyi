/** Bound small network chunks to one 128 KiB disk write. Call flush before checkpoints. */
export function bufferedWriter(write:(bytes:Buffer)=>Promise<void>){
  const buffer=Buffer.allocUnsafe(128*1024)
  let used=0
  const flush=async()=>{if(used){await write(buffer.subarray(0,used));used=0}}
  return {flush,async write(bytes:Buffer){
    let offset=0
    while(offset<bytes.length){
      const length=Math.min(buffer.length-used,bytes.length-offset)
      bytes.copy(buffer,used,offset,offset+length);used+=length;offset+=length
      if(used===buffer.length)await flush()
    }
  }}
}
