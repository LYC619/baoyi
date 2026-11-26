import {randomUUID} from 'node:crypto'
import type {SqlDb} from '../../services/storage/schema.ts'
import type {GameNote,GameNoteInput} from '../../../src/types/game-workspace.ts'
export const GAME_NOTES_SQL=`CREATE TABLE IF NOT EXISTS game_notes(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,title TEXT NOT NULL,body TEXT NOT NULL,sort INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS idx_game_notes_resource ON game_notes(resource_id,sort,created_at);`
export function migrateLegacyGameNotes(d:SqlDb){d.exec(`INSERT OR IGNORE INTO game_notes(id,resource_id,title,body,sort,created_at,updated_at) SELECT 'legacy-game-note:'||id,id,'笔记',notes,0,created_at,updated_at FROM resource WHERE kind='game' AND trim(COALESCE(notes,''))!='' AND NOT EXISTS(SELECT 1 FROM game_notes n WHERE n.resource_id=resource.id)`)}
function owner(d:SqlDb,id:string){if(!d.prepare("SELECT 1 FROM resource WHERE id=? AND kind='game'").get(id))throw Error('游戏不存在')}
export function listGameNotes(d:SqlDb,id:string):GameNote[]{owner(d,id);return d.prepare('SELECT * FROM game_notes WHERE resource_id=? ORDER BY sort,created_at,id').all(id) as GameNote[]}
export function validateGameNote(input:GameNoteInput){if(!input||typeof input.title!=='string'||typeof input.body!=='string'||input.title.length>200||Buffer.byteLength(input.body,'utf8')>1024*1024)throw Error('笔记标题最多 200 字，正文最多 1 MB');return {title:input.title.trim()||'未命名笔记',body:input.body}}
export function saveGameNote(d:SqlDb,id:string,input:GameNoteInput):GameNote{
 owner(d,id);const value=validateGameNote(input),now=Date.now()
 if(input.id){const old=d.prepare('SELECT * FROM game_notes WHERE id=? AND resource_id=?').get(input.id,id) as GameNote|undefined;if(!old)throw Error('笔记已被移除');if(old.updated_at!==input.expectedUpdatedAt)throw Error('笔记已在其他位置修改，请重新读取后再保存');const updated=Math.max(now,old.updated_at+1);const result=d.prepare('UPDATE game_notes SET title=?,body=?,updated_at=? WHERE id=? AND resource_id=? AND updated_at=?').run(value.title,value.body,updated,old.id,id,old.updated_at);if(Number(result.changes)!==1)throw Error('笔记保存冲突');return {...old,...value,updated_at:updated}}
 const notes=listGameNotes(d,id);if(notes.length>=200)throw Error('一个游戏最多保存 200 条笔记')
 const note:GameNote={id:randomUUID(),resource_id:id,...value,sort:Math.max(-1,...notes.map(n=>n.sort))+1,created_at:now,updated_at:now}
 d.prepare('INSERT INTO game_notes(id,resource_id,title,body,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(note.id,id,note.title,note.body,note.sort,now,now);return note
}
export function removeGameNote(d:SqlDb,id:string,noteId:string,expected:number){owner(d,id);const result=d.prepare('DELETE FROM game_notes WHERE id=? AND resource_id=? AND updated_at=?').run(noteId,id,expected);if(Number(result.changes)!==1)throw Error('笔记已变化，请重新读取后再删除')}
