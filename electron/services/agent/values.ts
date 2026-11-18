/** 模型工具参数的文本边界：只收字符串，去掉首尾空白并限制长度。 */
export function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}
