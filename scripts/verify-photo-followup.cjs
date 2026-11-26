const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process')
const output=path.resolve('output/photo-followup-2026-10-29');fs.mkdirSync(output,{recursive:true})
const suites=['verify-photo-folder-sync.ts','verify-video-removal-residue.ts','verify-photo-library.ts','verify-video-library-service.ts','verify-image-management-field.ts','agent-selfcheck.ts']
const results=[]
for(const name of suites){const r=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','scripts/'+name],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});fs.writeFileSync(path.join(output,name+'.log'),(r.stdout||'')+(r.stderr||'')+(r.error?.message||''));results.push({name,exitCode:r.status,passed:r.status===0});console.log((r.status===0?'PASS ':'FAIL ')+name);if(r.status!==0)console.log(r.stderr||r.stdout)}
fs.writeFileSync(path.join(output,'regressions.json'),JSON.stringify({status:results.every(r=>r.passed)?'passed':'failed',results},null,2));process.exitCode=results.every(r=>r.passed)?0:1
