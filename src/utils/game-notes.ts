import {marked} from 'marked'
/** Map rendered headings and GFM tasks to source lines, excluding code and HTML. */
export function markdownLines(text:string){
 const lines=text.split('\n'),headings:Array<{line:number;text:string;level:number}>=[],tasks:number[]=[]
 let cursor=0
 const normalize=(line:string)=>line.replace(/^(?:\s*>\s*)+/,'').trim()
 marked.walkTokens(marked.lexer(text),token=>{
  const heading=token.type==='heading'&&(token.depth===2||token.depth===3)
  const task=token.type==='list_item'&&token.task
  if(!heading&&!task)return
  const first=normalize(token.raw.split('\n')[0])
  const line=lines.findIndex((value,index)=>index>=cursor&&normalize(value)===first)
  if(line<0)return
  cursor=line+1
  if(heading)headings.push({line,text:token.text,level:token.depth})
  if(task)tasks.push(line)
 })
 return {headings,tasks}
}
export function toggleMarkdownTask(text:string,index:number){const lines=text.split('\n'),line=markdownLines(text).tasks[index];if(line===undefined)return text;lines[line]=lines[line].replace(/\[([ xX])\]/,(_,mark)=>mark===' '?'[x]':'[ ]');return lines.join('\n')}
