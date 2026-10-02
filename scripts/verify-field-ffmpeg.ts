import assert from 'node:assert/strict'
import path from 'node:path'
import {createRendererLoader} from './helpers/renderer-harness.ts'
const files=new Set<string>(),valid=new Set<string>(),root='E:\\Software',file=path.win32.join(root,'Media','bin','ffmpeg.exe')
const directories=new Map([
 [root,[{name:'Media',isDirectory:()=>true,isFile:()=>false}]],
 [path.win32.join(root,'Media'),[{name:'bin',isDirectory:()=>true,isFile:()=>false}]],
 [path.win32.join(root,'Media','bin'),[{name:'ffmpeg.exe',isDirectory:()=>false,isFile:()=>true}]],
])
const mockedFs={statSync:(p:string)=>{if(!files.has(p))throw new Error('missing');return {isFile:()=>true}},readdirSync:(p:string)=>directories.get(p)||[]}
const load=createRendererLoader({'node:fs':{default:mockedFs,...mockedFs},'node:path':{default:path.win32,...path.win32},'node:child_process':{
 execFileSync:(p:string,args:string[],options:any)=>{assert.ok(options.timeout>0&&options.windowsHide);if(p==='where')throw new Error('not on PATH');assert.equal(args.join(','),'-version');return valid.has(p)?'ffmpeg version 7.1\n':'unrelated program'},spawn:()=>{throw new Error('not used')}
}},{process:{platform:'win32',env:{}}})
const {locateFfmpeg,validateFfmpeg}=load('electron/kinds/video/download/ffmpeg.ts')
assert.equal(locateFfmpeg('',[root]),null)
files.add(file);valid.add(file)
assert.equal(locateFfmpeg('',[root]),file,'a previous failed detection must not be cached')
assert.equal(locateFfmpeg(file,[]),file)
valid.delete(file)
assert.equal(validateFfmpeg(file),false)
assert.throws(()=>locateFfmpeg(file,[]),/配置的 FFmpeg 无效/)
assert.equal(locateFfmpeg('',[root]),null,'an obsolete successful cache must be revalidated')
console.log('PASS FFmpeg configured path, software-root discovery, executable validation and cache invalidation')
