import { ref, type App } from 'vue'
import { resolveLocale, setLocaleReader, tr, systemMessage, type Locale, type LanguageSetting } from './core.ts'
export { resolveLocale, tr, systemMessage } from './core.ts'
export type { Locale, LanguageSetting } from './core.ts'
export const locale = ref<Locale>('zh-CN')
setLocaleReader(() => locale.value)

export function applyLanguage(setting: LanguageSetting): void {
  locale.value = resolveLocale(setting, typeof navigator === 'undefined' ? ['zh-CN'] : navigator.languages)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale.value
    document.title = locale.value === 'en' ? 'BaoYi' : '抱一'
  }
}

export function dateTime(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale.value, options).format(value)
}

export function number(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale.value, options).format(value)
}

export function installI18n(app: App): void {
  app.config.globalProperties.$t = tr
  app.config.globalProperties.$systemMessage = systemMessage
  Object.defineProperty(app.config.globalProperties, '$locale', { get: () => locale.value })
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $t: typeof tr
    $systemMessage: typeof systemMessage
    $locale: Locale
  }
}
