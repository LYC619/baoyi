/** Load actual renderer TS/SFC setup offline; only Electron/DOM boundaries are mocked. */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
export function createRendererLoader(mocks: Record<string, unknown>, globals: Record<string, unknown> = {}, inlineTemplate = false) {
  const cache = new Map<string, { exports: any }>()
  function load(file: string): any {
    const absolute = path.resolve(file)
    if (cache.has(absolute)) return cache.get(absolute)!.exports
    let source = fs.readFileSync(absolute, 'utf8')
    if (absolute.endsWith('.vue')) source = compileScript(parse(source).descriptor, { id: 'regression', inlineTemplate }).content
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    const module = { exports: {} as any }
    cache.set(absolute, module)
    const require = (name: string): unknown => {
      if (name in mocks) return mocks[name]
      if (name.endsWith('.vue')) return {}
      if (name.startsWith('@/') || name.startsWith('.')) {
        let target = name.startsWith('@/') ? path.resolve('src', name.slice(2)) : path.resolve(path.dirname(absolute), name)
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.ts')
        else if (!fs.existsSync(target)) target += '.ts'
        return load(target)
      }
      return nodeRequire(name)
    }
    vm.runInNewContext(compiled, { module, exports: module.exports, require, Error, console, ...globals }, { filename: absolute })
    return module.exports
  }
  return load
}
