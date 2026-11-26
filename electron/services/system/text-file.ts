import fs from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'

export interface TextCursor {offset:number;line:number;version:string}
const textFile=/\.(?:md|markdown|txt|json|jsonc|ts|tsx|js|jsx|mjs|cjs|vue|css|scss|html|py|rs|go|java|cs|cpp|c|h|toml|yaml|yml|xml|ini|cfg|sh|ps1|bat|cmd|sql)$/i
/** Caller must authorize this exact path. This reader never discovers sibling files. */
export async function inspectTextFile(target:string,cursor?:TextCursor){
  const stat=await fs.stat(target)
  if(!stat.isFile())throw new Error('请选择文本文件，不能读取目录')
  if(!textFile.test(target)&&!/(?:README|LICENSE|Makefile|Dockerfile)$/i.test(target))throw new Error('此格式不能作为文本读取，请通过资料阅读工具打开')
  const version=createHash('sha256').update(`${target}\0${stat.size}\0${stat.mtimeMs}`).digest('hex')
  if(cursor&&(cursor.version!==version||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>stat.size||!Number.isSafeInteger(cursor.line)||cursor.line<1))throw new Error('续读位置已失效，请重新读取文件')
  return {target,stat,version}
}
export async function readTextFilePage(target:string,start=1,cursor?:TextCursor){
  const {stat,version}=await inspectTextFile(target,cursor)
  if(!Number.isInteger(start)||start<1)throw new Error('起始行无效')
  let offset=cursor?.offset||0,line=cursor?.line||1,startLine=line,text='',captured=0,scanned=0
  const stream=createReadStream(target,{encoding:'utf8',start:offset,highWaterMark:16384})
  try {
    for await(const chunk of stream)for(const char of chunk as string){
      if(char==='\0')throw new Error('文件含二进制内容，不能作为文本读取')
      if(text.length>=4500||captured>=160||scanned>=32*1024*1024)return {startLine,next:{offset,line,version},size:stat.size,reachedStart:line>=start,text}
      const bytes=Buffer.byteLength(char);offset+=bytes;scanned+=bytes
      if(line>=start||cursor){if(!text)startLine=line;text+=char;if(char==='\n')captured++}
      if(char==='\n')line++
    }
    return {startLine,next:null,size:stat.size,reachedStart:line>=start,text}
  }finally{stream.destroy()}
}
