import english from './en.json' with { type: 'json' }

export type Locale = 'zh-CN' | 'en'
export type LanguageSetting = Locale | 'system'
type Params = Record<string, unknown>
const messages: Record<string, string> = Object.assign(Object.create(null), english)
let readLocale: () => Locale = () => 'zh-CN'
export function setLocaleReader(read: () => Locale): void { readLocale = read }
export const currentLocale = { get value(): Locale { return readLocale() } }

export function resolveLocale(setting: LanguageSetting, languages: readonly string[] = []): Locale {
  if (setting !== 'system') return setting
  return languages[0]?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** Shared by runtime translation and the static catalogue checker. */
export function isSystemTemplate(source: string): boolean {
  return /\{p\d+\}/.test(source) && /\p{Script=Han}/u.test(source) &&
    (source.replace(/\{p\d+\}/g, '').length >= 4 || source === '已启动{p0}' || source === '{p0}无效')
}

/** Only application-owned messages enter this function. User text is never translated. */
export function tr(message: string, params: Params = {}): string {
  const translated = currentLocale.value === 'en' ? messages[message] ?? message : message
  return translated.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(params, name) ? String(params[name] ?? '') : token)
}

const patterns = Object.entries(messages).filter(([source]) => isSystemTemplate(source)).map(([source, target]) => {
  const names = [...source.matchAll(/\{(p\d+)\}/g)].map(match => match[1])
  return { source, target, names, literals: source.split(/\{p\d+\}/g) }
}).sort((a, b) => b.source.replace(/\{p\d+\}/g, '').length - a.source.replace(/\{p\d+\}/g, '').length)

/** For existing system notifications received from the main process, never library content. */
export function systemMessage(message: string): string {
  if (currentLocale.value !== 'en' || !/[\p{Script=Han}]/u.test(message)) return message
  if (messages[message]) return messages[message]
  if (message.length > 2048) return message
  for (const pattern of patterns) {
    const { literals } = pattern
    const suffix = literals[literals.length - 1]
    if (!message.startsWith(literals[0]) || !message.endsWith(suffix)) continue
    let position = literals[0].length
    const end = message.length - suffix.length
    const values: string[] = []
    // Ordered literal delimiters avoid wildcard regex backtracking on long errors.
    for (let i = 1; i < literals.length; i++) {
      const next = i === literals.length - 1 ? end : message.indexOf(literals[i], position)
      if (next < position || next > end) break
      values.push(message.slice(position, next))
      position = next + literals[i].length
    }
    if (values.length !== pattern.names.length) continue
    if (pattern.source === '{p0}无效' && !messages[values[0]] && !/^[\w.-]+$/.test(values[0])) continue
    return pattern.target.replace(/\{(p\d+)\}/g, (token, name: string) => {
      const index = pattern.names.indexOf(name)
      return index < 0 ? token : messages[values[index]] ?? values[index]
    })
  }
  return message
}
