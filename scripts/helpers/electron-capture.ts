import assert from 'node:assert/strict'
import fs from 'node:fs'

/** Briefly expose the synthetic test window without focusing it so Windows supplies a composited surface. */
export async function captureHiddenElectron(app: any, target: string): Promise<void> {
  const capture = await app.evaluate(async ({ BrowserWindow }: any) => {
    const window = BrowserWindow.getAllWindows()[0], visible = window.isVisible()
    if (!visible) window.showInactive()
    try {
      const image = await window.webContents.capturePage()
      return { size: image.getSize(), png: image.toPNG().toString('base64') }
    } finally { if (!visible) window.hide() }
  })
  assert.ok(capture.size.width > 0 && capture.size.height > 0, 'native window capture must not be empty')
  fs.writeFileSync(target, Buffer.from(capture.png, 'base64'))
}
