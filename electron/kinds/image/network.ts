import { net } from 'electron'
import { createChromiumDownloadFetch } from '../../services/network/chromium-download-fetch.ts'
import { getImageSourceSession } from '../../services/network/proxy.ts'

export function createImageSourceFetch(): (url:string,init?:RequestInit)=>Promise<Response> {
  return (url,init)=>{
    const ses=getImageSourceSession()
    if(init?.redirect==='manual'){
      const media=createChromiumDownloadFetch(options=>net.request(options),ses)
      return media(url,{...init,credentials:'omit'})
    }
    return ses.fetch(url,init)
  }
}
