import exifr from 'exifr'
import type { PhotoMetadata } from '../../../src/types/image.ts'

/** Reading camera metadata is optional: broken/missing EXIF never hides a photo. */
export async function readPhotoMetadata(data: Uint8Array): Promise<PhotoMetadata> {
  try {
    const raw=await exifr.parse(data,{pick:['Make','Model','LensModel','DateTimeOriginal','CreateDate','ModifyDate','ExposureTime','FNumber','ISO','FocalLength','Orientation'],reviveValues:false})
    if (!raw) return {}
    const value:PhotoMetadata={}
    const camera=[raw.Make,raw.Model].filter(Boolean).join(' ').trim()
    if(camera)value.camera=camera
    if(raw.LensModel)value.lens=String(raw.LensModel)
    const date=raw.DateTimeOriginal||raw.CreateDate||raw.ModifyDate
    if(date)value.takenAt=String(date).replace(/^(\d{4}):(\d{2}):(\d{2})/,'$1-$2-$3')
    const exposure=Number(raw.ExposureTime)
    if(exposure>0)value.exposure=exposure<1?`1/${Math.round(1/exposure)} s`:`${exposure} s`
    if(Number(raw.FNumber)>0)value.aperture=`f/${raw.FNumber}`
    if(Number(raw.ISO)>0)value.iso=Number(raw.ISO)
    if(Number(raw.FocalLength)>0)value.focalLength=`${raw.FocalLength} mm`
    if(raw.Orientation)value.orientation=String(raw.Orientation)
    return value
  }catch{return {}}
}
