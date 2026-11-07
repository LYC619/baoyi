/** 手机安装包作为软件记录管理，不作为 Windows 可执行程序运行。 */
export const MOBILE_PACKAGE_EXTENSIONS = ['apk', 'apks', 'xapk', 'aab', 'ipa', 'hap']
export const SOFTWARE_EXTENSIONS = ['exe', ...MOBILE_PACKAGE_EXTENSIONS]
export const APP_CATEGORY = 'APP'

export function isMobilePackage(file: string): boolean {
  return MOBILE_PACKAGE_EXTENSIONS.includes(extensionOf(file))
}

export function isSoftwareFile(file: string): boolean {
  return SOFTWARE_EXTENSIONS.includes(extensionOf(file))
}

function extensionOf(file: string): string {
  return /\.([^.\\/]+)$/.exec(file)?.[1].toLowerCase() ?? ''
}
