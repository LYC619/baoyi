import type {WorkspaceSession,ReadingLocation} from '../types/workspace.ts'
export interface WorkspaceSource {documentId:string;name:string;quote:string;location:ReadingLocation;line?:number;label:string}
/** Never turn model-written citations into evidence: cards come from actual successful tool results. */
export function workspaceSources(session:WorkspaceSession,messageId:string):WorkspaceSource[] {
  const message=session.messages.find(m=>m.id===messageId);if(!message||message.role!=='assistant')return []
  const result:WorkspaceSource[]=[],selection=session.context.selection
  if(selection)result.push({documentId:selection.documentId,name:'当前选文',quote:selection.quote,location:selection.location,label:`选文 · 第 ${selection.location.page} 页/段`})
  for(const event of message.events){
    if(event.error||event.label!=='read_document_text 结果')continue
    try {
      const data=JSON.parse(event.detail),source=data.source,isPage=Number.isSafeInteger(source?.page)&&source.page>0,isLine=Number.isSafeInteger(source?.startLine)&&source.startLine>0
      if(typeof source?.documentId!=='string'||typeof data.text!=='string'||!isPage&&!isLine)continue
      result.push({documentId:source.documentId,name:typeof source.name==='string'?source.name:'资料',quote:data.text,location:{page:isPage?source.page:1,offset:0},...(isLine?{line:source.startLine}:{}),label:isPage?`第 ${source.page} 页`:`第 ${source.startLine} 行起`})
    }catch{/* Incomplete or invalid tool output is still visible in the process log, not a source card. */}
  }
  return result
}
