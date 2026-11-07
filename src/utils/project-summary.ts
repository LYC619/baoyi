import type {TimelineEvent,SummaryKind} from '../types/workspace.ts'
export function summaryGroup(event:TimelineEvent,kind:SummaryKind):string {
  if(kind==='version')return event.version
  const date=new Date(event.occurredAt)
  if(kind==='week')date.setDate(date.getDate()-(date.getDay()+6)%7)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
