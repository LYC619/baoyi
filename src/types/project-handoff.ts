import type {ProjectContext} from './workspace'
import type {ProjectGitStatus} from './project'
export interface ProjectHandoffSnapshot {
  projectId:string;name:string;git:ProjectGitStatus;context:ProjectContext
  rules:Array<{label:string;path:string;content:string;hash:string;truncated:boolean;warning:string}>
  readAt:number;warnings:string[]
}
export interface ProjectHandoffPreview {
  token:string;stamp:string;snapshot:ProjectHandoffSnapshot;localPrompt:string
  configured:boolean;provider:string;remembered:boolean;includeRules:boolean
}
export interface ProjectHandoffResult {sessionId:string;projectId:string;contextRevision:number;goal:string;facts:string[];constraints:string[];prompt:string;acceptance:string[]}
