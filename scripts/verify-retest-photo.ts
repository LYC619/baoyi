import test from 'node:test'
import assert from 'node:assert/strict'

function photo() {
  const fields:Array<[number,string]>=[[0x010f,'Camera Maker'],[0x0110,'Camera Model'],[0x0132,'2024:06:12 09:30:00']]
  const tiff=Buffer.alloc(256);tiff.write('II');tiff.writeUInt16LE(42,2);tiff.writeUInt32LE(8,4);tiff.writeUInt16LE(fields.length,8)
  let offset=10+fields.length*12+4
  fields.forEach(([tag,value],i)=>{const pos=10+i*12;tiff.writeUInt16LE(tag,pos);tiff.writeUInt16LE(2,pos+2);tiff.writeUInt32LE(value.length+1,pos+4);tiff.writeUInt32LE(offset,pos+8);tiff.write(value,offset);offset+=value.length+1})
  const exif=Buffer.concat([Buffer.from('Exif\0\0'),tiff.subarray(0,offset)]),header=Buffer.from([0xff,0xd8,0xff,0xe1,0,0]);header.writeUInt16BE(exif.length+2,4)
  return Buffer.concat([header,exif,Buffer.from([0xff,0xc0,0,17,8,0,12,0,16,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9])])
}
test('自动读取照片相机与拍摄时间，缺少 EXIF 的图片仍可读取', async()=>{
  const metadata=await import('../electron/kinds/image/photo-metadata.ts').catch(()=>({readPhotoMetadata:undefined}))
  assert.equal(typeof metadata.readPhotoMetadata,'function')
  const info=await metadata.readPhotoMetadata!(photo())
  assert.equal(info.camera,'Camera Maker Camera Model')
  assert.match(info.takenAt||'',/2024-06-12/)
  assert.deepEqual(await metadata.readPhotoMetadata!(Buffer.from('invalid')), {})
})
