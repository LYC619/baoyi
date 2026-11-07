import type { SqlDb } from '../services/schema.ts'
import type { AgentTool } from '../services/agent/loop.ts'
import type { ProjectSession, ProjectItem, ProjectRepositoryState } from '../../src/types/project.ts'
import { projectHistory, projectCommit } from './project-history.ts'
import { AgentJournal } from './agent-journal.ts'
import { TimelineLibrary } from './timeline.ts'
import { ProjectSummaries } from './project-summaries.ts'
import {conversationContext,createConversationHistoryTool} from '../services/agent/context.ts'
import path from 'node:path'
import {projectRepoPath,nestedGitRoots} from './project-repositories.ts'
export {projectRepoPath} from './project-repositories.ts'
function checkCancelled(signal?:AbortSignal){signal?.throwIfAborted()}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }, integer = { type: 'integer' }

export function projectAgentTools(db: SqlDb, item: ProjectItem, session: ProjectSession, changed: () => void, historyMessages = session.messages, onHistoryIssue?: () => void): AgentTool[] {
  const timeline = new TimelineLibrary(db), journal = new AgentJournal(db)
  const summaries=new ProjectSummaries(db),summaryReads=new Map<string,{stamp:string;end:number;complete:boolean}>(),summaryArgs={kind:{type:'string',enum:['day','week','version']},key:string}
  const remember=(page:any)=>{const key=JSON.stringify([page.kind,page.key]),prior=summaryReads.get(key);if(page.start===0||prior&&prior.stamp===page.stamp&&prior.end===page.start)summaryReads.set(key,{stamp:page.stamp,end:page.end,complete:page.next===null})}
  for(const message of session.messages)for(const event of message.events)if(event.label==='read_project_summary_sources 结果'&&!event.error)try{remember(JSON.parse(event.detail))}catch{}
  const observed = new Map<string, string>()
  const observedRoots = new Map<string, string>()
  const commitSources = new Map<string, {sha:string;at:string;subject:string;repoPath:string}>()
  for (const message of session.messages) for (const event of message.events) if (event.label === 'read_project_history 结果') {
    try {
      const page = JSON.parse(event.detail), repoPath = typeof page.repoPath === 'string' ? page.repoPath : ''
      for (const commit of page.commits || []) {
        observed.set(commit.sha, commit.at); observedRoots.set(commit.sha, repoPath)
        commitSources.set(commit.sha, {sha:commit.sha,at:commit.at,subject:commit.subject || '',repoPath})
      }
    } catch { /* Older traces may have been clipped. Re-read them through the tool. */ }
  }
  const blocked = (state: ProjectRepositoryState) => {
    session.repository = state
    if (session.workflow) session.workflow.state = 'paused'
    onHistoryIssue?.()
    return JSON.stringify({ available:false, reason:state.status, candidates:state.candidates, scan:state.scan, error:state.message })
  }
  return [
    {name:'read_project_summary_sources',description:'读取天、周或版本摘要所需的原始事件全文及其提交依据，不读取其他摘要。day 的 key 为 YYYY-MM-DD，week 为周一日期，version 为版本原名（未标记为""）。text 为原始事件 JSON 分段，next 非空时原样传 start 并带 stamp 继续；必须读完才能保存摘要。',maxOutput:20000,parameters:object({...summaryArgs,start:integer,stamp:string},['kind','key']),execute:async a=>{
      const source=summaries.sources(item.id,a.kind,a.key),raw=JSON.stringify(source.events),start=a.start??0,key=JSON.stringify([a.kind,a.key]),prior=summaryReads.get(key)
      if(!Number.isSafeInteger(start)||start<0||start>raw.length)throw new Error('来源续读位置无效')
      if(start>0&&(a.stamp!==source.stamp||prior?.stamp!==source.stamp||prior.end!==start))throw new Error('来源已变化或未连续读取，请从起点重新读取')
      const end=Math.min(start+14000,raw.length),page={kind:a.kind,key:a.key,stamp:source.stamp,start,end,next:end<raw.length?end:null,text:raw.slice(start,end),count:source.events.length};remember(page);return JSON.stringify(page)
    }},
    {name:'save_project_summary',description:'将已读完整原始记录整理为实际摘要并保存，保留来源快照与会话；不会新增重复日志。不覆盖人工修订。必须传入完整读取结果的 stamp，来源变化时需重新读取。',parameters:object({...summaryArgs,title:string,body:string,stamp:string},['kind','key','title','body','stamp']),execute:async a=>{
      const read=summaryReads.get(JSON.stringify([a.kind,a.key]));if(!read?.complete||read.stamp!==a.stamp)throw new Error('请完整读取本分组的原始记录后再保存摘要')
      const summary=summaries.save(item.id,session.id,a);changed();return JSON.stringify({id:summary.id,saved:true,title:summary.title,sourceCount:summary.sources.length})
    }},
    { name: 'read_project_history', description: '读取 Git 当前分支历史的一页。优先使用会话已选仓库；默认目录不是仓库时有限搜索子仓库，仅扫描完整且唯一才自动读取。available:false 表示任务已暂停，请用户选择仓库或检查路径，不要重复尝试。后续页保留 repoPath 和 next 游标。已有日志不妨碍回顾历史。', maxOutput: 30000,
      parameters: object({ repoPath: string, limit: { ...integer, minimum: 1, maximum: 100 }, since: string, until: string, after: string, cursor: object({ head: string, offset: integer, since: string, until: string, after: string }, ['head', 'offset']) }),
      execute: async (args, signal) => {
        checkCancelled(signal)
        const selected = args.repoPath ?? (session.repository?.status === 'ready' ? session.repository.repoPath : session.workflow?.repoPath) ?? ''
        let root = await projectRepoPath(item.path, selected, signal)
        if(session.workflow?.head && session.workflow.repoPath !== undefined && path.resolve(root) !== path.resolve(item.path,session.workflow.repoPath)) throw new Error('此整理已读取另一个仓库，请在原仓库继续，或新建会话后选择其他仓库')
        let page
        const read = () => projectHistory(root, { ...args, signal, ...(session.workflow?.after ? {after:session.workflow.after} : {}) })
        try { page = await read() }
        catch (error) {
          checkCancelled(signal)
          const message = (error as Error).message
          if (/not a git repository|不是.*Git|不是.*仓库/i.test(message)) {
            if (selected) return blocked({status:'unavailable',repoPath:selected,candidates:[],message:'所选目录不是可读取的 Git 仓库，请检查路径或重新选择；本次整理已暂停。'})
            const scan = await nestedGitRoots(item.path, signal)
            const scanInfo = {complete:scan.complete,visited:scan.visited,reasons:scan.reasons}
            const paths = scan.roots.map(candidate => path.relative(item.path, candidate).split(path.sep).join('/'))
            if (scan.complete && scan.roots.length === 1) {
              root = scan.roots[0]
              try { page = await read() }
              catch (cause) {
                checkCancelled(signal)
                return blocked({status:'needs_selection',candidates:paths,scan:scanInfo,message:'发现的子目录暂时无法读取 Git 历史，请检查仓库状态并重新选择；本次整理已暂停。'})
              }
            } else {
              const detail = !scan.complete ? '子仓库搜索未完成（达到范围上限或有目录不可读）' : paths.length ? '发现多个 Git 子仓库' : '在本次搜索范围内未找到 Git 子仓库'
              return blocked({status:paths.length || !scan.complete?'needs_selection':'unavailable',candidates:paths,scan:scanInfo,message:detail+'。请在会话中选择仓库或填写已知子目录；本次整理已暂停。'})
            }
          } else throw error
        }
        const repoPath = path.relative(item.path, root).split(path.sep).join('/')
        session.repository = {status:'ready',repoPath,candidates:[],message:repoPath ? '当前仓库：'+repoPath : '当前仓库：项目根目录'}
        page.commits.forEach(c => {
          observed.set(c.sha, c.at); observedRoots.set(c.sha, repoPath)
          commitSources.set(c.sha, {...c,repoPath})
        })
        if (session.workflow) {
          session.workflow.repoPath = repoPath
          session.workflow.head = page.head; session.workflow.next = page.next
          session.workflow.readComplete = !page.next
        }
        return JSON.stringify({ available:true, repoPath, head: page.head, next: page.next, commits: page.commits })
      } },
    { name: 'read_project_commit', description: '读取提交说明及文件变更统计。若历史工具返回 repoPath，续读时也传入该相对路径。提供 file 可读取该文件差异，next 非空时用 start 续读。',
      parameters: object({ sha: string, repoPath: string, file: string, start: integer }, ['sha']), execute: async (args, signal) => {
        const root = await projectRepoPath(item.path, args.repoPath ?? observedRoots.get(args.sha) ?? session.workflow?.repoPath ?? session.repository?.repoPath, signal)
        return JSON.stringify(await projectCommit(root, args.sha, args.file, args.start || 0, signal))
      } },
    { name:'read_pending_project_commits',description:'分页查询已读历史中尚未记录日志的提交编号、时间和标题摘录。内部续接不会展开全部 SHA，请用 next 作为 start 续查。可用 read_project_commit 核对完整说明。',maxOutput:18000,parameters:object({start:integer}),execute:async args=>{
      const remaining=new Set(reviewRemaining(db,session)),rows=[...commitSources.values()].filter(commit=>remaining.has(commit.sha)),start=args.start??0
      if(!Number.isSafeInteger(start)||start<0||start>rows.length)throw new Error('待整理提交分页位置无效')
      const items=rows.slice(start,start+100).map(commit=>({...commit,subject:commit.subject.slice(0,500),subjectTruncated:commit.subject.length>500}))
      const pack=()=>JSON.stringify({total:rows.length,items,next:start+items.length<rows.length?start+items.length:null})
      while(pack().length>16000&&items.length>1)items.pop()
      return pack()
    }},
    { name: 'read_project_events', description: '查询已有项目日志、当前情况与下一步。用于理解历史和避免重复写入。', maxOutput: 20000,
      parameters: object({ start: integer }), execute: async args => {
        const rows = timeline.events(item.id), start = Math.max(0, Number(args.start) || 0), events = rows.slice(start, start + 10)
        return JSON.stringify({ next: start + events.length < rows.length ? start + events.length : null, current: timeline.context(item.id), events })
      } },
    { name: 'record_project_event', description: '把已读提交整理为一条易读日志并自动保存，标明 AI 生成，可撤销。仅使用 read_project_history 实际读到的完整 SHA；重复提交不会重复写入。',
      parameters: object({ title: string, body: string, commits: { type: 'array', items: string, minItems: 1, maxItems: 100 }, version: string }, ['title', 'body', 'commits']),
      execute: async args => {
        if (!Array.isArray(args.commits) || !args.commits.length || args.commits.some((sha: string) => !observed.has(sha))) throw new Error('请先通过历史工具读取这些提交，不可填入未核对的 SHA')
        const at = Math.max(...args.commits.map((sha: string) => Date.parse(observed.get(sha)!)))
        const event = journal.record(item.id, session.id, { ...args, occurredAt: at })
        changed(); return JSON.stringify({ id: event.id, status: event.status, title: event.title, saved: true, existing: event.generated?.sessionId !== session.id, generated: event.generated })
      } },
    createConversationHistoryTool('read_session_history',historyMessages)
  ]
}

export function reviewRemaining(db: SqlDb, session: ProjectSession) {
  const read = new Set<string>()
  for (const message of session.messages) for (const event of message.events) if (event.label === 'read_project_history 结果') {
    try { JSON.parse(event.detail).commits.forEach((c: {sha:string}) => read.add(c.sha)) } catch { /* Re-readable through history tool. */ }
  }
  const saved = new Set(new TimelineLibrary(db).events(session.projectId).flatMap(e => e.evidence.map(s => /^commit:([a-f0-9]+)/.exec(s)?.[1])))
  return [...read].filter(sha => !saved.has(sha))
}

/** Bounded source index; full originals stay in the session store. */
export function projectConversationContext(session: ProjectSession, keep: number) {
  return conversationContext(session.messages,keep)
}
