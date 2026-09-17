import { deflateSync } from 'node:zlib'

/** Small, genuinely decodable PNGs; no image downloads or installed games in fixtures. */
export function pngFixture(width: number, height: number, rgb = [45, 92, 156]): Buffer {
  function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3
      for (let color = 0; color < 3; color++) rows[offset + color] = rgb[color]
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))
  ])
}
