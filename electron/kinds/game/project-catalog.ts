/** Local, evidence-gated project registration. Never executes or changes a source file. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../../services/storage/schema.ts'
import {projectOf} from '../../../src/utils/game-project.ts'
import type { LinkedFile } from '../../../src/types'
import type { GameProjectCandidate, GameProjectPreview, GameProjectImportResult, GameProjectRecord, GameProjectCheck } from '../../../src/types/game-project'
import { getGame, insertGame, updateGame } from './db.ts'
import { relocateGame } from './files.ts'
import { addLinks, MAX_LINKS } from './links.ts'
import { ensureResourceCategory } from '../../services/taxonomy/resource-taxonomy.ts'
import { previewProjectArtwork, artworkSignature, artworkHasChanges, prepareProjectArtwork, type ProjectArtworkContext } from './project-artwork.ts'
import type { GameArtworkChoices } from '../../../src/types/game-project'

const keyPath = (value: string) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
const within = (parent: string, child: string) => keyPath(child) === keyPath(parent) || keyPath(child).startsWith(keyPath(parent) + path.sep)
const text = (value: unknown, limit = 4000) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const rows = (value: unknown): any[] => Array.isArray(value) ? value : []
const existsFile = (value: string) => { try { return fs.statSync(value).isFile() } catch { return false } }

function checkedPath(root: string, value: unknown): string {
  const target = text(value, 32000)
  if (!target || !path.isAbsolute(target) || !within(root, target)) throw new Error('清单路径超出游戏库目录')
  // Reparse points must not make a registered launcher/document escape the selected library.
  if (!within(fs.realpathSync(root), fs.realpathSync(target))) throw new Error('清单路径链接到了游戏库之外')
  return path.resolve(target)
}

function readCatalog(source: string) {
  if (!fs.statSync(source).isFile() || fs.statSync(source).size > 8 * 1024 * 1024) throw new Error('项目清单须为不超过 8 MB 的 JSON 文件')
  const bytes = fs.readFileSync(source)
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  if (!data || !Array.isArray(data.entries) || data.entries.length > 2000 || !path.isAbsolute(text(data.root, 32000))) throw new Error('清单需要 root 和 entries，最多 2000 个项目')
  const root = path.resolve(data.root)
  if (!fs.statSync(root).isDirectory()) throw new Error('游戏库根目录不存在')
  checkedPath(root, path.resolve(source))
  return { data, root, digest: createHash('sha256').update(bytes).digest('hex') }
}

function existingProject(db: SqlDb, item: GameProjectCandidate): { id?: string; problem?: string } {
  const all = db.prepare('SELECT id,kind,path,source_dir FROM resource').all() as Array<{id:string;kind:string;path:string;source_dir:string}>
  const matches = all.filter(row => (row.kind === 'game' && (()=>{const p=projectOf(getGame(db,row.id)!);return p?.key===item.key && keyPath(p.source)===keyPath(item.links.find(l=>l.project)!.project!.source)})()) || item.launchers.some(target => keyPath(row.path) === keyPath(target)) || (row.kind === 'game' && (keyPath(row.source_dir || row.path) === keyPath(item.root) || within(item.root, row.path) || item.previousRoots.some(root => !fs.existsSync(row.path) && within(root,row.path)))))
  if (matches.some(row => row.kind !== 'game')) return { problem: '启动入口已登记在其他资源库' }
  if (matches.length > 1) return { problem: '同一项目已关联多个游戏条目，请先核对重复记录' }
  return { id: matches[0]?.id }
}

export function previewGameProjects(db: SqlDb, source: string): GameProjectPreview {
  const { data, root, digest } = readCatalog(source)
  const eligible = data.entries.filter((entry: any) => entry?.kind === 'game' && ['Windows','Android'].includes(entry.platform) && entry.availability === 'present' && ['runtime_verified','static_complete'].includes(entry.refinement?.status))
  const seen = new Set<string>(), roots = new Set<string>(), launchPaths = new Set<string>()
  const candidates: GameProjectCandidate[] = eligible.sort((a: any,b: any) => (a.refinement.order || 0) - (b.refinement.order || 0)).map((entry: any) => {
    const candidate: GameProjectCandidate = { key: text(entry.id, 200), name: text(entry.name, 300), platform: entry.platform, status: entry.refinement.status, root: '', previousRoots: [], launcher: '', launchers: [], category: text(entry.category, 100), summary: text(entry.summary || entry.refinement.guide, 1000), description: '', links: [], changes:{added:[],refreshed:[],retired:[],missing:[],metadata:false}, problem: '' }
    try {
      if (!candidate.key || !candidate.name || seen.has(candidate.key)) throw new Error('项目编号或名称为空，或编号重复')
      seen.add(candidate.key)
      candidate.root = checkedPath(root, entry.assetRoot)
      candidate.previousRoots = rows(entry.previousRoots).map(value => {
        const previous = text(value,32000)
        if (!path.isAbsolute(previous) || !within(root,previous) || keyPath(previous) === keyPath(root) || fs.existsSync(previous)) throw Error('旧目录须为游戏库内已不存在的明确路径')
        return path.resolve(previous)
      })
      if (keyPath(candidate.root) === keyPath(root) || !fs.statSync(candidate.root).isDirectory()) throw new Error('项目根目录无效')
      if (roots.has(keyPath(candidate.root))) throw new Error('清单内项目目录重复')
      roots.add(keyPath(candidate.root))
      const report = checkedPath(root, entry.refinement.report)
      if (!existsFile(report)) throw new Error('缺少精修验收记录')
      const entries = rows(entry.launchers).map(value => checkedPath(candidate.root, value?.path))
      const tools = new Set(rows(entry.trainer?.launchers).map(value => keyPath(checkedPath(root, value?.path))))
      candidate.launchers = entries.filter(value => !tools.has(keyPath(value)) && !/管理|维护|助手|核对|诊断/.test(path.basename(value)) && (candidate.platform === 'Android' ? /\.apk$/i : /\.(exe|lnk|bat|cmd)$/i).test(value))
      if (!candidate.launchers.length || candidate.launchers.some(value => !existsFile(value))) throw new Error('游戏入口或安卓安装包缺失')
      for (const launcher of candidate.launchers) {
        if (launchPaths.has(keyPath(launcher))) throw new Error('清单内启动入口重复')
        launchPaths.add(keyPath(launcher))
      }
      // Tool helpers must never become the game's default entry. APKs are catalogued, not executed.
      candidate.launcher = candidate.launchers[0]
      const append = (target: unknown, label: string, type: LinkedFile['type'], role?: LinkedFile['role'], note = '') => {
        const file = checkedPath(root, target)
        if (!existsFile(file) && !(type === 'other' && fs.statSync(file).isDirectory())) throw new Error(`关联文件不存在：${file}`)
        if (!candidate.links.some(value => keyPath(value.path) === keyPath(file))) candidate.links.push({ path: file, label, type, ...(role ? { role } : {}), ...(note ? { note: note.slice(0,4000) } : {}) })
      }
      const status = candidate.status === 'runtime_verified' ? '已完成精修整理 · 限定运行验证' : '已完成精修整理 · 静态检查与隔离测试'
      const record = [
        '【项目精修档案】\n' + candidate.platform + ' · ' + status,
        '实际完成\n' + candidate.summary,
        '攻略与机制核对\n' + text(entry.refinement.guide),
        '工具与修复\n' + text(entry.refinement.trainer),
        '已做的检查\n' + text(entry.refinement.isolatedTests),
        '运行验证范围\n' + text(entry.refinement.runtime),
        '尚未验证或仍存在的问题\n' + rows(entry.refinement.remaining).map(value => '• ' + text(value)).join('\n'),
        '存档位置说明\n' + text(entry.save?.locationHint),
      ].join('\n\n')
      append(report, '精修记录 · 工作与边界', 'guide', 'report', record)
      for (const launcher of rows(entry.trainer?.launchers)) {
        append(launcher?.path, text(entry.trainer?.title,100) || text(launcher?.name,100), 'trainer', 'launcher', [text(entry.refinement.trainer), text(entry.trainer?.validationSummary)].filter(Boolean).join('\n'))
        const link = candidate.links.find(value => keyPath(value.path) === keyPath(launcher.path))!
        link.features = rows(entry.trainer?.features).map(value => ({key:'',label:text(value,200)})).filter(value=>value.label).slice(0,100)
        link.purpose = ['modifier','backup','inspection','patch','mixed'].includes(entry.trainer?.purpose) ? entry.trainer.purpose : candidate.platform === 'Android' ? 'inspection' : 'mixed'
        link.fit_version = text(entry.version?.label,500)
        link.usage = [text(entry.refinement.trainer),text(entry.trainer?.validationSummary)].filter(Boolean).join('\n')
      }
      if (entry.trainer?.usage) append(entry.trainer.usage, '工具使用说明', 'trainer', 'usage')
      for (const doc of rows(entry.guides?.docFiles)) {
        const target = text(doc?.path,32000)
        // Machine-readable evidence remains beside the full report, not in the reading list.
        if (/\.(json|csv)$/i.test(target)) continue
        const usage = /[\\/]修改器[\\/]/.test(target)
        append(target, keyPath(target) === keyPath(report) ? '精修验收记录' : text(doc?.name,100), usage ? 'trainer' : 'guide', keyPath(target) === keyPath(report) ? 'report' : usage ? 'usage' : undefined)
      }
      for (const doc of rows(entry.guides?.htmlFiles)) append(doc?.path, '原帖 · ' + text(doc?.name,90), 'guide', 'source', '本地原帖快照；内容以精修攻略与验收记录为准')
      for (const file of entries.filter(value => value !== candidate.launcher && !tools.has(keyPath(value)))) {
        const helper = /\.(bat|cmd|exe)$/i.test(file) && !candidate.launchers.includes(file)
        append(file, path.basename(file), helper ? 'trainer' : 'other', helper || candidate.platform === 'Windows' && candidate.launchers.includes(file) ? 'launcher' : undefined, helper ? text(entry.refinement.trainer) : candidate.platform === 'Android' ? '安卓安装包或配套资源；通过文件夹取用，未作设备运行认证' : '游戏备用入口或配套资源')
      }
      if (candidate.links.length > MAX_LINKS) throw new Error(`关联文件超过 ${MAX_LINKS} 个，请先精简清单`)
      candidate.links = addLinks([], candidate.links)
      candidate.description = [text(entry.verifiedSynopsis), text(entry.engine), text(entry.version?.label), candidate.platform === 'Android' ? '安卓资料档案：安装包需在安卓设备使用，抱一不执行 APK。' : '', status, text(entry.refinement.runtime), '存档位置说明：' + text(entry.save?.locationHint), ...rows(entry.refinement.remaining).map(value => '待验收：' + text(value)), '来源清单：' + path.resolve(source)].filter(Boolean).join('\n')
      const followup=entry.followup || {}
      if(followup.guidePath)append(followup.guidePath,'使用与攻略导航','guide')
      if(candidate.links.length>MAX_LINKS)throw new Error(`关联文件超过 ${MAX_LINKS} 个，请先精简清单`)
      const recordLink=candidate.links.find(link=>link.role==='report')!
      const facets=rows(followup.facets).map(f=>({label:text(f.label,100),state:text(f.state,100),detail:text(f.detail,1500)}))
      const issues=rows(followup.issues).map(i=>({text:text(i.text,1500),status:(['open','fixed','deferred'].includes(i.status)?i.status:'deferred') as 'open'|'fixed'|'deferred',evidence:text(i.evidence,1500)}))
      const project:GameProjectRecord={key:candidate.key,source:path.resolve(source),root:candidate.root,platform:candidate.platform,family:text(followup.family,200)||candidate.key,version:text(entry.version?.label,500),synopsis:text(entry.verifiedSynopsis||entry.summary,2000),revision:'',facets,issues,saveScope:text(followup.saveScope||entry.save?.locationHint,4000),guidePath:followup.guidePath?checkedPath(root,followup.guidePath):'',history:[]}
      recordLink.project=project
      const existing = existingProject(db, candidate)
      candidate.existingId = existing.id
      if (existing.problem) throw new Error(existing.problem)
      if (existing.id) {
        const current = getGame(db, existing.id)!
        candidate.relocate = candidate.previousRoots.some(previous => within(previous,current.path)) && !fs.existsSync(current.path)
        if (!candidate.relocate && keyPath(current.path) !== keyPath(candidate.launcher)) append(candidate.launcher, path.basename(candidate.launcher), 'other', candidate.platform === 'Windows' ? 'launcher' : undefined, '项目推荐入口；保留已有默认入口')
        candidate.existingStamp=createHash('sha256').update(JSON.stringify(current)).digest('hex')
        const merged = addLinks(current.linked_files, candidate.links)
        if (candidate.links.some(value => !merged.some(link => keyPath(link.path) === keyPath(value.path)))) throw new Error(`现有附件与新资料合计超过 ${MAX_LINKS} 个，请先精简附件`)
      }
      for(const link of candidate.links){
        const stat=fs.statSync(link.path)
        const fingerprint=createHash('sha256').update(stat.isFile()&&stat.size<1024*1024?fs.readFileSync(link.path):String(stat.size)+':'+stat.mtimeMs).digest('hex')
        const fields=Object.fromEntries(['note','features','usage','fit_version','purpose'].filter(key=>link[key as keyof LinkedFile]!==undefined).map(key=>[key,link[key as keyof LinkedFile]]))
        link.catalog={key:candidate.key,source:path.resolve(source),fingerprint,fields}
      }
      project.revision=createHash('sha256').update(JSON.stringify({project,links:candidate.links.map(l=>({path:l.path,catalog:l.catalog}))})).digest('hex')
      const old=candidate.existingId?getGame(db,candidate.existingId)!:null
      candidate.artwork = previewProjectArtwork(root, entry.artwork, old)
      candidate.changes.added=candidate.links.filter(l=>!old?.linked_files.some(o=>keyPath(o.path)===keyPath(l.path))).map(l=>l.label)
      candidate.changes.refreshed=candidate.links.filter(l=>old?.linked_files.some(o=>keyPath(o.path)===keyPath(l.path)&&JSON.stringify(o.catalog)!==JSON.stringify(l.catalog))).map(l=>l.label)
      candidate.changes.retired=(old?.linked_files||[]).filter(l=>l.catalog?.key===candidate.key&&!l.catalog.retired&&!candidate.links.some(n=>keyPath(n.path)===keyPath(l.path))).map(l=>l.label)
      candidate.changes.missing=(old?.linked_files||[]).filter(l=>!fs.existsSync(l.path)).map(l=>l.label)
      candidate.changes.metadata=!old||projectOf(old)?.revision!==project.revision
    } catch (error) { candidate.problem = error instanceof Error ? error.message : String(error) }
    return candidate
  })
  return { token: randomUUID(), source: path.resolve(source), digest, candidates, excluded: data.entries.length - eligible.length }
}

export function importGameProjects(db: SqlDb, preview: GameProjectPreview, selected: string[], artwork: GameArtworkChoices = {}, context?: ProjectArtworkContext): GameProjectImportResult {
  if (!Array.isArray(selected) || selected.length === 0 || selected.some(key => typeof key !== 'string')) throw new Error('请选择要登记的游戏')
  const current = previewGameProjects(db, preview.source)
  if (current.digest !== preview.digest) throw new Error('项目清单已变化，请重新预览')
  const keys = [...new Set(selected)]
  const chosen = keys.map(key => {
    const candidate = current.candidates.find(value => value.key === key)
    if (!candidate || !preview.candidates.some(value=>value.key===key && !value.problem) || candidate.problem) throw new Error(candidate?.problem || '所选游戏不在有效预览中')
    const before = preview.candidates.find(value=>value.key===key)!
    if (artworkSignature(before.artwork) !== artworkSignature(candidate.artwork)) throw new Error('图片在预览后变化，请重新预览')
    if (before.existingStamp !== candidate.existingStamp || before.links.find(l=>l.project)?.project?.revision !== candidate.links.find(l=>l.project)?.project?.revision || before.existingId !== candidate.existingId || !!before.relocate !== !!candidate.relocate) throw new Error('游戏库已变化，请重新预览')
    return candidate
  })
  const result: GameProjectImportResult = { created: 0, updated: 0, unchanged: 0, items: [] }
  const images = prepareProjectArtwork(chosen, artwork, context)
  db.exec('SAVEPOINT game_project_import')
  try {
    // File preparation can take time. Establish a database snapshot and recheck
    // identity/personal edits before the first write, including new registrations.
    for (const candidate of chosen) {
      const identity = existingProject(db, candidate)
      const game = identity.id ? getGame(db, identity.id) : null
      if (identity.problem || identity.id !== candidate.existingId || game && createHash('sha256').update(JSON.stringify(game)).digest('hex') !== candidate.existingStamp) throw Error('图片准备期间游戏库已变化，请重新预览')
    }
    images.assertUnchanged()
    for (const candidate of chosen) {
      let id = candidate.existingId, action: 'created'|'updated'|'unchanged' = 'created'
      if (id) {
        if (candidate.relocate) relocateGame(db,id,candidate.launcher,candidate.root,candidate.platform)
        const old = getGame(db,id)!
        const links = mergedProjectLinks(old.linked_files,candidate)
        const patch = { ...(JSON.stringify(links) !== JSON.stringify(old.linked_files) ? {linked_files:links} : {}), ...(!old.summary ? {summary:candidate.summary} : {}), ...(!old.description ? {description:candidate.description} : {}) }
        action = candidate.relocate || Object.keys(patch).length ? 'updated' : 'unchanged'
        if (action === 'updated') updateGame(db,id,patch)
      } else {
        ensureResourceCategory(db,'game',candidate.category)
        id = insertGame(db,{exe_path:candidate.launcher,source_dir:candidate.root,name_zh:candidate.name,name_en:'',file_size:fs.statSync(candidate.launcher).size,category:candidate.category,tags:['精修档案',candidate.platform,candidate.status === 'runtime_verified' ? '限定运行验证' : '静态检查'],summary:candidate.summary,description:candidate.description,official_url:'',save_paths:[],linked_files:mergedProjectLinks([],candidate)}).id
      }
      if (images.apply(db, id, candidate) && action === 'unchanged') action = 'updated'
      result[action]++
      result.items.push({key:candidate.key,id,name:candidate.name,action})
    }
    images.finish('committed')
    db.exec('RELEASE SAVEPOINT game_project_import')
    if (images.count) { result.artworkUpdated = images.count; result.artworkReceipt = images.receiptPath }
    return result
  } catch(error) { db.exec('ROLLBACK TO SAVEPOINT game_project_import'); db.exec('RELEASE SAVEPOINT game_project_import'); images.finish('rolled_back'); throw error }
}

function mergedProjectLinks(old:LinkedFile[],candidate:GameProjectCandidate):LinkedFile[]{
  return addLinks(old,candidate.links).map(link=>{
    const incoming=candidate.links.find(l=>keyPath(l.path)===keyPath(link.path))
    if(!incoming){
      if(link.catalog?.key===candidate.key){const {project,...kept}=link;return {...kept,catalog:{...link.catalog,retired:true}}}
      return link
    }
    const previous=old.find(l=>keyPath(l.path)===keyPath(link.path))
    const next={...link,catalog:incoming.catalog}
    for(const field of ['note','features','usage','fit_version','purpose'] as const){
      const before=previous?.catalog?.fields[field],value=incoming[field],current=previous?.[field]
      if(value!==undefined&&(!previous?.catalog&&(!current||Array.isArray(current)&&!current.length)||JSON.stringify(current)===JSON.stringify(before)||field==='note'&&!previous?.catalog&&String(current).startsWith('【项目精修档案】')))Object.assign(next,{[field]:value})
    }
    if(incoming.project){
      const prior=old.find(l=>l.project?.key===incoming.project!.key)?.project
      const changed=prior?.revision!==incoming.project.revision
      next.project={...incoming.project,history:changed?[...(prior?.history||[]),{at:Date.now(),revision:incoming.project.revision,summary:`${prior?'更新':'登记'}：新增资料 ${candidate.changes.added.length}，刷新 ${candidate.changes.refreshed.length}，保留旧资料 ${candidate.changes.retired.length}`}].slice(-20):prior!.history}
      if (prior?.artwork) next.project.artwork = prior.artwork
    }
    return next
  })
}

export function checkGameProjects(db:SqlDb):GameProjectCheck[]{
  const games=(db.prepare("SELECT id FROM resource WHERE kind='game'").all() as {id:string}[]).map(r=>getGame(db,r.id)!).filter(g=>projectOf(g))
  const sources=[...new Set(games.map(g=>projectOf(g)!.source))]
  return sources.flatMap(source=>{
    const selected=games.filter(g=>projectOf(g)!.source===source)
    try{
      const preview=previewGameProjects(db,source)
      return selected.map(g=>{
        const candidate=preview.candidates.find(c=>c.key===projectOf(g)!.key)
        if (!candidate || candidate.problem) return {id:g.id,state:'unavailable',detail:candidate?.problem||'来源清单中已无此项目'} as GameProjectCheck
        const unavailable=candidate.artwork?.find(image=>image.state==='unavailable')
        if (unavailable) return {id:g.id,state:'unavailable',detail:`图片来源不可用：${unavailable.detail}（${unavailable.path}）`} as GameProjectCheck
        const changes=candidate.changes
        return {id:g.id,state:changes.metadata||changes.added.length||changes.retired.length||changes.missing.length||artworkHasChanges(candidate)?'changed':'current',detail:changes.missing.length?'有附件缺失':changes.retired.length?'来源不再提供部分旧资料，旧关联保留':changes.metadata?'项目内容有更新':artworkHasChanges(candidate)?'项目图片可更新或恢复':'已与来源一致'} as GameProjectCheck
      })
    }catch(error){return selected.map(g=>({id:g.id,state:'unavailable' as const,detail:error instanceof Error?error.message:String(error)}))}
  })
}
