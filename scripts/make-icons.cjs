/**
 * 从 resources/icon.svg 生成打包用的图标：
 *   resources/icon.png  512x512（mac / linux，也是 electron-builder 的通用回退）
 *   resources/icon.ico  16/24/32/48/64/128/256 七个尺寸（Windows）
 *
 * 用 Electron 自己渲染 —— 它带着 Chromium，SVG 渲染结果就是应用里看到的那个，
 * 不用引一个图形库进来，也不用手工在 GDI+ 里把那几段弧重画一遍（重画就等于
 * 维护两份图标，改了 svg 而忘了改代码时没人会发现）。
 *
 *   npx electron scripts/make-icons.cjs
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const RES = path.join(__dirname, '..', 'resources')
const SVG = path.join(RES, 'icon.svg')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 按 ICO 容器格式把若干 PNG 拼起来。Vista 之后的 Windows 认 PNG 压缩的条目，
 * 所以不用退回 BMP + AND 掩码那套老格式。
 * 256 在头里写 0 —— 那两个字段各只有一个字节，256 存不下，格式规定用 0 表示。
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((e, i) => {
    const at = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 0)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1)
    dir.writeUInt8(0, at + 2) // 调色板颜色数：真彩色写 0
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // planes
    dir.writeUInt16LE(32, at + 6) // 位深
    dir.writeUInt32LE(e.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += e.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

async function main() {
  if (!fs.existsSync(SVG)) throw new Error(`找不到图标源文件：${SVG}`)
  const svg = fs.readFileSync(SVG, 'utf8')

  // 透明背景：图标是圆角矩形，四个角外面必须是透明的，不然装出来是个方块
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })

  // margin:0 + 定死 512：SVG 自带 width/height，但页面默认 8px 边距会把它挤偏
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:512px;height:512px}</style>${svg}`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 400))

  const shot = await win.webContents.capturePage()
  if (shot.isEmpty()) throw new Error('截到的是空图 —— 页面没渲染出来')

  const png512 = shot.resize({ width: 512, height: 512, quality: 'best' })
  fs.writeFileSync(path.join(RES, 'icon.png'), png512.toPNG())

  const entries = ICO_SIZES.map((size) => ({
    size,
    png: shot.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  fs.writeFileSync(path.join(RES, 'icon.ico'), buildIco(entries))

  console.log(`icon.png  512x512  ${fs.statSync(path.join(RES, 'icon.png')).size} B`)
  console.log(
    `icon.ico  ${ICO_SIZES.join('/')}  ${fs.statSync(path.join(RES, 'icon.ico')).size} B`
  )

  win.destroy()
  app.quit()
}

app.whenReady().then(main).catch((e) => {
  console.error('生成图标失败：', e.message)
  process.exit(1)
})
