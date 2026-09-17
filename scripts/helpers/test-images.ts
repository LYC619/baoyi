import { deflateSync } from 'node:zlib'

/** Small real PNGs for decoded-image and native-protocol tests. */
export function pngImage(width: number, height: number, color = [40, 90, 150]): Buffer<ArrayBuffer> {
  const crc = (data: Buffer) => {
    let value = 0xffffffff
    for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0) }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type,data])))
    return Buffer.concat([length,type,data,checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2
  const pixels = Buffer.alloc(height * (width * 3 + 1))
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) for (let c=0; c<3; c++) pixels[y*(width*3+1)+1+x*3+c]=color[c]
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))])
}
