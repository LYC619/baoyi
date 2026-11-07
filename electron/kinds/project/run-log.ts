import { StringDecoder } from 'node:string_decoder'

export function stripTerminalCodes(value:string):string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'')
}
export function detectPreviewUrl(line:string):string|null {
  const cleaned=stripTerminalCodes(line)
  const url=cleaned.match(/\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{1,5})(?=[\s/]|$)(\/[^\s<>"']*)?/i)
  if(url){const port=Number(url[3]);if(port>0&&port<=65535)return `${url[1].toLowerCase()}://${['0.0.0.0','[::]'].includes(url[2])?'127.0.0.1':url[2].toLowerCase()}:${port}${(url[4]||'/').replace(/[),.;]+$/,'')}`}
  const port=cleaned.match(/\b(?:listening|running|started|serving)\b.{0,60}?\bport\s*[:=]?\s*(\d{1,5})\b/i)
  return port&&Number(port[1])>0&&Number(port[1])<=65535?`http://127.0.0.1:${Number(port[1])}/`:null
}
/** Parse complete lines only; a partial chunk must not turn 5173 into port 517. */
export class ProjectRunLog {
  lines:string[]=[]
  previewUrl=''
  private pending=''
  private decoder=new StringDecoder('utf8')
  feed(chunk:Buffer):string[]{this.pending+=this.decoder.write(chunk);return this.drain(false)}
  finish():string[]{this.pending+=this.decoder.end();return this.drain(true)}
  private drain(final:boolean):string[]{
    const pieces=this.pending.split(/\r\n|\r|\n/);this.pending=final?'':pieces.pop()||''
    if(this.pending.length>32768){pieces.push(this.pending.slice(0,32768)+' [长行已截断]');this.pending=''}
    const lines=pieces.map(stripTerminalCodes).filter(Boolean)
    for(const line of lines){this.lines.push(line.slice(0,32768));this.previewUrl=detectPreviewUrl(line)||this.previewUrl}
    this.lines=this.lines.slice(-20)
    return lines
  }
}
