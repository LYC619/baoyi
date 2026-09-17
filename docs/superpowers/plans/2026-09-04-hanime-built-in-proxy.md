# Hanime 内置代理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仅 Hanime 网络链路支持直连、系统代理、HTTP 和 SOCKS5 四种运行时可切换的内置代理模式，并在设置页显示实际生效状态。

**Architecture:** 使用 Hanime 专用 Chromium session 与 Hanime fetch 注入。增加纯函数配置解析层，把用户配置映射为该 session 的 `setProxy` 参数；代理服务只负责 Hanime 网络状态和 fetch 注入，默认 session 及其他请求链路不改；设置页通过现有 `settings:patch` IPC 保存并即时应用。

**Tech Stack:** Electron 37 (`session.fromPartition`, `Session.setProxy`, `Session.fetch`), Vue 3 + Pinia, TypeScript, Vite, Node 自检脚本。

---

## 文件地图

- Modify: `electron/services/proxy-rules.ts`：代理模式、输入解析、序列化和纯校验，不导入 Electron。
- Modify: `electron/services/proxy.ts`：把解析后的模式映射到 `session.setProxy`，处理启动/保存失败和 Hanime fetch 注入。
- Modify: `electron/kinds/video/hentai/hanime.ts`：保持可注入 fetch 边界，并补充可测试的注入行为（不引入 Electron）。
- Modify: `src/types/index.ts`：同步代理模式、设置接口和 IPC 返回类型。
- Modify: `electron/ipc/handlers.ts`、`electron/preload.ts`：保存后应用代理、暴露状态诊断 IPC。
- Modify: `src/pages/Settings.vue`：视频模块的代理模式选择、主机/端口表单、保存和诊断反馈。
- Modify: `scripts/agent-selfcheck.ts`：纯函数配置和边界行为的离线回归检查。
- Modify: `scripts/verify-proxy.cjs`：覆盖 direct/system/custom 映射、loopback 豁免和 Hanime Chromium 网络栈接线。
- Modify: `scripts/verify-packaged.ts`：保留现有打包验证并确认代理相关 IPC 仍能加载。

### Task 1: 为代理配置建立失败测试和纯函数模型

**Files:**
- Modify: `scripts/agent-selfcheck.ts:9320` 附近的代理测试区
- Modify: `electron/services/proxy-rules.ts`
- Modify: `src/types/index.ts`（仅新增共享类型）

- [ ] **Step 1: 写失败测试**

在 `proxySection()` 中先加入以下断言，并从 `proxy-rules.ts` 导入待实现函数 `parseProxyInput`、`serializeProxyInput`、`toElectronProxyConfig`：

```ts
await check('空输入解析为 direct', () => {
  assert.deepEqual(parseProxyInput(''), { mode: 'direct' })
})
await check('system:// 解析为 system', () => {
  assert.deepEqual(parseProxyInput('system://'), { mode: 'system' })
})
await check('HTTP 地址拆出主机和端口', () => {
  assert.deepEqual(parseProxyInput('http://127.0.0.1:8080'), {
    mode: 'http', host: '127.0.0.1', port: 8080
  })
})
await check('SOCKS5 地址拆出主机和端口', () => {
  assert.deepEqual(parseProxyInput('socks5://127.0.0.1:10808'), {
    mode: 'socks5', host: '127.0.0.1', port: 10808
  })
})
await check('裸 host:port 仍按 HTTP 兼容', () => {
  assert.deepEqual(parseProxyInput(' proxy.local:3128 '), {
    mode: 'http', host: 'proxy.local', port: 3128
  })
})
await check('非法端口给出可读错误', () => {
  assert.throws(() => parseProxyInput('http://127.0.0.1:70000'), /端口/)
})
await check('Electron 配置映射正确', () => {
  assert.deepEqual(toElectronProxyConfig({ mode: 'direct' }), { mode: 'direct' })
  assert.deepEqual(toElectronProxyConfig({ mode: 'system' }), { mode: 'system' })
  assert.deepEqual(toElectronProxyConfig({ mode: 'http', host: 'h', port: 80 }), {
    proxyRules: 'http://h:80'
  })
  assert.deepEqual(toElectronProxyConfig({ mode: 'socks5', host: 'h', port: 1080 }), {
    proxyRules: 'socks5://h:1080'
  })
})
```

- [ ] **Step 2: 运行测试确认它因缺少实现而失败**

Run: `npm run selfcheck`

Expected: FAIL，错误应指向 `parseProxyInput` 或 `toElectronProxyConfig` 未导出/未定义，而不是脚本语法错误。

- [ ] **Step 3: 实现最小纯函数模型**

在 `proxy-rules.ts` 中新增：

```ts
export type ProxyInput =
  | { mode: 'direct' }
  | { mode: 'system' }
  | { mode: 'http' | 'socks5'; host: string; port: number }

export type ElectronProxyConfig =
  | { mode: 'direct' | 'system' }
  | { proxyRules: string }

export function parseProxyInput(raw: string): ProxyInput {
  const value = String(raw ?? '').trim()
  if (!value) return { mode: 'direct' }
  if (value.toLowerCase() === 'system://' || value.toLowerCase() === 'system') {
    return { mode: 'system' }
  }
  const normalized = normalizeProxyRules(value)
  const match = /^(https?|socks5):\/\/([^/:]+|\[[^\]]+\]):(\d+)$/.exec(normalized)
  if (!match) throw new Error('代理地址必须是 system://、http://host:port 或 socks5://host:port')
  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须在 1-65535 之间')
  return { mode: match[1].toLowerCase() === 'socks5' ? 'socks5' : 'http', host: match[2], port }
}

export function serializeProxyInput(input: ProxyInput): string {
  if (input.mode === 'direct') return ''
  if (input.mode === 'system') return 'system://'
  return `${input.mode === 'socks5' ? 'socks5' : 'http'}://${input.host}:${input.port}`
}

export function toElectronProxyConfig(input: ProxyInput): ElectronProxyConfig {
  if (input.mode === 'direct' || input.mode === 'system') return { mode: input.mode }
  return { proxyRules: serializeProxyInput(input) }
}
```

- [ ] **Step 4: 运行测试确认纯函数通过**

Run: `npm run selfcheck`

Expected: PASS，代理配置区全部通过。

- [ ] **Step 5: 提交纯函数和测试**

```bash
git add electron/services/proxy-rules.ts scripts/agent-selfcheck.ts src/types/index.ts
git commit -m "feat: model Hanime proxy modes"
```

### Task 2: 将代理模式接入 Electron session 和 Hanime fetch

**Files:**
- Modify: `electron/services/proxy.ts`
- Modify: `electron/kinds/video/hentai/hanime.ts`
- Modify: `scripts/agent-selfcheck.ts`：补充 fetch 模式判定的离线断言

- [ ] **Step 1: 写失败的 fetch 模式测试**

在 `scripts/agent-selfcheck.ts` 对纯函数 `usesChromiumFetch` 增加断言，明确只有 system/http/socks5 需要 Chromium 网络栈：

```ts
await check('代理模式决定 Hanime fetch 网络栈', () => {
  assert.equal(usesChromiumFetch({ mode: 'direct' }), false)
  assert.equal(usesChromiumFetch({ mode: 'system' }), true)
  assert.equal(usesChromiumFetch({ mode: 'http', host: 'h', port: 80 }), true)
  assert.equal(usesChromiumFetch({ mode: 'socks5', host: 'h', port: 1080 }), true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run selfcheck`

Expected: FAIL，因为当前纯规则模块尚未导出 `usesChromiumFetch`。

- [ ] **Step 3: 最小实现服务改动**

在 `proxy-rules.ts` 新增：

```ts
export function usesChromiumFetch(input: ProxyInput): boolean {
  return input.mode !== 'direct'
}
```

在 `proxy.ts`：

- 用 `parseProxyInput` 和 `toElectronProxyConfig` 替代把所有非空值都当 `proxyRules` 的逻辑。
- `applyProxy` 的缓存键使用规范化序列化结果；调用 Hanime 专用 session 的 `setProxy(toElectronProxyConfig(input))` 成功后才更新 `applied`。
- 失败时把 `applied` 清为 `null`，不改变当前 Hanime fetch，允许下一次保存重试。
- direct 设置 `setHanimeFetch(null)`；system/http/socks5 根据 `usesChromiumFetch` 设置 `setHanimeFetch(netFetch)`。
- 保持不设置 `proxyBypassRules`，让 Chromium 默认 loopback 规则生效。
- `initProxy` 继续吞启动异常并记录“按直连运行”；`reapplyProxy` 返回明确失败消息。

在 `hanime.ts` 保持 `injected ?? globalThis.fetch` 的唯一取页入口，不新增 Electron 依赖；离线测试只验证 `usesChromiumFetch`，Electron 级脚本验证实际注入。

- [ ] **Step 4: 运行离线验证**

Run: `npm run selfcheck`

Expected: PASS，且没有 Electron 加载错误。

- [ ] **Step 5: 提交网络服务改动**

```bash
git add electron/services/proxy.ts electron/kinds/video/hentai/hanime.ts scripts/agent-selfcheck.ts
git commit -m "feat: apply Hanime proxy modes at runtime"
```

### Task 3: 同步 IPC、类型和设置页交互

**Files:**
- Modify: `src/types/index.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/pages/Settings.vue`

- [ ] **Step 1: 更新 IPC 和共享类型**

确保 `BaoyiApi.settings` 包含：

```ts
proxyStatus(url?: string): Promise<{ rules: string; resolved: string }>
```

确保 `settings:patch` 只在 patch 含 `proxy` 时调用 `reapplyProxy(next.proxy)`，其他设置保存不重设代理；`preload.ts` 对 patch 使用现有 `plain()`，避免 Vue reactive 值穿过 contextBridge。

- [ ] **Step 2: 更新设置页为四模式表单**

把当前单输入框改为：

```ts
type ProxyMode = 'direct' | 'system' | 'http' | 'socks5'
const proxyMode = ref<ProxyMode>('direct')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref(10808)
```

加载已有 `settings.proxy` 时调用 `parseProxyInput`；无法解析的旧值保留在兼容文本字段并显示错误。保存时：

- direct 写入 `''`；system 写入 `'system://'`；HTTP/SOCKS5 写入对应 URI。
- HTTP/SOCKS5 要求非空主机与 `1-65535` 端口，失败只显示 toast，不发 IPC。
- 保存成功后调用现有 `checkProxy()`，状态文案明确“仅 Hanime 使用代理”。
- 不在 TMDB、豆瓣或其他设置区域添加代理入口。

- [ ] **Step 3: 运行类型检查**

Run: `npm run typecheck`

Expected: PASS，无 Vue 模板、IPC 或共享类型错误。

- [ ] **Step 4: 提交 IPC 和 UI 改动**

```bash
git add src/types/index.ts electron/ipc/handlers.ts electron/preload.ts src/pages/Settings.vue
git commit -m "feat: configure Hanime proxy modes in settings"
```

### Task 4: 扩展 Electron 级代理验证

**Files:**
- Modify: `scripts/verify-proxy.cjs`
- Modify: `scripts/probe-hanime-proxy.cjs`（仅在现有脚本需要支持 system/direct 参数时）

- [ ] **Step 1: 增加验证场景**

在 `verify-proxy.cjs` 中加入：

- `setProxy({ mode: 'direct' })` 后 `resolveProxy('https://hanime1.me/')` 包含 `DIRECT`。
- `setProxy({ mode: 'system' })` 后结果由系统代理决定，但脚本必须成功返回字符串。
- 自定义 SOCKS5/HTTP 参数仍能解析为 `SOCKS5 host:port` / `PROXY host:port`。
- `resolveProxy('http://127.0.0.1:1/')` 包含 `DIRECT`。
- 清空代理后再次检查 Hanime 为 `DIRECT`。
- 通过 Hanime 模块发起一次请求，确认所有模式都使用 Hanime 专用 Chromium `Session.fetch`，不再是 Node undici。

- [ ] **Step 2: 运行 Electron 验证**

Run: `npm run verify-proxy -- socks5://127.0.0.1:10808`

Expected: 在存在可用代理时打印 PASS；无代理环境下允许网络出口比较失败，但 `resolveProxy`、loopback 和清空回退断言必须完成，并在输出中明确失败原因。

- [ ] **Step 3: 提交验证脚本**

```bash
git add scripts/verify-proxy.cjs scripts/probe-hanime-proxy.cjs
git commit -m "test: verify Hanime proxy routing"
```

### Task 5: 全量回归与交付检查

**Files:**
- Modify: none unless a test exposes a regression in the files above.

- [ ] **Step 1: 运行完整离线检查**

Run: `npm run selfcheck`

Expected: PASS，所有已有自检区和新增代理区通过。

- [ ] **Step 2: 运行类型检查与构建**

Run: `npm run typecheck`

Run: `npm run build`

Expected: 两者均 PASS；不得出现未处理的 TypeScript 或 Vite 构建错误。

- [ ] **Step 3: 运行代理 Electron 验证**

Run: `npm run verify-proxy`

Expected: 记录实际 `resolveProxy` 输出；若环境没有代理服务或外网不可用，报告网络性失败，不把它误报为代码通过。

- [ ] **Step 4: 检查工作区边界**

Run: `git status --short`

Expected: 只包含本计划涉及的文件与用户原先已有的未提交改动；不得覆盖或回滚用户改动。

- [ ] **Step 5: 交付前验证**

读取 `C:\Users\yicha\.codex\skills\verification-before-completion\SKILL.md`，按其要求重新核对命令输出后，再向用户报告完成状态和剩余网络环境限制。
