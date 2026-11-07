import test from 'node:test'
import assert from 'node:assert/strict'
import { outlinePdf, textPdf } from './helpers/pdf-fixture.ts'

test('native PDF outlines preserve hierarchy and resolve named and referenced pages',async()=>{
  const {normalizeOutline,outlinePage}=await import('../src/utils/pdf-outline.ts')
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task=getDocument({data:new Uint8Array(Buffer.from(outlinePdf())),useSystemFonts:true})
  const pdf=await task.promise
  try {
    const {nodes,truncated}=normalizeOutline(await pdf.getOutline())
    assert.equal(truncated,false);assert.equal(nodes.length,4)
    assert.equal(await outlinePage(pdf,nodes[0].dest),1)
    assert.equal(await outlinePage(pdf,nodes[1].dest),2)
    assert.equal(await outlinePage(pdf,nodes[1].children[0].dest),3)
    assert.equal(nodes[2].dest,null)
    assert.equal(await outlinePage(pdf,nodes[3].dest),null)
    assert.equal(await outlinePage(pdf,[0,{name:'Fit'}]),1)
    assert.equal(await outlinePage(pdf,[99,{name:'Fit'}]),null)
    assert.equal(await outlinePage(pdf,[NaN]),null)
    assert.equal(await outlinePage(pdf,{url:'https://example.com'}),null)
    assert.notEqual(nodes[1].id,nodes[1].children[0].id)
  } finally {await task.destroy()}
  const plain=getDocument({data:new Uint8Array(Buffer.from(textPdf())),useSystemFonts:true})
  try {assert.equal(normalizeOutline(await (await plain.promise).getOutline()).nodes.length,0)}finally{await plain.destroy()}
})

test('outline size and depth limits bound malformed trees',async()=>{
  const {normalizeOutline,outlinePage}=await import('../src/utils/pdf-outline.ts')
  const tree:any={title:'Parent',dest:null,items:[]};tree.items=[tree]
  assert.equal(normalizeOutline([tree]).truncated,true)
  assert.equal(normalizeOutline(Array.from({length:6000},()=>({title:'Same',dest:null,items:[]}))).nodes.length,5000)
  const pdf:any={numPages:3,getDestination:async()=>{throw Error('bad')},getPageIndex:async()=>{throw Error('bad')}}
  assert.equal(await outlinePage(pdf,'bad'),null)
  assert.equal(await outlinePage(pdf,[{num:999,gen:0}]),null)
})
