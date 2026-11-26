import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import type { ElementNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import { isSystemTemplate } from '../src/i18n/core.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const han = /\p{Script=Han}/u
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(',')
// Persisted business values may occur in comparisons/assignments, never as display fallbacks.
const businessEnums = new Set(['其他', '其他分类', '未分类', '里番', '电影', '剧集', '动画', '纪录片', '综艺', '音乐', '音频', '有声书', '服务', '经历', '华语', '欧美', '日韩', '调研写作'])

export function createChecker(catalog: Record<string, string>) {
  const failures: string[] = []
  const used = new Set<string>()
  function checkMessage(message: string, file: string, system = false): void {
    used.add(message)
    if (!Object.hasOwn(catalog, message)) failures.push('Missing translation in ' + file + ': ' + message)
    if (system && /\{p\d+\}/.test(message) && !isSystemTemplate(message)) failures.push('System template cannot match at runtime in ' + file + ': ' + message)
  }
  function script(source: string, file: string, ui = false): void {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const main = /[\\/]electron[\\/]/.test(file)
    const isTranslation = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && ['$t', 'tr'].includes(n.expression.getText(ast))
    const string = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
    function systemLiteral(n: ts.Node): string | null {
      if (string(n)) return n.text
      if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((part, i) => '{p' + i + '}' + part.literal.text).join('')
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const parts: Array<string | null> = []
        function flatten(value: ts.Expression): void {
          if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) { flatten(value.left); flatten(value.right) }
          else if (ts.isTemplateExpression(value)) { parts.push(value.head.text); for (const span of value.templateSpans) parts.push(null, span.literal.text) }
          else parts.push(string(value) ? value.text : null)
        }
        flatten(n); let index = 0
        return parts.map(part => part === null ? '{p' + index++ + '}' : part).join('')
      }
      return null
    }
    function checkSystem(n: ts.Node, reason = false): void {
      const message = systemLiteral(n)
      if (message && han.test(message)) {
        checkMessage(message, file, true)
        // Dynamic reasons match complete errors, never recursively match a captured path.
        if (reason && /\{p\d+\}/.test(message)) checkMessage('参数 {p0} 无效：' + message.replace(/\{p(\d+)\}/g, (_, i) => '{p' + (Number(i) + 1) + '}'), file, true)
      } else if (ts.isConditionalExpression(n)) { checkSystem(n.whenTrue, reason); checkSystem(n.whenFalse, reason) }
    }
    function enumValue(n: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
      if (!businessEnums.has(n.text)) return false
      const p = n.parent
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsToken].includes(p.operatorToken.kind)) return true
      return ts.isArrayLiteralExpression(p)
    }
    function checkUi(n: ts.Node): void {
      if (isTranslation(n)) {
        for (const arg of n.arguments.slice(1)) checkUi(arg)
        return
      }
      if (string(n) && han.test(n.text) && !enumValue(n)) {
        const p = n.parent
        if (!((ts.isPropertyAssignment(p) || ts.isPropertyAccessExpression(p)) && p.name === n)) failures.push('Untranslated UI literal in ' + file + ': ' + n.text)
      }
      if ((ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && han.test(n.text)) failures.push('Untranslated UI template in ' + file + ': ' + n.text)
      ts.forEachChild(n, checkUi)
    }
    function insideMenu(n: ts.Node): boolean {
      for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && p.expression.getText(ast) === 'Menu.buildFromTemplate') return true
      return false
    }
    function visit(n: ts.Node): void {
      if (main) {
        if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText(ast))) for (const arg of n.arguments || []) checkSystem(arg)
        if (ts.isPropertyAssignment(n) && /^(message|reason|error|phase|warning|transferMessage)$/.test(n.name.getText(ast))) checkSystem(n.initializer)
        if (ts.isPropertyAssignment(n) && n.name.getText(ast) === 'label' && insideMenu(n)) checkUi(n.initializer)
        if (ts.isNewExpression(n) && n.expression.getText(ast) === 'BrowserWindow') for (const arg of n.arguments || []) if (ts.isObjectLiteralExpression(arg)) for (const p of arg.properties) if (ts.isPropertyAssignment(p) && p.name.getText(ast) === 'title') checkUi(p.initializer)
        if (ts.isCallExpression(n)) {
          const call = n.expression.getText(ast)
          if (call === 'invalidArg' && n.arguments[1]) checkSystem(n.arguments[1], true)
          if (/\.(showErrorBox|setTitle)$/.test(call)) for (const arg of n.arguments) checkUi(arg)
          const fieldArg = /^(?:v\.)?(?:text|number|projectRelative|array)$/.test(call) ? n.arguments[1] : call === 'str' ? n.arguments[2] : undefined
          if (fieldArg && string(fieldArg) && han.test(fieldArg.text)) checkMessage(fieldArg.text, file)
        }
      }
      if (isTranslation(n) && n.arguments.length) {
        const first = n.arguments[0]
        if (string(first)) checkMessage(first.text, file)
        else if (ts.isTemplateExpression(first) || ts.isBinaryExpression(first)) failures.push('Translation key must be a complete static sentence in ' + file + ': ' + first.getText(ast))
        if (!ui) for (const arg of n.arguments.slice(1)) checkUi(arg)
      }
      ts.forEachChild(n, visit)
    }
    visit(ast)
    if (ui) checkUi(ast)
  }
  function template(n: RootNode | TemplateChildNode, file: string, skip = false): void {
    if (n.type === 1) {
      const el = n as ElementNode
      if (el.tag === 'option' && !el.props.some(p => p.type === 6 && p.name === 'value' || p.type === 7 && p.name === 'bind' && p.arg?.type === 4 && p.arg.content === 'value') && el.children.some(c => c.type === 5 && c.content.type === 4 && c.content.content.includes('$t('))) {
        failures.push('Translated option needs an explicit stable value in ' + file)
      }
      if (el.props.some(p => p.name === 'lang' || p.name === 'pre')) skip = true
      for (const p of el.props) {
        if (p.type === 7 && p.exp && p.exp.type === 4) script(p.exp.content, file, true)
        if (p.type === 6 && p.value && ['title', 'placeholder', 'aria-label', 'alt', 'label', 'hint', 'all-label', 'empty-categories', 'tag-label'].includes(p.name) && han.test(p.value.content) && p.value.content !== 'Language / 界面语言') {
          failures.push('Untranslated attribute in ' + file + ': ' + p.value.content)
        }
      }
    }
    if (n.type === 2 && !skip && han.test(n.content)) failures.push('Untranslated template text in ' + file + ': ' + n.content.trim())
    if (n.type === 5 && n.content.type === 4) script(n.content.content, file, true)
    if ('children' in n && n.type !== 8) for (const child of n.children) template(child, file, skip)
  }
  return { failures, used, script, template }
}

export function checkRepository() {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/en.json'), 'utf8')) as Record<string, string>
  const check = createChecker(catalog)
  for (const [source, target] of Object.entries(catalog)) {
    if (typeof target !== 'string' || !target.trim()) check.failures.push('Empty translation: ' + source)
    else if (placeholders(source) !== placeholders(target)) check.failures.push('Changed interpolation variables: ' + source)
  }
  function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'i18n') walk(file) }
      else if (file.endsWith('.vue')) {
        const d = parse(fs.readFileSync(file, 'utf8')).descriptor
        if (d.scriptSetup) check.script(d.scriptSetup.content, file)
        if (d.script) check.script(d.script.content, file)
        if (d.template?.ast) check.template(d.template.ast, file)
      } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) check.script(fs.readFileSync(file, 'utf8'), file)
    }
  }
  walk(path.join(root, 'src')); walk(path.join(root, 'electron'))
  return check
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, used } = checkRepository()
  if (failures.length) { console.error(failures.join('\n')); console.error(failures.length + ' translation checks failed'); process.exitCode = 1 }
  else console.log('PASS translation coverage and interpolation variables (' + used.size + ' static messages)')
}
