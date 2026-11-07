const {spawnSync}=require('node:child_process')
const scripts=[
  'verify-software-category.ts','verify-download-stability.ts','verify-video-streams.ts','verify-field-video.ts',
  'verify-video-acceleration.ts','verify-video-media.ts','verify-video-concurrency.ts',
  'verify-video-download.ts','verify-video-download-service.ts','verify-video-download-network.ts',
  'verify-video-series-download.ts','verify-video-workflow.ts','verify-video-workflow-ui.ts',
  'verify-discovery-workflow.ts','verify-library-backup.ts','verify-hanime-verification.ts','verify-field-ffmpeg.ts','verify-missav-parse.ts'
]
let failed=0
for(const script of scripts){
  const result=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','scripts/'+script],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024})
  if(result.status!==0){failed++;console.error('FAIL '+script+'\n'+(result.error?.message||'')+'\n'+result.stdout+result.stderr)}
  else console.log('PASS '+script+': '+result.stdout.trim().split(/\r?\n/).at(-1))
}
console.log('Download improvements: '+(scripts.length-failed)+' suites passed / '+failed+' failed')
process.exitCode=failed?1:0
