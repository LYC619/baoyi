import { net, session } from 'electron'
import { createChromiumDownloadFetch } from '../../services/chromium-download-fetch.ts'

export function createImageSourceFetch(): (url:string,init?:RequestInit)=>Promise<Response> {
  const media=createChromiumDownloadFetch(options=>net.request(options),session.defaultSession)
  return (url,init)=>init?.redirect==='manual'
    ? media(url,{...init,credentials:'omit'})
    : net.fetch(url,init)
}
