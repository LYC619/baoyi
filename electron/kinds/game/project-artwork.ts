import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { imageSize } from 'image-size'
import type { GameItem } from '../../../src/types'
import type { GameArtworkChoices, GameArtworkDifference, GameArtworkRole, GameProjectCandidate, GameProjectRecord } from '../../../src/types/game-project'
import type { SqlDb } from '../../services/schema.ts'
import { projectOf } from '../../../src/utils/game-project.ts'
import { getGame, updateGame } from './db.ts'
import { MAX_COVER_BYTES, MAX_COVER_EDGE, MAX_COVER_PIXELS, MIN_COVER_LONG_EDGE, MIN_COVER_SHORT_EDGE } from './covers.ts'

const roles: GameArtworkRole[] = ['portrait', 'wide']
const field = (role: GameArtworkRole) => role === 'portrait' ? 'cover_path' : 'background_path'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const digest = (file: string) => file && fs.existsSync(file) ? hash(imageBytes(file)) : ''
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (root: string, file: string) => path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)
const str = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 32000) : ''
const editable = (image: GameArtworkDifference) => !['protected', 'unavailable', 'current'].includes(image.state)

function imageBytes(file: string): Buffer {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_COVER_BYTES) throw Error('图片为空或超过封面大小限制')
  const bytes = fs.readFileSync(file), size = imageSize(bytes)
  if (!['jpg', 'png', 'webp', 'gif', 'bmp'].includes(size.type || '') || !size.width || !size.height) throw Error('不是支持的封面图片')
  if (Math.min(size.width, size.height) < MIN_COVER_SHORT_EDGE || Math.max(size.width, size.height) < MIN_COVER_LONG_EDGE || Math.max(size.width, size.height) > MAX_COVER_EDGE || size.width * size.height > MAX_COVER_PIXELS) throw Error('图片尺寸超出封面限制')
  return bytes
}

export function previewProjectArtwork(root: string, input: any, game: GameItem | null): GameArtworkDifference[] {
  return roles.filter(role => input?.[role]).map(role => {
    const source = input[role], currentPath = game?.[field(role)] || ''
    const item: GameArtworkDifference = {role, path: str(source.path), sha256: '', kind: str(source.kind), source: str(source.source), page: str(source.page), layout: str(source.layout), form: ['original', 'adapted', 'typography'].includes(source.form) ? source.form : source.kind === 'typography' ? 'typography' : 'adapted', currentPath, currentSha256: '', state: 'unavailable', detail: ''}
    try {
      // Preserved manual artwork is descriptive metadata, never an import source.
      const manualWide = role === 'wide' && game && path.basename(currentPath).toLowerCase().startsWith(game.id.toLowerCase() + '-background.')
      if (source.preserved || game?.cover_focus || role === 'portrait' && game?.cover_source === 'manual' || manualWide) { item.state = 'protected'; item.detail = '保留个人图片与焦点'; return item }
      if (!path.isAbsolute(item.path) || !inside(root, item.path)) throw Error('图片须位于所选游戏库内')
      if (!inside(fs.realpathSync(root), fs.realpathSync(item.path))) throw Error('图片链接到了游戏库之外')
      item.sha256 = digest(item.path)
      if (!item.sha256) throw Error('原图不存在，请在此路径补回图片后重新预览')
      if (source.sha256 && source.sha256 !== item.sha256) throw Error('图片与清单摘要不符，请核对来源后更新清单')
      item.currentSha256 = digest(currentPath)
      const previous = game && projectOf(game)?.artwork?.[role]
      const manual = !!game?.cover_focus || role === 'portrait' && game?.cover_source === 'manual'
      const changedByUser = previous && !samePath(previous.installedPath, currentPath)
      const unowned = currentPath && !previous && item.currentSha256 !== item.sha256
      if (manual || changedByUser || unowned || previous && item.currentSha256 && item.currentSha256 !== previous.sha256) {
        item.state = 'protected'; item.detail = '保留手选图片或焦点；需要更换时请在游戏详情中操作'
      } else if (previous && previous.sha256 === item.sha256 && item.currentSha256 === item.sha256 && ['kind','source','page','layout','form'].every(key => previous[key as keyof typeof previous] === item[key as keyof typeof item])) {
        item.state = 'current'; item.detail = '图片与来源说明一致'
      } else if (currentPath && !item.currentSha256) {
        item.state = 'recover'; item.detail = '当前缓存缺失，可从清单图片恢复'
      } else if (item.currentSha256 === item.sha256) {
        item.state = 'track'; item.detail = '图片相同，补齐来源与以后更新所需的记录'
      } else {
        item.state = currentPath ? 'changed' : 'new'; item.detail = currentPath ? '清单提供了新版图片' : '补充此方向的图片'
      }
    } catch (error) { item.detail = error instanceof Error ? error.message : String(error) }
    return item
  })
}

export const artworkSignature = (items: GameArtworkDifference[] = []) => JSON.stringify(items.map(({previewUrl, currentPreviewUrl, detail, ...item}) => item))
export const artworkHasChanges = (candidate: GameProjectCandidate) => candidate.artwork?.some(editable) || false

export interface ProjectArtworkContext {
  coversDir: string
  recoveryDir: string
  validate?: (file: string) => {ok: boolean; message: string}
}
type CoverPatch = Partial<Pick<GameItem, 'cover_path' | 'background_path' | 'cover_source' | 'cover_source_url' | 'cover_status' | 'cover_detail'>>
interface ReceiptItem {id: string; name: string; focus: string; roles: GameArtworkRole[]; before: CoverPatch; after: CoverPatch; beforeArtwork?: GameProjectRecord['artwork']; afterArtwork?: GameProjectRecord['artwork']; backups: Array<{path: string; backup: string; sha256: string}>}
interface Receipt {schema: 1; state: 'prepared' | 'committed' | 'rolled_back' | 'restored'; items: ReceiptItem[]}

export function prepareProjectArtwork(candidates: GameProjectCandidate[], choices: GameArtworkChoices, context?: ProjectArtworkContext) {
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw Error('图片选择无效')
  const plans = candidates.flatMap(candidate => {
    const selected = choices[candidate.key] || []
    if (!Array.isArray(selected) || selected.some(role => !roles.includes(role))) throw Error('图片方向选择无效')
    return [...new Set(selected)].map(role => {
      const image = candidate.artwork?.find(item => item.role === role)
      if (!image || !editable(image)) throw Error('所选图片不可更新，请重新预览')
      return {key: candidate.key, image, cached: ''}
    })
  })
  if (Object.keys(choices).some(key => !candidates.some(c => c.key === key))) throw Error('图片选择不属于所选游戏')
  if (plans.length && !context) throw Error('未提供封面保存目录')
  const receipt: Receipt = {schema: 1, state: 'prepared', items: []}
  const createdCaches = new Set<string>()
  let receiptPath = ''
  if (plans.length) {
    const ctx = context!, folder = path.join(ctx.recoveryDir, Date.now() + '-' + randomUUID())
    fs.mkdirSync(folder, {recursive: true}); fs.mkdirSync(ctx.coversDir, {recursive: true})
    receiptPath = path.join(folder, 'artwork.json')
    for (const plan of plans) {
      const bytes = imageBytes(plan.image.path)
      if (hash(bytes) !== plan.image.sha256) throw Error('图片在预览后变化，请重新预览')
      if (ctx.validate) { const valid = ctx.validate(plan.image.path); if (!valid.ok) throw Error(valid.message) }
      const ext = imageSize(bytes).type === 'jpg' ? 'jpg' : imageSize(bytes).type
      plan.cached = path.join(ctx.coversDir, `project-art-${plan.image.sha256}.${ext}`)
      if (!fs.existsSync(plan.cached)) {
        fs.writeFileSync(plan.cached, bytes, {flag: 'wx'})
        createdCaches.add(path.resolve(plan.cached).toLowerCase())
      }
      if (digest(plan.cached) !== plan.image.sha256) throw Error('封面缓存校验失败，取消登记')
    }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), {flag: 'wx'})
  }
  return {
    count: plans.length, receiptPath,
    assertUnchanged() {
      for (const plan of plans) {
        const image = plan.image
        // Restoring a missing content-addressed cache can recreate the current
        // path during staging. Only our own verified write is expected here.
        const restored = !image.currentSha256 && image.currentPath && createdCaches.has(path.resolve(image.currentPath).toLowerCase()) && samePath(image.currentPath, plan.cached)
        if (digest(image.currentPath) !== (restored ? image.sha256 : image.currentSha256)) throw Error('图片准备期间当前封面文件已变化，请重新预览')
        if (digest(plan.cached) !== image.sha256) throw Error('图片准备期间新封面缓存已变化，请重新预览')
      }
    },
    apply(db: SqlDb, id: string, candidate: GameProjectCandidate) {
      const selected = plans.filter(p => p.key === candidate.key)
      if (!selected.length) return false
      const game = getGame(db, id)!, project = projectOf(game)!
      const beforeArtwork = project.artwork ? structuredClone(project.artwork) : undefined
      const before: CoverPatch = {}, after: CoverPatch = {}, backups: ReceiptItem['backups'] = []
      for (const plan of selected) {
        const f = field(plan.image.role), previous = game[f]
        before[f] = previous; after[f] = plan.cached
        if (previous && fs.existsSync(previous)) {
          const bytes = imageBytes(previous), backup = hash(bytes) + '.image'
          fs.writeFileSync(path.join(path.dirname(receiptPath), backup), bytes)
          backups.push({path: previous, backup, sha256: hash(bytes)})
        }
        if (plan.image.role === 'portrait') {
          Object.assign(before, {cover_source: game.cover_source, cover_source_url: game.cover_source_url, cover_status: game.cover_status, cover_detail: game.cover_detail})
          Object.assign(after, {cover_source: plan.image.kind === 'steam' ? 'steam' : 'local', cover_source_url: /^https?:\/\//.test(plan.image.source) && plan.image.kind === 'steam' ? plan.image.source : '', cover_status: 'ready', cover_detail: plan.image.layout})
        }
        const {role, state, detail, currentPath, currentSha256, previewUrl, currentPreviewUrl, ...asset} = plan.image
        project.artwork = {...project.artwork, [role]: {...asset, installedPath: plan.cached}}
      }
      updateGame(db, id, {...after, linked_files: game.linked_files})
      receipt.items.push({id, name: candidate.name, focus: game.cover_focus || '', roles: selected.map(p => p.image.role), before, after, beforeArtwork, afterArtwork: structuredClone(project.artwork), backups})
      return true
    },
    finish(state: Receipt['state']) {
      if (receiptPath) {
        receipt.state = state
        const temporary = receiptPath + '.tmp'
        fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2)); fs.renameSync(temporary, receiptPath)
      }
    }
  }
}

export function restoreProjectArtwork(db: SqlDb, file: string, context: ProjectArtworkContext, apply = false): string[] {
  if (!inside(fs.realpathSync(context.recoveryDir), fs.realpathSync(file)) || path.basename(file) !== 'artwork.json' || fs.statSync(file).size > 2 * 1024 * 1024) throw Error('请选择本机项目图片登记生成的撤销记录')
  const receipt: Receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (receipt.schema !== 1 || !['committed', 'prepared', 'restored'].includes(receipt.state) || !Array.isArray(receipt.items) || !receipt.items.length) throw Error('此记录没有可撤销的图片登记')
  const allowed = new Set(['cover_path','background_path','cover_source','cover_source_url','cover_status','cover_detail'])
  for (const item of receipt.items) {
    const game = getGame(db, item.id)
    if (!game || Object.keys(item.before).some(key => !allowed.has(key)) || JSON.stringify(Object.keys(item.before).sort()) !== JSON.stringify(Object.keys(item.after).sort())) throw Error('撤销记录与当前游戏不符')
    if ((game.cover_focus || '') !== item.focus || Object.entries(item.after).some(([key, value]) => game[key as keyof GameItem] !== value) || JSON.stringify(projectOf(game)?.artwork) !== JSON.stringify(item.afterArtwork)) throw Error(`${item.name} 的图片已再次变化，取消撤销`)
    for (const role of item.roles) if (digest(game[field(role)]) !== item.afterArtwork?.[role]?.sha256) throw Error(`${item.name} 的图片文件已再次变化，取消撤销`)
    for (const backup of item.backups) {
      if (path.basename(backup.backup) !== backup.backup || !inside(context.coversDir, backup.path) || hash(fs.readFileSync(path.join(path.dirname(file), backup.backup))) !== backup.sha256) throw Error('原图备份校验失败')
      if (fs.existsSync(backup.path) && digest(backup.path) !== backup.sha256) throw Error('原图片文件已被修改，取消撤销')
    }
  }
  if (apply) {
    db.exec('SAVEPOINT game_project_artwork_restore')
    try {
      // Recheck inside the database snapshot used for restoration as well.
      restoreProjectArtwork(db, file, context)
      for (const item of receipt.items) {
        for (const backup of item.backups) if (!fs.existsSync(backup.path)) fs.copyFileSync(path.join(path.dirname(file), backup.backup), backup.path, fs.constants.COPYFILE_EXCL)
        const game = getGame(db, item.id)!, project = projectOf(game)!
        if (item.beforeArtwork) project.artwork = item.beforeArtwork; else delete project.artwork
        updateGame(db, item.id, {...item.before, linked_files: game.linked_files})
      }
      receipt.state = 'restored'
      fs.writeFileSync(file + '.tmp', JSON.stringify(receipt, null, 2)); fs.renameSync(file + '.tmp', file)
      db.exec('RELEASE SAVEPOINT game_project_artwork_restore')
    } catch (error) { db.exec('ROLLBACK TO SAVEPOINT game_project_artwork_restore'); db.exec('RELEASE SAVEPOINT game_project_artwork_restore'); throw error }
  }
  return receipt.items.map(item => item.name)
}
