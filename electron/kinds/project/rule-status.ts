import fs from 'node:fs/promises'
import type {ProjectItem,ProjectRuleStatus} from '../../../src/types/project.ts'
import type {ProjectRule} from '../../../src/types/workspace.ts'
import {resolveProjectFile} from './workspace.ts'
export async function projectRuleStatus(item:ProjectItem,rules:ProjectRule[]):Promise<ProjectRuleStatus[]>{
  return Promise.all(rules.map(async rule=>{
    try{
      if(rule.type==='path'){
        const file=await resolveProjectFile(item.path,rule.value)
        if(!(await fs.stat(file)).isFile())throw new Error('不是文件')
      }else{
        const entry=item.entries.find(value=>value.id===rule.value)
        if(!entry||entry.type==='command')throw new Error('入口已移除或不能作为规则')
        if(entry.type==='path')await fs.stat(entry.path)
      }
      return {key:rule.type+':'+rule.value,available:true,message:rule.type==='entry'?'只打开入口，不读取外部正文':'可用'}
    }catch(error){return {key:rule.type+':'+rule.value,available:false,message:(error as NodeJS.ErrnoException).code==='ENOENT'?'文件已移走或离线':(error as Error).message}}
  }))
}
