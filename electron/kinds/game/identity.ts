import ts from 'typescript'

export interface KnownGameIdentity {
  name_zh: string
  name_en: string
  identity_name: string
  query: string
  evidence: string
}

export function isGenshinAlias(raw: string): boolean {
  return /^(?:原神|yuanshen|genshin|genshinimpact|hk4e(?:cn|os|global)?)$/i.test(
    String(raw ?? '').trim().replace(/\.(?:exe|lnk|bat|cmd)$/i, '').replace(/[\s_-]+/g, '')
  )
}

/** Only exact product files or named local config fields identify a generic launcher. */
export function isGenshinLauncherAlias(raw: string): boolean {
  const product = String(raw ?? '').trim().replace(/\.(?:exe|lnk|bat|cmd)$/i, '')
    .replace(/(?:启动器|客户端|launcher|client)$/i, '').trim()
  return isGenshinAlias(product)
}

function genshinIdentity(evidence: string): KnownGameIdentity {
  return { name_zh: '原神', name_en: 'Genshin Impact', identity_name: '原神', query: 'Genshin Impact', evidence }
}

export function confirmedGameIdentity(name: string): KnownGameIdentity | null {
  return isGenshinLauncherAlias(name) ? genshinIdentity('用户确认的产品名称') : null
}

export function knownGameIdentity(evidence: { executables: string[]; configs: string[]; selectedExecutable?: string }): KnownGameIdentity | null {
  if (/^(?:YuanShen|GenshinImpact)\.exe$/i.test(evidence.selectedExecutable || '')) {
    return genshinIdentity(`本地产品文件 ${evidence.selectedExecutable}`)
  }
  const executable = evidence.executables.find(name => /^(?:YuanShen|GenshinImpact)\.exe$/i.test(name))
  const values = evidence.configs.flatMap(text => [...text.matchAll(/(?:^|[\r\n,{])\s*["']?(game_biz|game_name|product_name|game_start_name)["']?\s*[:=]\s*["']?([^\r\n,"'}]+)/gi)]
    .map(match => match[2].trim()))
  // Consider all files together: one launcher may contain several product configs.
  if ([...values, ...evidence.executables].some(value => /^(?:(?:hkrpg|nap|bh3|bh2)[_-]|(?:StarRail|ZenlessZoneZero|BH3)\.exe$)/i.test(value))) return null
  const config = values.some(value => isGenshinAlias(value))
  if (!executable && !config) return null
  return genshinIdentity(executable ? `本地产品文件 ${executable}` : '本地产品配置')
}

export interface OfficialIdentity {
  name: string
  query: string
  candidates: string[]
  source: string
}

const IMAGE_RE = /^https:\/\/[^\s"']+\.(?:png|jpe?g|webp|avif)(?:\?[^\s"']*)?$/i

/** Parse bounded static config text. This never evaluates remote JavaScript. */
export function parseOfficialConfig(source: string, sourceUrl: string): OfficialIdentity | null {
  const file = ts.createSourceFile('launcher-config.js', source.slice(0, 2_000_000), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let best: OfficialIdentity | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const scalars = new Map<string, string>()
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.initializer)) continue
        const key = prop.name.getText(file).replace(/["']/g, '')
        scalars.set(key, prop.initializer.text)
      }
      const official = [...scalars.values()].find((v) => /^(原神|Genshin Impact|hk4e_cn)$/i.test(v))
      if (official) {
        const urls: string[] = []
        const walk = (child: ts.Node): void => {
          if (ts.isStringLiteral(child) && IMAGE_RE.test(child.text)) urls.push(child.text)
          if (urls.length < 16) ts.forEachChild(child, walk)
        }
        walk(node)
        const unique = [...new Set(urls)].slice(0, 8)
        if (unique.length && (!best || unique.length > best.candidates.length)) {
          best = {
            name: official === 'Genshin Impact' ? 'Genshin Impact' : '原神',
            query: '原神',
            candidates: unique,
            source: sourceUrl
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return best
}

/** Extract bounded same-origin static config URLs from launcher HTML. */
export function configUrlsFromLauncher(html: string, launcherUrl = 'https://launcher.mihoyo.com/'): string[] {
  const base = new URL(launcherUrl)
  const out: string[] = []
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)) {
    try {
      const u = new URL(match[1], base)
      if (u.protocol === 'https:' && (u.hostname === base.hostname || u.hostname.endsWith('.mihoyo.com'))) out.push(u.href)
    } catch { /* ignore malformed HTML */ }
  }
  return [...new Set(out)].slice(0, 12)
}
