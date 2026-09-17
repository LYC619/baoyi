# Hanime 内置代理设计

## 目标

为抱一增加参考 Han1meViewer 的内置代理能力，但代理范围限定为 Hanime 网络链路。用户可以在设置页选择直连、系统代理、HTTP 代理或 SOCKS5 代理；保存后立即生效，无需重启。TMDB、豆瓣及其他现有联网链路保持原有直连行为。

## 现状与约束

- Electron 主进程同时存在 Node `fetch` 与 Chromium 网络栈。Hanime 使用独立的持久化
  Chromium session，其他默认 session 的请求不受这条代理影响。
- `session.setProxy` 只影响对应 session，因此 Hanime 请求统一切换到该 session 的
  `fetch`；直连时也必须使用它，才能吃启动阶段的内置 Hosts 规则。
- 直连时也使用 Hanime 专用 session 的 fetch，确保内置 Hosts 规则在无代理场景生效。
- Chromium 默认绕过 loopback；不设置 `<-loopback>`，避免本地协议被错误送入代理。
- 代理配置需要持久化，并兼容当前已有的单字符串 `proxy` 设置字段。

## 方案

### 配置模型

继续使用 `AppSettings.proxy` 字符串字段，约定如下：

- 空字符串：直连。
- `system://`：使用系统代理。
- `http://host:port`：HTTP 代理。
- `socks5://host:port`：SOCKS5 代理。
- 裸 `host:port`：规范化为 HTTP 代理。

除上述快捷形式外，允许 Chromium `proxyRules` 支持的分号分隔和按协议分流规则原样透传。Electron 负责最终协议与端口校验，设置页提供基本输入校验和可读错误提示。

### 网络应用层

新增/完善代理服务，提供四个边界函数：

- `applyProxy(raw)`：规范化规则，调用 Hanime 专用 session 的 `setProxy`；统一注入该 session 的 fetch。
- `initProxy(read)`：应用启动后读取持久化配置并应用；失败时记录错误但不阻塞窗口启动。
- `reapplyProxy(raw)`：设置保存后即时应用，返回 `{ ok, message }`，失败时清空缓存状态以允许重试。
- `resolveProxyFor(url)`：通过 Chromium 查询实际代理路径，用于设置页诊断。

系统代理使用专用 session 的 `setProxy({ mode: 'system' })`，直连使用 `{ mode: 'direct' }`；自定义规则使用 `{ proxyRules }`。所有模式都把 Hanime 请求切换到该 session 的 fetch，并强制 `credentials: 'omit'`。

### Hanime 请求接线

Hanime 模块保留一个可替换的 fetch 引用，默认指向全局 `fetch`。代理服务只在配置发生变化时更新该引用，避免每次请求判断代理状态。所有 Hanime 页面、搜索和详情请求继续复用现有模块，不在业务层散落代理判断。

### 设置页

在现有网络设置区域增加：

- 模式选择：直连 / 系统代理 / HTTP / SOCKS5。
- HTTP、SOCKS5 模式下的主机与端口输入。
- 保存按钮：先持久化，再即时应用，并展示应用结果。
- 状态检查：显示当前规则及 `hanime1.me` 的 `resolveProxy` 结果。
- SOCKS5 说明：仅影响 Hanime 链路，其他服务仍按原网络策略运行。

为兼容已有用户输入，加载旧的 `proxy` 字符串时自动解析为对应模式；保存时继续写回统一字符串格式。

## 错误处理

- 代理规则为空时显式切换到 `direct`，不能仅停止注入，否则旧 session 代理会残留。
- `setProxy` 失败不阻止应用启动；设置页返回失败消息并允许再次保存。
- 无效端口、空主机等输入在界面层拦截；Chromium 拒绝的复杂规则由主进程捕获并反馈。
- `resolveProxy` 在应用未 ready 或查询失败时返回可读状态，不泄漏异常堆栈到界面。

## 测试与验证

采用测试先行：

1. 为纯规则规范化和模式序列化/反序列化添加单元测试，先确认测试失败。
2. 为直连、系统、自定义代理的 `setProxy` 参数映射及失败回退添加主进程边界测试。
3. 保留并扩展 Electron 级验证：检查 `resolveProxy('https://hanime1.me/')`、loopback 返回 `DIRECT`，清空配置后恢复 `DIRECT`，并验证 Hanime fetch 已切换到 Chromium 网络栈。
4. 运行现有 `typecheck`、`selfcheck` 及代理验证脚本；网络环境不可用时，至少完成规则和接线的离线验证并明确记录。

## 非目标

- 不把代理扩展到 TMDB、豆瓣、AI 服务或其他非 Hanime 请求；默认 session 保持原行为。
- 不实现 VPN、PAC 编辑器、代理订阅或多节点测速管理。
- 不修改 Han1meViewer 的 DNS/DoH 全套能力；仅复用其代理模式和运行时重建思路。
