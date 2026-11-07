const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict')
function checkComicRuntime(root){
  root=path.resolve(root)
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const stampFile=path.join(root,'runtime-stamp.json'),stamp=JSON.parse(fs.readFileSync(stampFile,'utf8')),files=[]
  function visit(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue
    const file=path.join(folder,entry.name);assert.ok(!entry.isSymbolicLink(),'Comic runtime must be relocatable')
    if(entry.isDirectory())visit(file);else if(file!==stampFile)files.push([path.relative(root,file).replaceAll('\\','/'),digest(file)])
  }}
  visit(root);files.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)
  const expected=new Map(stamp.files)
  assert.equal(stamp.format,'baoyi-comic-runtime');assert.equal(stamp.sourceVersion,'jmcomic==2.7.11');assert.equal(files.length,expected.size)
  for(const [file,hash]of files)assert.equal(hash,expected.get(file),'Comic runtime changed: '+file)
  // The Python stamp follows Windows path ordering; verify its exact order too.
  assert.equal(stamp.treeSha256,crypto.createHash('sha256').update(stamp.files.map(([name,hash])=>name+'\0'+hash+'\n').join('')).digest('hex'))
  for(const file of ['site-packages/jmcomic/__init__.py','site-packages/jmcomic-2.7.11.dist-info/licenses/LICENSE','requirements.lock','dependencies.json'])assert.ok(fs.existsSync(path.join(root,file)),file)
  return {files:files.length,sha256:stamp.treeSha256,version:stamp.sourceVersion}
}
module.exports={checkComicRuntime}
if(require.main===module)console.log(JSON.stringify(checkComicRuntime(process.argv[2]||'output/comic-runtime')))
