import fs from 'node:fs'
import path from 'node:path'
import type { GameItem } from '../../../src/types/index.ts'
import type { SqlDb } from '../../services/schema.ts'
import { getGame, updateGame } from './db.ts'

export function gamePathState(game: GameItem): GameItem {
  let state: GameItem['path_state'] = 'missing'
  try { if (fs.statSync(game.path).isFile()) state = 'present' } catch { if (!fs.existsSync(path.parse(game.path).root)) state = 'offline' }
  return { ...game, path_state: state }
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
}
/** User-selected replacement; the original resource ID and all gameplay history survive. */
export function relocateGame(db: SqlDb, id: string, entry: string, directory?: string): GameItem {
  const game = getGame(db, id)
  if (!game) throw new Error('游戏已不存在')
  const file = path.resolve(entry), stat = fs.statSync(file)
  if (!stat.isFile() || !/\.(exe|lnk|bat|cmd)$/i.test(file)) throw new Error('请选择游戏程序、快捷方式或启动脚本')
  const conflict = db.prepare('SELECT id FROM resource WHERE path = ? COLLATE NOCASE AND id <> ?').get(file, id)
  if (conflict) throw new Error('所选程序已经属于另一个条目，请先处理重复记录')
  const oldRoot = path.resolve(game.source_dir || path.dirname(game.path))
  let newRoot = directory ? path.resolve(directory) : path.dirname(file)
  const oldRelative = path.relative(oldRoot, game.path)
  if (!directory && within(oldRoot, game.path) && file.toLowerCase().endsWith((path.sep + oldRelative).toLowerCase())) newRoot = file.slice(0, -(oldRelative.length + 1))
  if (!fs.statSync(newRoot).isDirectory() || !within(newRoot, file)) throw new Error('主程序必须位于所选游戏目录内')
  const rebase = (value: string) => value && within(oldRoot, path.resolve(value)) ? path.join(newRoot, path.relative(oldRoot, value)) : value
  db.exec('SAVEPOINT relocate_game')
  try {
    db.prepare('UPDATE resource SET path=?, source_dir=?, file_name=?, file_size=?, updated_at=? WHERE id=? AND kind=\'game\'').run(file,newRoot,path.basename(file),stat.size,Date.now(),id)
    updateGame(db,id,{ save_paths: game.save_paths.map(value=>({...value,path:rebase(value.path),verified_at:0})), linked_files:game.linked_files.map(value=>({...value,path:rebase(value.path)})), cover_path:rebase(game.cover_path),background_path:rebase(game.background_path) })
    db.exec('RELEASE SAVEPOINT relocate_game')
  } catch(error) {db.exec('ROLLBACK TO SAVEPOINT relocate_game');db.exec('RELEASE SAVEPOINT relocate_game');throw error}
  return gamePathState(getGame(db,id)!)
}
