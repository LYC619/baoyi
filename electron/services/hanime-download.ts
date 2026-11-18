import { getDb } from './database.ts'
import { net } from 'electron'
import { createVideoMediaTransfer } from '../kinds/video/download/media.ts'
import { createChromiumDownloadFetch } from './chromium-download-fetch.ts'
import { getSettings } from './settings-store.ts'
import { getHanimeSession, recoverHanimeConnections, waitForHanimeNetworkRecovery } from './proxy.ts'
import { locateFfmpeg } from '../kinds/video/download/ffmpeg.ts'

/** Shared by legacy and persistent downloads: one global video/connection budget. */
export const transferHanimeMedia=createVideoMediaTransfer({
  settings:()=>getSettings(getDb()),
  ffmpeg:()=>locateFfmpeg(getSettings(getDb()).ffmpeg_path,getSettings(getDb()).software_scan_dirs),
  recoverNetwork:()=>recoverHanimeConnections(),
  fetch:async(input,init)=>{
    await waitForHanimeNetworkRecovery()
    return createChromiumDownloadFetch(options=>net.request(options),getHanimeSession())(input,init)
  }
})
