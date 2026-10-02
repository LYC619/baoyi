/** Actual SFC + Vue renderer, with an in-memory DOM host; no app/process is launched. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { createRendererLoader } from './helpers/renderer-harness.ts'

type Node = {
  type: string; text: string; props: Record<string, any>; children: Node[]; parent: Node | null
  focus: () => void; contains: (target: Node | null) => boolean
}
let activeElement: Node | null = null
const events = new Map<string, Set<(event: any) => void>>()
const doc = {
  get activeElement() { return activeElement },
  addEventListener: (type: string, cb: (e: any) => void) => { const list = events.get(type) ?? new Set(); list.add(cb); events.set(type, list) },
  removeEventListener: (type: string, cb: (e: any) => void) => events.get(type)?.delete(cb)
}
function node(type: string, text = ''): Node {
  const n: Node = {
    type, text, props: {}, children: [], parent: null,
    focus: () => { activeElement = n },
    contains: (target) => target === n || n.children.some(child => child.contains(target))
  }
  return n
}
const root = node('root')
const body = node('body')
const renderer = Vue.createRenderer<Node, Node>({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert: (child, parent, anchor = null) => {
    if (child.parent) child.parent.children = child.parent.children.filter(n => n !== child)
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child)
  },
  remove: child => { if (child.parent) child.parent.children = child.parent.children.filter(n => n !== child); child.parent = null },
  setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text; n.children = [] },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, key, _prev, value) => { n.props[key] = value }, querySelector: () => body
})
function all(n: Node): Node[] { return [n, ...n.children.flatMap(all)] }
function text(n: Node): string { return n.text + n.children.map(text).join(' ') }
function find(predicate: (n: Node) => boolean): Node {
  const found = [...all(root), ...all(body)].find(predicate)
  assert.ok(found, 'expected rendered element')
  return found
}
function classed(name: string): Node { return find(n => String(n.props.class ?? '').split(' ').includes(name)) }
const load = createRendererLoader({
  vue: { ...Vue, Transition: { props: ['name'], setup: (_: unknown, ctx: any) => () => ctx.slots.default?.() } }
}, { document: doc, console: { info: () => {}, warn: () => {}, error: () => {} } }, true)
const center = load('src/composables/useTaskCenter.ts').useTaskCenter()
const activeModule = load('src/composables/useModules.ts').activeModule
activeModule.value = 'video'
const app = renderer.createApp(load('src/components/tasks/TaskCenter.vue').default)
app.config.warnHandler = message => { throw new Error('Unexpected Vue warning: ' + message) }
app.mount(root)
const click = async (n: Node) => { n.props.onClick({ stopPropagation: () => {} }); await Vue.nextTick() }
const trigger = classed('task-trigger')
assert.equal(trigger.props['aria-expanded'], false)
await click(trigger)
assert.equal(trigger.props['aria-expanded'], true)
assert.match(text(body), /暂无任务/)
assert.equal(classed('task-panel__clear').props.disabled, true)
assert.equal(find(n => n.props.role === 'dialog').props['aria-labelledby'], 'task-center-title')
assert.ok(events.get('pointerdown')?.size)
const running = center.start('video-scan', '影视扫描', { message: '正在遍历目录' })
const failed = center.start('video-scan', '影视识别')
center.finish(failed, 'failed', '识别失败', '<script>敏感字符作为文本</script>')
await Vue.nextTick()
assert.match(String(trigger.props['aria-label']), /1.*运行.*1.*失败/)
const bar = find(n => n.props.role === 'progressbar')
assert.equal(bar.props['aria-valuenow'], undefined)
center.update(running, { total: 4, processed: 2, current: 'D:/library/test.mkv', message: '读取事实' }, { message: '读取事实' })
await Vue.nextTick()
assert.equal(find(n => n.props.role === 'progressbar').props['aria-valuenow'], 50)
assert.ok(text(body).includes('D:/library/test.mkv'))
assert.match(text(body), /敏感字符作为文本/)
assert.equal(all(body).some(n => n.type === 'script'), false)
const videoDownload = center.start('video-download', '下载：站点标题')
center.update(videoDownload, { total: 1024 * 1024, processed: 512 * 1024, message: '正在下载' })
await Vue.nextTick()
assert.match(text(body), /512 KB.*1\.0 MB/)
center.finish(videoDownload, 'success', '下载完成')
const seriesDownload = center.start('video-series-download', '下载系列：站点标题')
center.update(seriesDownload, { total: 3, processed: 1, message: '正在下载第 2 集' })
await Vue.nextTick()
assert.match(text(body), /1 \/ 3 集/)
center.finish(seriesDownload, 'success', '系列下载完成')
await click(find(n => n.type === 'button' && text(n).includes('查看日志')))
assert.match(text(body), /任务开始/)
await click(find(n => n.type === 'button' && text(n).includes('清除')))
assert.equal(center.tasks.value.length, 1)
assert.equal(center.tasks.value[0].id, running)
assert.equal(center.runningCount.value, 1)
center.finish(running, 'success', '扫描完成')
await Vue.nextTick()
assert.equal(classed('task-panel__clear').props.disabled, false, 'completed history can be cleared with no running tasks')
await click(classed('task-panel__clear'))
assert.equal(center.history.value.length, 0)
assert.match(text(body), /暂无任务/)
await click(classed('task-panel__close'))
assert.equal(trigger.props['aria-expanded'], false)
assert.equal(activeElement, trigger)
await click(trigger)
events.get('keydown')?.forEach(cb => cb({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} }))
await Vue.nextTick()
assert.equal(trigger.props['aria-expanded'], false)
await click(trigger)
events.get('pointerdown')?.forEach(cb => cb({ target: node('outside') }))
await Vue.nextTick()
assert.equal(trigger.props['aria-expanded'], false)
app.unmount()
assert.equal([...events.values()].reduce((sum, list) => sum + list.size, 0), 0)
const source = fs.readFileSync('src/components/tasks/TaskCenter.vue', 'utf8')
assert.match(source, /-webkit-app-region: no-drag/)
assert.match(source, /prefers-reduced-motion/)
assert.ok(fs.readFileSync('src/components/TitleBar.vue', 'utf8').includes('<TaskCenter />'))
assert.match(source, /日志<\/span>/, 'the title bar entry is called 日志 now')
assert.match(source, /下载记录/); assert.match(source, /整理记录/); assert.match(source, /识别与调用/)
console.log('Task center UI: render, live counts/progress, escaped logs, clear, keyboard, outside click and cleanup passed')
