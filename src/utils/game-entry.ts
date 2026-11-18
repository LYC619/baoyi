/** APKs and resource folders can be catalogued, but are not Windows game launchers. */
export const isWindowsGameEntry = (target: string) => /\.(exe|bat|cmd|lnk)$/i.test(target)
