
import { tr } from "../i18n/index.ts"
import type {TextAnchor} from '../types/workspace.ts'

// A change detector, not a security hash; exact text is always checked as well.
export function textFingerprint(text:string):string {
  let a=2166136261,b=5381
  for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i)}
  return `${text.length}:${a>>>0}:${b>>>0}`
}
export function makeTextAnchor(text:string,start:number,end:number,kind:TextAnchor['kind']):TextAnchor {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>text.length||end-start>30000)throw new Error(tr('文字范围无效'))
  return {version:1,kind,start,end,exact:text.slice(start,end),prefix:text.slice(Math.max(0,start-48),start),suffix:text.slice(end,end+48),fingerprint:textFingerprint(text)}
}
export function resolveTextAnchor(text:string,anchor?:TextAnchor,legacyQuote=''):{start:number;end:number;status:'exact'|'relocated'}|null {
  const quote=anchor?.exact||legacyQuote;if(!quote)return null
  if(anchor&&anchor.fingerprint===textFingerprint(text)&&text.slice(anchor.start,anchor.end)===quote)return {start:anchor.start,end:anchor.end,status:'exact'}
  const matches:number[]=[]
  for(let i=text.indexOf(quote);i>=0;i=text.indexOf(quote,i+1)){matches.push(i);if(matches.length>10000)return null}
  const candidates=matches.length===1?matches:matches.filter(i=>anchor&&(anchor.prefix||anchor.suffix)&&(!anchor.prefix||text.slice(Math.max(0,i-anchor.prefix.length),i)===anchor.prefix)&&(!anchor.suffix||text.slice(i+quote.length,i+quote.length+anchor.suffix.length)===anchor.suffix))
  if(candidates.length!==1)return null
  return {start:candidates[0],end:candidates[0]+quote.length,status:'relocated'}
}

/** DOM ranges use the same UTF-16 coordinates as textContent, across inline nodes. */
export function rangeOffsets(root:Element,range:Range):{start:number;end:number} {
  if(!root.contains(range.startContainer)||!root.contains(range.endContainer))throw new Error(tr('选文超出正文范围'))
  const prefix=range.cloneRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset)
  const start=prefix.toString().length;return {start,end:start+range.toString().length}
}
export function rangeFromOffsets(root:Element,start:number,end:number):Range|null {
  const walker=root.ownerDocument.createTreeWalker(root,NodeFilter.SHOW_TEXT),range=root.ownerDocument.createRange();let total=0,started=false
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    const length=node.textContent?.length||0
    if(!started&&start<total+length){range.setStart(node,start-total);started=true}
    if(started&&end<=total+length){range.setEnd(node,end-total);return range}
    total+=length
  }
  return null
}
