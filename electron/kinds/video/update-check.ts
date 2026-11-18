import fs from 'node:fs/promises'
import type {SqlDb} from '../../services/schema.ts'
import {getVideo,listEpisodes} from './db.ts'
import {listVideoAssets} from './library.ts'
import type {VideoDownloadJob} from '../../../src/types/video-workflow.ts'
import type {VideoUpdateRow,VideoUpdateState} from '../../../src/types/video-updates.ts'
import type {VideoWorkSource} from './download/workflow.ts'

const WEEK=7*24*60*60*1000
export function weeklyCheckDue(enabled:boolean,last:number,now=Date.now()){
  return enabled&&(!Number.isFinite(last)||last<=0||now-last>=WEEK||last>now)
}
export function createVideoUpdateCheck(deps:{db:SqlDb;hidden:()=>boolean;ready:()=>boolean;
  resolve:(code:string,signal:AbortSignal)=>Promise<VideoWorkSource>;jobs:()=>VideoDownloadJob[];
  weekly:()=>{enabled:boolean;last:number};completed:(time:number)=>void;changed:()=>void}){
  let state:VideoUpdateState={running:false,checked:0,total:0,rows:[],finishedAt:0,cancelled:false}
  let controller:AbortController|undefined
  const visible=(id:string)=>{const item=getVideo(deps.db,id);return item&&(!deps.hidden()||item.category!=='里番')?item:null}
  const sourceCode=(id:string)=>{const item=visible(id);if(!item||item.media_kind==='audio'||!['剧集','里番'].includes(item.category))return '';const code=item.hanime_id||(deps.db.prepare("SELECT external_id FROM video_sources WHERE resource_id=? AND provider='hanime' AND scope='work' LIMIT 1").get(id) as {external_id:string}|undefined)?.external_id||'';return /^\d{1,20}$/.test(code)?code:''}
  const status=():VideoUpdateState=>({...state,rows:state.rows.filter(row=>sourceCode(row.id)).map(row=>({...row}))})
  const present=async(file:string)=>!!file&&await fs.stat(file).then(s=>s.isFile()).catch(()=>false)
  async function inspect(id:string,signal:AbortSignal):Promise<VideoUpdateRow|null>{
    const item=visible(id),code=sourceCode(id);if(!item||!code)return null
    const episodes=listEpisodes(deps.db,id),assets=listVideoAssets(deps.db,id).filter(a=>a.role==='video')
    const paths=[...new Set([...assets.map(a=>a.path),...episodes.map(e=>e.path),...(!episodes.length&&!assets.length?[item.path]:[])].filter(Boolean))]
    let missingFiles=0
    for(const file of paths){signal.throwIfAborted();if(!await present(file))missingFiles++}
    for(const episode of episodes)if(!episode.path&&!listVideoAssets(deps.db,id,episode.id).some(a=>a.role==='video'))missingFiles++
    const row:VideoUpdateRow={id,title:item.name_zh||item.name_en||item.file_name,source:/^\d{1,20}$/.test(code),newEpisodes:0,missingFiles,status:'complete',message:''}
    if(!row.source){row.message='已核验本地文件；未登记支持系列检查的来源';return row}
    try{
      const info=await deps.resolve(code,signal)
      signal.throwIfAborted()
      if(info.videoCode!==code||info.episodes.length>500)throw new Error('来源返回的系列身份或范围无效')
      // Do not use prepare(): checking must never write catalogue metadata or files.
      const codes=[...new Set([code,...info.episodes.map(e=>e.videoCode)])].filter(c=>/^\d{1,20}$/.test(c))
      const queued=new Set(deps.jobs().filter(j=>['queued','running'].includes(j.status)).flatMap(j=>j.items.map(e=>e.videoCode)))
      for(const current of codes){
        if(queued.has(current))continue
        const known=deps.db.prepare("SELECT resource_id FROM video_sources WHERE provider='hanime' AND external_id=? LIMIT 1").get(current)
          ||deps.db.prepare('SELECT resource_id FROM video_meta WHERE hanime_id=? LIMIT 1').get(current)
        if(!known)row.newEpisodes++
      }
      row.message=row.newEpisodes?'发现未收录集数，补齐前会再次核对来源和队列':'系列中没有未收录集数'
    }catch(error){signal.throwIfAborted();row.status='failed';row.message=(error as Error).message}
    return row
  }
  function start(ids?:string[],startup=false):VideoUpdateState{
    if(!deps.ready())throw new Error('资料库正在恢复，请等待重启')
    if(state.running)return status()
    if(startup){const prefs=deps.weekly();if(!weeklyCheckDue(prefs.enabled,prefs.last))return status()}
    if(ids!==undefined&&(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string')))throw new Error('检查范围无效')
    const selected=[...new Set(ids??(deps.db.prepare("SELECT id FROM resource WHERE kind='video' ORDER BY id").all() as {id:string}[]).map(r=>r.id))].filter(id=>sourceCode(id))
    if(!selected.length){state={running:false,checked:0,total:0,rows:[],finishedAt:Date.now(),cancelled:false};deps.changed();return status()}
    const own=new AbortController();controller=own
    state={running:true,checked:0,total:selected.length,rows:[],finishedAt:0,cancelled:false};deps.changed()
    void(async()=>{
      try{
        for(const id of selected){
          own.signal.throwIfAborted();if(!deps.ready())throw new Error('资料库正在恢复')
          const row=await inspect(id,AbortSignal.any([own.signal,AbortSignal.timeout(45000)])).catch(error=>{
            own.signal.throwIfAborted();const item=visible(id);return item?{id,title:item.name_zh||item.name_en||item.file_name,source:!!item.hanime_id,newEpisodes:0,missingFiles:0,status:'failed' as const,message:(error as Error).message}:null
          })
          own.signal.throwIfAborted()
          if(row&&visible(id))state.rows.push(row)
          state.checked++;deps.changed()
        }
        if(ids===undefined&&deps.ready()&&state.rows.length&&!state.rows.some(row=>row.status==='failed'))deps.completed(Date.now())
      }catch{state.cancelled=true}
      finally{state.running=false;state.finishedAt=Date.now();controller=undefined;deps.changed()}
    })()
    return status()
  }
  return {start,status,cancel(){controller?.abort();return status()}}
}
