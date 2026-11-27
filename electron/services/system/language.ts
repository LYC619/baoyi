import { resolveLocale, setLocaleReader, type LanguageSetting } from '../../../src/i18n/core.ts'
export { currentLocale, systemMessage, tr } from '../../../src/i18n/core.ts'

const listeners = new Set<() => void>()

export function onNativeLanguageChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Native dialogs share the saved UI language without importing Vue or opening a database. */
export function setNativeLanguage(setting: LanguageSetting, systemLanguages: readonly string[]): void {
  const language = resolveLocale(setting, systemLanguages)
  setLocaleReader(() => language)
  for (const listener of [...listeners]) listener()
}
