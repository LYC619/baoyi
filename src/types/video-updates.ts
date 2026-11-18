export interface VideoUpdateRow {
  id:string; title:string; source:boolean; newEpisodes:number; missingFiles:number
  status:'complete'|'failed'; message:string
}
export interface VideoUpdateState {
  running:boolean; checked:number; total:number; rows:VideoUpdateRow[]; finishedAt:number; cancelled:boolean
}
