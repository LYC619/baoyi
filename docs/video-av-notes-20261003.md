# AV 接入参考资料：JAVDB + MissAV 解析规则 · 2026-10-03

第 0 步「探路」产物。来源均为公开开源项目源码，仅用于本项目第一版实现参考。
**尚未在本机对真实站点实测**，选择器与流程需用真实页面样本复核后再定稿。

## 一、参考项目与许可证

| 用途 | 项目 | 许可证 | 取用方式 |
| --- | --- | --- | --- |
| JAVDB 页面结构、外部播放站模板、MissAV 媒体域名 | 9E307/JavdbEmbySkin | BSD-3-Clause | 可参考思路与选择器 |
| MissAV / Jable / SupJav 解析器、HLS 下载 | xin0907/vget-cli | Apache-2.0 | 可参考并改写 |
| 播放站跳转 | aizhimou/jav-play | Apache-2.0 | 参考 |
| 多站聚合刮削 | ShotHeadman/mdcz | GPL-3.0 | **只看思路，不复制代码** |
| 元数据聚合服务 | metatube-community/metatube-sdk-go | Apache-2.0 | 备选（未选用） |

改写自 vget / UAV 的代码应在文件头注明来源与许可证。

## 二、JAVDB（逛 / 资料）

- 站点会换域名，需要可配置的基准域名（默认 `https://javdb.com`，可填镜像）。
- **列表页网格**：`.movie-list > .item > .box`；卡内 `.cover > img`、`.video-title`、`.score`、`.meta`、`.tags`。
- **详情页**：`.video-detail`，含 `h2.title`、`img.video-cover`、`.panel-block > .value`。
- **封面图床**：`https://c0.jdbstatic.com`（`covers` / `thumbs`）；演员头像
  `https://c0.jdbstatic.com/avatars/{id 前 2 位小写}/{id}.jpg`。
- 番号从标题或详情字段解析；列表/搜索以番号定位。
- 有 Cloudflare，可能触发挑战页；需要「开窗口过盾」或带 Cookie 的会话。
- 注意：JavdbEmbySkin 实际跑在镜像 `jdforrepam.com` 并使用该站的私有 `/api`。
  我们**不依赖这个私有 API**，直接解析 JAVDB HTML。

## 三、外部播放站（看）

模板占位符：`{code}`（原样番号）、`{code_lower}`（小写）。第一版只接 **MissAV**。

| 站点 | 模板 | 镜像 |
| --- | --- | --- |
| MissAV | `https://missav.live/search/{code}` | missav.ai / missav.ws / missav123.com / missav.live |
| Jable | `https://jable.tv/search/{code}/` | jable.tv / fs1.app |
| SupJav | `https://supjav.com/?s={code}` | supjav.com |

## 四、MissAV 下载（存）

- 播放页内嵌**压缩后的 JS**（Dean Edwards `eval(function(p,a,c,k,e,d){...})` 形式），
  解包后从 `source = "....m3u8"` 取播放地址。
- 媒体是 **HLS（m3u8）**，不是 mp4 直链。
- 请求需要 `Referer` 与 `Origin` = `https://{missav 主机}/`。
- 备选镜像：missav.ai / missav.ws / missav123.com / missav.live；
  HTTP 403 / 429 / 503 或 Cloudflare 特征页视为被拦截。
- 预览片段 `https://fourhoi.com/{code}/preview.mp4` 只是预告，不是完整片。

## 五、Jable 下载

- 镜像：jable.tv / fs1.app；cookie `kt_rt_lang=""`。
- 页面直接暴露 `.m3u8`；同为 HLS。

## 六、HLS 下载与封装要点（vget hls.py）

1. 主清单 → 选画质 → 媒体清单。
2. 分片并发下载、断点续传、支持 `BYTERANGE`。
3. `AES-128` 解密（IV 缺省按分片 sequence 生成）；不处理 DRM / SAMPLE-AES。
4. 分片合并后，**用 FFmpeg 以 `-c copy` 封装为 MP4**（不重编码，速度快）。

## 七、关键阻塞：FFmpeg

MissAV / Jable 都是 HLS，要合成能入库的 MP4 需要 FFmpeg。抱一当前**不含 FFmpeg**。
三个选项，待「逛」完成后再定：

1. 打包 `ffmpeg.exe`（体积约 +80–100MB）。
2. 要求用户自备 FFmpeg，程序自动查找并提示。
3. 纯 JS 方案（mux.js + AES）绕过 FFmpeg —— 工程量更大、风险更高。

## 八、第一版边界

- 只做 **JAVDB（逛）+ MissAV（看 / 存）**。
- 不做账号登录 / 收藏同步、不做自动追新、不做其余播放站。
- 不改本地影视库数据模型，下载后走现有入库流程。

## 九、待办：需要真实页面样本

已由用户提供 JAVDB 搜索页、JAVDB 详情页、MissAV 播放页三个真实样本，选择器据此复核。
样本不入库（含 NSFW 内容），只用于本地离线校验。

## 十、已实现（2026-10-03）

第一版链路「JAVDB 逛 + MissAV 看/存」已落地：

| 环节 | 实现 | 位置 |
| --- | --- | --- |
| 逛 | JAVDB 站点适配器，接入在线来源 | `discovery/adapters/javdb.ts`、`discovery/online.ts` |
| 封面 | 图床需 Referer + 浏览器 UA（否则 Cloudflare 403） | `ipc/video-workflow.ts` 的 `posterRequestHeaders` |
| 看 | 按番号在通用浏览窗口打开 MissAV 搜索页 | `discovery/playback-sites.ts`、`ipc/video-discovery.ts` |
| 存 | MissAV 解析 m3u8 → HLS 分片下载 → FFmpeg 合片 → 入库 | `discovery/missav.ts`、`download/hls.ts`、`download/ffmpeg.ts` |

依赖：**系统 FFmpeg**（方案 B）。找不到时下载会报明确错误，不静默失败。

验证：`verify-javdb-parse`、`verify-missav-parse`、`verify-online-source`（11）、
`verify-video-workflow`（8）、`verify-video-download`（29）、`verify-video-posters`（2）、
`selfcheck`（634）、`npm run build` 全部通过。**真实站点联网抓取与真实下载仍待本机实测**。
