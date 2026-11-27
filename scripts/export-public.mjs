import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PUBLIC_ROOT_FILES = ['package.json','package-lock.json','README.md','README.en.md','LICENSE','CONTRIBUTING.md','SECURITY.md','.gitignore','.editorconfig','.prettierrc.json','.prettierignore','index.html','vite.config.ts','tsconfig.json','electron-builder.yml','electron-builder.portable.yml','electron-builder.green.yml']
export const PUBLIC_DIRECTORIES = ['src','electron','resources','tests','scripts','.github','docs/site','docs/third-party']
export const PUBLIC_DOCS = ['docs/architecture-and-ipc.md']
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const supportScripts=new Set(['build-save-manifest.ts','build-site.mjs','export-public.mjs','generate-architecture-docs.ts','make-icons.cjs','package-windows.ps1','prepare-comic-runtime.py','prepare-hermes-runtime.py','preview-site.mjs','run-tests.cjs','test-manifest.json','fixtures','helpers','lib','selfcheck'])
const localToolTests=new Set(['verify-snapshot-live-db.cjs','verify-photo-data-migration.ts'])
const blockedParts=new Set(['node_modules','.git','.user','.codex','.agents','__pycache__'])

export function publicPackage(pkg, files){
  const scripts=Object.fromEntries(Object.entries(pkg.scripts).filter(([,command])=>
    [...command.matchAll(/scripts\/[\w.-]+/g)].every(match=>files.includes(match[0]))))
  return {...pkg,scripts}
}

export async function publicFiles(projectRoot=root){
  const result=[]
  // Local field checks and historical packaged checks can reference daily profiles.
  // Only portable unit/UI suites and explicit build helpers belong in public source.
  const manifest=JSON.parse(await fs.readFile(path.join(projectRoot,'scripts/test-manifest.json'),'utf8'))
  const suites=new Set(manifest.filter(suite=>['unit','ui-dev'].includes(suite.kind)&&!localToolTests.has(suite.file)).map(suite=>suite.file))
  async function add(relative){
    const absolute=path.join(projectRoot,relative),stat=await fs.lstat(absolute)
    if(stat.isSymbolicLink())throw new Error('Public export refuses links: '+relative)
    if(stat.isDirectory()){
      for(const entry of await fs.readdir(absolute)){
        if(blockedParts.has(entry)||entry.startsWith('.env')||/\.(log|pyc|pyo|db|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm|bak)$/i.test(entry))continue
        if(relative==='scripts'&&!supportScripts.has(entry)&&!suites.has(entry))continue
        await add(relative+'/'+entry)
      }
    }else if(stat.isFile())result.push(relative)
  }
  for(const relative of [...PUBLIC_ROOT_FILES,...PUBLIC_DOCS]){
    try{await add(relative)}catch(error){if(error.code!=='ENOENT')throw error}
  }
  for(const relative of PUBLIC_DIRECTORIES)await add(relative)
  return result.sort()
}

export async function exportPublic(projectRoot=root){
  const files=await publicFiles(projectRoot)
  const parent=path.join(projectRoot,'output/public-export')
  await fs.mkdir(parent,{recursive:true})
  const target=await fs.mkdtemp(path.join(parent,new Date().toISOString().replace(/[:.]/g,'-')+'-'))
  for(const file of files){
    await fs.mkdir(path.dirname(path.join(target,file)),{recursive:true})
    if(file==='package.json'){
      const pkg=JSON.parse(await fs.readFile(path.join(projectRoot,file),'utf8'))
      await fs.writeFile(path.join(target,file),JSON.stringify(publicPackage(pkg,files),null,2)+'\n')
    }else if(file==='scripts/test-manifest.json'){
      const manifest=JSON.parse(await fs.readFile(path.join(projectRoot,file),'utf8')).filter(suite=>files.includes('scripts/'+suite.file))
      await fs.writeFile(path.join(target,file),JSON.stringify(manifest,null,2)+'\n')
    }else await fs.copyFile(path.join(projectRoot,file),path.join(target,file))
  }
  await fs.writeFile(path.join(target,'AGENTS.md'),'# BaoYi contributor guidance\n\nRead README.en.md and CONTRIBUTING.md. Keep user data out of source control. Use isolated profiles for tests. Run npm run typecheck, npm run build, npm run i18n:check and relevant module tests. Run npm run docs:generate when IPC or routes change. Interface copy is bilingual; preserve user text and stored domain values.\n')
  await fs.writeFile(path.join(target,'public-source-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),source:'reviewable working-tree export; no Git history',files:[...files,'AGENTS.md']},null,2)+'\n')
  console.log('Public source prepared for review: '+target)
  return target
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await exportPublic()
