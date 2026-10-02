/** A browser address, independent of any website's catalogue or content. */
export function normalizeWebUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入网页地址')
  let input = value.trim()
  if (!input || input.length > 4000 || /[\s\\\u0000-\u001f\u007f]/.test(input)) throw new Error('网页地址无效，请检查后重试')
  if (input.startsWith('//')) input = 'https:' + input
  else if (!/^[a-z][a-z\d+.-]*:/i.test(input) || /^(?:localhost|[a-z\d.-]+\.[a-z\d.-]+):\d+(?:[/?#]|$)/i.test(input)) input = 'https://' + input
  try {
    const url = new URL(input)
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error()
    return url.href
  } catch { throw new Error('只支持不含账号密码的 HTTP(S) 网页地址') }
}

/** Navigation events already provide absolute URLs; never reinterpret protocols. */
export function isWebNavigation(value: string): boolean {
  return /^https?:\/\//i.test(value) && (() => { try { normalizeWebUrl(value); return true } catch { return false } })()
}
