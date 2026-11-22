# hanime1.me 接口笔记

来源：[Han1meViewer](https://github.com/misaka10032w/Han1meViewer)（Apache-2.0，Kotlin，Retrofit + OkHttp + Jsoup）。
仓库 clone 在 `reference/`（已进 `.gitignore`），**只当规格读，不抄代码**。

写这份笔记是因为 v0.8 要给里番做刮削通道，而通道能不能做取决于一个问题：
这个站是公开页面，还是得拿逆向出来的密钥签名。答案在下面第一节。

---

## 一、结论：全是公开 HTML，没有私有 API

`HanimeBaseService.kt` 里每一个方法的返回类型都是 `Response<ResponseBody>` —— 原始
HTML 字节流，不是 JSON。`ServiceCreator.kt` 里给 hanime 用的那个 Retrofit 客户端
**没有挂任何 JSON converter**（只有 `createGitHubApi` 挂了）。整个项目里唯一一个
`Authorization` 头是 `Bearer ${BuildConfig.HA_GITHUB_TOKEN}`，打的是
`api.github.com/repos/misaka10032w/Han1meViewer/`，那是这个 App 自己的更新检查，
跟 hanime1.me 无关。

这一点要紧，因为它和 v0.7 里被否掉的那条路**形状不同**：MoviePilot 取豆瓣数据走
`frodo.douban.com/api/v2`，带硬编码的 `_api_key` / `_api_secret_key` 和 HMAC 签名 ——
那是从安卓客户端里逆出来的私有接口，抄它等于抄一份不该有的凭据，所以豆瓣改成走
用户自己配的搜索服务商（见 `electron/kinds/video/douban.ts` 开头那段）。

hanime1.me 这边没有这个问题：**没有 key、没有签名、没有私有端点**，就是普通
GET 一个网页回来自己解析。所以 v0.8 的刮削通道不撞那条红线。

代价换到了另一头：**返回的是 HTML，站方改版就会解析失败**。JSON 接口改字段名会
报错，HTML 改 class 名也会报错，区别只在于前者通常有版本号。所以选择器要集中放，
解析失败要能降级成"刮不到"而不是抛异常炸掉整次识别。

---

## 二、端点

Base URL 取 `HANIME_URL` 数组的第一项，默认 `https://hanime1.me/`。

| 用途 | 方法 | 路径 | 参数 |
|---|---|---|---|
| 搜索 | GET | `/search` | 见下表 |
| 作品详情 | GET | `/watch` | `v=<videoCode>` |
| 每日预览 | GET | `/previews/{date}` | 路径参数 `date` |
| 首页 | GET | `@Url`（整个 URL 传进去） | — |
| 下载页 | GET | `/download` | `v=<videoCode>` |

登录、订阅、收藏、观看记录那几个端点（`@FormUrlEncoded @POST("login")`、
`/subscriptions`、`/favourite` 等）是账号功能，抱一用不到 —— 刮削只需要公开的
搜索和详情两个。

### `/search` 的查询参数

来自 `HanimeBaseService.getHanimeSearchResult` 的签名：

| 参数 | 类型 | 说明 |
|---|---|---|
| `page` | Int | 页码，从 1 开始 |
| `query` | String? | 关键词。抱一用作品名搜就填这个 |
| `genre` | String? | 分类，单选。取值见第五节 |
| `sort` | String? | 排序 |
| `broad` | String? | 宽泛匹配开关 |
| `date` | String? | 年月 |
| `duration` | String? | 时长区间 |
| `tags[]` | Set\<String\> | 标签，可多个（重复同名参数） |
| `brands[]` | Set\<String\> | 厂牌，可多个 |

`HanimeManager.kt` 里还有两个现成的拼接函数，说明最小可用形态就是一个 query：

```kotlin
fun getHanimeSearchLink(artist: String) = HANIME_BASE_URL + "search?query=" + artist
fun getHanimeVideoLink(videoCode: String) = HANIME_BASE_URL + "watch?v=" + videoCode
```

### videoCode 是什么

纯数字，从 URL 里抠出来。`HanimeManager.kt`：

```kotlin
val videoUrlRegex = Regex(
    """(?:(?:https?:)?//[^\s"'<>/]+|(?:hanime(?:1|one)|javchu)\.(?:com|me))?(?:/[^/?#\s"'<>]+)*/watch\?(?:[^#\s"'<>]*&)?v=(\d+)"""
)
fun String.toVideoCode() = videoUrlRegex.find(this)?.groupValues?.get(1)
```

这个正则同时兼容站内相对链接和四个镜像域名，`v=` 前面允许有别的查询参数。
对抱一来说 videoCode 的地位相当于 `tmdb_id`：**存下来，重新刮削就是一次精确
查询而不是重新搜一遍**。

### 镜像域名

```kotlin
HANIME_HOSTNAME = arrayOf("hanime1.me", "hanime1.com", "hanimeone.me", "javchu.com")
HANIME_URL      = arrayOf("https://hanime1.me/", ...)
```

四个域名同源内容。上游客户端还挂了 `CloudflareInterceptor`、`UserAgentInterceptor`、
`HCookieJar`、`HProxySelector`、`HDns` —— 说明这个站**有 Cloudflare 盾**，不带
正常 UA 直接请求可能拿到挑战页而不是内容。

---

## 三、详情页怎么解析（`/watch?v=`）

选择器抄自 `Parser.kt` 的 `hanimeVideoVer2`（约 330-470 行）。**这是整份笔记里最
容易过期的一节** —— 都是 class 名和 DOM 结构。

| 字段 | 选择器 | 备注 |
|---|---|---|
| 标题 | `#shareBtn-title` | 分享按钮上带的那个标题，比正文标题稳 |
| 封面 | 页面 meta / 首个主图 | 详见下面代码块 |
| 中文名 | `div[class^=video-caption-text]` 的 `previousElementSibling()?.ownText()` | 在简介**前面**那个兄弟节点上 |
| 简介 | `div[class^=video-caption-text]` 自己的 `ownText()` | 两者共处 `div[class=video-details-wrapper]` 下 |
| 上传时间 + 播放量 | `div > div > div`，用 `Regex.viewAndUploadTime` 拆 | 挤在同一个文本节点里 |
| 标签 | `getElementsByClass("single-video-tag")` | 取子节点带 `href` 的那个的文本 |
| 系列（集数表） | `div.video-playlist-wrapper` → `#playlist-scroll` | **两种页面结构**，见下 |
| 作者/厂牌 | `.meta-author a` | |
| 收藏数 / 踩数 | `favTimes` / `unlikesCount` | 抱一不用 |

### 标签要洗一遍

```kotlin
it.substringBefore(" (").removePrefix("#").trim()
```

页面上标签写成 `#巨乳 (1234)` 这种形状 —— 前面一个 `#`，后面括号里是该标签下的
作品数。两个都得去掉，否则入库的标签会变成 `#巨乳 (1234)` 这种带计数的字符串，
而计数每天都在变，同一个标签会因为数字不同被当成不同的标签反复入池。

### 集数表有两套结构

`div.video-playlist-wrapper`（新）和 `div[id=video-playlist-wrapper]`（旧）都要试，
拿到之后再取 `#playlist-scroll`。新结构里每一项在 `playlist-hover-wrap` 下：

| 项内字段 | 选择器 |
|---|---|
| 系列名 | `#playlist-top-block h4 a` |
| 单集链接 | 项上的 `data-href`，再过 `toVideoCode()` |
| 单集封面 | `img.main-thumb` |
| 单集标题 | `h4.video-title a` |
| 时长 | `.duration` |
| 播放量 | `.stat-item` |

旧结构走另一套 fallback 选择器。上游是**先试新的、失败再试旧的**，抱一照这个
顺序做就行。

这个 playlist 就是**集数的来源**。`HanimeVideo.kt` 里那条注释说得很清楚：

> 這裏的playlist是指該影片的系列影片，並非用戶的播放清單

也就是说：站上没有"季/集"这套层级，一部作品的多集是**一个 playlist 里的多个
独立条目**，每个条目有自己的 videoCode、自己的封面、自己的时长。这跟 TMDB 的
`season → episode` 结构不一样，v0.8 的映射要在这儿做取舍（见 `v0.8-计划.md`）。

---

## 四、搜索结果怎么解析（`/search`）

`Parser.kt` 的 `hanimeSearch`（约 219-300 行）先看页面是哪种版式：

- `content-padding-new` → 正常版式（`itemType = NORMAL`）
- `home-rows-videos-wrapper` → 简化版式（`itemType = SIMPLIFIED`）

两种都要认。正常版式每一项：

| 字段 | 选择器 |
|---|---|
| 标题 | `div.title, h4.video-title` |
| 封面 | 首个 `img` 的 `absUrl("src")` |
| videoCode | 首个 `a` 的 `absUrl("href")` → `toVideoCode()` |
| 时长 | `div[class^=thumb-container]` → `div[class^=duration]` |
| 播放量 | 同上容器里第二个 `div[class^=stat-item]` |
| 作者 + 上传时间 | `div.subtitle, div.video-meta-data`，按 `•` 切开 |

注意封面和链接都用 `absUrl` 而不是 `attr` —— 页面上是相对路径，得跟 base URL 拼。

---

## 五、数据模型

### 列表项（`HanimeInfo.kt`）

`title`、`coverUrl`、`videoCode`、`duration`、`views`、`uploadTime`、`genre`、
`isPlaying`、`playlistItemId`、`itemType`(NORMAL=0/SIMPLIFIED=1)、`reviews`、
`currentArtist`、`watched`。

### 详情（`HanimeVideo.kt`）

`title`、`coverUrl`、`chineseTitle`、`introduction`、`uploadTime: LocalDate?`、
`views`、`videoUrls: ResolutionLinkMap`、`tags: List<String>`、`playlist: Playlist?`、
`relatedHanimes`、`artist: Artist?`(name/avatarUrl/genre)、`favTimes`、`unlikesCount`。

嵌套 `Playlist(playlistName: String?, video: List<HanimeInfo>)`。

### 清晰度

`HanimeResolution.kt`：`1080P` / `720P` / `480P` / `240P` / `Unknown`，最多 5 档
（`arrayOfNulls<Pair<String, HanimeLink>>(5)`）。

**这一档取值和文件名尾巴上的 `_720P` 是同一套词表**，不是巧合 —— 文件是从这个站
下来的，命名跟着站上的清晰度标记走。`videoUrls` 是在线播放地址，抱一放本地文件，
这个字段用不上。

---

## 六、站方自己的分类体系

`assets/search_options/genre.json`，**单选**，十个：

| 显示名（简中） | `search_key` | 备注 |
|---|---|---|
| 全部 | `全部` | |
| **里番** | **`裏番`** | 繁简不一致，见下 |
| 泡面番 | `泡麵番` | |
| Motion Anime | `Motion Anime` | |
| 3D动画 | `3DCG` | |
| 2.5D | `2.5D` | |
| 2D动画 | `2D動畫` | |
| AI生成 | `AI生成` | |
| MMD | `MMD` | |
| Cosplay | `Cosplay` | |

每条都带四语言 `lang`（zh-rCN / zh-rTW / en / ja）加一个 `search_key`。

两件事值得记下来：

**一，`search_key` 是繁体，显示名才是简体。** 里番这一条简中显示"里番"、繁中显示
"裏番"、英文显示 "Hentai"，而拼进 URL 的 key 是繁体的 `裏番`。拼错了搜不到东西，
而且不会报错 —— 只会回一个空结果，看起来像"这个作品站上没有"。

**二，这个 genre 列表和抱一的 `category` 是同一种形状** —— 单选、互斥、格子少而满。
`kinds/video/taxonomy.ts` 里那段"为什么按地区/形态分不按题材分"的道理在这儿也成立：
站方也没把题材放进 genre，题材全在 tags 里。

## 七、站方自己的标签体系

`assets/search_options/tags.json`，**七个域、235 个标签**，每条同样带四语言加 key：

| 域 | 数量 | 头几个 key |
|---|---|---|
| `video_attributes` | 9 | 無碼、AI解碼、中文字幕、中文配音、同人作品、斷面圖、ASMR、1080p |
| `character_relationships` | 9 | 近親、姐、妹、母、女兒、師生、情侶、青梅竹馬 |
| `characteristics` | 47 | JK、處女、御姐、熟女、人妻、女教師 |
| `appearance_and_figure` | 47 | 短髮、馬尾、雙馬尾、丸子頭、巨乳 |
| `story_location` | 24 | 校園、教室、圖書館、保健室、游泳池 |
| `story_plot` | 45 | 純愛、戀愛喜劇、後宮、NTR、精神控制 |
| `sex_positions` | 54 | （略） |

全是繁体 key。

### 一个对 v0.8 有直接用处的发现

`video_attributes` 这个域里有 **無碼、中文字幕、1080p**。

对照用户给的两个真实文件名：

```
OVAピュアピュア ぺろぺろ プリンセス ＃2 [中文字幕]_720P
寝取られファイター ヤリっちんぐ！ ROUND1 [中文字幕]_720P
```

`[中文字幕]` 和 `_720P` **本身就是站方的标签**。也就是说文件名尾巴上那些要剥掉的
后缀不是垃圾，是**可回收的元数据** —— 剥的时候顺手记下来，就等于免费拿到了几个
标签，不用等刮削。这条写进 `v0.8-计划.md` 的解析器设计里。

（注意繁简：文件名里是简体"中文字幕"，站方 key 也是"中文字幕"这四个字繁简同形，
碰巧一致。但"無碼"是繁体，文件名里常见的是"无修正"——两者对不上，需要一张
别名表，不能指望字面相等。）

---

## 八、对接抱一时要注意的

1. **必须带正常 User-Agent。** 上游挂了 `UserAgentInterceptor` 和
   `CloudflareInterceptor`，说明裸请求可能被盾挡。Electron 主进程里发请求默认 UA
   带 `Electron/`，八成要覆盖。
2. **解析失败要降级，不要抛。** 站方改版会让选择器全线失效，这时候正确的行为是
   "这一条刮不到、跳过"，不是让整次识别炸掉。和 `tmdb.ts` 同一个约定。
3. **选择器集中放一处。** 上面第三、四节的选择器全部集中在一个文件里，别散进
   业务逻辑 —— 改版时只改一个文件。
4. **videoCode 存进库。** 地位等同 `tmdb_id`：有它就能精确重刮。
5. **纯逻辑和网络请求分开。** URL 拼装、HTML 解析、标签清洗都做成不发请求的纯
   函数，自检拿固定 fixture 跑；只有真正取页面那一个函数碰网络。这是
   `tmdb.ts` / `douban.ts` / `mediainfo.ts` 已经在用的约定。
6. **不做账号功能。** 登录、收藏、订阅、观看记录那些端点存在，但抱一的观看状态
   在本地库里，不往站上同步。

---

## 附：读过的文件清单

`app/src/main/java/com/yenaly/han1meviewer/` 下：

- `logic/network/HanimeBaseService.kt` —— 端点定义（**第一节的结论出自这里**）
- `logic/network/ServiceCreator.kt` —— Retrofit / OkHttp 装配、拦截器、唯一的 token
- `logic/network/NetworkRepo.kt` —— 仓库层，把 service 和 parser 接起来
- `logic/model/HanimeVideo.kt` / `HanimeInfo.kt` —— 数据模型
- `util/Parser.kt` —— Jsoup 选择器（第三、四节）
- `HanimeManager.kt` —— URL 拼装、`toVideoCode` 正则
- `HanimeResolution.kt` —— 清晰度档位
- `model/SearchOption.kt` / `ui/fragment/search/HAdvancedSearch.kt` —— 搜索参数
- `assets/search_options/genre.json` / `tags.json` —— 分类与标签体系
