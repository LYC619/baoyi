import fs from 'node:fs'
import path from 'node:path'
import type {SqlDb} from '../../services/storage/schema.ts'
import type {LinkedFile} from '../../../src/types'
import {getGame,updateGame} from './db.ts'
export function linkExtras(file:LinkedFile):Partial<LinkedFile>{
 const out:Partial<LinkedFile>={}
 if(file.purpose!==undefined){if(!['modifier','backup','inspection','patch','mixed'].includes(file.purpose))throw Error('工具用途无效');out.purpose=file.purpose}
 for(const key of ['usage','version','fit_version','source'] as const){if(file[key]!==undefined&&typeof file[key]!=='string')throw Error('工具说明须为文本');if(typeof file[key]==='string')out[key]=file[key]!.trim().slice(0,key==='usage'?4000:500)}
 if(file.features!==undefined){if(!Array.isArray(file.features)||file.features.length>100)throw Error('最多填写 100 项工具功能');out.features=file.features.map(f=>{if(!f||typeof f.key!=='string'||typeof f.label!=='string')throw Error('工具功能格式不正确');return {key:f.key.slice(0,60),label:f.label.slice(0,200)}})}
 if(file.launch_with_game!==undefined){if(typeof file.launch_with_game!=='boolean')throw Error('随游戏启动须为开关');out.launch_with_game=file.type==='trainer'&&file.role!=='usage'&&/\.(exe|bat|cmd|lnk)$/i.test(file.path)?file.launch_with_game:false}
 if(file.read_progress!==undefined){if(typeof file.read_progress!=='number'||!Number.isFinite(file.read_progress)||file.read_progress<0||file.read_progress>1)throw Error('阅读进度须在 0 到 1 之间');out.read_progress=file.read_progress}
 return out
}
export function patchGameLink(d:SqlDb,id:string,target:string,patch:Partial<LinkedFile>|null,expected:string){
 const game=getGame(d,id);if(!game)throw Error('游戏不存在')
 const file=game.linked_files.find(f=>f.path===target);if(!file)throw Error('这份文件未关联到当前游戏')
 if(JSON.stringify(file)!==expected)throw Error('关联资料已变化，请重新读取后再保存')
 const next=patch===null?null:{...file,...patch,path:file.path,role:file.role,project:file.project,catalog:file.catalog}
 if(next){if(!['trainer','guide','mod','emulator','other'].includes(next.type)||typeof next.label!=='string')throw Error('关联资料格式不正确');next.label=next.label.trim().slice(0,100)||path.basename(next.path);Object.assign(next,linkExtras(next))}
 return updateGame(d,id,{linked_files:game.linked_files.flatMap(f=>f.path!==target?[f]:next?[next]:[])})
}
export function setDefaultGameEntry(d:SqlDb,id:string,target:string){
 const game=getGame(d,id);if(!game)throw Error('游戏不存在')
 if(target===game.path)return game
 if(!game.linked_files.some(f=>f.path===target&&f.role==='launcher'))throw Error('请选择当前游戏已登记的启动入口')
 if(!/\.(exe|bat|cmd|lnk)$/i.test(target)||!fs.statSync(target).isFile())throw Error('启动入口不可用')
 if(d.prepare('SELECT 1 FROM resource WHERE path=? AND id!=?').get(target,id))throw Error('该入口已登记在其他资源中')
 const links=game.linked_files.map(f=>f.path===target?{path:game.path,label:game.file_name,type:'other' as const,role:'launcher' as const}:f)
 d.exec('SAVEPOINT game_default_entry')
 try{d.prepare('UPDATE resource SET path=?,file_name=?,updated_at=? WHERE id=?').run(target,path.basename(target),Date.now(),id);updateGame(d,id,{linked_files:links});d.exec('RELEASE game_default_entry')}catch(e){d.exec('ROLLBACK TO game_default_entry');d.exec('RELEASE game_default_entry');throw e}
 return getGame(d,id)
}
