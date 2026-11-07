import path from 'node:path'
import type { ProjectContext,ProjectRule } from '../../../src/types/workspace.ts'
import { keys } from '../../workspace/validation.ts'

// Preserve spacing: these are user-authored notes, not identifiers.
function note(value:unknown,label:string,max:number):string {
  if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new Error(label+'无效或超长')
  return value
}
export function validateProjectRules(value:unknown):ProjectRule[] {
  if(!Array.isArray(value)||value.length>20)throw new Error('规则链接最多 20 项')
  return value.map(rule=>{
    keys(rule,['type','value','label'])
    const target=note(rule.value,'规则路径',2048).trim(),label=note(rule.label,'规则名称',160).trim()
    if(!target||!label||!['path','entry'].includes(rule.type))throw new Error('规则链接无效')
    if(rule.type==='path'&&(path.win32.isAbsolute(target)||path.posix.isAbsolute(target)||target.includes(':')||target.split(/[\\/]/).some(p=>p==='..'||/^\.env(?:\.|$)|credential|secret|password|cookie|token|密钥|密码|私钥|^id_(?:rsa|ed25519)|\.(?:pem|key|p12|pfx)$/i.test(p))))throw new Error('规则请使用项目内非敏感文件的相对路径')
    return {type:rule.type,value:target,label}
  })
}
export function validateProjectContext(input:ProjectContext):ProjectContext {
  keys(input,['current','next','prompt','rules','version','revision','updatedAt'])
  if(input.version!==1||!Number.isSafeInteger(input.revision)||input.revision<0||input.revision===Number.MAX_SAFE_INTEGER)throw new Error('便签版本无效，请重新载入')
  return {current:note(input.current,'当前情况',4000),next:note(input.next,'下一步',2000),prompt:note(input.prompt,'关键 Prompt',8000),rules:validateProjectRules(input.rules),version:1,revision:input.revision,updatedAt:input.updatedAt}
}
