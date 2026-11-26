const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function checkRuntime(root){
  root=path.resolve(root)
  const stampFile=path.join(root,'runtime-stamp.json')
  assert.ok(fs.existsSync(stampFile),'Hermes 运行组件未准备好，请先运行 npm run prepare:hermes')
  const stamp=JSON.parse(fs.readFileSync(stampFile,'utf8')),files=[]
  function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue
    const file=path.join(directory,entry.name)
    assert.ok(!entry.isSymbolicLink(),'Runtime must be relocatable: '+file)
    if(entry.isDirectory())visit(file)
    else if(file!==stampFile)files.push([path.relative(root,file).replaceAll('\\','/'),digest(file)])
  }}
  visit(root);files.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)
  assert.equal(stamp.manifestSha256,digest(path.join(root,'manifest.json')),'Hermes manifest changed after preparation')
  assert.equal(stamp.fileCount,files.length,'Hermes runtime file count changed')
  assert.equal(stamp.treeSha256,crypto.createHash('sha256').update(files.map(([name,hash])=>name+'\0'+hash+'\n').join('')).digest('hex'),'Hermes runtime content changed after preparation')
  for(const file of ['python/python.exe','python/LICENSE.txt','hermes/run_agent.py','hermes/LICENSE','requirements.txt','dependencies.json'])assert.ok(fs.existsSync(path.join(root,file)),file)
  return {files:files.length,sha256:stamp.treeSha256,sourceCommit:stamp.sourceCommit}
}
module.exports={checkRuntime}
if(require.main===module){console.log(JSON.stringify(checkRuntime(process.argv[2]||'output/hermes-runtime')));if(!process.argv[2])console.log(JSON.stringify(require('./check-comic-runtime.cjs').checkComicRuntime('output/comic-runtime')))}
