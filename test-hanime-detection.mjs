import { hanimeChannel, looksLikeHentaiName } from './electron/kinds/video/hentai/channel.ts'

const testCases = [
  '妻NTR・凌辱輪迴 4  妻ネトリ 姦 美術教師の場合 [中文字幕]_720P',
  '妻NTR・凌辱輪迴 4  妻ネトリ 姦 美術教師の場合 [中文字幕]_720P.mkv',
  '妻NTR・凌辱輪迴 4  妻ネトリ 姦 美術教師の場合 [中文字幕]_720P.mp4'
]

console.log('测试里番识别逻辑：\n')

for (const name of testCases) {
  const result = hanimeChannel(name, '')
  const looks = looksLikeHentaiName(name)
  console.log(`文件名: ${name}`)
  console.log(`  looksLikeHentaiName: ${looks}`)
  console.log(`  hanimeChannel 结果: ${result || '(空串 - 不走里番通道)'}`)
  console.log(`  包含"中文字幕": ${name.toLowerCase().includes('中文字幕')}`)
  console.log('')
}
